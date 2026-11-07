-- Wave 2 rejected-SHA remediation: split canonical source writer, runtime
-- least privilege, receiver inbox, repair effect receipts, and worker attempts.
-- Forward-only; the migration runner owns the surrounding transaction.

SELECT set_config('rorca.migration_mode','on',TRUE);

DO $$
DECLARE runtime_user TEXT:=current_setting('rorca.runtime_database_user',TRUE);
DECLARE writer_user TEXT:=current_setting('rorca.canonical_writer_database_user',TRUE);
BEGIN
  IF runtime_user IS NULL OR runtime_user='' OR writer_user IS NULL OR writer_user=''
     OR writer_user=runtime_user OR writer_user=current_user
     OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=writer_user AND NOT rolsuper
       AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolbypassrls AND rolcanlogin)
     OR pg_has_role(runtime_user,writer_user,'MEMBER') OR pg_has_role(writer_user,runtime_user,'MEMBER')
     OR EXISTS(SELECT 1 FROM pg_auth_members membership JOIN pg_roles member ON member.oid=membership.member
       WHERE member.rolname=writer_user)
  THEN RAISE EXCEPTION 'Wave 2 requires a distinct constrained canonical writer principal' USING ERRCODE='42501'; END IF;
END $$;

CREATE TABLE rorca.wave2_canonical_writer_identities (
  database_user TEXT PRIMARY KEY,
  grant_receipt_hash TEXT NOT NULL CHECK(grant_receipt_hash ~ '^sha256:[0-9a-f]{64}$'),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE rorca.wave2_canonical_writer_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.wave2_canonical_writer_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY wave2_canonical_writer_self_read ON rorca.wave2_canonical_writer_identities
  FOR SELECT USING(database_user=current_user);
CREATE POLICY wave2_canonical_writer_migration_insert ON rorca.wave2_canonical_writer_identities
  FOR INSERT WITH CHECK(current_setting('rorca.migration_mode',TRUE)='on');

-- Extend the existing workspace RLS class without weakening its policies. The
-- dedicated writer is an internal workspace-bound principal but is the only
-- principal allowed to invoke canonical mutation issuance.
ALTER TABLE rorca.wave2_database_principals DROP CONSTRAINT wave2_database_principals_principal_class_check;
ALTER TABLE rorca.wave2_database_principals ADD CONSTRAINT wave2_database_principals_principal_class_check
  CHECK(principal_class IN('migration_owner','internal_runtime','canonical_writer'));
CREATE POLICY wave2_principal_canonical_writer_insert ON rorca.wave2_database_principals
  FOR INSERT WITH CHECK(current_setting('rorca.migration_mode',TRUE)='on' AND principal_class='canonical_writer');

DO $$
DECLARE writer_user TEXT:=current_setting('rorca.canonical_writer_database_user',TRUE);
BEGIN
  INSERT INTO rorca.wave2_database_principals(database_user,principal_class,grant_receipt_hash)
  VALUES(writer_user,'canonical_writer','sha256:af3a76e53c5f13157e10c0782d5c810428efb4e12ef4cb863b4ad04ad6f21093');
  INSERT INTO rorca.wave2_canonical_writer_identities(database_user,grant_receipt_hash)
  VALUES(writer_user,'sha256:af3a76e53c5f13157e10c0782d5c810428efb4e12ef4cb863b4ad04ad6f21093');
  -- Compatibility identity used only inside the already-installed v1 definer.
  -- The runtime identity remains unable to execute that function after this migration.
  INSERT INTO rorca.wave2_runtime_principal_identities(database_user,grant_receipt_hash)
  VALUES(writer_user,'sha256:af3a76e53c5f13157e10c0782d5c810428efb4e12ef4cb863b4ad04ad6f21093');
END $$;

-- Existing workspace policies used an exact internal_runtime class predicate.
-- Add writer-only policies instead of broadening runtime policy text.
DO $$
DECLARE table_name TEXT;
DECLARE writer_user TEXT:=current_setting('rorca.canonical_writer_database_user',TRUE);
DECLARE runtime_user TEXT:=current_setting('rorca.runtime_database_user',TRUE);
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA rorca TO %I',writer_user);
  EXECUTE format('GRANT SELECT ON rorca.wave2_canonical_writer_identities,rorca.wave2_database_principals,
    rorca.wave2_prerequisite_receipts,rorca.wave2_schema_readiness,rorca.wave2_effective_readiness,
    rorca.workspaces,rorca.workspace_members,rorca.story_closeout_decisions,rorca.governed_execution_attempts,
    rorca.context_epoch_retirement_evidence,rorca.context_epoch_retirement_review_decisions,
    rorca.governed_spec_authority_snapshots,rorca.governed_decision_authority_snapshots,
    rorca.context_policy_authority_receipts,rorca.governed_exact_revision_authority_snapshots,
    rorca.governed_repository_authority_snapshots,rorca.governed_path_manifest_snapshots,
    rorca.governed_evidence_obligation_sets,rorca.governed_evidence_obligations TO %I',writer_user);

  FOREACH table_name IN ARRAY ARRAY[
    'governed_missions','governed_mission_versions','governed_mission_heads','governed_work_packages',
    'governed_work_package_revisions','governed_work_package_dependencies','governed_work_package_heads',
    'execution_lease_slots','execution_leases','execution_lease_events','context_policy_definitions','context_policy_activations',
    'context_policy_activation_heads','context_scope_heads','context_checkpoints','context_retrieval_receipts','context_retrieval_sources',
    'context_bundles','context_bundle_deltas','continuation_retry_budgets','continuation_retry_events','continuation_quarantines',
    'continuation_dispatches','continuation_dispatch_consumptions','continuation_dispatch_outbox','continuation_dispatch_outcomes',
    'continuation_dispatch_acceptances','runtime_event_stream_heads','runtime_events','runtime_event_conflicts','ssdlc_lifecycle_evidence',
    'governed_closeout_evaluations','execution_cancellation_requests','execution_cancellation_acknowledgements',
    'plan_change_proposals','plan_change_proposal_heads','plan_change_proposal_reviews','mission_control_idempotency',
    'mission_control_replay_conflicts','mission_control_audit','context_epoch_retirement_evaluations'
  ] LOOP
    EXECUTE format('REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON rorca.%I FROM %I',table_name,runtime_user);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON rorca.%I TO %I',table_name,writer_user);
    EXECUTE format('CREATE POLICY %I ON rorca.%I USING (
      workspace_id=current_setting(''rorca.workspace_id'',TRUE) AND EXISTS(
        SELECT 1 FROM rorca.wave2_canonical_writer_identities i WHERE i.database_user=current_user
      )) WITH CHECK (
      workspace_id=current_setting(''rorca.workspace_id'',TRUE) AND EXISTS(
        SELECT 1 FROM rorca.wave2_canonical_writer_identities i WHERE i.database_user=current_user
      ))','wave2_canonical_writer_'||table_name,table_name);
  END LOOP;

  EXECUTE format('REVOKE EXECUTE ON FUNCTION rorca.authorize_wave2_runtime_mutation_v1(TEXT,TEXT,TEXT,TEXT,JSONB) FROM %I',runtime_user);
  EXECUTE format('REVOKE EXECUTE ON FUNCTION rorca.authorize_wave2_runtime_mutation_v1(TEXT,TEXT,TEXT,TEXT,JSONB) FROM %I',writer_user);
  EXECUTE format('REVOKE ALL ON rorca.wave2_runtime_mutation_capabilities FROM %I',runtime_user);
  EXECUTE format('GRANT SELECT ON rorca.wave2_canonical_writer_identities TO %I',writer_user);
  FOREACH table_name IN ARRAY ARRAY[
    'execution_lease_events_id_seq','runtime_event_conflicts_id_seq','mission_control_replay_conflicts_id_seq',
    'mission_control_audit_id_seq','ssdlc_lifecycle_evidence_id_seq'
  ] LOOP
    IF to_regclass('rorca.'||table_name) IS NOT NULL THEN
      EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE rorca.%I TO %I',table_name,writer_user);
    END IF;
  END LOOP;
END $$;

CREATE POLICY wave2_prerequisite_writer_read ON rorca.wave2_prerequisite_receipts FOR SELECT USING(
  EXISTS(SELECT 1 FROM rorca.wave2_canonical_writer_identities i WHERE i.database_user=current_user));
CREATE POLICY wave2_readiness_writer_read ON rorca.wave2_schema_readiness FOR SELECT USING(
  EXISTS(SELECT 1 FROM rorca.wave2_canonical_writer_identities i WHERE i.database_user=current_user));
DO $$ DECLARE table_name TEXT; BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'governed_spec_authority_snapshots','governed_decision_authority_snapshots','context_policy_authority_receipts',
    'governed_exact_revision_authority_snapshots','governed_repository_authority_snapshots','governed_path_manifest_snapshots',
    'governed_evidence_obligation_sets','governed_evidence_obligations','governed_execution_attempts',
    'context_epoch_retirement_evidence','context_epoch_retirement_review_decisions'
  ] LOOP
    EXECUTE format('CREATE POLICY %I ON rorca.%I FOR SELECT USING(
      workspace_id=current_setting(''rorca.workspace_id'',TRUE) AND EXISTS(
        SELECT 1 FROM rorca.wave2_canonical_writer_identities i WHERE i.database_user=current_user))',
      'wave2_writer_read_'||table_name,table_name);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION rorca.authorize_wave2_canonical_writer_mutation_v2(
  p_workspace_id TEXT,p_operation TEXT,p_request_hash TEXT,p_subject_hash TEXT,p_request JSONB
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=rorca,pg_catalog AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM rorca.wave2_runtime_principal_identities i WHERE i.database_user=session_user
    AND i.grant_receipt_hash='sha256:af3a76e53c5f13157e10c0782d5c810428efb4e12ef4cb863b4ad04ad6f21093')
  THEN RAISE EXCEPTION 'Canonical writer identity denied' USING ERRCODE='42501'; END IF;
  PERFORM rorca.authorize_wave2_runtime_mutation_v1(p_workspace_id,p_operation,p_request_hash,p_subject_hash,p_request);
END $$;
REVOKE ALL ON FUNCTION rorca.authorize_wave2_canonical_writer_mutation_v2(TEXT,TEXT,TEXT,TEXT,JSONB) FROM PUBLIC;
DO $$ DECLARE writer_user TEXT:=current_setting('rorca.canonical_writer_database_user',TRUE); BEGIN
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.authorize_wave2_canonical_writer_mutation_v2(TEXT,TEXT,TEXT,TEXT,JSONB) TO %I',writer_user);
END $$;
COMMENT ON FUNCTION rorca.authorize_wave2_runtime_mutation_v1(TEXT,TEXT,TEXT,TEXT,JSONB) IS
  'Owner-internal compatibility implementation; no runtime or canonical-writer principal has direct EXECUTE.';

-- Receiver-enforced delivery is an atomic durable inbox acceptance. The
-- receiver identity is configured by the receiver process and never supplied
-- by the sending caller.
CREATE TABLE rorca.continuation_dispatch_receiver_inbox (
  workspace_id TEXT NOT NULL,
  dispatch_id TEXT NOT NULL,
  receiver_principal_id TEXT NOT NULL,
  acceptance_receipt_hash TEXT NOT NULL CHECK(acceptance_receipt_hash ~ '^sha256:[0-9a-f]{64}$'),
  delivery_key TEXT NOT NULL CHECK(delivery_key ~ '^sha256:[0-9a-f]{64}$'),
  payload_hash TEXT NOT NULL CHECK(payload_hash ~ '^sha256:[0-9a-f]{64}$'),
  accepted_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL CHECK(state IN('accepted','consumed','quarantined')) DEFAULT 'accepted',
  PRIMARY KEY(workspace_id,dispatch_id),
  UNIQUE(workspace_id,delivery_key),
  FOREIGN KEY(workspace_id,dispatch_id) REFERENCES rorca.continuation_dispatch_acceptances(workspace_id,dispatch_id) ON DELETE RESTRICT
);
ALTER TABLE rorca.continuation_dispatch_receiver_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.continuation_dispatch_receiver_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY wave2_receiver_inbox_writer ON rorca.continuation_dispatch_receiver_inbox USING(
  workspace_id=current_setting('rorca.workspace_id',TRUE) AND EXISTS(
    SELECT 1 FROM rorca.wave2_canonical_writer_identities i WHERE i.database_user=current_user))
WITH CHECK(workspace_id=current_setting('rorca.workspace_id',TRUE) AND EXISTS(
    SELECT 1 FROM rorca.wave2_canonical_writer_identities i WHERE i.database_user=current_user));
CREATE OR REPLACE FUNCTION rorca.insert_continuation_receiver_inbox_v1(
  p_workspace_id TEXT,p_dispatch_id TEXT,p_receiver_principal_id TEXT,p_acceptance_receipt_hash TEXT,
  p_delivery_key TEXT,p_payload_hash TEXT,p_accepted_at TIMESTAMPTZ
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=rorca,pg_catalog AS $$
BEGIN
  IF current_setting('rorca.workspace_id',TRUE) IS DISTINCT FROM p_workspace_id
    OR p_receiver_principal_id<>'rorca-dispatch-receiver'
    OR NOT EXISTS(SELECT 1 FROM rorca.wave2_runtime_principal_identities i WHERE i.database_user=session_user
      AND i.grant_receipt_hash='sha256:af3a76e53c5f13157e10c0782d5c810428efb4e12ef4cb863b4ad04ad6f21093')
    OR NOT EXISTS(SELECT 1 FROM rorca.continuation_dispatch_acceptances acceptance
      JOIN rorca.continuation_dispatch_outbox outbox USING(workspace_id,dispatch_id)
      WHERE acceptance.workspace_id=p_workspace_id AND acceptance.dispatch_id=p_dispatch_id
        AND acceptance.receiver_id=p_receiver_principal_id
        AND acceptance.acceptance_receipt_hash=p_acceptance_receipt_hash
        AND acceptance.delivery_key=p_delivery_key AND acceptance.payload_hash=p_payload_hash
        AND acceptance.accepted_at=p_accepted_at
        AND outbox.send_authorization_consumed_at=p_accepted_at
        AND outbox.receiver_acceptance_receipt_hash=p_acceptance_receipt_hash
        AND outbox.receiver_accepted_at=p_accepted_at)
  THEN RAISE EXCEPTION 'Receiver inbox exact transition denied' USING ERRCODE='42501'; END IF;
  INSERT INTO rorca.continuation_dispatch_receiver_inbox
    (workspace_id,dispatch_id,receiver_principal_id,acceptance_receipt_hash,delivery_key,payload_hash,accepted_at)
  VALUES(p_workspace_id,p_dispatch_id,p_receiver_principal_id,p_acceptance_receipt_hash,p_delivery_key,p_payload_hash,p_accepted_at);
END $$;
REVOKE ALL ON FUNCTION rorca.insert_continuation_receiver_inbox_v1(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ) FROM PUBLIC;
DO $$ DECLARE writer_user TEXT:=current_setting('rorca.canonical_writer_database_user',TRUE); runtime_user TEXT:=current_setting('rorca.runtime_database_user',TRUE); BEGIN
  EXECUTE format('GRANT SELECT ON rorca.continuation_dispatch_receiver_inbox TO %I',writer_user);
  EXECUTE format('REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON rorca.continuation_dispatch_receiver_inbox FROM %I',writer_user);
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.insert_continuation_receiver_inbox_v1(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ) TO %I',writer_user);
  EXECUTE format('REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON rorca.continuation_dispatch_receiver_inbox FROM %I',runtime_user);
END $$;
CREATE TRIGGER continuation_dispatch_receiver_inbox_no_delete BEFORE DELETE ON rorca.continuation_dispatch_receiver_inbox
FOR EACH ROW EXECUTE FUNCTION rorca.w2_reject_immutable_mutation();
CREATE TRIGGER continuation_dispatch_receiver_inbox_no_truncate BEFORE TRUNCATE ON rorca.continuation_dispatch_receiver_inbox
FOR EACH STATEMENT EXECUTE FUNCTION rorca.w2_reject_immutable_truncate();

-- Exact worker transport attempts make pre-run poison/rejection terminalization
-- inspectable and restart-safe.
ALTER TABLE rorca.spec_jobs ADD CONSTRAINT spec_jobs_id_workspace_uq UNIQUE(id,workspace_id);
CREATE TABLE rorca.spec_job_transport_attempts (
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  job_id UUID NOT NULL,
  boss_job_id UUID NOT NULL,
  queue_name TEXT NOT NULL,
  transport_schema TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK(attempt_number>0),
  phase TEXT NOT NULL CHECK(phase IN('received','validated','claimed','running','terminal')),
  outcome TEXT CHECK(outcome IS NULL OR outcome IN('completed','failed','cancelled','superseded','rejected')),
  reason_code TEXT,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,job_id,boss_job_id,attempt_number,phase),
  FOREIGN KEY(job_id,workspace_id) REFERENCES rorca.spec_jobs(id,workspace_id) ON DELETE RESTRICT
);

-- Repair effect receipts are fence-bound intent/completion evidence. A caller
-- must CAS the live claim before every durable or externally visible effect.
ALTER TABLE rorca.spec_repair_operations ADD CONSTRAINT spec_repair_operations_id_workspace_uq UNIQUE(id,workspace_id);
CREATE TABLE rorca.spec_repair_effect_receipts (
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  operation_id BIGINT NOT NULL,
  claim_fence BIGINT NOT NULL CHECK(claim_fence>0),
  effect_sequence INTEGER NOT NULL CHECK(effect_sequence>0),
  effect_kind TEXT NOT NULL,
  effect_hash TEXT NOT NULL CHECK(effect_hash ~ '^sha256:[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK(state IN('authorized','completed','failed')),
  authorized_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY(workspace_id,operation_id,claim_fence,effect_sequence),
  UNIQUE(workspace_id,operation_id,claim_fence,effect_hash),
  FOREIGN KEY(operation_id,workspace_id) REFERENCES rorca.spec_repair_operations(id,workspace_id) ON DELETE RESTRICT,
  CHECK((state='authorized' AND completed_at IS NULL) OR (state IN('completed','failed') AND completed_at IS NOT NULL))
);

ALTER TABLE rorca.spec_job_transport_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.spec_job_transport_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE rorca.spec_repair_effect_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.spec_repair_effect_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY spec_job_transport_attempts_runtime_scope ON rorca.spec_job_transport_attempts USING(
  workspace_id=current_setting('rorca.workspace_id',TRUE) AND EXISTS(SELECT 1 FROM rorca.wave2_database_principals p
    WHERE p.database_user=current_user AND p.principal_class='internal_runtime'))
WITH CHECK(workspace_id=current_setting('rorca.workspace_id',TRUE) AND EXISTS(SELECT 1 FROM rorca.wave2_database_principals p
    WHERE p.database_user=current_user AND p.principal_class='internal_runtime'));
CREATE POLICY spec_repair_effect_receipts_runtime_scope ON rorca.spec_repair_effect_receipts USING(
  workspace_id=current_setting('rorca.workspace_id',TRUE) AND EXISTS(SELECT 1 FROM rorca.wave2_database_principals p
    WHERE p.database_user=current_user AND p.principal_class='internal_runtime'))
WITH CHECK(workspace_id=current_setting('rorca.workspace_id',TRUE) AND EXISTS(SELECT 1 FROM rorca.wave2_database_principals p
    WHERE p.database_user=current_user AND p.principal_class='internal_runtime'));
DO $$ DECLARE runtime_user TEXT:=current_setting('rorca.runtime_database_user',TRUE); BEGIN
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON rorca.spec_job_transport_attempts TO %I',runtime_user);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON rorca.spec_repair_effect_receipts TO %I',runtime_user);
END $$;

UPDATE rorca.wave2_schema_readiness SET migration_version=20260731153000,installed_at=clock_timestamp()
WHERE singleton=TRUE AND state='ready' AND migration_version=20260729152000
  AND contract_source_digest='sha256:1111a20f8b6e8cfca7ddcf8861069989bdd7b7c4b52c5b12e26cb2ff8ad6bbfb';
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM rorca.wave2_schema_readiness WHERE singleton=TRUE AND state='ready' AND migration_version=20260731153000) THEN
  RAISE EXCEPTION 'Wave 2 9ff4 remediation readiness transition failed closed' USING ERRCODE='55000';
 END IF;
END $$;
