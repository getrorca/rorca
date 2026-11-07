-- SCR-004: Provider-neutral credential rollback, emergency, and status-reconciliation
-- receipts. These relations persist only fingerprints, references, bounded evidence,
-- and immutable authority constraints; credential values remain in SecretStore.

CREATE TABLE rorca.provider_credential_rotation_rollbacks (
  receipt_id UUID PRIMARY KEY,
  rotation_intent_id UUID NOT NULL UNIQUE
    REFERENCES rorca.provider_credential_rotation_intents(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider ~ '^[a-z][a-z0-9-]{0,63}$'),
  binding_id UUID NOT NULL REFERENCES rorca.provider_credential_bindings(id) ON DELETE RESTRICT,
  replacement_binding_id UUID NOT NULL UNIQUE,
  intent_digest TEXT NOT NULL UNIQUE CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  prior_fingerprint TEXT NOT NULL CHECK (prior_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  replacement_fingerprint TEXT NOT NULL CHECK (replacement_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  target_binding_reference TEXT NOT NULL CHECK (
    btrim(target_binding_reference) <> '' AND length(target_binding_reference) <= 2048
  ),
  disposition TEXT NOT NULL CHECK (disposition IN ('ROLLED_BACK', 'MANUAL_RECONCILIATION')),
  receipt_payload JSONB NOT NULL CHECK (jsonb_typeof(receipt_payload) = 'object'),
  settled_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT provider_credential_rollback_distinct_fingerprints CHECK (
    prior_fingerprint <> replacement_fingerprint
  ),
  CONSTRAINT provider_credential_rollback_payload_identity CHECK (
    receipt_payload->>'receiptId' = receipt_id::TEXT
    AND receipt_payload->>'intentId' = rotation_intent_id::TEXT
    AND receipt_payload->>'workspaceId' = workspace_id
    AND receipt_payload->>'bindingId' = binding_id::TEXT
    AND receipt_payload->>'replacementBindingId' = replacement_binding_id::TEXT
    AND receipt_payload->>'intentDigest' = intent_digest
    AND receipt_payload->>'priorFingerprint' = prior_fingerprint
    AND receipt_payload->>'replacementFingerprint' = replacement_fingerprint
    AND receipt_payload->>'targetBindingReference' = target_binding_reference
    AND receipt_payload->>'disposition' = disposition
    AND (receipt_payload->>'settledAt')::TIMESTAMPTZ = settled_at
    AND receipt_payload->>'replacementSecretStatus' = 'quarantined'
  )
);

CREATE INDEX provider_credential_rotation_rollbacks_workspace_idx
  ON rorca.provider_credential_rotation_rollbacks (workspace_id, settled_at DESC);

CREATE TABLE rorca.provider_credential_emergency_requests (
  request_id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider ~ '^[a-z][a-z0-9-]{0,63}$'),
  binding_id UUID NOT NULL REFERENCES rorca.provider_credential_bindings(id) ON DELETE RESTRICT,
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  mode TEXT NOT NULL CHECK (mode IN ('test', 'live')),
  evidence_reference TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state = 'AWAITING_DASHBOARD_AUTHENTICATION'),
  request_payload JSONB NOT NULL CHECK (jsonb_typeof(request_payload) = 'object'),
  requested_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT provider_credential_emergency_evidence_key UNIQUE (provider, evidence_reference),
  CONSTRAINT provider_credential_emergency_payload_identity CHECK (
    request_payload->>'requestId' = request_id::TEXT
    AND request_payload->>'workspaceId' = workspace_id
    AND request_payload->>'bindingId' = binding_id::TEXT
    AND request_payload->>'fingerprint' = fingerprint
    AND request_payload->>'mode' = mode
    AND request_payload->>'state' = state
    AND request_payload->'evidence'->>'providerRequestReference' = evidence_reference
    AND (request_payload->>'requestedAt')::TIMESTAMPTZ = requested_at
    AND request_payload->'authority' = jsonb_build_object(
      'canGrant', false,
      'canBroadenPermissions', false,
      'canCrossWorkspace', false,
      'canCrossMode', false,
      'canInjectSecret', false,
      'requiresDashboardAuthentication', true
    )
  )
);

CREATE INDEX provider_credential_emergency_requests_workspace_state_idx
  ON rorca.provider_credential_emergency_requests (workspace_id, state, requested_at DESC);

CREATE TABLE rorca.provider_credential_status_reconciliations (
  receipt_id UUID PRIMARY KEY,
  rotation_intent_id UUID NOT NULL
    REFERENCES rorca.provider_credential_rotation_intents(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider ~ '^[a-z][a-z0-9-]{0,63}$'),
  binding_id UUID NOT NULL REFERENCES rorca.provider_credential_bindings(id) ON DELETE RESTRICT,
  evidence_digest TEXT NOT NULL CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  disposition TEXT NOT NULL CHECK (disposition IN ('PROVIDER_READBACK_RESOLVED', 'MANUAL_RECONCILIATION')),
  retry_allowed BOOLEAN NOT NULL,
  receipt_payload JSONB NOT NULL CHECK (jsonb_typeof(receipt_payload) = 'object'),
  reconciled_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT provider_credential_status_reconciliation_evidence_key UNIQUE (
    rotation_intent_id, evidence_digest
  ),
  CONSTRAINT provider_credential_status_reconciliation_payload_identity CHECK (
    receipt_payload->>'receiptId' = receipt_id::TEXT
    AND receipt_payload->>'intentId' = rotation_intent_id::TEXT
    AND receipt_payload->>'workspaceId' = workspace_id
    AND receipt_payload->>'bindingId' = binding_id::TEXT
    AND receipt_payload->>'evidenceDigest' = evidence_digest
    AND receipt_payload->>'disposition' = disposition
    AND (receipt_payload->>'retryAllowed')::BOOLEAN = retry_allowed
    AND (receipt_payload->>'reconciledAt')::TIMESTAMPTZ = reconciled_at
  ),
  CONSTRAINT provider_credential_status_reconciliation_retry_guard CHECK (
    retry_allowed = (disposition = 'PROVIDER_READBACK_RESOLVED')
  )
);

CREATE INDEX provider_credential_status_reconciliations_workspace_idx
  ON rorca.provider_credential_status_reconciliations (workspace_id, reconciled_at DESC);

CREATE OR REPLACE FUNCTION rorca.guard_provider_credential_failure_receipt()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'provider credential failure receipts are audit-retained and immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION rorca.reject_provider_credential_failure_value()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF to_jsonb(NEW)::TEXT ~ '(^|[^[:alnum:]])((sk|rk)_(test|live)_[[:alnum:]]{8,}|whsec_[[:alnum:]]{8,})' THEN
    RAISE EXCEPTION 'credential-shaped values are forbidden in provider credential failure evidence';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION rorca.guard_provider_credential_emergency_request()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM rorca.provider_credential_bindings binding
     WHERE binding.id = NEW.binding_id
       AND binding.workspace_id = NEW.workspace_id
       AND binding.provider = NEW.provider
       AND binding.mode = NEW.mode
       AND binding.fingerprint = NEW.fingerprint
       AND binding.status = 'active'
       AND binding.credential_class = 'restricted_api_key'
       AND NEW.request_payload->>'accountId' = binding.provider_account_id
       AND NEW.request_payload->'affectedResource'->>'applicationId' = binding.application_id
       AND NEW.request_payload->'affectedResource'->>'resourceType' = binding.resource_type
       AND NEW.request_payload->'affectedResource'->>'resourceId' = binding.resource_id
       AND NEW.request_payload->'evidence'->>'targetBindingReference' = binding.target_binding_reference
       AND binding.permission_manifest @> (NEW.request_payload->'permissionManifest')
       AND NEW.request_payload->'permissionManifest' @> binding.permission_manifest
       AND binding.permission_manifest ? (NEW.request_payload->'evidence'->>'operation')
       AND NEW.request_payload->'evidence'->>'providerHttpStatus' = '401'
  ) THEN
    RAISE EXCEPTION 'emergency request cannot change binding scope, mode, permissions, or authority';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER provider_credential_rotation_rollback_immutable
  BEFORE UPDATE OR DELETE ON rorca.provider_credential_rotation_rollbacks
  FOR EACH ROW EXECUTE FUNCTION rorca.guard_provider_credential_failure_receipt();
CREATE TRIGGER provider_credential_rotation_rollback_no_values
  BEFORE INSERT OR UPDATE ON rorca.provider_credential_rotation_rollbacks
  FOR EACH ROW EXECUTE FUNCTION rorca.reject_provider_credential_failure_value();

CREATE TRIGGER provider_credential_emergency_request_exact_authority
  BEFORE INSERT ON rorca.provider_credential_emergency_requests
  FOR EACH ROW EXECUTE FUNCTION rorca.guard_provider_credential_emergency_request();

CREATE TRIGGER provider_credential_emergency_request_immutable
  BEFORE UPDATE OR DELETE ON rorca.provider_credential_emergency_requests
  FOR EACH ROW EXECUTE FUNCTION rorca.guard_provider_credential_failure_receipt();
CREATE TRIGGER provider_credential_emergency_request_no_values
  BEFORE INSERT OR UPDATE ON rorca.provider_credential_emergency_requests
  FOR EACH ROW EXECUTE FUNCTION rorca.reject_provider_credential_failure_value();

CREATE TRIGGER provider_credential_status_reconciliation_immutable
  BEFORE UPDATE OR DELETE ON rorca.provider_credential_status_reconciliations
  FOR EACH ROW EXECUTE FUNCTION rorca.guard_provider_credential_failure_receipt();
CREATE TRIGGER provider_credential_status_reconciliation_no_values
  BEFORE INSERT OR UPDATE ON rorca.provider_credential_status_reconciliations
  FOR EACH ROW EXECUTE FUNCTION rorca.reject_provider_credential_failure_value();

ALTER TABLE rorca.provider_credential_rotation_rollbacks ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.provider_credential_rotation_rollbacks FORCE ROW LEVEL SECURITY;
ALTER TABLE rorca.provider_credential_emergency_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.provider_credential_emergency_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE rorca.provider_credential_status_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.provider_credential_status_reconciliations FORCE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE rorca.provider_credential_rotation_rollbacks FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE rorca.provider_credential_emergency_requests FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE rorca.provider_credential_status_reconciliations FROM PUBLIC;
REVOKE ALL ON FUNCTION rorca.guard_provider_credential_failure_receipt() FROM PUBLIC;
REVOKE ALL ON FUNCTION rorca.reject_provider_credential_failure_value() FROM PUBLIC;
REVOKE ALL ON FUNCTION rorca.guard_provider_credential_emergency_request() FROM PUBLIC;

DO $$
DECLARE
  runtime_user TEXT := current_setting('rorca.runtime_database_user', TRUE);
  writer_user TEXT := current_setting('rorca.canonical_writer_database_user', TRUE);
  table_name TEXT;
BEGIN
  IF runtime_user IS NULL OR runtime_user = ''
     OR NOT EXISTS (
       SELECT 1 FROM rorca.wave2_database_principals
       WHERE database_user = runtime_user AND principal_class = 'internal_runtime'
     ) THEN
    RAISE EXCEPTION 'registered credential-failure runtime principal is required' USING ERRCODE = '42501';
  END IF;
  IF writer_user IS NULL OR writer_user = '' OR writer_user = runtime_user
     OR NOT EXISTS (
       SELECT 1 FROM rorca.wave2_database_principals
       WHERE database_user = writer_user AND principal_class = 'canonical_writer'
     ) THEN
    RAISE EXCEPTION 'registered distinct credential-failure canonical writer is required' USING ERRCODE = '42501';
  END IF;

  FOREACH table_name IN ARRAY ARRAY[
    'provider_credential_rotation_rollbacks',
    'provider_credential_emergency_requests',
    'provider_credential_status_reconciliations'
  ] LOOP
    EXECUTE format('GRANT SELECT ON TABLE rorca.%I TO %I', table_name, runtime_user);
    EXECUTE format('GRANT SELECT, INSERT ON TABLE rorca.%I TO %I', table_name, writer_user);
    EXECUTE format(
      'CREATE POLICY %I ON rorca.%I FOR SELECT TO %I USING (current_user = %L)',
      table_name || '_runtime_read', table_name, runtime_user, runtime_user
    );
    EXECUTE format(
      'CREATE POLICY %I ON rorca.%I FOR ALL TO %I USING (current_user = %L) WITH CHECK (current_user = %L)',
      table_name || '_writer_insert', table_name, writer_user, writer_user, writer_user
    );
  END LOOP;

  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.guard_provider_credential_failure_receipt() TO %I', writer_user);
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.reject_provider_credential_failure_value() TO %I', writer_user);
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.guard_provider_credential_emergency_request() TO %I', writer_user);
END;
$$;
