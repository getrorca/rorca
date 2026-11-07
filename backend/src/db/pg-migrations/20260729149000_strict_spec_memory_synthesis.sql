-- Provider-neutral strict spec-memory synthesis receipts. The receipt is an
-- immutable, payload-safe idempotency fence; synthesized memory content remains
-- in the canonical memories table.

CREATE TABLE rorca.spec_memory_synthesis_receipts (
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  spec_id TEXT NOT NULL,
  save_generation BIGINT NOT NULL CHECK(save_generation > 0),
  policy_hash TEXT NOT NULL CHECK(policy_hash ~ '^[0-9a-f]{64}$'),
  application_job_id UUID NOT NULL UNIQUE REFERENCES rorca.spec_jobs(id) ON DELETE RESTRICT,
  memory_id INTEGER NOT NULL UNIQUE REFERENCES rorca.memories(id) ON DELETE RESTRICT,
  input_hash TEXT NOT NULL CHECK(input_hash ~ '^sha256:[0-9a-f]{64}$'),
  output_hash TEXT NOT NULL CHECK(output_hash ~ '^sha256:[0-9a-f]{64}$'),
  sandbox_profile TEXT NOT NULL CHECK(sandbox_profile = 'linux-bwrap-strict-memory-v1'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,spec_id,save_generation,policy_hash)
);

ALTER TABLE rorca.spec_memory_synthesis_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.spec_memory_synthesis_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY strict_memory_receipt_read ON rorca.spec_memory_synthesis_receipts
FOR SELECT USING (
  (current_setting('rorca.migration_mode',TRUE)='on' AND EXISTS (
    SELECT 1 FROM rorca.wave2_database_principals p
     WHERE p.database_user=current_user AND p.principal_class='migration_owner'
  )) OR (
    workspace_id=current_setting('rorca.workspace_id',TRUE) AND EXISTS (
      SELECT 1 FROM rorca.wave2_database_principals p
       WHERE p.database_user=current_user AND p.principal_class='internal_runtime'
    )
  )
);
CREATE POLICY strict_memory_receipt_insert ON rorca.spec_memory_synthesis_receipts
FOR INSERT WITH CHECK (
  workspace_id=current_setting('rorca.workspace_id',TRUE) AND EXISTS (
    SELECT 1 FROM rorca.wave2_database_principals p
     WHERE p.database_user=current_user AND p.principal_class='internal_runtime'
  )
);

CREATE TRIGGER spec_memory_synthesis_receipts_immutable
BEFORE UPDATE OR DELETE ON rorca.spec_memory_synthesis_receipts
FOR EACH ROW EXECUTE FUNCTION rorca.w2_reject_immutable_mutation();
CREATE TRIGGER spec_memory_synthesis_receipts_no_truncate
BEFORE TRUNCATE ON rorca.spec_memory_synthesis_receipts
FOR EACH STATEMENT EXECUTE FUNCTION rorca.w2_reject_immutable_truncate();

DO $$
DECLARE runtime_user TEXT := current_setting('rorca.runtime_database_user',TRUE);
BEGIN
  IF runtime_user IS NULL OR runtime_user='' THEN
    RAISE EXCEPTION 'rorca.runtime_database_user must identify the runtime principal';
  END IF;
  EXECUTE format('GRANT SELECT,INSERT ON rorca.spec_memory_synthesis_receipts TO %I',runtime_user);
  -- The strict stage atomically inserts one memory with its receipt.
  EXECUTE format('GRANT SELECT,INSERT ON rorca.memories TO %I',runtime_user);
  EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE rorca.memories_id_seq TO %I',runtime_user);
END;
$$;

UPDATE rorca.wave2_schema_readiness SET migration_version=20260729149000,installed_at=clock_timestamp()
WHERE singleton=TRUE AND state='ready' AND migration_version=20260729147000
 AND contract_source_digest='sha256:ee4bb819784530868104f7f1a25e68d15105ca14ab8578d536055ade69992b2d';
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM rorca.wave2_schema_readiness WHERE singleton=TRUE AND state='ready' AND migration_version=20260729149000) THEN
  RAISE EXCEPTION 'Wave 2 strict-memory readiness transition failed closed' USING ERRCODE='55000';
 END IF;
END $$;
