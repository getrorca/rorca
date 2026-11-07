-- SCR-002: Provider-neutral immutable credential-rotation intents and isolated
-- SecretStore objects. Raw provider credentials are accepted only by the
-- canonical-writer SecretStore boundary and persist only as AES-GCM ciphertext.

CREATE TABLE rorca.provider_credential_rotation_intents (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider ~ '^[a-z][a-z0-9-]{0,63}$'),
  binding_id UUID NOT NULL REFERENCES rorca.provider_credential_bindings(id) ON DELETE RESTRICT,
  provider_account_id TEXT NOT NULL CHECK (btrim(provider_account_id) <> '' AND length(provider_account_id) <= 255),
  mode TEXT NOT NULL CHECK (mode IN ('test', 'live')),
  current_fingerprint TEXT NOT NULL CHECK (current_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  permission_manifest JSONB NOT NULL CHECK (
    jsonb_typeof(permission_manifest) = 'array' AND jsonb_array_length(permission_manifest) > 0
  ),
  target_binding_reference TEXT NOT NULL CHECK (
    btrim(target_binding_reference) <> '' AND length(target_binding_reference) <= 2048
  ),
  intent_digest TEXT NOT NULL UNIQUE CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  intent_canonical_bytes BYTEA NOT NULL CHECK (octet_length(intent_canonical_bytes) BETWEEN 2 AND 131072),
  intent_authority_payload JSONB NOT NULL CHECK (jsonb_typeof(intent_authority_payload) = 'object'),
  intent_payload JSONB NOT NULL CHECK (jsonb_typeof(intent_payload) = 'object'),
  approval_digest TEXT NOT NULL CHECK (approval_digest ~ '^sha256:[0-9a-f]{64}$'),
  approval_receipt_id UUID NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('WAITING_FOR_AUTHENTICATION', 'READY_FOR_STAGING')),
  timeout_disposition TEXT NOT NULL DEFAULT 'paused' CHECK (timeout_disposition IN ('paused', 'running')),
  active_timeout_elapsed_ms BIGINT NOT NULL DEFAULT 0 CHECK (active_timeout_elapsed_ms >= 0),
  waiting_started_at TIMESTAMPTZ NOT NULL,
  resumed_at TIMESTAMPTZ,
  resume_count INTEGER NOT NULL DEFAULT 0 CHECK (resume_count IN (0, 1)),
  provider_evidence_digest TEXT CHECK (provider_evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  capture_receipt_reference TEXT UNIQUE CHECK (
    capture_receipt_reference IS NULL
    OR capture_receipt_reference ~ '^credential-capture://rorca/[0-9a-f-]{36}$'
  ),
  capture_result JSONB CHECK (capture_result IS NULL OR jsonb_typeof(capture_result) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT provider_credential_rotation_digest_matches_bytes CHECK (
    intent_digest = 'sha256:' || encode(digest(intent_canonical_bytes, 'sha256'), 'hex')
  ),
  CONSTRAINT provider_credential_rotation_canonical_payload_matches CHECK (
    convert_from(intent_canonical_bytes, 'UTF8')::jsonb = intent_authority_payload
  ),
  CONSTRAINT provider_credential_rotation_approval_matches CHECK (approval_digest = intent_digest),
  CONSTRAINT provider_credential_rotation_payload_identity CHECK (
    intent_payload->>'intentId' = id::TEXT
    AND intent_payload->>'workspaceId' = workspace_id
    AND intent_payload->>'bindingId' = binding_id::TEXT
    AND intent_payload->>'accountId' = provider_account_id
    AND intent_payload->>'mode' = mode
    AND intent_payload->>'currentFingerprint' = current_fingerprint
    AND intent_payload->>'targetBindingReference' = target_binding_reference
    AND intent_payload->>'intentDigest' = intent_digest
    AND intent_payload->>'replacementCredentialClass' = 'restricted_api_key'
    AND intent_payload->>'state' = 'WAITING_FOR_AUTHENTICATION'
    AND intent_payload->'approval'->>'intentDigest' = approval_digest
    AND intent_payload->'approval'->>'authorityReceiptId' = approval_receipt_id::TEXT
    AND intent_payload->'humanSteps' = jsonb_build_object(
      'dashboardReauthentication', 'required',
      'restrictedKeyCreation', 'required',
      'mfaAutomation', 'forbidden',
      'providerControlBypass', 'forbidden'
    )
  ),
  CONSTRAINT provider_credential_rotation_authority_identity CHECK (
    intent_authority_payload->>'workspaceId' = workspace_id
    AND intent_authority_payload->>'bindingId' = binding_id::TEXT
    AND intent_authority_payload->>'accountId' = provider_account_id
    AND intent_authority_payload->>'mode' = mode
    AND intent_authority_payload->>'currentFingerprint' = current_fingerprint
    AND intent_authority_payload->>'targetBindingReference' = target_binding_reference
    AND intent_authority_payload->>'replacementCredentialClass' = 'restricted_api_key'
    AND intent_authority_payload->'permissionManifest' = permission_manifest
  ),
  CONSTRAINT provider_credential_rotation_lifecycle_consistency CHECK (
    (state = 'WAITING_FOR_AUTHENTICATION'
      AND timeout_disposition = 'paused'
      AND resumed_at IS NULL
      AND resume_count = 0
      AND provider_evidence_digest IS NULL
      AND capture_receipt_reference IS NULL
      AND capture_result IS NULL)
    OR
    (state = 'READY_FOR_STAGING'
      AND timeout_disposition = 'running'
      AND resumed_at IS NOT NULL
      AND resume_count = 1
      AND provider_evidence_digest IS NOT NULL
      AND capture_receipt_reference IS NOT NULL
      AND capture_result IS NOT NULL)
  )
);

CREATE INDEX provider_credential_rotation_intents_workspace_state_idx
  ON rorca.provider_credential_rotation_intents (workspace_id, state, created_at DESC);

CREATE TABLE rorca.provider_credential_secret_objects (
  id UUID PRIMARY KEY,
  rotation_intent_id UUID NOT NULL UNIQUE
    REFERENCES rorca.provider_credential_rotation_intents(id) ON DELETE RESTRICT,
  intent_digest TEXT NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider ~ '^[a-z][a-z0-9-]{0,63}$'),
  provider_account_id TEXT NOT NULL CHECK (btrim(provider_account_id) <> '' AND length(provider_account_id) <= 255),
  mode TEXT NOT NULL CHECK (mode IN ('test', 'live')),
  credential_class TEXT NOT NULL CHECK (credential_class IN (
    'restricted_api_key', 'unrestricted_api_key', 'webhook_signing_secret'
  )),
  permission_manifest JSONB NOT NULL CHECK (
    jsonb_typeof(permission_manifest) = 'array' AND jsonb_array_length(permission_manifest) > 0
  ),
  target_binding_reference TEXT NOT NULL CHECK (
    btrim(target_binding_reference) <> '' AND length(target_binding_reference) <= 2048
  ),
  encrypted_value BYTEA NOT NULL CHECK (octet_length(encrypted_value) BETWEEN 1 AND 4096),
  encryption_iv BYTEA NOT NULL CHECK (octet_length(encryption_iv) = 12),
  encryption_auth_tag BYTEA NOT NULL CHECK (octet_length(encryption_auth_tag) = 16),
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  provider_evidence JSONB NOT NULL CHECK (jsonb_typeof(provider_evidence) = 'object'),
  provider_evidence_canonical_bytes BYTEA NOT NULL CHECK (
    octet_length(provider_evidence_canonical_bytes) BETWEEN 2 AND 131072
  ),
  provider_evidence_digest TEXT NOT NULL CHECK (provider_evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  provenance JSONB NOT NULL CHECK (jsonb_typeof(provenance) = 'object'),
  status TEXT NOT NULL CHECK (status IN ('captured', 'quarantined', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT provider_credential_secret_object_fingerprint_key UNIQUE (provider, fingerprint),
  CONSTRAINT provider_credential_secret_object_evidence_key UNIQUE (provider, provider_evidence_digest),
  CONSTRAINT provider_credential_secret_object_evidence_digest CHECK (
    provider_evidence_digest = 'sha256:' || encode(digest(provider_evidence_canonical_bytes, 'sha256'), 'hex')
  ),
  CONSTRAINT provider_credential_secret_object_evidence_payload CHECK (
    convert_from(provider_evidence_canonical_bytes, 'UTF8')::jsonb = provider_evidence
  ),
  CONSTRAINT provider_credential_secret_object_evidence_identity CHECK (
    provider_evidence->>'intentDigest' = intent_digest
    AND provider_evidence->>'workspaceId' = workspace_id
    AND provider_evidence->>'accountId' = provider_account_id
    AND provider_evidence->>'mode' = mode
    AND provider_evidence->>'targetBindingReference' = target_binding_reference
    AND provider_evidence->>'keyKind' = 'restricted'
    AND provider_evidence->'permissionManifest' @> permission_manifest
    AND permission_manifest @> (provider_evidence->'permissionManifest')
    AND provider_evidence->>'replacementFingerprint' = fingerprint
    AND provider_evidence->>'signature' IS NOT NULL
    AND length(provider_evidence->>'signature') >= 40
    AND provenance->>'captureReceiptReference' = 'credential-capture://rorca/' || id::TEXT
    AND provenance->>'providerEvidenceId' = provider_evidence->>'evidenceId'
    AND provenance->>'targetBindingReference' = target_binding_reference
  )
);

CREATE OR REPLACE FUNCTION rorca.guard_provider_credential_rotation_intent()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'provider credential rotation intents are audit-retained';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM rorca.provider_credential_bindings binding
       WHERE binding.id = NEW.binding_id
         AND binding.workspace_id = NEW.workspace_id
         AND binding.provider = NEW.provider
         AND binding.provider_account_id = NEW.provider_account_id
         AND binding.mode = NEW.mode
         AND binding.fingerprint = NEW.current_fingerprint
         AND binding.target_binding_reference = NEW.target_binding_reference
         AND binding.credential_class = 'restricted_api_key'
         AND binding.key_kind = 'restricted'
         AND binding.status = 'active'
         AND binding.permission_manifest @> NEW.permission_manifest
         AND NEW.permission_manifest @> binding.permission_manifest
    ) THEN
      RAISE EXCEPTION 'provider credential rotation intent does not match the exact active restricted binding';
    END IF;
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - ARRAY[
        'state', 'timeout_disposition', 'active_timeout_elapsed_ms', 'resumed_at',
        'resume_count', 'provider_evidence_digest', 'capture_receipt_reference',
        'capture_result'
      ]::TEXT[])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY[
        'state', 'timeout_disposition', 'active_timeout_elapsed_ms', 'resumed_at',
        'resume_count', 'provider_evidence_digest', 'capture_receipt_reference',
        'capture_result'
      ]::TEXT[]) THEN
    RAISE EXCEPTION 'provider credential rotation intent authority is immutable';
  END IF;

  IF OLD.state <> 'WAITING_FOR_AUTHENTICATION'
     OR NEW.state <> 'READY_FOR_STAGING'
     OR OLD.resume_count <> 0 OR NEW.resume_count <> 1
     OR OLD.active_timeout_elapsed_ms <> NEW.active_timeout_elapsed_ms
     OR NEW.resumed_at IS NULL
     OR NEW.provider_evidence_digest IS NULL
     OR NEW.capture_receipt_reference IS NULL
     OR NEW.capture_result IS NULL THEN
    RAISE EXCEPTION 'provider credential rotation intent resume transition is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION rorca.guard_provider_credential_secret_object()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'provider credential SecretStore objects are audit-retained';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM rorca.provider_credential_rotation_intents intent
       WHERE intent.id = NEW.rotation_intent_id
         AND intent.intent_digest = NEW.intent_digest
         AND intent.workspace_id = NEW.workspace_id
         AND intent.provider = NEW.provider
         AND intent.provider_account_id = NEW.provider_account_id
         AND intent.mode = NEW.mode
         AND intent.target_binding_reference = NEW.target_binding_reference
         AND intent.state = 'WAITING_FOR_AUTHENTICATION'
         AND NEW.credential_class = 'restricted_api_key'
         AND NEW.provider_evidence->'permissionManifest' @> NEW.permission_manifest
         AND NEW.permission_manifest @> (NEW.provider_evidence->'permissionManifest')
         AND intent.permission_manifest @> NEW.permission_manifest
         AND NEW.permission_manifest @> intent.permission_manifest
    ) THEN
      RAISE EXCEPTION 'provider credential SecretStore capture does not match its waiting intent';
    END IF;
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - ARRAY['status', 'status_changed_at']::TEXT[])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status', 'status_changed_at']::TEXT[]) THEN
    RAISE EXCEPTION 'provider credential SecretStore object is immutable';
  END IF;
  NEW.status_changed_at := CASE
    WHEN NEW.status IS DISTINCT FROM OLD.status THEN clock_timestamp()
    ELSE OLD.status_changed_at
  END;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION rorca.reject_provider_credential_rotation_value()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  inspected TEXT;
BEGIN
  inspected := CASE TG_TABLE_NAME
    WHEN 'provider_credential_rotation_intents' THEN
      concat_ws(' ', NEW.target_binding_reference, NEW.intent_payload::TEXT,
                NEW.intent_authority_payload::TEXT, COALESCE(NEW.capture_result::TEXT, ''))
    ELSE
      concat_ws(' ', NEW.target_binding_reference, NEW.provider_evidence::TEXT, NEW.provenance::TEXT)
  END;
  IF inspected ~ '(^|[^[:alnum:]])((sk|rk)_(test|live)_[[:alnum:]]{8,}|whsec_[[:alnum:]]{8,})' THEN
    RAISE EXCEPTION 'credential-shaped values are forbidden in provider rotation metadata';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER provider_credential_rotation_intent_guard
  BEFORE INSERT OR UPDATE OR DELETE ON rorca.provider_credential_rotation_intents
  FOR EACH ROW EXECUTE FUNCTION rorca.guard_provider_credential_rotation_intent();

CREATE TRIGGER provider_credential_rotation_intent_no_values
  BEFORE INSERT OR UPDATE ON rorca.provider_credential_rotation_intents
  FOR EACH ROW EXECUTE FUNCTION rorca.reject_provider_credential_rotation_value();

CREATE TRIGGER provider_credential_secret_object_guard
  BEFORE INSERT OR UPDATE OR DELETE ON rorca.provider_credential_secret_objects
  FOR EACH ROW EXECUTE FUNCTION rorca.guard_provider_credential_secret_object();

CREATE TRIGGER provider_credential_secret_object_no_values
  BEFORE INSERT OR UPDATE ON rorca.provider_credential_secret_objects
  FOR EACH ROW EXECUTE FUNCTION rorca.reject_provider_credential_rotation_value();

ALTER TABLE rorca.provider_credential_rotation_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.provider_credential_rotation_intents FORCE ROW LEVEL SECURITY;
ALTER TABLE rorca.provider_credential_secret_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.provider_credential_secret_objects FORCE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE rorca.provider_credential_rotation_intents FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE rorca.provider_credential_secret_objects FROM PUBLIC;
REVOKE ALL ON FUNCTION rorca.guard_provider_credential_rotation_intent() FROM PUBLIC;
REVOKE ALL ON FUNCTION rorca.guard_provider_credential_secret_object() FROM PUBLIC;
REVOKE ALL ON FUNCTION rorca.reject_provider_credential_rotation_value() FROM PUBLIC;

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
    RAISE EXCEPTION 'registered credential-rotation runtime principal is required' USING ERRCODE = '42501';
  END IF;
  IF writer_user IS NULL OR writer_user = '' OR writer_user = runtime_user
     OR NOT EXISTS (
       SELECT 1 FROM rorca.wave2_database_principals
       WHERE database_user = writer_user AND principal_class = 'canonical_writer'
     ) THEN
    RAISE EXCEPTION 'registered distinct credential-rotation canonical writer is required' USING ERRCODE = '42501';
  END IF;

  EXECUTE format('GRANT SELECT ON TABLE rorca.provider_credential_rotation_intents TO %I', runtime_user);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE rorca.provider_credential_rotation_intents TO %I', writer_user);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE rorca.provider_credential_secret_objects TO %I', writer_user);
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.guard_provider_credential_rotation_intent() TO %I', writer_user);
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.guard_provider_credential_secret_object() TO %I', writer_user);
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.reject_provider_credential_rotation_value() TO %I', writer_user);

  EXECUTE format(
    'CREATE POLICY provider_credential_rotation_runtime_read ON rorca.provider_credential_rotation_intents FOR SELECT TO %I USING (current_user = %L)',
    runtime_user,
    runtime_user
  );
  EXECUTE format(
    'CREATE POLICY provider_credential_rotation_writer_mutation ON rorca.provider_credential_rotation_intents FOR ALL TO %I USING (current_user = %L) WITH CHECK (current_user = %L)',
    writer_user,
    writer_user,
    writer_user
  );
  EXECUTE format(
    'CREATE POLICY provider_credential_secret_object_writer_only ON rorca.provider_credential_secret_objects FOR ALL TO %I USING (current_user = %L) WITH CHECK (current_user = %L)',
    writer_user,
    writer_user,
    writer_user
  );
END;
$$;
