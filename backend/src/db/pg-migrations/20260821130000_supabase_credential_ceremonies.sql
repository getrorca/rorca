-- SMC-005 credential-ceremony authority. Ceremony metadata, grants, runtime
-- bindings, and receipts contain only opaque SecretStore references and
-- fingerprints. Captured bytes exist solely as encrypted SecretStore payloads.

CREATE TABLE rorca.credential_ceremony_grants (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  credential_binding_id UUID NOT NULL,
  binding_generation BIGINT NOT NULL CHECK (binding_generation > 0),
  ceremony_type TEXT NOT NULL CHECK (ceremony_type IN (
    'api-key-rotation',
    'legacy-key-migration',
    'jwt-signing-rotation'
  )),
  capability TEXT NOT NULL CHECK (capability IN (
    'credential.supabase.api-key.rotate',
    'credential.supabase.legacy-key.migrate',
    'credential.supabase.jwt-signing.rotate'
  )),
  risk_class TEXT NOT NULL CHECK (
    (ceremony_type = 'api-key-rotation'
      AND capability = 'credential.supabase.api-key.rotate'
      AND risk_class = 'high')
    OR (ceremony_type = 'legacy-key-migration'
      AND capability = 'credential.supabase.legacy-key.migrate'
      AND risk_class = 'critical')
    OR (ceremony_type = 'jwt-signing-rotation'
      AND capability = 'credential.supabase.jwt-signing.rotate'
      AND risk_class = 'critical')
  ),
  subject_hash TEXT NOT NULL CHECK (subject_hash ~ '^sha256:[0-9a-f]{64}$'),
  issued_by_authority_hash TEXT NOT NULL CHECK (issued_by_authority_hash ~ '^sha256:[0-9a-f]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_by_ceremony_id UUID,
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (credential_binding_id, workspace_id)
    REFERENCES rorca.authority_provider_bindings(id, workspace_id) ON DELETE RESTRICT,
  CHECK (expires_at > created_at),
  CHECK (
    (consumed_by_ceremony_id IS NULL AND consumed_at IS NULL)
    OR (consumed_by_ceremony_id IS NOT NULL AND consumed_at IS NOT NULL)
  ),
  CHECK (consumed_at IS NULL OR revoked_at IS NULL)
);

CREATE TABLE rorca.credential_ceremonies (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  credential_binding_id UUID NOT NULL,
  binding_generation BIGINT NOT NULL CHECK (binding_generation > 0),
  authority_grant_id UUID NOT NULL UNIQUE
    REFERENCES rorca.credential_ceremony_grants(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 255),
  ceremony_type TEXT NOT NULL CHECK (ceremony_type IN (
    'api-key-rotation',
    'legacy-key-migration',
    'jwt-signing-rotation'
  )),
  capability TEXT NOT NULL CHECK (capability IN (
    'credential.supabase.api-key.rotate',
    'credential.supabase.legacy-key.migrate',
    'credential.supabase.jwt-signing.rotate'
  )),
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  binding_inventory_digest TEXT NOT NULL CHECK (binding_inventory_digest ~ '^sha256:[0-9a-f]{64}$'),
  request_record JSONB NOT NULL CHECK (
    jsonb_typeof(request_record) = 'object'
    AND request_record ->> 'ceremonyId' = id::TEXT
    AND request_record ->> 'authorityGrantId' = authority_grant_id::TEXT
    AND request_record ->> 'ceremonyType' = ceremony_type
    AND request_record ->> 'capability' = capability
    AND request_record ->> 'bindingInventoryDigest' = binding_inventory_digest
    AND request_record #>> '{scope,workspaceId}' = workspace_id
    AND request_record #>> '{scope,credentialBindingId}' = credential_binding_id::TEXT
    AND (request_record #>> '{scope,bindingGeneration}')::BIGINT = binding_generation
    AND rorca.authority_metadata_is_reference_only_v1(request_record)
  ),
  state TEXT NOT NULL CHECK (state IN (
    'planned',
    'replacement-bound',
    'standby',
    'canary-verified',
    'current',
    'revoked'
  )),
  captures JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(captures) = 'array'
    AND rorca.authority_metadata_is_reference_only_v1(captures)
  ),
  canary_evidence JSONB CHECK (
    canary_evidence IS NULL OR (
      jsonb_typeof(canary_evidence) = 'object'
      AND canary_evidence ->> 'ceremonyType' = ceremony_type
      AND canary_evidence #>> '{consumerResults,0,passed}' = 'true'
      AND rorca.authority_metadata_is_reference_only_v1(canary_evidence)
    )
  ),
  cutover_evidence JSONB CHECK (
    cutover_evidence IS NULL OR (
      jsonb_typeof(cutover_evidence) = 'object'
      AND rorca.authority_metadata_is_reference_only_v1(cutover_evidence)
    )
  ),
  revocation_evidence JSONB CHECK (
    revocation_evidence IS NULL OR (
      jsonb_typeof(revocation_evidence) = 'object'
      AND revocation_evidence ->> 'ceremonyType' = ceremony_type
      AND revocation_evidence ->> 'rollbackReadinessPassed' = 'true'
      AND rorca.authority_metadata_is_reference_only_v1(revocation_evidence)
    )
  ),
  receipt_id UUID UNIQUE,
  receipt_record JSONB CHECK (
    receipt_record IS NULL OR (
      jsonb_typeof(receipt_record) = 'object'
      AND receipt_record ->> 'receiptId' = receipt_id::TEXT
      AND receipt_record ->> 'ceremonyId' = id::TEXT
      AND receipt_record ->> 'ceremonyType' = ceremony_type
      AND receipt_record ->> 'capability' = capability
      AND receipt_record ->> 'requestDigest' = request_digest
      AND receipt_record ->> 'bindingInventoryDigest' = binding_inventory_digest
      AND rorca.authority_metadata_is_reference_only_v1(receipt_record)
    )
  ),
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (credential_binding_id, workspace_id)
    REFERENCES rorca.authority_provider_bindings(id, workspace_id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (workspace_id, request_digest),
  CHECK (
    (ceremony_type = 'api-key-rotation' AND capability = 'credential.supabase.api-key.rotate')
    OR (ceremony_type = 'legacy-key-migration' AND capability = 'credential.supabase.legacy-key.migrate')
    OR (ceremony_type = 'jwt-signing-rotation' AND capability = 'credential.supabase.jwt-signing.rotate')
  ),
  CHECK (
    (state IN ('planned', 'replacement-bound', 'standby')
      AND canary_evidence IS NULL AND cutover_evidence IS NULL
      AND revocation_evidence IS NULL AND receipt_record IS NULL)
    OR (state = 'canary-verified'
      AND canary_evidence IS NOT NULL AND cutover_evidence IS NULL
      AND revocation_evidence IS NULL AND receipt_record IS NULL)
    OR (state = 'current'
      AND canary_evidence IS NOT NULL AND cutover_evidence IS NOT NULL
      AND revocation_evidence IS NULL AND receipt_record IS NULL)
    OR (state = 'revoked'
      AND canary_evidence IS NOT NULL AND cutover_evidence IS NOT NULL
      AND revocation_evidence IS NOT NULL AND receipt_record IS NOT NULL)
  ),
  CHECK (state <> 'standby' OR ceremony_type = 'jwt-signing-rotation'),
  CHECK (state <> 'replacement-bound' OR ceremony_type <> 'jwt-signing-rotation')
);

ALTER TABLE rorca.credential_ceremony_grants
  ADD CONSTRAINT credential_ceremony_grant_consuming_ceremony_fk
  FOREIGN KEY (consumed_by_ceremony_id)
  REFERENCES rorca.credential_ceremonies(id) ON DELETE RESTRICT;

CREATE TABLE rorca.authority_secret_store_entries (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  ceremony_id UUID NOT NULL REFERENCES rorca.credential_ceremonies(id) ON DELETE RESTRICT,
  slot_id TEXT NOT NULL CHECK (length(slot_id) BETWEEN 1 AND 255),
  material_class TEXT NOT NULL CHECK (material_class IN (
    'application-publishable',
    'application-secret',
    'jwt-signing'
  )),
  encrypted_value BYTEA NOT NULL CHECK (octet_length(encrypted_value) BETWEEN 29 AND 65564),
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  captured_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, workspace_id),
  CHECK (revoked_at IS NULL OR revoked_at >= captured_at)
);

COMMENT ON TABLE rorca.authority_secret_store_entries IS
  'Core encrypted SecretStore payloads. Never join encrypted_value into API responses, model context, logs, authority rows, or receipts.';

CREATE TABLE rorca.credential_consumer_bindings (
  ceremony_id UUID NOT NULL REFERENCES rorca.credential_ceremonies(id) ON DELETE RESTRICT,
  consumer_id TEXT NOT NULL CHECK (length(consumer_id) BETWEEN 1 AND 255),
  binding_id UUID NOT NULL,
  component TEXT NOT NULL CHECK (length(component) BETWEEN 1 AND 255),
  environment TEXT NOT NULL CHECK (environment IN ('staging', 'production')),
  old_material_class TEXT NOT NULL CHECK (old_material_class IN (
    'application-publishable',
    'application-secret',
    'application-anon',
    'application-service-role',
    'jwt-signing'
  )),
  old_reference_id TEXT NOT NULL CHECK (
    old_reference_id ~ '^[a-z][a-z0-9+.-]{1,31}://[^[:space:]]+$'
    AND old_reference_id !~* '^(https?|postgres(?:ql)?)://'
  ),
  old_fingerprint TEXT NOT NULL CHECK (old_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  old_generation BIGINT NOT NULL CHECK (old_generation > 0),
  replacement_slot_id TEXT NOT NULL CHECK (length(replacement_slot_id) BETWEEN 1 AND 255),
  replacement_material_class TEXT NOT NULL CHECK (replacement_material_class IN (
    'application-publishable',
    'application-secret',
    'jwt-signing'
  )),
  replacement_reference_id TEXT CHECK (
    replacement_reference_id IS NULL OR (
      replacement_reference_id ~ '^secret-store://[^[:space:]]+$'
      AND replacement_reference_id !~* '^(https?|postgres(?:ql)?)://'
    )
  ),
  replacement_fingerprint TEXT CHECK (
    replacement_fingerprint IS NULL OR replacement_fingerprint ~ '^sha256:[0-9a-f]{64}$'
  ),
  target_generation BIGINT NOT NULL CHECK (target_generation > old_generation),
  state TEXT NOT NULL CHECK (state IN ('current', 'standby', 'current-replacement', 'revoked-old')),
  replacement_captured_at TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  old_revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (ceremony_id, consumer_id),
  CHECK ((replacement_reference_id IS NULL) = (replacement_fingerprint IS NULL)),
  CHECK (
    (state = 'current' AND replacement_reference_id IS NULL
      AND replacement_captured_at IS NULL AND activated_at IS NULL AND old_revoked_at IS NULL)
    OR (state = 'standby' AND replacement_reference_id IS NOT NULL
      AND replacement_captured_at IS NOT NULL AND activated_at IS NULL AND old_revoked_at IS NULL)
    OR (state = 'current-replacement' AND replacement_reference_id IS NOT NULL
      AND replacement_captured_at IS NOT NULL AND activated_at IS NOT NULL AND old_revoked_at IS NULL)
    OR (state = 'revoked-old' AND replacement_reference_id IS NOT NULL
      AND replacement_captured_at IS NOT NULL AND activated_at IS NOT NULL AND old_revoked_at IS NOT NULL)
  )
);

CREATE TABLE rorca.credential_ceremony_receipts (
  id UUID PRIMARY KEY,
  ceremony_id UUID NOT NULL UNIQUE REFERENCES rorca.credential_ceremonies(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  ceremony_type TEXT NOT NULL CHECK (ceremony_type IN (
    'api-key-rotation',
    'legacy-key-migration',
    'jwt-signing-rotation'
  )),
  capability TEXT NOT NULL CHECK (capability IN (
    'credential.supabase.api-key.rotate',
    'credential.supabase.legacy-key.migrate',
    'credential.supabase.jwt-signing.rotate'
  )),
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  binding_inventory_digest TEXT NOT NULL CHECK (binding_inventory_digest ~ '^sha256:[0-9a-f]{64}$'),
  receipt_record JSONB NOT NULL CHECK (
    jsonb_typeof(receipt_record) = 'object'
    AND receipt_record ->> 'receiptId' = id::TEXT
    AND receipt_record ->> 'ceremonyId' = ceremony_id::TEXT
    AND receipt_record ->> 'ceremonyType' = ceremony_type
    AND receipt_record ->> 'capability' = capability
    AND receipt_record ->> 'requestDigest' = request_digest
    AND receipt_record ->> 'bindingInventoryDigest' = binding_inventory_digest
    AND rorca.authority_metadata_is_reference_only_v1(receipt_record)
  ),
  created_at TIMESTAMPTZ NOT NULL,
  CHECK (
    (ceremony_type = 'api-key-rotation' AND capability = 'credential.supabase.api-key.rotate'
      AND receipt_record ->> 'version' = 'rorca.supabase-api-key-rotation-receipt.v1')
    OR (ceremony_type = 'legacy-key-migration' AND capability = 'credential.supabase.legacy-key.migrate'
      AND receipt_record ->> 'version' = 'rorca.supabase-legacy-key-migration-receipt.v1')
    OR (ceremony_type = 'jwt-signing-rotation' AND capability = 'credential.supabase.jwt-signing.rotate'
      AND receipt_record ->> 'version' = 'rorca.supabase-jwt-signing-rotation-receipt.v1')
  )
);

ALTER TABLE rorca.credential_ceremonies
  ADD CONSTRAINT credential_ceremony_receipt_fk
  FOREIGN KEY (receipt_id)
  REFERENCES rorca.credential_ceremony_receipts(id) ON DELETE RESTRICT;

CREATE INDEX credential_ceremonies_active_idx
  ON rorca.credential_ceremonies (workspace_id, state, updated_at)
  WHERE state <> 'revoked';
CREATE INDEX credential_consumer_bindings_reference_idx
  ON rorca.credential_consumer_bindings (old_reference_id, state);
CREATE UNIQUE INDEX authority_secret_store_one_active_slot_idx
  ON rorca.authority_secret_store_entries (ceremony_id, slot_id)
  WHERE revoked_at IS NULL;
CREATE INDEX authority_secret_store_active_idx
  ON rorca.authority_secret_store_entries (workspace_id, ceremony_id)
  WHERE revoked_at IS NULL;

CREATE FUNCTION rorca.guard_credential_ceremony_grant_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, rorca
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Credential ceremony grants are immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
     OR OLD.credential_binding_id IS DISTINCT FROM NEW.credential_binding_id
     OR OLD.binding_generation IS DISTINCT FROM NEW.binding_generation
     OR OLD.ceremony_type IS DISTINCT FROM NEW.ceremony_type
     OR OLD.capability IS DISTINCT FROM NEW.capability
     OR OLD.risk_class IS DISTINCT FROM NEW.risk_class
     OR OLD.subject_hash IS DISTINCT FROM NEW.subject_hash
     OR OLD.issued_by_authority_hash IS DISTINCT FROM NEW.issued_by_authority_hash
     OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
     OR OLD.created_at IS DISTINCT FROM NEW.created_at
     OR OLD.consumed_by_ceremony_id IS NOT NULL
     OR OLD.revoked_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'Credential ceremony grant subject is immutable and single-use' USING ERRCODE = '42501';
  END IF;
  IF NEW.consumed_by_ceremony_id IS NOT NULL THEN
    IF NEW.consumed_at IS NULL OR NEW.revoked_at IS NOT NULL
       OR clock_timestamp() >= OLD.expires_at
       OR NOT EXISTS (
         SELECT 1 FROM rorca.credential_ceremonies ceremony
          WHERE ceremony.id = NEW.consumed_by_ceremony_id
            AND ceremony.authority_grant_id = NEW.id
            AND ceremony.workspace_id = NEW.workspace_id
            AND ceremony.credential_binding_id = NEW.credential_binding_id
            AND ceremony.binding_generation = NEW.binding_generation
            AND ceremony.ceremony_type = NEW.ceremony_type
            AND ceremony.capability = NEW.capability
            AND ceremony.request_digest = NEW.subject_hash
       )
    THEN
      RAISE EXCEPTION 'Credential ceremony grant consumption does not match its exact typed subject'
        USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.revoked_at IS NULL OR NEW.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Credential ceremony grant requires exact consumption or revocation'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER credential_ceremony_grant_transition
BEFORE UPDATE OR DELETE ON rorca.credential_ceremony_grants
FOR EACH ROW EXECUTE FUNCTION rorca.guard_credential_ceremony_grant_v1();

CREATE FUNCTION rorca.guard_credential_ceremony_transition_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, rorca
AS $$
DECLARE
  allowed BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Credential ceremonies and receipts are append-only' USING ERRCODE = '42501';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
     OR OLD.credential_binding_id IS DISTINCT FROM NEW.credential_binding_id
     OR OLD.binding_generation IS DISTINCT FROM NEW.binding_generation
     OR OLD.authority_grant_id IS DISTINCT FROM NEW.authority_grant_id
     OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
     OR OLD.ceremony_type IS DISTINCT FROM NEW.ceremony_type
     OR OLD.capability IS DISTINCT FROM NEW.capability
     OR OLD.request_digest IS DISTINCT FROM NEW.request_digest
     OR OLD.binding_inventory_digest IS DISTINCT FROM NEW.binding_inventory_digest
     OR OLD.request_record IS DISTINCT FROM NEW.request_record
     OR OLD.created_at IS DISTINCT FROM NEW.created_at
     OR NEW.revision <> OLD.revision + 1
     OR NEW.updated_at < OLD.updated_at
  THEN
    RAISE EXCEPTION 'Credential ceremony identity and request subject are immutable' USING ERRCODE = '42501';
  END IF;
  allowed :=
    (OLD.state = 'planned' AND NEW.state IN ('planned', 'replacement-bound', 'standby'))
    OR (OLD.state IN ('replacement-bound', 'standby') AND NEW.state = 'canary-verified')
    OR (OLD.state = 'canary-verified' AND NEW.state = 'current')
    OR (OLD.state = 'current' AND NEW.state = 'revoked');
  IF NOT allowed THEN
    RAISE EXCEPTION 'Credential ceremony state transition is invalid' USING ERRCODE = '42501';
  END IF;
  IF jsonb_array_length(NEW.captures) < jsonb_array_length(OLD.captures)
     OR EXISTS (
       SELECT 1
         FROM jsonb_array_elements(OLD.captures) old_capture
        WHERE NOT EXISTS (
          SELECT 1
            FROM jsonb_array_elements(NEW.captures) new_capture
           WHERE new_capture ->> 'slotId' = old_capture ->> 'slotId'
             AND new_capture ->> 'materialClass' = old_capture ->> 'materialClass'
             AND new_capture ->> 'referenceId' = old_capture ->> 'referenceId'
             AND new_capture ->> 'fingerprint' = old_capture ->> 'fingerprint'
             AND new_capture ->> 'capturedAt' = old_capture ->> 'capturedAt'
             AND (
               new_capture ->> 'keyState' = old_capture ->> 'keyState'
               OR (old_capture ->> 'keyState' = 'standby' AND new_capture ->> 'keyState' = 'current')
             )
        )
     )
  THEN
    RAISE EXCEPTION 'Captured SecretStore references are append-only and key state is one-way' USING ERRCODE = '42501';
  END IF;
  IF OLD.canary_evidence IS NOT NULL AND OLD.canary_evidence IS DISTINCT FROM NEW.canary_evidence
     OR OLD.cutover_evidence IS NOT NULL AND OLD.cutover_evidence IS DISTINCT FROM NEW.cutover_evidence
     OR OLD.revocation_evidence IS NOT NULL AND OLD.revocation_evidence IS DISTINCT FROM NEW.revocation_evidence
     OR OLD.receipt_record IS NOT NULL AND OLD.receipt_record IS DISTINCT FROM NEW.receipt_record
  THEN
    RAISE EXCEPTION 'Credential ceremony evidence and receipt are immutable once recorded' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER credential_ceremony_transition
BEFORE UPDATE OR DELETE ON rorca.credential_ceremonies
FOR EACH ROW EXECUTE FUNCTION rorca.guard_credential_ceremony_transition_v1();

CREATE FUNCTION rorca.guard_authority_secret_store_transition_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, rorca
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Credential SecretStore entries cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
     OR OLD.ceremony_id IS DISTINCT FROM NEW.ceremony_id
     OR OLD.slot_id IS DISTINCT FROM NEW.slot_id
     OR OLD.material_class IS DISTINCT FROM NEW.material_class
     OR OLD.encrypted_value IS DISTINCT FROM NEW.encrypted_value
     OR OLD.fingerprint IS DISTINCT FROM NEW.fingerprint
     OR OLD.captured_at IS DISTINCT FROM NEW.captured_at
     OR OLD.created_at IS DISTINCT FROM NEW.created_at
     OR OLD.revoked_at IS NOT NULL
     OR NEW.revoked_at IS NULL
  THEN
    RAISE EXCEPTION 'Credential SecretStore permits only one-way revocation' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER authority_secret_store_transition
BEFORE UPDATE OR DELETE ON rorca.authority_secret_store_entries
FOR EACH ROW EXECUTE FUNCTION rorca.guard_authority_secret_store_transition_v1();

CREATE FUNCTION rorca.guard_credential_consumer_binding_transition_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, rorca
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Credential consumer inventory is append-only' USING ERRCODE = '42501';
  END IF;
  IF OLD.ceremony_id IS DISTINCT FROM NEW.ceremony_id
     OR OLD.consumer_id IS DISTINCT FROM NEW.consumer_id
     OR OLD.binding_id IS DISTINCT FROM NEW.binding_id
     OR OLD.component IS DISTINCT FROM NEW.component
     OR OLD.environment IS DISTINCT FROM NEW.environment
     OR OLD.old_material_class IS DISTINCT FROM NEW.old_material_class
     OR OLD.old_reference_id IS DISTINCT FROM NEW.old_reference_id
     OR OLD.old_fingerprint IS DISTINCT FROM NEW.old_fingerprint
     OR OLD.old_generation IS DISTINCT FROM NEW.old_generation
     OR OLD.replacement_slot_id IS DISTINCT FROM NEW.replacement_slot_id
     OR OLD.replacement_material_class IS DISTINCT FROM NEW.replacement_material_class
     OR OLD.target_generation IS DISTINCT FROM NEW.target_generation
     OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'Credential consumer inventory identity is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.state = 'current' AND NEW.state = 'standby' THEN
    IF NEW.replacement_reference_id IS NULL OR NEW.replacement_fingerprint IS NULL
       OR NEW.replacement_captured_at IS NULL
    THEN
      RAISE EXCEPTION 'Standby transition requires an exact SecretStore replacement' USING ERRCODE = '42501';
    END IF;
  ELSIF OLD.state = 'standby' AND NEW.state = 'current-replacement' THEN
    IF OLD.replacement_reference_id IS DISTINCT FROM NEW.replacement_reference_id
       OR OLD.replacement_fingerprint IS DISTINCT FROM NEW.replacement_fingerprint
       OR NEW.activated_at IS NULL
    THEN
      RAISE EXCEPTION 'Current transition changed the standby replacement' USING ERRCODE = '42501';
    END IF;
  ELSIF OLD.state = 'current-replacement' AND NEW.state = 'revoked-old' THEN
    IF OLD.replacement_reference_id IS DISTINCT FROM NEW.replacement_reference_id
       OR OLD.replacement_fingerprint IS DISTINCT FROM NEW.replacement_fingerprint
       OR NEW.old_revoked_at IS NULL
    THEN
      RAISE EXCEPTION 'Old-key revocation changed the current replacement' USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'Credential consumer binding transition is invalid' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER credential_consumer_binding_transition
BEFORE UPDATE OR DELETE ON rorca.credential_consumer_bindings
FOR EACH ROW EXECUTE FUNCTION rorca.guard_credential_consumer_binding_transition_v1();

CREATE FUNCTION rorca.deny_credential_ceremony_receipt_mutation_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, rorca
AS $$
BEGIN
  RAISE EXCEPTION 'Credential ceremony receipts are immutable' USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER credential_ceremony_receipt_immutability
BEFORE UPDATE OR DELETE ON rorca.credential_ceremony_receipts
FOR EACH ROW EXECUTE FUNCTION rorca.deny_credential_ceremony_receipt_mutation_v1();

ALTER TABLE rorca.credential_ceremony_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.credential_ceremonies ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.authority_secret_store_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.credential_consumer_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.credential_ceremony_receipts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE rorca.credential_ceremony_grants FROM PUBLIC;
REVOKE ALL ON TABLE rorca.credential_ceremonies FROM PUBLIC;
REVOKE ALL ON TABLE rorca.authority_secret_store_entries FROM PUBLIC;
REVOKE ALL ON TABLE rorca.credential_consumer_bindings FROM PUBLIC;
REVOKE ALL ON TABLE rorca.credential_ceremony_receipts FROM PUBLIC;
REVOKE ALL ON FUNCTION rorca.guard_credential_ceremony_grant_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION rorca.guard_credential_ceremony_transition_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION rorca.guard_authority_secret_store_transition_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION rorca.guard_credential_consumer_binding_transition_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION rorca.deny_credential_ceremony_receipt_mutation_v1() FROM PUBLIC;

DO $$
DECLARE
  runtime_user TEXT := current_setting('rorca.runtime_database_user', TRUE);
  writer_user TEXT := current_setting('rorca.canonical_writer_database_user', TRUE);
  request_role TEXT;
BEGIN
  IF runtime_user IS NULL OR runtime_user = ''
     OR NOT EXISTS (
       SELECT 1 FROM rorca.wave2_database_principals
        WHERE database_user = runtime_user AND principal_class = 'internal_runtime'
     )
  THEN
    RAISE EXCEPTION 'registered credential-authority runtime principal is required' USING ERRCODE = '42501';
  END IF;
  IF writer_user IS NULL OR writer_user = '' OR writer_user = runtime_user
     OR NOT EXISTS (
       SELECT 1 FROM rorca.wave2_database_principals
        WHERE database_user = writer_user AND principal_class = 'canonical_writer'
     )
  THEN
    RAISE EXCEPTION 'registered distinct credential-authority canonical writer is required' USING ERRCODE = '42501';
  END IF;

  FOR request_role IN
    SELECT rolname FROM pg_roles WHERE rolname IN ('authenticated', 'anon')
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE rorca.credential_ceremony_grants FROM %I', request_role);
    EXECUTE format('REVOKE ALL ON TABLE rorca.credential_ceremonies FROM %I', request_role);
    EXECUTE format('REVOKE ALL ON TABLE rorca.authority_secret_store_entries FROM %I', request_role);
    EXECUTE format('REVOKE ALL ON TABLE rorca.credential_consumer_bindings FROM %I', request_role);
    EXECUTE format('REVOKE ALL ON TABLE rorca.credential_ceremony_receipts FROM %I', request_role);
  END LOOP;

  EXECUTE format('GRANT SELECT ON rorca.authority_secret_store_entries TO %I', runtime_user);
  EXECUTE format('GRANT SELECT ON rorca.credential_consumer_bindings TO %I', runtime_user);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON rorca.credential_ceremony_grants TO %I', writer_user);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON rorca.credential_ceremonies TO %I', writer_user);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON rorca.authority_secret_store_entries TO %I', writer_user);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON rorca.credential_consumer_bindings TO %I', writer_user);
  EXECUTE format('GRANT SELECT, INSERT ON rorca.credential_ceremony_receipts TO %I', writer_user);

  EXECUTE format(
    'CREATE POLICY credential_secret_store_runtime_read ON rorca.authority_secret_store_entries FOR SELECT TO %I USING (current_user = %L AND revoked_at IS NULL)',
    runtime_user, runtime_user
  );
  EXECUTE format(
    'CREATE POLICY credential_consumer_bindings_runtime_read ON rorca.credential_consumer_bindings FOR SELECT TO %I USING (current_user = %L)',
    runtime_user, runtime_user
  );
  EXECUTE format(
    'CREATE POLICY credential_ceremony_grants_writer ON rorca.credential_ceremony_grants FOR ALL TO %I USING (current_user = %L) WITH CHECK (current_user = %L)',
    writer_user, writer_user, writer_user
  );
  EXECUTE format(
    'CREATE POLICY credential_ceremonies_writer ON rorca.credential_ceremonies FOR ALL TO %I USING (current_user = %L) WITH CHECK (current_user = %L)',
    writer_user, writer_user, writer_user
  );
  EXECUTE format(
    'CREATE POLICY credential_secret_store_writer ON rorca.authority_secret_store_entries FOR ALL TO %I USING (current_user = %L) WITH CHECK (current_user = %L)',
    writer_user, writer_user, writer_user
  );
  EXECUTE format(
    'CREATE POLICY credential_consumer_bindings_writer ON rorca.credential_consumer_bindings FOR ALL TO %I USING (current_user = %L) WITH CHECK (current_user = %L)',
    writer_user, writer_user, writer_user
  );
  EXECUTE format(
    'CREATE POLICY credential_ceremony_receipts_writer ON rorca.credential_ceremony_receipts FOR ALL TO %I USING (current_user = %L) WITH CHECK (current_user = %L)',
    writer_user, writer_user, writer_user
  );
END;
$$;
