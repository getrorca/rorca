-- Durable SMC-004 production-migration authority. The exact backup, manifest,
-- target, window, health/abort evidence, recovery plan and owner are sealed by
-- the one-use critical grant subject. A waiting external gate reserves that
-- subject without consuming the grant. Credentials and migration SQL remain
-- outside core authority storage.

ALTER TABLE rorca.database_authority_operation_grants
  DROP CONSTRAINT IF EXISTS database_authority_operation_grants_capability_check,
  DROP CONSTRAINT IF EXISTS database_authority_operation_grants_risk_class_check,
  DROP CONSTRAINT IF EXISTS database_authority_operation_grants_check,
  DROP CONSTRAINT IF EXISTS database_authority_operation_grants_check1,
  DROP CONSTRAINT IF EXISTS database_authority_operation_grants_check2,
  DROP CONSTRAINT IF EXISTS database_authority_operation_grants_check3;

ALTER TABLE rorca.database_authority_operation_grants
  ADD CONSTRAINT database_authority_operation_grants_capability_check
    CHECK (capability IN (
      'database.backup.create',
      'database.backup.restore',
      'database.migration.apply.staging',
      'database.migration.apply.production'
    )),
  ADD CONSTRAINT database_authority_operation_grants_risk_class_check
    CHECK (
      (capability = 'database.backup.create' AND risk_class = 'elevated')
      OR (capability IN ('database.backup.restore', 'database.migration.apply.staging') AND risk_class = 'high')
      OR (capability = 'database.migration.apply.production' AND risk_class = 'critical')
    );

CREATE TABLE rorca.database_production_migration_operations (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  binding_id UUID NOT NULL,
  binding_generation BIGINT NOT NULL CHECK (binding_generation > 0),
  authority_grant_id UUID NOT NULL UNIQUE
    REFERENCES rorca.database_authority_operation_grants(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 255),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^sha256:[0-9a-f]{64}$'),
  manifest_id UUID NOT NULL,
  manifest_digest TEXT NOT NULL CHECK (manifest_digest ~ '^sha256:[0-9a-f]{64}$'),
  target_identity_hash TEXT NOT NULL CHECK (target_identity_hash ~ '^sha256:[0-9a-f]{64}$'),
  target_digest TEXT NOT NULL CHECK (target_digest ~ '^sha256:[0-9a-f]{64}$'),
  backup_artifact_id UUID NOT NULL,
  backup_record_hash TEXT NOT NULL CHECK (backup_record_hash ~ '^sha256:[0-9a-f]{64}$'),
  window_digest TEXT NOT NULL CHECK (window_digest ~ '^sha256:[0-9a-f]{64}$'),
  evidence_digest TEXT NOT NULL CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  recovery_plan_digest TEXT NOT NULL CHECK (recovery_plan_digest ~ '^sha256:[0-9a-f]{64}$'),
  recovery_owner_digest TEXT NOT NULL CHECK (recovery_owner_digest ~ '^sha256:[0-9a-f]{64}$'),
  external_gate_digest TEXT NOT NULL CHECK (external_gate_digest ~ '^sha256:[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('waiting', 'started', 'succeeded', 'aborted')),
  receipt_id UUID UNIQUE REFERENCES rorca.authority_operation_receipts(id) ON DELETE RESTRICT,
  before_schema_hash TEXT CHECK (before_schema_hash ~ '^sha256:[0-9a-f]{64}$'),
  after_schema_hash TEXT CHECK (after_schema_hash ~ '^sha256:[0-9a-f]{64}$'),
  result_record JSONB CHECK (
    result_record IS NULL OR (
      jsonb_typeof(result_record) = 'object'
      AND result_record ->> 'version' = 'rorca.production-migration-receipt.v1'
      AND result_record ->> 'operationId' = id::TEXT
      AND result_record ->> 'receiptId' = receipt_id::TEXT
      AND result_record ->> 'capability' = 'database.migration.apply.production'
      AND result_record ->> 'requestHash' = request_hash
      AND result_record ->> 'authorityGrantId' = authority_grant_id::TEXT
      AND result_record ->> 'manifestId' = manifest_id::TEXT
      AND result_record ->> 'manifestDigest' = manifest_digest
      AND result_record #>> '{target,targetIdentityHash}' = target_identity_hash
      AND result_record #>> '{target,targetDigest}' = target_digest
      AND result_record #>> '{backup,artifactId}' = backup_artifact_id::TEXT
      AND result_record #>> '{backup,recordHash}' = backup_record_hash
      AND result_record #>> '{changeWindow,windowDigest}' = window_digest
      AND result_record ->> 'evidenceDigest' = evidence_digest
      AND result_record ->> 'recoveryPlanDigest' = recovery_plan_digest
      AND result_record ->> 'recoveryOwnerDigest' = recovery_owner_digest
      AND result_record ->> 'externalGateDigest' = external_gate_digest
      AND result_record ->> 'beforeSchemaHash' = before_schema_hash
      AND result_record ->> 'afterSchemaHash' = after_schema_hash
      AND result_record ->> 'status' = state
      AND result_record #>> '{finalConsistency,verified}' = 'true'
      AND result_record #>> '{finalConsistency,schemaHash}' = after_schema_hash
      AND rorca.authority_metadata_is_reference_only_v1(result_record)
    )
  ),
  abort_proof JSONB CHECK (
    abort_proof IS NULL OR (
      jsonb_typeof(abort_proof) = 'object'
      AND abort_proof ->> 'strategy' IN ('rollback', 'forward-fix', 'restore')
      AND abort_proof ->> 'resultingSchemaHash' = after_schema_hash
      AND rorca.authority_metadata_is_reference_only_v1(abort_proof)
    )
  ),
  final_consistency JSONB CHECK (
    final_consistency IS NULL OR (
      jsonb_typeof(final_consistency) = 'object'
      AND final_consistency ->> 'verified' = 'true'
      AND final_consistency ->> 'schemaHash' = after_schema_hash
      AND final_consistency ->> 'migrationHistoryDigest' ~ '^sha256:[0-9a-f]{64}$'
      AND rorca.authority_metadata_is_reference_only_v1(final_consistency)
    )
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  started_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  FOREIGN KEY (binding_id, workspace_id)
    REFERENCES rorca.authority_provider_bindings(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (backup_artifact_id, workspace_id)
    REFERENCES rorca.database_backup_artifacts(id, workspace_id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (workspace_id, target_identity_hash, manifest_digest),
  CHECK (
    (state = 'waiting' AND receipt_id IS NULL
      AND before_schema_hash IS NULL AND after_schema_hash IS NULL
      AND result_record IS NULL AND abort_proof IS NULL
      AND final_consistency IS NULL AND settled_at IS NULL)
    OR (state = 'started' AND receipt_id IS NULL
      AND before_schema_hash IS NULL AND after_schema_hash IS NULL
      AND result_record IS NULL
      AND final_consistency IS NULL AND settled_at IS NULL)
    OR (state = 'succeeded' AND receipt_id IS NOT NULL
      AND before_schema_hash IS NOT NULL AND after_schema_hash IS NOT NULL
      AND result_record IS NOT NULL AND abort_proof IS NULL
      AND final_consistency IS NOT NULL AND settled_at IS NOT NULL)
    OR (state = 'aborted' AND receipt_id IS NOT NULL
      AND before_schema_hash IS NOT NULL AND after_schema_hash IS NOT NULL
      AND result_record IS NOT NULL AND abort_proof IS NOT NULL
      AND final_consistency IS NOT NULL AND settled_at IS NOT NULL)
  )
);

CREATE TABLE rorca.database_production_migration_attempts (
  workspace_id TEXT NOT NULL,
  binding_id UUID NOT NULL,
  binding_generation BIGINT NOT NULL CHECK (binding_generation > 0),
  target_identity_hash TEXT NOT NULL CHECK (target_identity_hash ~ '^sha256:[0-9a-f]{64}$'),
  operation_id UUID NOT NULL
    REFERENCES rorca.database_production_migration_operations(id) ON DELETE RESTRICT,
  manifest_digest TEXT NOT NULL CHECK (manifest_digest ~ '^sha256:[0-9a-f]{64}$'),
  migration_id TEXT NOT NULL CHECK (
    length(migration_id) BETWEEN 1 AND 255
    AND migration_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._:/+-]*$'
  ),
  migration_content_hash TEXT NOT NULL CHECK (migration_content_hash ~ '^sha256:[0-9a-f]{64}$'),
  target_ordinal BIGINT NOT NULL CHECK (target_ordinal >= 0),
  before_schema_hash TEXT NOT NULL CHECK (before_schema_hash ~ '^sha256:[0-9a-f]{64}$'),
  expected_schema_hash TEXT NOT NULL CHECK (expected_schema_hash ~ '^sha256:[0-9a-f]{64}$'),
  attempted_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (binding_id, workspace_id)
    REFERENCES rorca.authority_provider_bindings(id, workspace_id) ON DELETE RESTRICT,
  PRIMARY KEY (operation_id, migration_id),
  UNIQUE (workspace_id, target_identity_hash, migration_id),
  UNIQUE (workspace_id, target_identity_hash, target_ordinal)
);

CREATE TABLE rorca.database_production_migration_history (
  workspace_id TEXT NOT NULL,
  binding_id UUID NOT NULL,
  binding_generation BIGINT NOT NULL CHECK (binding_generation > 0),
  target_identity_hash TEXT NOT NULL CHECK (target_identity_hash ~ '^sha256:[0-9a-f]{64}$'),
  operation_id UUID NOT NULL
    REFERENCES rorca.database_production_migration_operations(id) ON DELETE RESTRICT,
  manifest_digest TEXT NOT NULL CHECK (manifest_digest ~ '^sha256:[0-9a-f]{64}$'),
  migration_id TEXT NOT NULL CHECK (
    length(migration_id) BETWEEN 1 AND 255
    AND migration_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._:/+-]*$'
  ),
  migration_content_hash TEXT NOT NULL CHECK (migration_content_hash ~ '^sha256:[0-9a-f]{64}$'),
  target_ordinal BIGINT NOT NULL CHECK (target_ordinal >= 0),
  schema_hash_after TEXT NOT NULL CHECK (schema_hash_after ~ '^sha256:[0-9a-f]{64}$'),
  statement_outcomes JSONB NOT NULL CHECK (
    jsonb_typeof(statement_outcomes) = 'array'
    AND jsonb_array_length(statement_outcomes) > 0
    AND rorca.authority_metadata_is_reference_only_v1(statement_outcomes)
  ),
  verification JSONB NOT NULL CHECK (
    jsonb_typeof(verification) = 'object'
    AND verification ->> 'passed' = 'true'
    AND verification ->> 'schemaPassed' = 'true'
    AND verification ->> 'actualSchemaHash' = schema_hash_after
    AND rorca.authority_metadata_is_reference_only_v1(verification)
  ),
  applied_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (binding_id, workspace_id)
    REFERENCES rorca.authority_provider_bindings(id, workspace_id) ON DELETE RESTRICT,
  PRIMARY KEY (workspace_id, target_identity_hash, migration_id),
  UNIQUE (workspace_id, target_identity_hash, target_ordinal)
);

CREATE INDEX database_production_migration_operations_reconciliation_idx
  ON rorca.database_production_migration_operations (state, created_at)
  WHERE state IN ('waiting', 'started');
CREATE INDEX database_production_migration_attempts_operation_idx
  ON rorca.database_production_migration_attempts (operation_id, target_ordinal);
CREATE INDEX database_production_migration_history_operation_idx
  ON rorca.database_production_migration_history (operation_id, target_ordinal);

CREATE OR REPLACE FUNCTION rorca.guard_database_authority_grant_transition_v1()
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
    IF (NEW.capability IN ('database.backup.create', 'database.backup.restore') AND NOT EXISTS (
          SELECT 1 FROM rorca.database_backup_restore_operations operation
           WHERE operation.id = NEW.consumed_by_operation_id
             AND operation.authority_grant_id = NEW.id
             AND operation.workspace_id = NEW.workspace_id
             AND operation.binding_id = NEW.binding_id
             AND operation.binding_generation = NEW.binding_generation
             AND operation.capability = NEW.capability
             AND operation.request_hash = NEW.subject_hash
        ))
       OR (NEW.capability = 'database.migration.apply.staging' AND NOT EXISTS (
          SELECT 1 FROM rorca.database_staging_migration_operations operation
           WHERE operation.id = NEW.consumed_by_operation_id
             AND operation.authority_grant_id = NEW.id
             AND operation.workspace_id = NEW.workspace_id
             AND operation.binding_id = NEW.binding_id
             AND operation.binding_generation = NEW.binding_generation
             AND operation.request_hash = NEW.subject_hash
        ))
       OR (NEW.capability = 'database.migration.apply.production' AND NOT EXISTS (
          SELECT 1 FROM rorca.database_production_migration_operations operation
           WHERE operation.id = NEW.consumed_by_operation_id
             AND operation.authority_grant_id = NEW.id
             AND operation.workspace_id = NEW.workspace_id
             AND operation.binding_id = NEW.binding_id
             AND operation.binding_generation = NEW.binding_generation
             AND operation.request_hash = NEW.subject_hash
        ))
    THEN
      RAISE EXCEPTION 'Database authority grant consuming operation does not match its exact subject'
        USING ERRCODE = '42501';
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

CREATE FUNCTION rorca.guard_database_production_migration_attempt_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, rorca
AS $$
DECLARE
  previous_ordinal BIGINT;
  previous_schema_hash TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Database production migration attempts are append-only' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'database-production-history:' || NEW.workspace_id || ':' || NEW.target_identity_hash,
    0
  ));
  IF NOT EXISTS (
    SELECT 1 FROM rorca.database_production_migration_operations operation
     WHERE operation.id = NEW.operation_id
       AND operation.state = 'started'
       AND operation.workspace_id = NEW.workspace_id
       AND operation.binding_id = NEW.binding_id
       AND operation.binding_generation = NEW.binding_generation
       AND operation.target_identity_hash = NEW.target_identity_hash
       AND operation.manifest_digest = NEW.manifest_digest
  ) THEN
    RAISE EXCEPTION 'Database production migration attempt lacks its active exact operation'
      USING ERRCODE = '42501';
  END IF;
  SELECT history.target_ordinal, history.schema_hash_after
    INTO previous_ordinal, previous_schema_hash
    FROM rorca.database_production_migration_history history
   WHERE history.workspace_id = NEW.workspace_id
     AND history.target_identity_hash = NEW.target_identity_hash
   ORDER BY history.target_ordinal DESC
   LIMIT 1;
  IF NEW.target_ordinal <> COALESCE(previous_ordinal + 1, 0) THEN
    RAISE EXCEPTION 'Database production migration attempt ordinal must be next after verified history'
      USING ERRCODE = '23514';
  END IF;
  IF previous_schema_hash IS NOT NULL AND NEW.before_schema_hash <> previous_schema_hash THEN
    RAISE EXCEPTION 'Database production migration attempt before-schema hash conflicts with verified history'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER database_production_migration_attempt_append_only
BEFORE INSERT OR UPDATE OR DELETE ON rorca.database_production_migration_attempts
FOR EACH ROW EXECUTE FUNCTION rorca.guard_database_production_migration_attempt_v1();

CREATE FUNCTION rorca.guard_database_production_migration_operation_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, rorca
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Database production migration operations are immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
     OR OLD.binding_id IS DISTINCT FROM NEW.binding_id
     OR OLD.binding_generation IS DISTINCT FROM NEW.binding_generation
     OR OLD.authority_grant_id IS DISTINCT FROM NEW.authority_grant_id
     OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
     OR OLD.request_hash IS DISTINCT FROM NEW.request_hash
     OR OLD.manifest_id IS DISTINCT FROM NEW.manifest_id
     OR OLD.manifest_digest IS DISTINCT FROM NEW.manifest_digest
     OR OLD.target_identity_hash IS DISTINCT FROM NEW.target_identity_hash
     OR OLD.target_digest IS DISTINCT FROM NEW.target_digest
     OR OLD.backup_artifact_id IS DISTINCT FROM NEW.backup_artifact_id
     OR OLD.backup_record_hash IS DISTINCT FROM NEW.backup_record_hash
     OR OLD.window_digest IS DISTINCT FROM NEW.window_digest
     OR OLD.evidence_digest IS DISTINCT FROM NEW.evidence_digest
     OR OLD.recovery_plan_digest IS DISTINCT FROM NEW.recovery_plan_digest
     OR OLD.recovery_owner_digest IS DISTINCT FROM NEW.recovery_owner_digest
     OR OLD.external_gate_digest IS DISTINCT FROM NEW.external_gate_digest
     OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'Database production migration operation subject is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.state = 'waiting' AND NEW.state = 'started' THEN
    IF NEW.receipt_id IS NOT NULL OR NEW.result_record IS NOT NULL OR NEW.settled_at IS NOT NULL THEN
      RAISE EXCEPTION 'Database production migration waiting promotion cannot settle' USING ERRCODE = '42501';
    END IF;
  ELSIF OLD.state = 'started' AND NEW.state = 'started' THEN
    IF OLD.abort_proof IS NOT NULL OR NEW.abort_proof IS NULL
       OR OLD.receipt_id IS DISTINCT FROM NEW.receipt_id
       OR OLD.before_schema_hash IS DISTINCT FROM NEW.before_schema_hash
       OR OLD.after_schema_hash IS DISTINCT FROM NEW.after_schema_hash
       OR OLD.result_record IS DISTINCT FROM NEW.result_record
       OR OLD.final_consistency IS DISTINCT FROM NEW.final_consistency
       OR OLD.started_at IS DISTINCT FROM NEW.started_at
       OR OLD.settled_at IS DISTINCT FROM NEW.settled_at
    THEN
      RAISE EXCEPTION 'Database production migration permits one durable abort-proof boundary'
        USING ERRCODE = '42501';
    END IF;
  ELSIF OLD.state = 'started' AND NEW.state IN ('succeeded', 'aborted') THEN
    IF (NEW.state = 'succeeded' AND (OLD.abort_proof IS NOT NULL OR NEW.abort_proof IS NOT NULL))
       OR (NEW.state = 'aborted' AND (
         OLD.abort_proof IS NULL OR NEW.abort_proof IS DISTINCT FROM OLD.abort_proof
       ))
    THEN
      RAISE EXCEPTION 'Database production migration terminal state conflicts with durable abort proof'
        USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM rorca.authority_operation_receipts receipt
       WHERE receipt.id = NEW.receipt_id
         AND receipt.workspace_id = NEW.workspace_id
         AND receipt.binding_id = NEW.binding_id
         AND receipt.binding_generation = NEW.binding_generation
         AND receipt.capability = 'database.migration.apply.production'
         AND receipt.request_hash = NEW.request_hash
         AND receipt.target_identity_hash = NEW.target_identity_hash
    ) THEN
      RAISE EXCEPTION 'Database production migration receipt does not match exact authority subject'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'Database production migration operation transition is invalid'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM rorca.database_authority_operation_grants grant_record
     WHERE grant_record.id = NEW.authority_grant_id
       AND grant_record.workspace_id = NEW.workspace_id
       AND grant_record.binding_id = NEW.binding_id
       AND grant_record.binding_generation = NEW.binding_generation
       AND grant_record.capability = 'database.migration.apply.production'
       AND grant_record.risk_class = 'critical'
       AND grant_record.subject_hash = NEW.request_hash
       AND grant_record.consumed_by_operation_id = NEW.id
       AND grant_record.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Database production migration operation lacks its exact consumed critical grant'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER database_production_migration_operation_transition
BEFORE UPDATE OR DELETE ON rorca.database_production_migration_operations
FOR EACH ROW EXECUTE FUNCTION rorca.guard_database_production_migration_operation_v1();

CREATE FUNCTION rorca.guard_database_production_migration_history_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, rorca
AS $$
DECLARE
  previous_ordinal BIGINT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Database production migration history is append-only' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'database-production-history:' || NEW.workspace_id || ':' || NEW.target_identity_hash,
    0
  ));
  IF NOT EXISTS (
    SELECT 1 FROM rorca.database_production_migration_operations operation
     WHERE operation.id = NEW.operation_id
       AND operation.state = 'started'
       AND operation.workspace_id = NEW.workspace_id
       AND operation.binding_id = NEW.binding_id
       AND operation.binding_generation = NEW.binding_generation
       AND operation.target_identity_hash = NEW.target_identity_hash
       AND operation.manifest_digest = NEW.manifest_digest
  ) THEN
    RAISE EXCEPTION 'Database production migration history lacks its active exact operation'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM rorca.database_production_migration_attempts attempt
     WHERE attempt.operation_id = NEW.operation_id
       AND attempt.workspace_id = NEW.workspace_id
       AND attempt.binding_id = NEW.binding_id
       AND attempt.binding_generation = NEW.binding_generation
       AND attempt.target_identity_hash = NEW.target_identity_hash
       AND attempt.manifest_digest = NEW.manifest_digest
       AND attempt.migration_id = NEW.migration_id
       AND attempt.migration_content_hash = NEW.migration_content_hash
       AND attempt.target_ordinal = NEW.target_ordinal
       AND attempt.expected_schema_hash = NEW.schema_hash_after
  ) THEN
    RAISE EXCEPTION 'Database production migration history lacks its exact durable attempt boundary'
      USING ERRCODE = '42501';
  END IF;
  SELECT max(history.target_ordinal) INTO previous_ordinal
    FROM rorca.database_production_migration_history history
   WHERE history.workspace_id = NEW.workspace_id
     AND history.target_identity_hash = NEW.target_identity_hash;
  IF NEW.target_ordinal <> COALESCE(previous_ordinal + 1, 0) THEN
    RAISE EXCEPTION 'Database production migration history ordinal must be gapless and increasing'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER database_production_migration_history_append_only
BEFORE INSERT OR UPDATE OR DELETE ON rorca.database_production_migration_history
FOR EACH ROW EXECUTE FUNCTION rorca.guard_database_production_migration_history_v1();

ALTER TABLE rorca.database_production_migration_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.database_production_migration_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.database_production_migration_history ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE rorca.database_production_migration_operations FROM PUBLIC;
REVOKE ALL ON TABLE rorca.database_production_migration_attempts FROM PUBLIC;
REVOKE ALL ON TABLE rorca.database_production_migration_history FROM PUBLIC;
REVOKE ALL ON FUNCTION rorca.guard_database_production_migration_operation_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION rorca.guard_database_production_migration_attempt_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION rorca.guard_database_production_migration_history_v1() FROM PUBLIC;

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
    RAISE EXCEPTION 'registered production-migration runtime principal is required' USING ERRCODE = '42501';
  END IF;
  IF writer_user IS NULL OR writer_user = '' OR writer_user = runtime_user
     OR NOT EXISTS (
       SELECT 1 FROM rorca.wave2_database_principals
       WHERE database_user = writer_user AND principal_class = 'canonical_writer'
     )
  THEN
    RAISE EXCEPTION 'registered distinct production-migration canonical writer is required' USING ERRCODE = '42501';
  END IF;

  FOR request_role IN
    SELECT rolname FROM pg_roles WHERE rolname IN ('authenticated', 'anon')
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE rorca.database_production_migration_operations FROM %I', request_role);
    EXECUTE format('REVOKE ALL ON TABLE rorca.database_production_migration_attempts FROM %I', request_role);
    EXECUTE format('REVOKE ALL ON TABLE rorca.database_production_migration_history FROM %I', request_role);
    EXECUTE format('REVOKE ALL ON FUNCTION rorca.guard_database_production_migration_operation_v1() FROM %I', request_role);
    EXECUTE format('REVOKE ALL ON FUNCTION rorca.guard_database_production_migration_attempt_v1() FROM %I', request_role);
    EXECUTE format('REVOKE ALL ON FUNCTION rorca.guard_database_production_migration_history_v1() FROM %I', request_role);
  END LOOP;

  EXECUTE format('GRANT SELECT, INSERT ON rorca.database_production_migration_operations TO %I', runtime_user);
  EXECUTE format(
    'GRANT UPDATE (state, receipt_id, before_schema_hash, after_schema_hash, result_record, abort_proof, final_consistency, started_at, settled_at) ON rorca.database_production_migration_operations TO %I',
    runtime_user
  );
  EXECUTE format('GRANT SELECT, INSERT ON rorca.database_production_migration_attempts TO %I', runtime_user);
  EXECUTE format('GRANT SELECT, INSERT ON rorca.database_production_migration_history TO %I', runtime_user);
  EXECUTE format('GRANT SELECT ON rorca.database_production_migration_operations, rorca.database_production_migration_attempts, rorca.database_production_migration_history TO %I', writer_user);

  EXECUTE format(
    'CREATE POLICY database_production_migration_operations_runtime_write ON rorca.database_production_migration_operations FOR ALL TO %I USING (current_user = %L) WITH CHECK (current_user = %L)',
    runtime_user, runtime_user, runtime_user
  );
  EXECUTE format(
    'CREATE POLICY database_production_migration_attempts_runtime_write ON rorca.database_production_migration_attempts FOR ALL TO %I USING (current_user = %L) WITH CHECK (current_user = %L)',
    runtime_user, runtime_user, runtime_user
  );
  EXECUTE format(
    'CREATE POLICY database_production_migration_history_runtime_write ON rorca.database_production_migration_history FOR ALL TO %I USING (current_user = %L) WITH CHECK (current_user = %L)',
    runtime_user, runtime_user, runtime_user
  );
  EXECUTE format(
    'CREATE POLICY database_production_migration_operations_writer_read ON rorca.database_production_migration_operations FOR SELECT TO %I USING (current_user = %L)',
    writer_user, writer_user
  );
  EXECUTE format(
    'CREATE POLICY database_production_migration_attempts_writer_read ON rorca.database_production_migration_attempts FOR SELECT TO %I USING (current_user = %L)',
    writer_user, writer_user
  );
  EXECUTE format(
    'CREATE POLICY database_production_migration_history_writer_read ON rorca.database_production_migration_history FOR SELECT TO %I USING (current_user = %L)',
    writer_user, writer_user
  );
END;
$$;
