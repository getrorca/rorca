-- Durable SMC-002 backup artifacts and restore-drill reconciliation state.
-- Provider/database credentials remain in SecretStore. These relations contain
-- only immutable identities, opaque references, fingerprints, hashes, and
-- redacted verification evidence.

CREATE TABLE rorca.database_backup_artifacts (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  source_binding_id UUID NOT NULL,
  source_binding_generation BIGINT NOT NULL CHECK (source_binding_generation > 0),
  source_identity JSONB NOT NULL CHECK (
    jsonb_typeof(source_identity) = 'object'
    AND source_identity ->> 'providerId' = 'supabase-database'
    AND source_identity ->> 'bindingId' = source_binding_id::TEXT
    AND (source_identity ->> 'bindingGeneration')::BIGINT = source_binding_generation
    AND source_identity ->> 'workspaceId' = workspace_id
    AND rorca.authority_metadata_is_reference_only_v1(source_identity)
  ),
  source_identity_hash TEXT NOT NULL CHECK (source_identity_hash ~ '^sha256:[0-9a-f]{64}$'),
  source_database_identity_hash TEXT NOT NULL CHECK (source_database_identity_hash ~ '^sha256:[0-9a-f]{64}$'),
  provider_artifact_reference TEXT NOT NULL CHECK (
    provider_artifact_reference ~ '^[a-z][a-z0-9+.-]{1,31}://[^[:space:]]+$'
    AND provider_artifact_reference !~* '^postgres(?:ql)?://'
    AND provider_artifact_reference !~ '://[^/@:]+:[^/@]+@'
  ),
  storage_provider_id TEXT NOT NULL CHECK (storage_provider_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,254}$'),
  storage_location_reference TEXT NOT NULL CHECK (
    storage_location_reference ~ '^[a-z][a-z0-9+.-]{1,31}://[^[:space:]]+$'
    AND storage_location_reference !~* '^postgres(?:ql)?://'
    AND storage_location_reference !~ '://[^/@:]+:[^/@]+@'
  ),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  byte_length BIGINT NOT NULL CHECK (byte_length > 0),
  schema_hash TEXT NOT NULL CHECK (schema_hash ~ '^sha256:[0-9a-f]{64}$'),
  database_version TEXT NOT NULL CHECK (btrim(database_version) <> '' AND length(database_version) <= 255),
  encryption_provenance JSONB NOT NULL CHECK (
    jsonb_typeof(encryption_provenance) = 'object'
    AND encryption_provenance ->> 'encrypted' = 'true'
    AND encryption_provenance ->> 'keyFingerprint' ~ '^sha256:[0-9a-f]{64}$'
    AND rorca.authority_metadata_is_reference_only_v1(encryption_provenance)
  ),
  retention JSONB NOT NULL CHECK (
    jsonb_typeof(retention) = 'object'
    AND btrim(retention ->> 'policy') <> ''
    AND (retention ->> 'retainUntil')::TIMESTAMPTZ > created_at
    AND rorca.authority_metadata_is_reference_only_v1(retention)
  ),
  verification JSONB NOT NULL CHECK (
    jsonb_typeof(verification) = 'object'
    AND verification ->> 'verified' = 'true'
    AND verification ->> 'verifiedContentHash' = content_hash
    AND verification ->> 'verifiedContentHash' ~ '^sha256:[0-9a-f]{64}$'
    AND rorca.authority_metadata_is_reference_only_v1(verification)
  ),
  artifact_record JSONB NOT NULL CHECK (
    jsonb_typeof(artifact_record) = 'object'
    AND artifact_record ->> 'version' = 'rorca.database-backup-artifact.v1'
    AND artifact_record ->> 'artifactId' = id::TEXT
    AND artifact_record ->> 'contentHash' = content_hash
    AND artifact_record ->> 'recordHash' = record_hash
    AND rorca.authority_metadata_is_reference_only_v1(artifact_record)
  ),
  record_hash TEXT NOT NULL UNIQUE CHECK (record_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (source_binding_id, workspace_id)
    REFERENCES rorca.authority_provider_bindings(id, workspace_id) ON DELETE RESTRICT,
  UNIQUE (id, workspace_id),
  UNIQUE (storage_provider_id, storage_location_reference),
  UNIQUE (provider_artifact_reference)
);

CREATE TABLE rorca.database_authority_operation_grants (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  binding_id UUID NOT NULL,
  binding_generation BIGINT NOT NULL CHECK (binding_generation > 0),
  capability TEXT NOT NULL CHECK (capability IN ('database.backup.create', 'database.backup.restore')),
  risk_class TEXT NOT NULL CHECK (
    (capability = 'database.backup.create' AND risk_class = 'elevated')
    OR (capability = 'database.backup.restore' AND risk_class = 'high')
  ),
  subject_hash TEXT NOT NULL CHECK (subject_hash ~ '^sha256:[0-9a-f]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  issued_by_authority_hash TEXT NOT NULL CHECK (issued_by_authority_hash ~ '^sha256:[0-9a-f]{64}$'),
  consumed_by_operation_id UUID UNIQUE,
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (binding_id, workspace_id)
    REFERENCES rorca.authority_provider_bindings(id, workspace_id) ON DELETE RESTRICT,
  CHECK (expires_at > created_at),
  CHECK ((consumed_by_operation_id IS NULL) = (consumed_at IS NULL)),
  CHECK (consumed_at IS NULL OR revoked_at IS NULL),
  UNIQUE (id, workspace_id)
);

CREATE TABLE rorca.database_backup_restore_operations (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  binding_id UUID NOT NULL,
  binding_generation BIGINT NOT NULL CHECK (binding_generation > 0),
  capability TEXT NOT NULL CHECK (capability IN ('database.backup.create', 'database.backup.restore')),
  authority_grant_id UUID NOT NULL UNIQUE
    REFERENCES rorca.database_authority_operation_grants(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 255),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^sha256:[0-9a-f]{64}$'),
  artifact_id UUID NOT NULL,
  target_identity_hash TEXT CHECK (target_identity_hash ~ '^sha256:[0-9a-f]{64}$'),
  state TEXT NOT NULL DEFAULT 'started' CHECK (state IN ('started', 'succeeded', 'cleanup_required')),
  receipt_id UUID UNIQUE REFERENCES rorca.authority_operation_receipts(id) ON DELETE RESTRICT,
  result_record JSONB CHECK (
    result_record IS NULL OR (
      jsonb_typeof(result_record) = 'object'
      AND result_record ->> 'operationId' = id::TEXT
      AND result_record ->> 'capability' = capability
      AND result_record ->> 'requestHash' = request_hash
      AND result_record ->> 'authorityGrantId' = authority_grant_id::TEXT
      AND rorca.authority_metadata_is_reference_only_v1(result_record)
    )
  ),
  cleanup_evidence JSONB CHECK (
    cleanup_evidence IS NULL OR (
      jsonb_typeof(cleanup_evidence) = 'object'
      AND cleanup_evidence ->> 'operationId' = id::TEXT
      AND cleanup_evidence ->> 'capability' = capability
      AND btrim(cleanup_evidence ->> 'reason') <> ''
      AND rorca.authority_metadata_is_reference_only_v1(cleanup_evidence)
    )
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  settled_at TIMESTAMPTZ,
  FOREIGN KEY (binding_id, workspace_id)
    REFERENCES rorca.authority_provider_bindings(id, workspace_id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, capability, idempotency_key),
  CHECK (
    (capability = 'database.backup.create' AND target_identity_hash IS NULL)
    OR (capability = 'database.backup.restore' AND target_identity_hash IS NOT NULL)
  ),
  CHECK (
    (state = 'started' AND receipt_id IS NULL AND result_record IS NULL
      AND cleanup_evidence IS NULL AND settled_at IS NULL)
    OR (state = 'succeeded' AND receipt_id IS NOT NULL AND result_record IS NOT NULL
      AND cleanup_evidence IS NULL AND settled_at IS NOT NULL)
    OR (state = 'cleanup_required' AND receipt_id IS NULL AND result_record IS NULL
      AND cleanup_evidence IS NOT NULL AND settled_at IS NOT NULL)
  )
);

ALTER TABLE rorca.database_authority_operation_grants
  ADD CONSTRAINT database_authority_grant_consuming_operation_fk
  FOREIGN KEY (consumed_by_operation_id)
  REFERENCES rorca.database_backup_restore_operations(id) ON DELETE RESTRICT;

CREATE INDEX database_backup_artifacts_source_idx
  ON rorca.database_backup_artifacts (workspace_id, source_binding_id, created_at DESC);
CREATE INDEX database_backup_restore_operations_reconciliation_idx
  ON rorca.database_backup_restore_operations (state, created_at)
  WHERE state = 'started';
CREATE INDEX database_backup_restore_operations_artifact_idx
  ON rorca.database_backup_restore_operations (artifact_id, capability);

CREATE FUNCTION rorca.guard_database_authority_grant_transition_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, rorca
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Database authority grants are immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
     OR OLD.binding_id IS DISTINCT FROM NEW.binding_id
     OR OLD.binding_generation IS DISTINCT FROM NEW.binding_generation
     OR OLD.capability IS DISTINCT FROM NEW.capability
     OR OLD.risk_class IS DISTINCT FROM NEW.risk_class
     OR OLD.subject_hash IS DISTINCT FROM NEW.subject_hash
     OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
     OR OLD.issued_by_authority_hash IS DISTINCT FROM NEW.issued_by_authority_hash
     OR OLD.created_at IS DISTINCT FROM NEW.created_at
     OR OLD.consumed_by_operation_id IS NOT NULL
     OR OLD.revoked_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'Database authority grant subject is immutable and single-use' USING ERRCODE = '42501';
  END IF;
  IF NEW.consumed_by_operation_id IS NOT NULL THEN
    IF NEW.consumed_at IS NULL OR NEW.revoked_at IS NOT NULL
       OR clock_timestamp() >= OLD.expires_at
       OR NEW.consumed_at < OLD.created_at
       OR NEW.consumed_at > clock_timestamp()
    THEN
      RAISE EXCEPTION 'Database authority grant consumption is invalid' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.revoked_at IS NOT NULL THEN
    IF NEW.consumed_at IS NOT NULL OR NEW.revoked_at < OLD.created_at
       OR NEW.revoked_at > clock_timestamp()
    THEN
      RAISE EXCEPTION 'Database authority grant revocation is invalid' USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'Database authority grant requires consumption or revocation' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER database_authority_grant_transition
BEFORE UPDATE OR DELETE ON rorca.database_authority_operation_grants
FOR EACH ROW EXECUTE FUNCTION rorca.guard_database_authority_grant_transition_v1();

CREATE FUNCTION rorca.deny_database_backup_artifact_mutation_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, rorca
AS $$
BEGIN
  RAISE EXCEPTION 'Database backup artifact records are immutable' USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER database_backup_artifact_immutability
BEFORE UPDATE OR DELETE ON rorca.database_backup_artifacts
FOR EACH ROW EXECUTE FUNCTION rorca.deny_database_backup_artifact_mutation_v1();

CREATE FUNCTION rorca.guard_database_backup_operation_transition_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, rorca
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Database backup operations are immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
     OR OLD.binding_id IS DISTINCT FROM NEW.binding_id
     OR OLD.binding_generation IS DISTINCT FROM NEW.binding_generation
     OR OLD.capability IS DISTINCT FROM NEW.capability
     OR OLD.authority_grant_id IS DISTINCT FROM NEW.authority_grant_id
     OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
     OR OLD.request_hash IS DISTINCT FROM NEW.request_hash
     OR OLD.artifact_id IS DISTINCT FROM NEW.artifact_id
     OR OLD.target_identity_hash IS DISTINCT FROM NEW.target_identity_hash
     OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'Database backup operation authority is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.state <> 'started' OR NEW.state NOT IN ('succeeded', 'cleanup_required') THEN
    RAISE EXCEPTION 'Database backup operation permits one terminal transition' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM rorca.database_authority_operation_grants grant_record
     WHERE grant_record.id = NEW.authority_grant_id
       AND grant_record.workspace_id = NEW.workspace_id
       AND grant_record.binding_id = NEW.binding_id
       AND grant_record.binding_generation = NEW.binding_generation
       AND grant_record.capability = NEW.capability
       AND grant_record.subject_hash = NEW.request_hash
       AND grant_record.risk_class = CASE NEW.capability
         WHEN 'database.backup.create' THEN 'elevated'
         WHEN 'database.backup.restore' THEN 'high'
       END
       AND grant_record.consumed_by_operation_id = NEW.id
       AND grant_record.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Database backup operation lacks its exact consumed authority grant'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.state = 'succeeded' THEN
    IF NOT EXISTS (
      SELECT 1 FROM rorca.authority_operation_receipts receipt
       WHERE receipt.id = NEW.receipt_id
         AND receipt.workspace_id = NEW.workspace_id
         AND receipt.binding_id = NEW.binding_id
         AND receipt.binding_generation = NEW.binding_generation
         AND receipt.capability = NEW.capability
         AND receipt.request_hash = NEW.request_hash
    ) THEN
      RAISE EXCEPTION 'Database backup operation receipt does not match exact authority subject'
        USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM rorca.database_backup_artifacts artifact
       WHERE artifact.id = NEW.artifact_id AND artifact.workspace_id = NEW.workspace_id
    ) THEN
      RAISE EXCEPTION 'Database backup operation cannot settle without its verified artifact'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER database_backup_operation_transition
BEFORE UPDATE OR DELETE ON rorca.database_backup_restore_operations
FOR EACH ROW EXECUTE FUNCTION rorca.guard_database_backup_operation_transition_v1();

ALTER TABLE rorca.database_authority_operation_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.database_backup_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.database_backup_restore_operations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE rorca.database_authority_operation_grants FROM PUBLIC;
REVOKE ALL ON TABLE rorca.database_backup_artifacts FROM PUBLIC;
REVOKE ALL ON TABLE rorca.database_backup_restore_operations FROM PUBLIC;
REVOKE ALL ON FUNCTION rorca.guard_database_authority_grant_transition_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION rorca.deny_database_backup_artifact_mutation_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION rorca.guard_database_backup_operation_transition_v1() FROM PUBLIC;

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
    RAISE EXCEPTION 'registered database-backup runtime principal is required' USING ERRCODE = '42501';
  END IF;
  IF writer_user IS NULL OR writer_user = '' OR writer_user = runtime_user
     OR NOT EXISTS (
       SELECT 1 FROM rorca.wave2_database_principals
       WHERE database_user = writer_user AND principal_class = 'canonical_writer'
     )
  THEN
    RAISE EXCEPTION 'registered distinct database-backup canonical writer is required' USING ERRCODE = '42501';
  END IF;

  FOR request_role IN
    SELECT rolname FROM pg_roles WHERE rolname IN ('authenticated', 'anon')
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE rorca.database_authority_operation_grants FROM %I', request_role);
    EXECUTE format('REVOKE ALL ON TABLE rorca.database_backup_artifacts FROM %I', request_role);
    EXECUTE format('REVOKE ALL ON TABLE rorca.database_backup_restore_operations FROM %I', request_role);
    EXECUTE format('REVOKE ALL ON FUNCTION rorca.guard_database_authority_grant_transition_v1() FROM %I', request_role);
    EXECUTE format('REVOKE ALL ON FUNCTION rorca.deny_database_backup_artifact_mutation_v1() FROM %I', request_role);
    EXECUTE format('REVOKE ALL ON FUNCTION rorca.guard_database_backup_operation_transition_v1() FROM %I', request_role);
  END LOOP;

  EXECUTE format('GRANT SELECT ON rorca.database_authority_operation_grants TO %I', runtime_user);
  EXECUTE format(
    'GRANT UPDATE (consumed_by_operation_id, consumed_at) ON rorca.database_authority_operation_grants TO %I',
    runtime_user
  );
  EXECUTE format('GRANT SELECT, INSERT ON rorca.database_backup_artifacts TO %I', runtime_user);
  EXECUTE format('GRANT SELECT, INSERT ON rorca.database_backup_restore_operations TO %I', runtime_user);
  EXECUTE format(
    'GRANT UPDATE (state, receipt_id, result_record, cleanup_evidence, settled_at) ON rorca.database_backup_restore_operations TO %I',
    runtime_user
  );
  EXECUTE format('GRANT SELECT ON rorca.database_backup_artifacts, rorca.database_backup_restore_operations TO %I', writer_user);
  EXECUTE format('GRANT SELECT, INSERT ON rorca.database_authority_operation_grants TO %I', writer_user);
  EXECUTE format('GRANT UPDATE (revoked_at) ON rorca.database_authority_operation_grants TO %I', writer_user);

  EXECUTE format(
    'CREATE POLICY database_authority_grants_runtime_use ON rorca.database_authority_operation_grants FOR ALL TO %I USING (current_user = %L) WITH CHECK (current_user = %L)',
    runtime_user, runtime_user, runtime_user
  );
  EXECUTE format(
    'CREATE POLICY database_authority_grants_writer_mutation ON rorca.database_authority_operation_grants FOR ALL TO %I USING (current_user = %L) WITH CHECK (current_user = %L)',
    writer_user, writer_user, writer_user
  );
  EXECUTE format(
    'CREATE POLICY database_backup_artifacts_runtime_write ON rorca.database_backup_artifacts FOR ALL TO %I USING (current_user = %L) WITH CHECK (current_user = %L)',
    runtime_user, runtime_user, runtime_user
  );
  EXECUTE format(
    'CREATE POLICY database_backup_operations_runtime_write ON rorca.database_backup_restore_operations FOR ALL TO %I USING (current_user = %L) WITH CHECK (current_user = %L)',
    runtime_user, runtime_user, runtime_user
  );
  EXECUTE format(
    'CREATE POLICY database_backup_artifacts_writer_read ON rorca.database_backup_artifacts FOR SELECT TO %I USING (current_user = %L)',
    writer_user, writer_user
  );
  EXECUTE format(
    'CREATE POLICY database_backup_operations_writer_read ON rorca.database_backup_restore_operations FOR SELECT TO %I USING (current_user = %L)',
    writer_user, writer_user
  );
END;
$$;
