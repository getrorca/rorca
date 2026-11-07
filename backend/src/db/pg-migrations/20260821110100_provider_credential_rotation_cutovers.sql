-- SCR-003: Provider-neutral credential cutover execution state. This table stores
-- fingerprints, references, provider request receipts, and exact grace expiry;
-- credential values remain exclusively in provider_credential_secret_objects.

-- A target reference identifies a runtime slot, not one immutable generation.
-- Keep exactly one active generation while retaining revoked rotation history.
ALTER TABLE rorca.provider_credential_bindings
  DROP CONSTRAINT provider_credential_binding_target_reference_key;

CREATE UNIQUE INDEX provider_credential_binding_active_target_reference_key
  ON rorca.provider_credential_bindings (provider, target_binding_reference)
  WHERE status = 'active';

ALTER TABLE rorca.provider_credential_secret_objects
  DROP CONSTRAINT provider_credential_secret_objects_status_check;
ALTER TABLE rorca.provider_credential_secret_objects
  ADD CONSTRAINT provider_credential_secret_objects_status_check
  CHECK (status IN ('captured', 'active', 'quarantined', 'revoked'));

CREATE TABLE rorca.provider_credential_rotation_cutovers (
  rotation_intent_id UUID PRIMARY KEY
    REFERENCES rorca.provider_credential_rotation_intents(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider ~ '^[a-z][a-z0-9-]{0,63}$'),
  binding_id UUID NOT NULL REFERENCES rorca.provider_credential_bindings(id) ON DELETE RESTRICT,
  replacement_binding_id UUID NOT NULL UNIQUE,
  intent_digest TEXT NOT NULL UNIQUE CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  target_binding_reference TEXT NOT NULL CHECK (
    btrim(target_binding_reference) <> '' AND length(target_binding_reference) <= 2048
  ),
  prior_fingerprint TEXT NOT NULL CHECK (prior_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  replacement_fingerprint TEXT NOT NULL CHECK (replacement_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK (state IN (
    'READY_FOR_STAGING', 'GRACE_PERIOD', 'WAITING_FOR_REVOCATION', 'COMPLETED'
  )),
  state_payload JSONB NOT NULL CHECK (jsonb_typeof(state_payload) = 'object'),
  grace_expires_at TIMESTAMPTZ,
  revocation_evidence_digest TEXT CHECK (
    revocation_evidence_digest IS NULL
    OR revocation_evidence_digest ~ '^sha256:[0-9a-f]{64}$'
  ),
  revocation_evidence_reference TEXT UNIQUE CHECK (
    revocation_evidence_reference IS NULL
    OR revocation_evidence_reference ~ '^stripe-dashboard-revocation://rorca/[0-9a-f-]{36}$'
  ),
  initialized_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT provider_credential_cutover_distinct_fingerprints CHECK (
    prior_fingerprint <> replacement_fingerprint
  ),
  CONSTRAINT provider_credential_cutover_payload_identity CHECK (
    state_payload->>'intentId' = rotation_intent_id::TEXT
    AND state_payload->>'workspaceId' = workspace_id
    AND state_payload->>'bindingId' = binding_id::TEXT
    AND state_payload->>'replacementBindingId' = replacement_binding_id::TEXT
    AND state_payload->>'intentDigest' = intent_digest
    AND state_payload->>'targetBindingReference' = target_binding_reference
    AND state_payload->>'priorFingerprint' = prior_fingerprint
    AND state_payload->>'replacementFingerprint' = replacement_fingerprint
    AND state_payload->>'state' = state
  ),
  CONSTRAINT provider_credential_cutover_lifecycle_consistency CHECK (
    (state = 'READY_FOR_STAGING'
      AND grace_expires_at IS NULL
      AND revocation_evidence_digest IS NULL
      AND revocation_evidence_reference IS NULL
      AND completed_at IS NULL
      AND state_payload->>'priorCredentialStatus' = 'active')
    OR
    (state IN ('GRACE_PERIOD', 'WAITING_FOR_REVOCATION')
      AND grace_expires_at IS NOT NULL
      AND (state_payload->>'graceExpiresAt')::TIMESTAMPTZ = grace_expires_at
      AND revocation_evidence_digest IS NULL
      AND revocation_evidence_reference IS NULL
      AND completed_at IS NULL
      AND state_payload->>'priorCredentialStatus' = 'active')
    OR
    (state = 'COMPLETED'
      AND grace_expires_at IS NOT NULL
      AND (state_payload->>'graceExpiresAt')::TIMESTAMPTZ = grace_expires_at
      AND revocation_evidence_digest IS NOT NULL
      AND state_payload->>'revocationEvidenceDigest' = revocation_evidence_digest
      AND revocation_evidence_reference IS NOT NULL
      AND state_payload->>'revocationEvidenceReference' = revocation_evidence_reference
      AND completed_at IS NOT NULL
      AND (state_payload->>'completedAt')::TIMESTAMPTZ = completed_at
      AND state_payload->>'priorCredentialStatus' = 'revoked'
      AND state_payload->'oldKeyRejection'->>'result' = 'authentication_rejected')
  )
);

CREATE INDEX provider_credential_rotation_cutovers_workspace_state_idx
  ON rorca.provider_credential_rotation_cutovers (workspace_id, state, updated_at DESC);

CREATE OR REPLACE FUNCTION rorca.guard_provider_credential_rotation_cutover()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'provider credential cutover receipts are audit-retained';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'READY_FOR_STAGING'
       OR NOT EXISTS (
         SELECT 1
           FROM rorca.provider_credential_rotation_intents intent
          WHERE intent.id = NEW.rotation_intent_id
            AND intent.workspace_id = NEW.workspace_id
            AND intent.provider = NEW.provider
            AND intent.binding_id = NEW.binding_id
            AND intent.intent_digest = NEW.intent_digest
            AND intent.current_fingerprint = NEW.prior_fingerprint
            AND intent.target_binding_reference = NEW.target_binding_reference
            AND intent.mode = 'test'
            AND intent.state = 'READY_FOR_STAGING'
            AND intent.capture_result->>'fingerprint' = NEW.replacement_fingerprint
       ) THEN
      RAISE EXCEPTION 'provider credential cutover does not match one captured test-mode intent';
    END IF;
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - ARRAY[
        'state', 'state_payload', 'grace_expires_at',
        'revocation_evidence_digest', 'revocation_evidence_reference',
        'completed_at', 'updated_at'
      ]::TEXT[])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY[
        'state', 'state_payload', 'grace_expires_at',
        'revocation_evidence_digest', 'revocation_evidence_reference',
        'completed_at', 'updated_at'
      ]::TEXT[]) THEN
    RAISE EXCEPTION 'provider credential cutover identity is immutable';
  END IF;

  IF NOT (
    (OLD.state = 'READY_FOR_STAGING' AND NEW.state = 'GRACE_PERIOD')
    OR (OLD.state = 'GRACE_PERIOD' AND NEW.state = 'WAITING_FOR_REVOCATION')
    OR (OLD.state = 'WAITING_FOR_REVOCATION' AND NEW.state = 'COMPLETED')
  ) THEN
    RAISE EXCEPTION 'provider credential cutover transition is invalid';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION rorca.reject_provider_credential_cutover_value()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  inspected TEXT;
BEGIN
  inspected := concat_ws(' ', NEW.target_binding_reference, NEW.state_payload::TEXT,
                          COALESCE(NEW.revocation_evidence_reference, ''));
  IF inspected ~ '(^|[^[:alnum:]])((sk|rk)_(test|live)_[[:alnum:]]{8,}|whsec_[[:alnum:]]{8,})' THEN
    RAISE EXCEPTION 'credential-shaped values are forbidden in provider cutover metadata';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER provider_credential_rotation_cutover_guard
  BEFORE INSERT OR UPDATE OR DELETE ON rorca.provider_credential_rotation_cutovers
  FOR EACH ROW EXECUTE FUNCTION rorca.guard_provider_credential_rotation_cutover();

CREATE TRIGGER provider_credential_rotation_cutover_no_values
  BEFORE INSERT OR UPDATE ON rorca.provider_credential_rotation_cutovers
  FOR EACH ROW EXECUTE FUNCTION rorca.reject_provider_credential_cutover_value();

ALTER TABLE rorca.provider_credential_rotation_cutovers ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.provider_credential_rotation_cutovers FORCE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE rorca.provider_credential_rotation_cutovers FROM PUBLIC;
REVOKE ALL ON FUNCTION rorca.guard_provider_credential_rotation_cutover() FROM PUBLIC;
REVOKE ALL ON FUNCTION rorca.reject_provider_credential_cutover_value() FROM PUBLIC;

DO $$
DECLARE
  runtime_user TEXT := current_setting('rorca.runtime_database_user', TRUE);
  writer_user TEXT := current_setting('rorca.canonical_writer_database_user', TRUE);
BEGIN
  IF runtime_user IS NULL OR runtime_user = ''
     OR NOT EXISTS (
       SELECT 1 FROM rorca.wave2_database_principals
       WHERE database_user = runtime_user AND principal_class = 'internal_runtime'
     ) THEN
    RAISE EXCEPTION 'registered credential-cutover runtime principal is required' USING ERRCODE = '42501';
  END IF;
  IF writer_user IS NULL OR writer_user = '' OR writer_user = runtime_user
     OR NOT EXISTS (
       SELECT 1 FROM rorca.wave2_database_principals
       WHERE database_user = writer_user AND principal_class = 'canonical_writer'
     ) THEN
    RAISE EXCEPTION 'registered distinct credential-cutover canonical writer is required' USING ERRCODE = '42501';
  END IF;

  EXECUTE format('GRANT SELECT ON TABLE rorca.provider_credential_rotation_cutovers TO %I', runtime_user);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE rorca.provider_credential_rotation_cutovers TO %I', writer_user);
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.guard_provider_credential_rotation_cutover() TO %I', writer_user);
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.reject_provider_credential_cutover_value() TO %I', writer_user);

  EXECUTE format(
    'CREATE POLICY provider_credential_cutover_runtime_read ON rorca.provider_credential_rotation_cutovers FOR SELECT TO %I USING (current_user = %L)',
    runtime_user,
    runtime_user
  );
  EXECUTE format(
    'CREATE POLICY provider_credential_cutover_writer_mutation ON rorca.provider_credential_rotation_cutovers FOR ALL TO %I USING (current_user = %L) WITH CHECK (current_user = %L)',
    writer_user,
    writer_user,
    writer_user
  );
END;
$$;
