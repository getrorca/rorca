-- 20260821090300_browser_session_broker_profiles.sql
-- Core provider-binding and receipt storage for dedicated browser test identities.
-- Browser profile bytes never enter PostgreSQL: profile_secret_ref is an opaque
-- reference to the separately encrypted browser profile SecretStore artifact.

CREATE TABLE rorca.browser_profile_bindings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_adapter TEXT NOT NULL DEFAULT 'browser-session'
    CHECK (provider_adapter = 'browser-session'),
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  external_provider TEXT NOT NULL CHECK (external_provider IN ('claude', 'chatgpt')),
  account_alias TEXT NOT NULL CHECK (
    account_alias = lower(account_alias)
    AND account_alias ~ '^[a-z0-9][a-z0-9._-]{2,119}$'
  ),
  allowed_origins TEXT[] NOT NULL CHECK (
    cardinality(allowed_origins) BETWEEN 1 AND 32
    AND array_position(allowed_origins, NULL) IS NULL
  ),
  profile_generation INTEGER NOT NULL DEFAULT 1 CHECK (profile_generation > 0),
  profile_secret_ref UUID,
  lifecycle_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (lifecycle_state IN ('pending', 'active', 'quarantined', 'deleted')),
  binding_status TEXT NOT NULL DEFAULT 'disabled'
    CHECK (binding_status IN ('active', 'disabled', 'invalid')),
  provider_health TEXT NOT NULL DEFAULT 'degraded'
    CHECK (provider_health IN ('healthy', 'degraded', 'locked')),
  session_health TEXT NOT NULL DEFAULT 'unknown'
    CHECK (session_health IN ('healthy', 'expired', 'unknown')),
  health_observed_at TIMESTAMPTZ NOT NULL,
  retention_mode TEXT NOT NULL CHECK (retention_mode IN ('preserve', 'quarantine', 'destroy')),
  retain_until TIMESTAMPTZ,
  destruction_policy TEXT NOT NULL
    CHECK (destruction_policy IN ('operator_delete', 'delete_after_retention')),
  enrollment_provenance JSONB NOT NULL CHECK (
    jsonb_typeof(enrollment_provenance) = 'object'
    AND enrollment_provenance->>'kind' = 'human_operator'
    AND enrollment_provenance->>'surface' = 'operator_takeover'
    AND NULLIF(btrim(enrollment_provenance->>'operatorId'), '') IS NOT NULL
    AND NULLIF(btrim(enrollment_provenance->>'enrolledAt'), '') IS NOT NULL
    AND lower(enrollment_provenance::text) !~ '"(password|cookie|totp|passkey|recovery.?code|access.?token|refresh.?token|private.?key)"'
  ),
  lifecycle_reason TEXT CHECK (
    lifecycle_reason IS NULL OR lifecycle_reason IN (
      'operator_quarantine', 'provider_unhealthy', 'session_unhealthy',
      'operator_delete', 'retention_expired'
    )
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  quarantined_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  UNIQUE (id, workspace_id),
  CHECK (
    (lifecycle_state = 'pending' AND profile_secret_ref IS NULL AND binding_status = 'disabled')
    OR
    (lifecycle_state = 'active' AND profile_secret_ref IS NOT NULL AND binding_status = 'active')
    OR
    (lifecycle_state = 'quarantined' AND profile_secret_ref IS NOT NULL
      AND binding_status = 'disabled' AND quarantined_at IS NOT NULL)
    OR
    (lifecycle_state = 'deleted' AND profile_secret_ref IS NOT NULL
      AND binding_status = 'disabled' AND deleted_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX browser_profile_bindings_identity_idx
  ON rorca.browser_profile_bindings (external_provider, lower(account_alias));
CREATE INDEX browser_profile_bindings_workspace_idx
  ON rorca.browser_profile_bindings (workspace_id, lifecycle_state, external_provider);

CREATE TABLE rorca.authority_provider_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  binding_id UUID NOT NULL,
  workspace_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'enrollment_started', 'enrollment_completed', 'profile_use_denied',
    'profile_quarantined', 'profile_deleted'
  )),
  evidence JSONB NOT NULL CHECK (
    jsonb_typeof(evidence) = 'object'
    AND lower(evidence::text) !~ '"(password|cookie|totp|passkey|recovery.?code|access.?token|refresh.?token|private.?key)"'
  ),
  evidence_digest TEXT NOT NULL CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (binding_id, workspace_id)
    REFERENCES rorca.browser_profile_bindings(id, workspace_id) ON DELETE RESTRICT
);

CREATE INDEX authority_provider_receipts_binding_idx
  ON rorca.authority_provider_receipts (binding_id, occurred_at);

-- BSB-002 extends issuance policy. BSB-001 owns only the minimum core lease
-- identity needed to make profile lifecycle revocation atomic and fail closed.
CREATE TABLE rorca.authority_provider_leases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  binding_id UUID NOT NULL,
  workspace_id TEXT NOT NULL,
  profile_generation INTEGER NOT NULL CHECK (profile_generation > 0),
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'revoked', 'expired', 'uncertain')),
  isolated_runner_id TEXT NOT NULL CHECK (btrim(isolated_runner_id) <> ''),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > issued_at),
  revoked_at TIMESTAMPTZ,
  revocation_reason TEXT,
  FOREIGN KEY (binding_id, workspace_id)
    REFERENCES rorca.browser_profile_bindings(id, workspace_id) ON DELETE RESTRICT,
  CHECK (
    (state = 'active' AND revoked_at IS NULL AND revocation_reason IS NULL)
    OR
    (state <> 'active' AND revoked_at IS NOT NULL AND NULLIF(btrim(revocation_reason), '') IS NOT NULL)
  )
);

CREATE INDEX authority_provider_leases_active_binding_idx
  ON rorca.authority_provider_leases (binding_id, state, expires_at);

CREATE OR REPLACE FUNCTION rorca.enforce_authority_provider_binding_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Provider bindings use retained lifecycle states; hard deletion is forbidden'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.provider_adapter <> OLD.provider_adapter
    OR NEW.workspace_id <> OLD.workspace_id
    OR NEW.external_provider <> OLD.external_provider
    OR NEW.account_alias <> OLD.account_alias
    OR NEW.allowed_origins <> OLD.allowed_origins
    OR NEW.retention_mode <> OLD.retention_mode
    OR NEW.retain_until IS DISTINCT FROM OLD.retain_until
    OR NEW.destruction_policy <> OLD.destruction_policy
    OR NEW.enrollment_provenance <> OLD.enrollment_provenance
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Provider binding identity, origin policy, retention, and provenance are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.lifecycle_state <> 'pending'
    AND (NEW.profile_generation <> OLD.profile_generation
      OR NEW.profile_secret_ref IS DISTINCT FROM OLD.profile_secret_ref) THEN
    RAISE EXCEPTION 'Active profile generation and SecretStore reference are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.lifecycle_state = 'deleted' OR (
    OLD.lifecycle_state = 'quarantined' AND NEW.lifecycle_state <> 'deleted'
  ) OR (
    OLD.lifecycle_state = 'active' AND NEW.lifecycle_state = 'pending'
  ) THEN
    RAISE EXCEPTION 'Invalid provider binding lifecycle transition'
      USING ERRCODE = '55000';
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER browser_profile_bindings_lifecycle_guard
  BEFORE UPDATE OR DELETE ON rorca.browser_profile_bindings
  FOR EACH ROW EXECUTE FUNCTION rorca.enforce_authority_provider_binding_lifecycle();

CREATE OR REPLACE FUNCTION rorca.settle_authority_provider_binding_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  lifecycle_evidence JSONB;
  lifecycle_digest TEXT;
BEGIN
  IF NEW.lifecycle_state NOT IN ('quarantined', 'deleted')
    OR NEW.lifecycle_state = OLD.lifecycle_state THEN
    RETURN NEW;
  END IF;

  UPDATE rorca.authority_provider_leases
     SET state = 'revoked',
         revoked_at = clock_timestamp(),
         revocation_reason = 'profile_' || NEW.lifecycle_state
   WHERE binding_id = NEW.id AND state = 'active';

  lifecycle_evidence := jsonb_build_object(
    'schemaVersion', 'rorca.browser-profile-lifecycle-receipt.v1',
    'bindingId', NEW.id,
    'workspaceId', NEW.workspace_id,
    'provider', NEW.external_provider,
    'accountAlias', NEW.account_alias,
    'profileGeneration', NEW.profile_generation,
    'outcome', NEW.lifecycle_state,
    'reason', NEW.lifecycle_reason,
    'secretMaterial', '[redacted]'
  );
  lifecycle_digest := 'sha256:' || encode(
    rorca.digest(convert_to(lifecycle_evidence::text, 'UTF8'), 'sha256'), 'hex'
  );

  INSERT INTO rorca.authority_provider_receipts (
    binding_id, workspace_id, event_type, evidence, evidence_digest
  ) VALUES (
    NEW.id,
    NEW.workspace_id,
    CASE WHEN NEW.lifecycle_state = 'quarantined'
      THEN 'profile_quarantined' ELSE 'profile_deleted' END,
    lifecycle_evidence,
    lifecycle_digest
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER browser_profile_bindings_lifecycle_settlement
  AFTER UPDATE OF lifecycle_state ON rorca.browser_profile_bindings
  FOR EACH ROW EXECUTE FUNCTION rorca.settle_authority_provider_binding_lifecycle();

CREATE OR REPLACE FUNCTION rorca.enforce_authority_provider_receipt_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Provider authority receipts are append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER authority_provider_receipts_append_only
  BEFORE UPDATE OR DELETE ON rorca.authority_provider_receipts
  FOR EACH ROW EXECUTE FUNCTION rorca.enforce_authority_provider_receipt_append_only();

REVOKE ALL ON TABLE rorca.browser_profile_bindings FROM PUBLIC;
REVOKE ALL ON TABLE rorca.authority_provider_receipts FROM PUBLIC;
REVOKE ALL ON TABLE rorca.authority_provider_leases FROM PUBLIC;

DO $$
DECLARE runtime_user TEXT := current_setting('rorca.runtime_database_user', TRUE);
BEGIN
  IF runtime_user IS NULL OR runtime_user = '' THEN
    RAISE EXCEPTION 'rorca.runtime_database_user must identify the runtime principal';
  END IF;
  EXECUTE format(
    'GRANT SELECT,INSERT,UPDATE ON rorca.browser_profile_bindings TO %I', runtime_user
  );
  EXECUTE format(
    'GRANT SELECT,INSERT ON rorca.authority_provider_receipts TO %I', runtime_user
  );
  EXECUTE format(
    'GRANT SELECT,INSERT,UPDATE ON rorca.authority_provider_leases TO %I', runtime_user
  );
END $$;

COMMENT ON TABLE rorca.browser_profile_bindings IS
  'Core metadata-only ProviderBinding store. Browser profile bytes remain in the separately encrypted SecretStore and are represented only by opaque UUID references.';
COMMENT ON TABLE rorca.authority_provider_receipts IS
  'Append-only redacted browser-profile enrollment, denial, quarantine, and deletion evidence.';
