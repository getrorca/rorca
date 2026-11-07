-- 20260823090200_browser_session_broker_leases.sql
-- BSB-002: expiring, generation-bound browser grants and isolated runner leases.

CREATE TABLE rorca.authority_provider_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  binding_id UUID NOT NULL,
  workspace_id TEXT NOT NULL,
  external_provider TEXT NOT NULL CHECK (external_provider IN ('claude', 'chatgpt')),
  run_id TEXT NOT NULL CHECK (btrim(run_id) <> ''),
  story_id TEXT NOT NULL CHECK (btrim(story_id) <> ''),
  purpose TEXT NOT NULL CHECK (btrim(purpose) <> ''),
  profile_generation INTEGER NOT NULL CHECK (profile_generation > 0),
  allowed_origins TEXT[] NOT NULL CHECK (
    cardinality(allowed_origins) BETWEEN 1 AND 32
    AND array_position(allowed_origins, NULL) IS NULL
  ),
  allowed_actions TEXT[] NOT NULL CHECK (
    cardinality(allowed_actions) BETWEEN 1 AND 7
    AND array_position(allowed_actions, NULL) IS NULL
    AND allowed_actions <@ ARRAY['navigate', 'click', 'fill', 'select', 'check', 'readText', 'upload']::TEXT[]
  ),
  maximum_concurrent_runners INTEGER NOT NULL
    CHECK (maximum_concurrent_runners BETWEEN 1 AND 16),
  evidence_contract JSONB NOT NULL CHECK (
    jsonb_typeof(evidence_contract) = 'object'
    AND evidence_contract->>'redaction' = 'required'
    AND lower(evidence_contract::text) !~ '"(password|cookie|totp|passkey|recovery.?code|access.?token|refresh.?token|private.?key)"'
  ),
  retention_mode TEXT NOT NULL CHECK (retention_mode IN ('preserve', 'quarantine', 'destroy')),
  retain_until TIMESTAMPTZ,
  destruction_policy TEXT NOT NULL
    CHECK (destruction_policy IN ('operator_delete', 'delete_after_retention')),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked', 'expired')),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > issued_at),
  revoked_at TIMESTAMPTZ,
  revocation_reason TEXT,
  UNIQUE (id, binding_id, workspace_id, profile_generation),
  FOREIGN KEY (binding_id, workspace_id)
    REFERENCES rorca.browser_profile_bindings(id, workspace_id) ON DELETE RESTRICT,
  CHECK (
    (state = 'active' AND revoked_at IS NULL AND revocation_reason IS NULL)
    OR
    (state IN ('revoked', 'expired') AND revoked_at IS NOT NULL
      AND NULLIF(btrim(revocation_reason), '') IS NOT NULL)
  )
);

CREATE INDEX authority_provider_grants_binding_state_idx
  ON rorca.authority_provider_grants (binding_id, state, expires_at);
CREATE INDEX authority_provider_grants_run_story_idx
  ON rorca.authority_provider_grants (workspace_id, run_id, story_id, state);

-- The BSB-001 lease relation deliberately carried only lifecycle-revocation
-- identity. Fence any legacy reservation as uncertain and preserve it through a
-- one-to-one revoked legacy grant before making the complete bindings mandatory.
UPDATE rorca.authority_provider_leases
   SET state = 'uncertain',
       revoked_at = COALESCE(revoked_at, clock_timestamp()),
       revocation_reason = COALESCE(revocation_reason, 'legacy_lease_requires_reconciliation')
 WHERE state = 'active';

INSERT INTO rorca.authority_provider_grants (
  id, binding_id, workspace_id, external_provider, run_id, story_id, purpose,
  profile_generation, allowed_origins, allowed_actions, maximum_concurrent_runners,
  evidence_contract, retention_mode, retain_until, destruction_policy, state,
  issued_at, expires_at, revoked_at, revocation_reason
)
SELECT l.id,
       l.binding_id,
       l.workspace_id,
       b.external_provider,
       'legacy-unbound:' || l.id::TEXT,
       'legacy-unbound',
       'legacy-profile-lifecycle-reservation',
       l.profile_generation,
       b.allowed_origins,
       ARRAY['navigate']::TEXT[],
       1,
       jsonb_build_object(
         'schemaVersion', 'rorca.browser-session-evidence.v1',
         'requiredEvidence', jsonb_build_array('security_event'),
         'redaction', 'required'
       ),
       b.retention_mode,
       b.retain_until,
       b.destruction_policy,
       'revoked',
       l.issued_at,
       l.expires_at,
       COALESCE(l.revoked_at, l.issued_at),
       COALESCE(l.revocation_reason, 'legacy_lease_requires_reconciliation')
  FROM rorca.authority_provider_leases l
  JOIN rorca.browser_profile_bindings b
    ON b.id = l.binding_id AND b.workspace_id = l.workspace_id;

ALTER TABLE rorca.authority_provider_leases
  ADD COLUMN grant_id UUID,
  ADD COLUMN external_provider TEXT,
  ADD COLUMN run_id TEXT,
  ADD COLUMN story_id TEXT,
  ADD COLUMN purpose TEXT,
  ADD COLUMN allowed_origins TEXT[],
  ADD COLUMN allowed_actions TEXT[],
  ADD COLUMN maximum_concurrent_runners INTEGER,
  ADD COLUMN evidence_contract JSONB,
  ADD COLUMN retention_mode TEXT,
  ADD COLUMN retain_until TIMESTAMPTZ,
  ADD COLUMN destruction_policy TEXT,
  ADD COLUMN last_heartbeat_at TIMESTAMPTZ;

UPDATE rorca.authority_provider_leases l
   SET grant_id = g.id,
       external_provider = g.external_provider,
       run_id = g.run_id,
       story_id = g.story_id,
       purpose = g.purpose,
       allowed_origins = g.allowed_origins,
       allowed_actions = g.allowed_actions,
       maximum_concurrent_runners = g.maximum_concurrent_runners,
       evidence_contract = g.evidence_contract,
       retention_mode = g.retention_mode,
       retain_until = g.retain_until,
       destruction_policy = g.destruction_policy,
       last_heartbeat_at = l.issued_at
  FROM rorca.authority_provider_grants g
 WHERE g.id = l.id;

ALTER TABLE rorca.authority_provider_leases
  ALTER COLUMN grant_id SET NOT NULL,
  ALTER COLUMN external_provider SET NOT NULL,
  ALTER COLUMN run_id SET NOT NULL,
  ALTER COLUMN story_id SET NOT NULL,
  ALTER COLUMN purpose SET NOT NULL,
  ALTER COLUMN allowed_origins SET NOT NULL,
  ALTER COLUMN allowed_actions SET NOT NULL,
  ALTER COLUMN maximum_concurrent_runners SET NOT NULL,
  ALTER COLUMN evidence_contract SET NOT NULL,
  ALTER COLUMN retention_mode SET NOT NULL,
  ALTER COLUMN destruction_policy SET NOT NULL,
  ALTER COLUMN last_heartbeat_at SET NOT NULL;

ALTER TABLE rorca.authority_provider_leases
  DROP CONSTRAINT IF EXISTS authority_provider_leases_state_check,
  DROP CONSTRAINT IF EXISTS authority_provider_leases_check,
  DROP CONSTRAINT IF EXISTS authority_provider_leases_check1;

ALTER TABLE rorca.authority_provider_leases
  ADD CONSTRAINT authority_provider_leases_state_check CHECK (
    state IN ('provisioning', 'active', 'revoked', 'expired', 'uncertain')
  ),
  ADD CONSTRAINT authority_provider_leases_expiry_check CHECK (expires_at > issued_at),
  ADD CONSTRAINT authority_provider_leases_terminal_check CHECK (
    (state IN ('provisioning', 'active') AND revoked_at IS NULL AND revocation_reason IS NULL)
    OR
    (state IN ('revoked', 'expired', 'uncertain') AND revoked_at IS NOT NULL
      AND NULLIF(btrim(revocation_reason), '') IS NOT NULL)
  ),
  ADD CONSTRAINT authority_provider_leases_provider_check CHECK (
    external_provider IN ('claude', 'chatgpt')
  ),
  ADD CONSTRAINT authority_provider_leases_identity_check CHECK (
    btrim(run_id) <> '' AND btrim(story_id) <> '' AND btrim(purpose) <> ''
  ),
  ADD CONSTRAINT authority_provider_leases_origin_policy_check CHECK (
    cardinality(allowed_origins) BETWEEN 1 AND 32
    AND array_position(allowed_origins, NULL) IS NULL
  ),
  ADD CONSTRAINT authority_provider_leases_action_policy_check CHECK (
    cardinality(allowed_actions) BETWEEN 1 AND 7
    AND array_position(allowed_actions, NULL) IS NULL
    AND allowed_actions <@ ARRAY['navigate', 'click', 'fill', 'select', 'check', 'readText', 'upload']::TEXT[]
  ),
  ADD CONSTRAINT authority_provider_leases_concurrency_check CHECK (
    maximum_concurrent_runners BETWEEN 1 AND 16
  ),
  ADD CONSTRAINT authority_provider_leases_evidence_check CHECK (
    jsonb_typeof(evidence_contract) = 'object'
    AND evidence_contract->>'redaction' = 'required'
    AND lower(evidence_contract::text) !~ '"(password|cookie|totp|passkey|recovery.?code|access.?token|refresh.?token|private.?key)"'
  ),
  ADD CONSTRAINT authority_provider_leases_retention_check CHECK (
    retention_mode IN ('preserve', 'quarantine', 'destroy')
    AND destruction_policy IN ('operator_delete', 'delete_after_retention')
  ),
  ADD CONSTRAINT authority_provider_leases_heartbeat_check CHECK (
    last_heartbeat_at >= issued_at AND last_heartbeat_at <= expires_at
  ),
  ADD CONSTRAINT authority_provider_leases_grant_fk FOREIGN KEY (
    grant_id, binding_id, workspace_id, profile_generation
  ) REFERENCES rorca.authority_provider_grants (
    id, binding_id, workspace_id, profile_generation
  ) ON DELETE RESTRICT;

CREATE INDEX authority_provider_leases_grant_state_idx
  ON rorca.authority_provider_leases (grant_id, state, expires_at);
CREATE INDEX authority_provider_leases_heartbeat_idx
  ON rorca.authority_provider_leases (binding_id, state, last_heartbeat_at);
CREATE UNIQUE INDEX authority_provider_leases_runner_identity_idx
  ON rorca.authority_provider_leases (isolated_runner_id);

ALTER TABLE rorca.authority_provider_receipts
  DROP CONSTRAINT authority_provider_receipts_event_type_check;
ALTER TABLE rorca.authority_provider_receipts
  ADD CONSTRAINT authority_provider_receipts_event_type_check CHECK (event_type IN (
    'enrollment_started', 'enrollment_completed', 'profile_use_denied',
    'profile_quarantined', 'profile_deleted',
    'browser_lease_requested', 'browser_lease_issued', 'browser_security_denied',
    'browser_lease_revoked', 'browser_lease_uncertain', 'browser_lease_reconciled'
  ));

CREATE OR REPLACE FUNCTION rorca.enforce_authority_provider_grant_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Browser authority grants are retained; hard deletion is forbidden'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.binding_id <> OLD.binding_id
    OR NEW.workspace_id <> OLD.workspace_id
    OR NEW.external_provider <> OLD.external_provider
    OR NEW.run_id <> OLD.run_id
    OR NEW.story_id <> OLD.story_id
    OR NEW.purpose <> OLD.purpose
    OR NEW.profile_generation <> OLD.profile_generation
    OR NEW.allowed_origins <> OLD.allowed_origins
    OR NEW.allowed_actions <> OLD.allowed_actions
    OR NEW.maximum_concurrent_runners <> OLD.maximum_concurrent_runners
    OR NEW.expires_at <> OLD.expires_at
    OR NEW.evidence_contract <> OLD.evidence_contract
    OR NEW.retention_mode <> OLD.retention_mode
    OR NEW.retain_until IS DISTINCT FROM OLD.retain_until
    OR NEW.destruction_policy <> OLD.destruction_policy
    OR NEW.issued_at <> OLD.issued_at THEN
    RAISE EXCEPTION 'Browser authority grant bindings and policy are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.state IN ('revoked', 'expired') AND NEW.state <> OLD.state THEN
    RAISE EXCEPTION 'Terminal browser authority grant state is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER authority_provider_grants_lifecycle_guard
  BEFORE UPDATE OR DELETE ON rorca.authority_provider_grants
  FOR EACH ROW EXECUTE FUNCTION rorca.enforce_authority_provider_grant_lifecycle();

CREATE OR REPLACE FUNCTION rorca.enforce_authority_provider_lease_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Browser authority leases are retained; hard deletion is forbidden'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.grant_id <> OLD.grant_id
    OR NEW.binding_id <> OLD.binding_id
    OR NEW.workspace_id <> OLD.workspace_id
    OR NEW.external_provider <> OLD.external_provider
    OR NEW.run_id <> OLD.run_id
    OR NEW.story_id <> OLD.story_id
    OR NEW.purpose <> OLD.purpose
    OR NEW.profile_generation <> OLD.profile_generation
    OR NEW.allowed_origins <> OLD.allowed_origins
    OR NEW.allowed_actions <> OLD.allowed_actions
    OR NEW.maximum_concurrent_runners <> OLD.maximum_concurrent_runners
    OR NEW.evidence_contract <> OLD.evidence_contract
    OR NEW.retention_mode <> OLD.retention_mode
    OR NEW.retain_until IS DISTINCT FROM OLD.retain_until
    OR NEW.destruction_policy <> OLD.destruction_policy
    OR NEW.isolated_runner_id <> OLD.isolated_runner_id
    OR NEW.issued_at <> OLD.issued_at
    OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'Browser authority lease bindings and policy are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.last_heartbeat_at < OLD.last_heartbeat_at THEN
    RAISE EXCEPTION 'Browser authority lease heartbeat cannot move backwards'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.state IN ('revoked', 'expired') AND NEW.state <> OLD.state THEN
    RAISE EXCEPTION 'Terminal browser authority lease state is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'uncertain' AND NEW.state NOT IN ('uncertain', 'revoked') THEN
    RAISE EXCEPTION 'Uncertain browser authority lease requires reconciliation or revocation'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER authority_provider_leases_lifecycle_guard
  BEFORE UPDATE OR DELETE ON rorca.authority_provider_leases
  FOR EACH ROW EXECUTE FUNCTION rorca.enforce_authority_provider_lease_lifecycle();

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

  UPDATE rorca.authority_provider_grants
     SET state = 'revoked',
         revoked_at = clock_timestamp(),
         revocation_reason = 'profile_' || NEW.lifecycle_state
   WHERE binding_id = NEW.id AND state = 'active';

  UPDATE rorca.authority_provider_leases
     SET state = 'revoked',
         revoked_at = clock_timestamp(),
         revocation_reason = 'profile_' || NEW.lifecycle_state
   WHERE binding_id = NEW.id AND state IN ('provisioning', 'active', 'uncertain');

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

REVOKE ALL ON TABLE rorca.authority_provider_grants FROM PUBLIC;

DO $$
DECLARE runtime_user TEXT := current_setting('rorca.runtime_database_user', TRUE);
BEGIN
  IF runtime_user IS NULL OR runtime_user = '' THEN
    RAISE EXCEPTION 'rorca.runtime_database_user must identify the runtime principal';
  END IF;
  EXECUTE format(
    'GRANT SELECT,INSERT,UPDATE ON rorca.authority_provider_grants TO %I', runtime_user
  );
END $$;

COMMENT ON TABLE rorca.authority_provider_grants IS
  'Immutable browser-session authority scope binding one run, story, purpose, profile generation, exact origins/actions, concurrency, expiry, evidence, and retention policy.';
COMMENT ON TABLE rorca.authority_provider_leases IS
  'Expiring isolated-runner leases. No encrypted profile reference, raw profile path, cookie, or authentication material is stored.';
