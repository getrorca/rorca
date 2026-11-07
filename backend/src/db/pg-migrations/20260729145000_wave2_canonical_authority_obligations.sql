-- Canonical authority snapshots and closeout obligations. These rows are
-- append-only imports from independently governed spec/decision/provider-human
-- systems; mission/policy services may resolve them but may never mint them.

CREATE TABLE rorca.governed_spec_authority_snapshots (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  spec_id TEXT NOT NULL,
  spec_version BIGINT NOT NULL CHECK(spec_version>0),
  spec_hash TEXT NOT NULL CHECK(spec_hash ~ '^sha256:[0-9a-f]{64}$'),
  canonical_spec_path TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  repository_sha TEXT NOT NULL CHECK(repository_sha ~ '^[0-9a-f]{40}$'),
  approval_receipt_hash TEXT NOT NULL CHECK(approval_receipt_hash ~ '^sha256:[0-9a-f]{64}$'),
  lifecycle_state TEXT NOT NULL CHECK(lifecycle_state='approved'),
  imported_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,spec_id,spec_version,spec_hash)
);
CREATE TABLE rorca.governed_decision_authority_snapshots (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  decision_ref TEXT NOT NULL,
  decision_hash TEXT NOT NULL CHECK(decision_hash ~ '^sha256:[0-9a-f]{64}$'),
  decision_state TEXT NOT NULL CHECK(decision_state='accepted'),
  imported_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,decision_ref)
);
CREATE TABLE rorca.context_policy_authority_receipts (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  authority_receipt_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN('publish','activate')),
  authority_ref TEXT NOT NULL,
  artifact_hash TEXT NOT NULL CHECK(artifact_hash ~ '^sha256:[0-9a-f]{64}$'),
  scope_key TEXT,
  decision_state TEXT NOT NULL CHECK(decision_state='accepted'),
  provider_human_attestation_hash TEXT NOT NULL CHECK(provider_human_attestation_hash ~ '^sha256:[0-9a-f]{64}$'),
  imported_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,authority_receipt_id,operation),
  CHECK((operation='activate')=(scope_key IS NOT NULL))
);
CREATE TABLE rorca.governed_evidence_obligations (
  workspace_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  work_package_id TEXT NOT NULL,
  work_package_revision BIGINT NOT NULL,
  obligation_kind TEXT NOT NULL,
  minimum_trust TEXT NOT NULL CHECK(minimum_trust IN('host_observed','automated_test','provider_verified','provider_human')),
  required_status TEXT NOT NULL CHECK(required_status IN('passed','failed')),
  obligation_hash TEXT NOT NULL CHECK(obligation_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,mission_id,work_package_id,work_package_revision,obligation_kind),
  FOREIGN KEY(workspace_id,mission_id,work_package_id,work_package_revision)
    REFERENCES rorca.governed_work_package_revisions(workspace_id,mission_id,work_package_id,work_package_revision) ON DELETE RESTRICT
);

DO $$
DECLARE table_name TEXT;
DECLARE runtime_user TEXT := current_setting('rorca.runtime_database_user',TRUE);
BEGIN
  FOREACH table_name IN ARRAY ARRAY['governed_spec_authority_snapshots','governed_decision_authority_snapshots',
    'context_policy_authority_receipts','governed_evidence_obligations'] LOOP
    EXECUTE format('GRANT SELECT,UPDATE ON rorca.%I TO %I',table_name,runtime_user);
    EXECUTE format('ALTER TABLE rorca.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE rorca.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY %I ON rorca.%I FOR SELECT USING (
      (current_setting(''rorca.migration_mode'',TRUE)=''on'' AND EXISTS (SELECT 1 FROM rorca.wave2_database_principals p WHERE p.database_user=current_user AND p.principal_class=''migration_owner'')) OR
      (workspace_id=current_setting(''rorca.workspace_id'',TRUE) AND EXISTS (SELECT 1 FROM rorca.wave2_database_principals p WHERE p.database_user=current_user AND p.principal_class=''internal_runtime''))
    )','wave2_scoped_read_'||table_name,table_name);
    -- Row-locking SELECT (FOR KEY SHARE) also evaluates UPDATE USING policy.
    -- WITH CHECK FALSE plus immutable triggers prevents runtime mutation.
    EXECUTE format('CREATE POLICY %I ON rorca.%I FOR UPDATE USING (
      workspace_id=current_setting(''rorca.workspace_id'',TRUE) AND EXISTS (
        SELECT 1 FROM rorca.wave2_database_principals p WHERE p.database_user=current_user AND p.principal_class=''internal_runtime''
      )
    ) WITH CHECK (FALSE)','wave2_scoped_lock_'||table_name,table_name);
    EXECUTE format('CREATE POLICY %I ON rorca.%I FOR INSERT WITH CHECK (
      current_setting(''rorca.migration_mode'',TRUE)=''on'' AND EXISTS (
        SELECT 1 FROM rorca.wave2_database_principals p WHERE p.database_user=current_user AND p.principal_class=''migration_owner''
      )
    )','wave2_authority_import_'||table_name,table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON rorca.%I FOR EACH ROW EXECUTE FUNCTION rorca.w2_reject_immutable_mutation()',table_name||'_immutable',table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON rorca.%I FOR EACH STATEMENT EXECUTE FUNCTION rorca.w2_reject_immutable_truncate()',table_name||'_no_truncate',table_name);
  END LOOP;
END;
$$;

UPDATE rorca.wave2_schema_readiness SET migration_version=20260729145000,installed_at=clock_timestamp()
WHERE singleton=TRUE AND state='ready' AND migration_version=20260729144000
 AND contract_source_digest='sha256:ee4bb819784530868104f7f1a25e68d15105ca14ab8578d536055ade69992b2d';
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM rorca.wave2_schema_readiness WHERE singleton=TRUE AND state='ready' AND migration_version=20260729145000) THEN
  RAISE EXCEPTION 'Wave 2 canonical-authority readiness transition failed closed' USING ERRCODE='55000';
 END IF;
END $$;
