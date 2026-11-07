-- Replace implicit table-owner RLS bypass with an explicit, transaction-scoped
-- runtime database principal and workspace policy. The migration capability
-- exists only inside this migration transaction; ordinary runtime access must
-- bind rorca.workspace_id before touching a forced-RLS relation.

SELECT set_config('rorca.migration_mode','on',TRUE);

CREATE TABLE rorca.wave2_database_principals (
  database_user TEXT NOT NULL,
  principal_class TEXT NOT NULL CHECK(principal_class IN('migration_owner','internal_runtime')),
  grant_receipt_hash TEXT NOT NULL CHECK(grant_receipt_hash ~ '^sha256:[0-9a-f]{64}$'),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(database_user,principal_class)
);
DO $$
DECLARE runtime_user TEXT := current_setting('rorca.runtime_database_user',TRUE);
BEGIN
  IF runtime_user IS NULL OR runtime_user='' OR runtime_user=current_user
    OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=runtime_user AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolbypassrls) THEN
    RAISE EXCEPTION 'Wave 2 requires a distinct existing non-privileged RORCA_RUNTIME_DATABASE_USER' USING ERRCODE='42501';
  END IF;
  INSERT INTO rorca.wave2_database_principals(database_user,principal_class,grant_receipt_hash)
  VALUES(current_user,'migration_owner','sha256:7d43fca2eec77c24b9e3fbc841a10c6c5e25a75d1805750eef0bf653660ff3fe'),
        (runtime_user,'internal_runtime','sha256:9bd2c3125afcf88b38010ff3a42f06d873501003812c986e2f18488d9d8d84f4');
END $$;

ALTER TABLE rorca.wave2_database_principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.wave2_database_principals FORCE ROW LEVEL SECURITY;
CREATE POLICY wave2_principal_self_read ON rorca.wave2_database_principals
  FOR SELECT USING (database_user=current_user);
CREATE POLICY wave2_principal_migration_insert ON rorca.wave2_database_principals
  FOR INSERT WITH CHECK (database_user=current_user AND current_setting('rorca.migration_mode',TRUE)='on');

-- Global gate/readiness rows have no workspace_id. Runtime may only read them;
-- only the distinct migration principal can bind or advance them.
ALTER TABLE rorca.wave2_prerequisite_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.wave2_prerequisite_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE rorca.wave2_schema_readiness ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.wave2_schema_readiness FORCE ROW LEVEL SECURITY;
CREATE POLICY wave2_prerequisite_runtime_read ON rorca.wave2_prerequisite_receipts FOR SELECT USING (
  EXISTS(SELECT 1 FROM rorca.wave2_database_principals p WHERE p.database_user=current_user
    AND p.principal_class IN('migration_owner','internal_runtime'))
);
CREATE POLICY wave2_readiness_runtime_read ON rorca.wave2_schema_readiness FOR SELECT USING (
  EXISTS(SELECT 1 FROM rorca.wave2_database_principals p WHERE p.database_user=current_user
    AND p.principal_class IN('migration_owner','internal_runtime'))
);
CREATE POLICY wave2_prerequisite_migration_write ON rorca.wave2_prerequisite_receipts FOR ALL USING (
  current_setting('rorca.migration_mode',TRUE)='on' AND EXISTS(SELECT 1 FROM rorca.wave2_database_principals p
    WHERE p.database_user=current_user AND p.principal_class='migration_owner')
) WITH CHECK (current_setting('rorca.migration_mode',TRUE)='on');
CREATE POLICY wave2_readiness_migration_write ON rorca.wave2_schema_readiness FOR ALL USING (
  current_setting('rorca.migration_mode',TRUE)='on' AND EXISTS(SELECT 1 FROM rorca.wave2_database_principals p
    WHERE p.database_user=current_user AND p.principal_class='migration_owner')
) WITH CHECK (current_setting('rorca.migration_mode',TRUE)='on');

DO $$
DECLARE table_name TEXT;
DECLARE runtime_user TEXT := current_setting('rorca.runtime_database_user',TRUE);
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA rorca TO %I',runtime_user);
  EXECUTE format('GRANT SELECT ON rorca.wave2_database_principals,rorca.wave2_prerequisite_receipts,rorca.wave2_schema_readiness,
    rorca.workspaces,rorca.workspace_members,rorca.story_closeout_decisions,rorca.wave2_effective_readiness,
    rorca.context_contract_release_history,rorca.context_epoch_client_migrations,
    rorca.execution_cancellation_effective_state TO %I',runtime_user);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON rorca.ssdlc_lifecycle_evidence TO %I',runtime_user);
  FOREACH table_name IN ARRAY ARRAY[
    'execution_lease_events_id_seq','runtime_event_conflicts_id_seq','mission_control_replay_conflicts_id_seq',
    'mission_control_audit_id_seq','context_epoch_projection_reads_id_seq','context_epoch_write_rejections_id_seq',
    'ssdlc_lifecycle_evidence_id_seq'
  ] LOOP
    IF to_regclass('rorca.'||table_name) IS NOT NULL THEN
      EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE rorca.%I TO %I',table_name,runtime_user);
    END IF;
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY[
    'governed_missions','governed_mission_versions','governed_mission_heads','governed_work_packages',
    'governed_work_package_revisions','governed_work_package_dependencies','governed_work_package_heads',
    'governed_execution_attempts','execution_lease_slots','execution_leases','execution_lease_events',
    'context_policy_definitions','context_policy_activations','context_policy_activation_heads','context_scope_heads','context_checkpoints',
    'context_retrieval_receipts','context_retrieval_sources','context_bundles','context_bundle_deltas',
    'continuation_retry_budgets','continuation_retry_events','continuation_dispatches','continuation_dispatch_consumptions',
    'continuation_dispatch_outbox','continuation_dispatch_outcomes','continuation_quarantines',
    'runtime_event_stream_heads','runtime_events','runtime_event_conflicts','governed_closeout_evaluations',
    'execution_cancellation_requests','execution_cancellation_acknowledgements','plan_change_proposals',
    'plan_change_proposal_heads','plan_change_proposal_reviews','mission_control_idempotency','mission_control_replay_conflicts',
    'mission_control_audit','context_epoch_projection_reads','context_epoch_write_rejections',
    'context_epoch_retirement_evidence','context_epoch_retirement_review_decisions',
    'managed_executor_compatibility_events'
  ] LOOP
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON rorca.%I TO %I',table_name,runtime_user);
    EXECUTE format('ALTER TABLE rorca.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format(
      'CREATE POLICY %I ON rorca.%I USING (
        (current_setting(''rorca.migration_mode'',TRUE)=''on'' AND EXISTS (
          SELECT 1 FROM rorca.wave2_database_principals p WHERE p.database_user=current_user AND p.principal_class=''migration_owner''
        )) OR
        (workspace_id=current_setting(''rorca.workspace_id'',TRUE) AND EXISTS (
          SELECT 1 FROM rorca.wave2_database_principals p WHERE p.database_user=current_user AND p.principal_class=''internal_runtime''
        ))
      ) WITH CHECK (
        (current_setting(''rorca.migration_mode'',TRUE)=''on'' AND EXISTS (
          SELECT 1 FROM rorca.wave2_database_principals p WHERE p.database_user=current_user AND p.principal_class=''migration_owner''
        )) OR
        (workspace_id=current_setting(''rorca.workspace_id'',TRUE) AND EXISTS (
          SELECT 1 FROM rorca.wave2_database_principals p WHERE p.database_user=current_user AND p.principal_class=''internal_runtime''
        ))
      )',
      'wave2_explicit_runtime_'||table_name,table_name);
  END LOOP;
END;
$$;

CREATE TRIGGER wave2_database_principals_immutable BEFORE UPDATE OR DELETE ON rorca.wave2_database_principals
  FOR EACH ROW EXECUTE FUNCTION rorca.w2_reject_immutable_mutation();
CREATE TRIGGER wave2_database_principals_no_truncate BEFORE TRUNCATE ON rorca.wave2_database_principals
  FOR EACH STATEMENT EXECUTE FUNCTION rorca.w2_reject_immutable_truncate();

UPDATE rorca.wave2_schema_readiness
SET migration_version=20260729144000, installed_at=clock_timestamp()
WHERE singleton=TRUE AND state='ready' AND migration_version=20260729143000
  AND contract_source_digest='sha256:ee4bb819784530868104f7f1a25e68d15105ca14ab8578d536055ade69992b2d';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM rorca.wave2_schema_readiness WHERE singleton=TRUE AND state='ready'
    AND migration_version=20260729144000 AND contract_source_digest='sha256:ee4bb819784530868104f7f1a25e68d15105ca14ab8578d536055ade69992b2d') THEN
    RAISE EXCEPTION 'Wave 2 forced-RLS readiness transition failed closed' USING ERRCODE='55000';
  END IF;
END;
$$;
