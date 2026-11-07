-- Exact-run post-save workflow reconciliation audit.
-- Application spec_jobs rows remain canonical; pg-boss is read-only transport evidence.

CREATE TABLE rorca.spec_post_save_reconciliation_audit (
  id BIGSERIAL PRIMARY KEY,
  schema_version TEXT NOT NULL DEFAULT 'rorca.spec-post-save-reconciliation-audit.v1'
    CHECK (schema_version = 'rorca.spec-post-save-reconciliation-audit.v1'),
  workspace_id TEXT NOT NULL,
  spec_id TEXT NOT NULL CHECK (char_length(spec_id) BETWEEN 1 AND 256),
  workflow_run_id BIGINT,
  stage_key TEXT CHECK (stage_key IS NULL OR stage_key IN ('enrich','matchSkills','memorySynthesis')),
  application_job_id UUID,
  boss_job_id UUID,
  operation_id TEXT NOT NULL CHECK (
    char_length(operation_id) BETWEEN 8 AND 200
    AND operation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{7,199}$'
  ),
  source TEXT NOT NULL CHECK (source IN ('operator','repair','stage_retry','worker_recovery')),
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted','rejected','no_op')),
  reason_code TEXT NOT NULL CHECK (char_length(reason_code) BETWEEN 1 AND 96),
  before_stage_status TEXT CHECK (before_stage_status IS NULL OR before_stage_status IN ('pending','queued','running','completed','failed','skipped')),
  after_stage_status TEXT CHECK (after_stage_status IS NULL OR after_stage_status IN ('pending','queued','running','completed','failed','skipped')),
  application_job_status TEXT CHECK (application_job_status IS NULL OR application_job_status IN ('pending','running','completed','failed','cancelled','superseded')),
  transport_location TEXT CHECK (transport_location IS NULL OR transport_location IN ('live','archive','missing')),
  transport_state TEXT CHECK (transport_state IS NULL OR char_length(transport_state) BETWEEN 1 AND 32),
  binding_hash TEXT NOT NULL CHECK (binding_hash ~ '^sha256:[0-9a-f]{64}$'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);

CREATE INDEX idx_spec_post_save_reconciliation_subject
  ON rorca.spec_post_save_reconciliation_audit(workspace_id,spec_id,workflow_run_id,recorded_at DESC,id DESC);
CREATE INDEX idx_spec_post_save_reconciliation_operation
  ON rorca.spec_post_save_reconciliation_audit(workspace_id,operation_id,recorded_at DESC,id DESC);

CREATE TRIGGER spec_post_save_reconciliation_audit_immutable
  BEFORE UPDATE OR DELETE ON rorca.spec_post_save_reconciliation_audit
  FOR EACH ROW EXECUTE FUNCTION rorca.w2_reject_immutable_mutation();
CREATE TRIGGER spec_post_save_reconciliation_audit_no_truncate
  BEFORE TRUNCATE ON rorca.spec_post_save_reconciliation_audit
  FOR EACH STATEMENT EXECUTE FUNCTION rorca.w2_reject_immutable_truncate();

ALTER TABLE rorca.spec_post_save_reconciliation_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.spec_post_save_reconciliation_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY spec_post_save_reconciliation_audit_runtime
  ON rorca.spec_post_save_reconciliation_audit
  USING (
    (current_setting('rorca.migration_mode',TRUE)='on' AND EXISTS (
      SELECT 1 FROM rorca.wave2_database_principals p
      WHERE p.database_user=current_user AND p.principal_class='migration_owner'
    )) OR
    (workspace_id=current_setting('rorca.workspace_id',TRUE) AND EXISTS (
      SELECT 1 FROM rorca.wave2_database_principals p
      WHERE p.database_user=current_user AND p.principal_class='internal_runtime'
    ))
  )
  WITH CHECK (
    (current_setting('rorca.migration_mode',TRUE)='on' AND EXISTS (
      SELECT 1 FROM rorca.wave2_database_principals p
      WHERE p.database_user=current_user AND p.principal_class='migration_owner'
    )) OR
    (workspace_id=current_setting('rorca.workspace_id',TRUE) AND EXISTS (
      SELECT 1 FROM rorca.wave2_database_principals p
      WHERE p.database_user=current_user AND p.principal_class='internal_runtime'
    ))
  );

DO $$
DECLARE runtime_user TEXT := current_setting('rorca.runtime_database_user',TRUE);
BEGIN
  IF runtime_user IS NULL OR runtime_user='' THEN
    RAISE EXCEPTION 'rorca.runtime_database_user must identify the runtime principal';
  END IF;
  EXECUTE format('GRANT SELECT,INSERT ON rorca.spec_post_save_reconciliation_audit TO %I',runtime_user);
  -- SELECT ... FOR UPDATE is required to bind reconciliation to the exact
  -- application job row; the service never changes the job outcome.
  EXECUTE format('GRANT SELECT,UPDATE ON rorca.spec_jobs TO %I',runtime_user);
  EXECUTE format('GRANT SELECT,UPDATE ON rorca.spec_post_save_workflow_runs,rorca.spec_post_save_workflow_stages TO %I',runtime_user);
  EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE rorca.spec_post_save_reconciliation_audit_id_seq TO %I',runtime_user);
END;
$$;
