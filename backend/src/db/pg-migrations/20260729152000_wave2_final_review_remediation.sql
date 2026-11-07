-- Final Wave 2 independent-review remediation.
-- Forward-only: exact compiler/repository/obligation authority, receiver-side
-- dispatch acceptance, fenced repair recovery, and least-privilege runtime DML.

SELECT set_config('rorca.migration_mode','on',TRUE);

CREATE TABLE rorca.governed_exact_revision_authority_snapshots (
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  reference_kind TEXT NOT NULL CHECK(reference_kind IN('compiler','mission_policy','context_policy_definition')),
  reference_id TEXT NOT NULL,
  reference_revision BIGINT NOT NULL CHECK(reference_revision>0),
  reference_hash TEXT NOT NULL CHECK(reference_hash ~ '^sha256:[0-9a-f]{64}$'),
  authority_receipt_hash TEXT NOT NULL CHECK(authority_receipt_hash ~ '^sha256:[0-9a-f]{64}$'),
  lifecycle_state TEXT NOT NULL CHECK(lifecycle_state='accepted'),
  maximum_authority_ceiling TEXT CHECK(maximum_authority_ceiling IS NULL OR maximum_authority_ceiling IN('none','observe','propose','execute_bounded')),
  sequential_only BOOLEAN,
  branch_only BOOLEAN,
  auto_merge_allowed BOOLEAN,
  deployment_allowed BOOLEAN,
  provider_mutation_allowed BOOLEAN,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,reference_kind,reference_id,reference_revision,reference_hash),
  CHECK((reference_kind='mission_policy')=(maximum_authority_ceiling IS NOT NULL AND sequential_only IS NOT NULL
    AND branch_only IS NOT NULL AND auto_merge_allowed IS NOT NULL AND deployment_allowed IS NOT NULL
    AND provider_mutation_allowed IS NOT NULL))
);

CREATE TABLE rorca.governed_repository_authority_snapshots (
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  repository_id TEXT NOT NULL,
  remote_authority_hash TEXT NOT NULL CHECK(remote_authority_hash ~ '^sha256:[0-9a-f]{64}$'),
  git_object_format TEXT NOT NULL CHECK(git_object_format IN('sha1','sha256')),
  base_sha TEXT NOT NULL CHECK(base_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  current_sha TEXT NOT NULL CHECK(current_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  expected_head_sha TEXT NOT NULL CHECK(expected_head_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  worktree_id TEXT NOT NULL,
  allowed_path_manifest_hash TEXT NOT NULL CHECK(allowed_path_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  required_path_manifest_hash TEXT NOT NULL CHECK(required_path_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  changed_path_manifest_hash TEXT NOT NULL CHECK(changed_path_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  forbidden_path_manifest_hash TEXT NOT NULL CHECK(forbidden_path_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  authority_receipt_hash TEXT NOT NULL CHECK(authority_receipt_hash ~ '^sha256:[0-9a-f]{64}$'),
  imported_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,repository_id,base_sha,authority_receipt_hash)
);

CREATE TABLE rorca.governed_path_manifest_snapshots (
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  repository_id TEXT NOT NULL,
  base_sha TEXT NOT NULL CHECK(base_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  manifest_kind TEXT NOT NULL CHECK(manifest_kind IN('allowed','required','changed','forbidden')),
  manifest_hash TEXT NOT NULL CHECK(manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  paths_json JSONB NOT NULL CHECK(jsonb_typeof(paths_json)='array' AND jsonb_array_length(paths_json)<=500),
  authority_receipt_hash TEXT NOT NULL CHECK(authority_receipt_hash ~ '^sha256:[0-9a-f]{64}$'),
  imported_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,repository_id,base_sha,manifest_kind,manifest_hash)
);

CREATE TABLE rorca.governed_evidence_obligation_sets (
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  mission_id TEXT NOT NULL,
  work_package_id TEXT NOT NULL,
  work_package_revision BIGINT NOT NULL CHECK(work_package_revision>0),
  obligation_set_id TEXT NOT NULL,
  obligation_policy_id TEXT NOT NULL,
  obligation_policy_revision BIGINT NOT NULL CHECK(obligation_policy_revision>0),
  obligation_policy_hash TEXT NOT NULL CHECK(obligation_policy_hash ~ '^sha256:[0-9a-f]{64}$'),
  manifest_hash TEXT NOT NULL CHECK(manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  manifest_json JSONB NOT NULL CHECK(jsonb_typeof(manifest_json)='array' AND jsonb_array_length(manifest_json) BETWEEN 1 AND 100),
  authority_receipt_hash TEXT NOT NULL CHECK(authority_receipt_hash ~ '^sha256:[0-9a-f]{64}$'),
  imported_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,mission_id,work_package_id,work_package_revision,obligation_set_id),
  UNIQUE(workspace_id,mission_id,work_package_id,work_package_revision,manifest_hash)
);

-- Existing obligation rows lack policy/set identity. Preserve them as an
-- owner-only non-authoritative quarantine rather than guessing authority.
DO $$
DECLARE runtime_user TEXT:=current_setting('rorca.runtime_database_user',TRUE);
BEGIN
  IF to_regclass('rorca.governed_evidence_obligations_unbound_legacy') IS NULL THEN
    EXECUTE format('REVOKE ALL PRIVILEGES ON rorca.governed_evidence_obligations FROM %I',runtime_user);
    ALTER TABLE rorca.governed_evidence_obligations RENAME TO governed_evidence_obligations_unbound_legacy;
    COMMENT ON TABLE rorca.governed_evidence_obligations_unbound_legacy IS
      'Non-authoritative quarantine: pre-152000 rows have no obligation-set/policy binding and are never used for closeout.';
  END IF;
END $$;

CREATE TABLE rorca.governed_evidence_obligations (
  workspace_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  work_package_id TEXT NOT NULL,
  work_package_revision BIGINT NOT NULL,
  obligation_set_id TEXT NOT NULL,
  obligation_order INTEGER NOT NULL CHECK(obligation_order>=0),
  obligation_kind TEXT NOT NULL,
  minimum_trust TEXT NOT NULL CHECK(minimum_trust IN('host_observed','automated_test','provider_verified','provider_human')),
  required_status TEXT NOT NULL CHECK(required_status IN('passed','failed')),
  obligation_hash TEXT NOT NULL CHECK(obligation_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,mission_id,work_package_id,work_package_revision,obligation_set_id,obligation_kind),
  UNIQUE(workspace_id,mission_id,work_package_id,work_package_revision,obligation_set_id,obligation_order),
  FOREIGN KEY(workspace_id,mission_id,work_package_id,work_package_revision,obligation_set_id)
    REFERENCES rorca.governed_evidence_obligation_sets(workspace_id,mission_id,work_package_id,work_package_revision,obligation_set_id)
    ON DELETE RESTRICT
);

ALTER TABLE rorca.governed_work_package_revisions
  ADD COLUMN evidence_obligation_set_id TEXT,
  ADD COLUMN evidence_obligation_policy_id TEXT,
  ADD COLUMN evidence_obligation_policy_revision BIGINT,
  ADD COLUMN evidence_obligation_policy_hash TEXT CHECK(evidence_obligation_policy_hash IS NULL OR evidence_obligation_policy_hash ~ '^sha256:[0-9a-f]{64}$'),
  ADD COLUMN evidence_obligation_manifest_hash TEXT CHECK(evidence_obligation_manifest_hash IS NULL OR evidence_obligation_manifest_hash ~ '^sha256:[0-9a-f]{64}$');
ALTER TABLE rorca.governed_work_package_dependencies
  ADD COLUMN dependency_hash TEXT CHECK(dependency_hash IS NULL OR dependency_hash ~ '^sha256:[0-9a-f]{64}$');
ALTER TABLE rorca.governed_closeout_evaluations
  DROP CONSTRAINT governed_closeout_evaluations_workspace_id_attempt_id_subje_key,
  ADD COLUMN obligation_set_id TEXT,
  ADD COLUMN obligation_policy_id TEXT,
  ADD COLUMN obligation_policy_revision BIGINT,
  ADD COLUMN obligation_policy_hash TEXT CHECK(obligation_policy_hash IS NULL OR obligation_policy_hash ~ '^sha256:[0-9a-f]{64}$'),
  ADD COLUMN obligation_manifest_hash TEXT CHECK(obligation_manifest_hash IS NULL OR obligation_manifest_hash ~ '^sha256:[0-9a-f]{64}$');

-- Receiver acceptance is the one-use authority boundary. Authorization alone
-- cannot be presented as an accepted external side effect.
ALTER TABLE rorca.continuation_dispatch_outbox
  ADD COLUMN send_authorization_consumed_at TIMESTAMPTZ,
  ADD COLUMN receiver_acceptance_receipt_hash TEXT CHECK(receiver_acceptance_receipt_hash IS NULL OR receiver_acceptance_receipt_hash ~ '^sha256:[0-9a-f]{64}$'),
  ADD COLUMN receiver_accepted_at TIMESTAMPTZ,
  ADD CONSTRAINT continuation_dispatch_receiver_acceptance_complete CHECK(
    (send_authorization_consumed_at IS NULL AND receiver_acceptance_receipt_hash IS NULL AND receiver_accepted_at IS NULL) OR
    (send_authorization_consumed_at IS NOT NULL AND receiver_acceptance_receipt_hash IS NOT NULL AND receiver_accepted_at IS NOT NULL)
  );
CREATE TABLE rorca.continuation_dispatch_acceptances (
  workspace_id TEXT NOT NULL,
  dispatch_id TEXT NOT NULL,
  claim_fence BIGINT NOT NULL CHECK(claim_fence>0),
  send_authorization_hash TEXT NOT NULL CHECK(send_authorization_hash ~ '^sha256:[0-9a-f]{64}$'),
  delivery_key TEXT NOT NULL CHECK(delivery_key ~ '^sha256:[0-9a-f]{64}$'),
  payload_hash TEXT NOT NULL CHECK(payload_hash ~ '^sha256:[0-9a-f]{64}$'),
  receiver_id TEXT NOT NULL,
  acceptance_receipt_hash TEXT NOT NULL CHECK(acceptance_receipt_hash ~ '^sha256:[0-9a-f]{64}$'),
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,dispatch_id),
  UNIQUE(workspace_id,send_authorization_hash),
  UNIQUE(workspace_id,acceptance_receipt_hash),
  FOREIGN KEY(workspace_id,dispatch_id) REFERENCES rorca.continuation_dispatch_outbox(workspace_id,dispatch_id) ON DELETE RESTRICT
);

-- Repair apply claims are expiring fenced ownership, not permanent tombstones.
ALTER TABLE rorca.spec_repair_operations
  DROP CONSTRAINT spec_repair_operations_status_check,
  DROP CONSTRAINT spec_repair_operations_check,
  ADD COLUMN claim_owner UUID,
  ADD COLUMN claim_fence BIGINT NOT NULL DEFAULT 0 CHECK(claim_fence>=0),
  ADD COLUMN lease_expires_at TIMESTAMPTZ,
  ADD COLUMN last_error_code TEXT;
DROP TRIGGER spec_repair_operations_guard ON rorca.spec_repair_operations;
-- Old in-progress claims have no recoverable owner/fence. Quarantine them
-- explicitly so the same exact key can be reclaimed under the new protocol.
UPDATE rorca.spec_repair_operations SET status='quarantined',completed_at=statement_timestamp(),
  last_error_code='legacy_unfenced_claim_quarantined' WHERE status='in_progress';
ALTER TABLE rorca.spec_repair_operations
  ADD CONSTRAINT spec_repair_operations_status_check CHECK(status IN('in_progress','completed','failed','quarantined')),
  ADD CONSTRAINT spec_repair_operations_state_check CHECK(
    (status='in_progress' AND response_json IS NULL AND completed_at IS NULL AND claim_owner IS NOT NULL AND claim_fence>0 AND lease_expires_at IS NOT NULL) OR
    (status='completed' AND response_json IS NOT NULL AND completed_at IS NOT NULL AND lease_expires_at IS NULL) OR
    (status IN('failed','quarantined') AND response_json IS NULL AND completed_at IS NOT NULL AND lease_expires_at IS NULL)
  );
CREATE OR REPLACE FUNCTION rorca.guard_spec_repair_operation_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW.workspace_id<>OLD.workspace_id OR NEW.actor_id<>OLD.actor_id OR NEW.surface<>OLD.surface
     OR NEW.operation_key_hash<>OLD.operation_key_hash OR NEW.request_hash<>OLD.request_hash OR NEW.created_at<>OLD.created_at
     OR OLD.status='completed' OR NEW.claim_fence<OLD.claim_fence
     OR (NEW.status='in_progress' AND NEW.claim_fence<=OLD.claim_fence AND NEW.claim_owner IS DISTINCT FROM OLD.claim_owner)
     OR (OLD.status='in_progress' AND NEW.status='in_progress' AND OLD.lease_expires_at>statement_timestamp() AND NEW.claim_owner IS DISTINCT FROM OLD.claim_owner)
  THEN RAISE EXCEPTION 'spec repair operation is immutable or transition-invalid' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER spec_repair_operations_guard BEFORE UPDATE OR DELETE ON rorca.spec_repair_operations
FOR EACH ROW EXECUTE FUNCTION rorca.guard_spec_repair_operation_update();

DO $$
DECLARE table_name TEXT;
DECLARE runtime_user TEXT:=current_setting('rorca.runtime_database_user',TRUE);
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'governed_exact_revision_authority_snapshots','governed_repository_authority_snapshots','governed_path_manifest_snapshots',
    'governed_evidence_obligation_sets','governed_evidence_obligations'
  ] LOOP
    EXECUTE format('ALTER TABLE rorca.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE rorca.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY %I ON rorca.%I FOR SELECT USING (
      (current_setting(''rorca.migration_mode'',TRUE)=''on'' AND EXISTS(SELECT 1 FROM rorca.wave2_database_principals p WHERE p.database_user=current_user AND p.principal_class=''migration_owner'')) OR
      (workspace_id=current_setting(''rorca.workspace_id'',TRUE) AND EXISTS(SELECT 1 FROM rorca.wave2_database_principals p WHERE p.database_user=current_user AND p.principal_class=''internal_runtime'')))',
      'wave2_final_read_'||table_name,table_name);
    EXECUTE format('CREATE POLICY %I ON rorca.%I FOR INSERT WITH CHECK (
      current_setting(''rorca.migration_mode'',TRUE)=''on'' AND EXISTS(SELECT 1 FROM rorca.wave2_database_principals p WHERE p.database_user=current_user AND p.principal_class=''migration_owner''))',
      'wave2_final_import_'||table_name,table_name);
    EXECUTE format('GRANT SELECT ON rorca.%I TO %I',table_name,runtime_user);
    EXECUTE format('REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON rorca.%I FROM %I',table_name,runtime_user);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON rorca.%I FOR EACH ROW EXECUTE FUNCTION rorca.w2_reject_immutable_mutation()',table_name||'_immutable',table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON rorca.%I FOR EACH STATEMENT EXECUTE FUNCTION rorca.w2_reject_immutable_truncate()',table_name||'_no_truncate',table_name);
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY['governed_spec_authority_snapshots','governed_decision_authority_snapshots','context_policy_authority_receipts'] LOOP
    EXECUTE format('REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON rorca.%I FROM %I',table_name,runtime_user);
  END LOOP;
  ALTER TABLE rorca.continuation_dispatch_acceptances ENABLE ROW LEVEL SECURITY;
  ALTER TABLE rorca.continuation_dispatch_acceptances FORCE ROW LEVEL SECURITY;
  CREATE POLICY wave2_dispatch_acceptance_runtime ON rorca.continuation_dispatch_acceptances USING(
    workspace_id=current_setting('rorca.workspace_id',TRUE) AND EXISTS(SELECT 1 FROM rorca.wave2_database_principals p WHERE p.database_user=current_user AND p.principal_class='internal_runtime'))
  WITH CHECK(workspace_id=current_setting('rorca.workspace_id',TRUE) AND EXISTS(SELECT 1 FROM rorca.wave2_database_principals p WHERE p.database_user=current_user AND p.principal_class='internal_runtime'));
  EXECUTE format('GRANT SELECT,INSERT ON rorca.continuation_dispatch_acceptances TO %I',runtime_user);
  EXECUTE format('GRANT UPDATE(status,response_json,completed_at,claim_owner,claim_fence,lease_expires_at,last_error_code) ON rorca.spec_repair_operations TO %I',runtime_user);
END $$;
CREATE TRIGGER continuation_dispatch_acceptances_immutable BEFORE UPDATE OR DELETE ON rorca.continuation_dispatch_acceptances
FOR EACH ROW EXECUTE FUNCTION rorca.w2_reject_immutable_mutation();
CREATE TRIGGER continuation_dispatch_acceptances_no_truncate BEFORE TRUNCATE ON rorca.continuation_dispatch_acceptances
FOR EACH STATEMENT EXECUTE FUNCTION rorca.w2_reject_immutable_truncate();

-- Runtime DML is guarded by a transaction-bound, procedure-issued capability.
-- A bare runtime SQL session cannot mint or rewrite canonical rows merely by
-- setting workspace GUCs. The procedure is the only capability issuer and
-- checks the registered principal, exact readiness, operation, and request.
CREATE TABLE rorca.wave2_runtime_mutation_capabilities (
  transaction_id BIGINT NOT NULL,
  backend_pid INTEGER NOT NULL,
  database_user TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(request_hash ~ '^sha256:[0-9a-f]{64}$'),
  subject_hash TEXT NOT NULL CHECK(subject_hash ~ '^sha256:[0-9a-f]{64}$'),
  request_json JSONB NOT NULL CHECK(jsonb_typeof(request_json) IN('object','array') AND octet_length(request_json::text)<=4194304),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY(transaction_id,backend_pid,database_user,workspace_id,operation)
);
REVOKE ALL ON rorca.wave2_runtime_mutation_capabilities FROM PUBLIC;

CREATE POLICY wave2_principal_capability_issuer_read ON rorca.wave2_database_principals FOR SELECT
  USING(current_setting('rorca.migration_mode',TRUE)='on');
CREATE TABLE rorca.wave2_runtime_principal_identities (
  database_user TEXT PRIMARY KEY,
  grant_receipt_hash TEXT NOT NULL CHECK(grant_receipt_hash ~ '^sha256:[0-9a-f]{64}$')
);
INSERT INTO rorca.wave2_runtime_principal_identities(database_user,grant_receipt_hash)
SELECT database_user,grant_receipt_hash FROM rorca.wave2_database_principals WHERE principal_class='internal_runtime';
REVOKE ALL ON rorca.wave2_runtime_principal_identities FROM PUBLIC;

CREATE OR REPLACE FUNCTION rorca.authorize_wave2_runtime_mutation_v1(
  p_workspace_id TEXT,p_operation TEXT,p_request_hash TEXT,p_subject_hash TEXT,p_request JSONB
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=rorca,pg_catalog AS $$
DECLARE prior_migration_mode TEXT:=current_setting('rorca.migration_mode',TRUE);
DECLARE artifact JSONB;
DECLARE v_lease_id TEXT;
DECLARE v_fence BIGINT;
BEGIN
  IF current_setting('rorca.workspace_id',TRUE) IS DISTINCT FROM p_workspace_id
     OR NOT EXISTS(SELECT 1 FROM rorca.wave2_runtime_principal_identities p WHERE p.database_user=session_user)
     OR p_operation NOT IN('mission.compile','work-package.revise','lease.acquire','lease.renew','lease.release',
       'context-policy.publish','context-policy.activate','retrieval-receipt.persist','context-bundle.persist','context-delta.persist',
       'continuation-budget.persist','continuation-dispatch.authorize','continuation-dispatch.consume','checkpoint.persist',
       'runtime-event.ingest','evidence.ingest','continuation-retry.claim','continuation-retry.settle',
       'continuation-outbox.claim','continuation-outbox.authorize-send','continuation-outbox.accept','continuation-outbox.settle',
       'closeout.evaluate','cancellation.request','cancellation.acknowledge','plan-change.propose','plan-change.review',
       'context-epoch-retirement.evaluate','mutation-rejection.audit')
     OR p_request_hash !~ '^sha256:[0-9a-f]{64}$' OR p_subject_hash !~ '^sha256:[0-9a-f]{64}$'
     OR jsonb_typeof(p_request) NOT IN('object','array') OR octet_length(p_request::text)>4194304
     OR NOT EXISTS(SELECT 1 FROM rorca.wave2_schema_readiness WHERE singleton=TRUE AND state='ready'
       AND migration_version>=20260729152000
       AND contract_source_digest='sha256:1111a20f8b6e8cfca7ddcf8861069989bdd7b7c4b52c5b12e26cb2ff8ad6bbfb')
     OR NOT EXISTS(SELECT 1 FROM rorca.wave2_effective_readiness WHERE ready=TRUE)
  THEN RAISE EXCEPTION 'Wave 2 runtime mutation capability denied' USING ERRCODE='42501'; END IF;

  -- The definer may inspect immutable authority under the migration-owner RLS
  -- branch only inside this function. Restore the caller's mode before issuing
  -- the transaction capability; the runtime session never receives migration
  -- authority.
  PERFORM set_config('rorca.migration_mode','on',TRUE);
  artifact:=CASE WHEN p_operation='mission.compile' THEN p_request->'mission'
                 WHEN p_operation='work-package.revise' THEN p_request->'value'
                 WHEN p_operation='context-policy.publish' THEN p_request->'policy'
                 ELSE p_request END;
  IF p_operation='mission.compile' THEN
    IF artifact->>'workspaceId' IS DISTINCT FROM p_workspace_id
      OR NOT EXISTS(SELECT 1 FROM rorca.governed_spec_authority_snapshots s WHERE s.workspace_id=p_workspace_id
        AND s.spec_id=artifact#>>'{canonicalSpec,specId}' AND s.spec_version=(artifact#>>'{canonicalSpec,specVersion}')::bigint
        AND s.spec_hash=artifact#>>'{canonicalSpec,specHash}' AND s.canonical_spec_path=artifact#>>'{canonicalSpec,canonicalSpecPath}'
        AND s.repository_id=artifact#>>'{repository,repositoryId}' AND s.repository_sha=artifact#>>'{repository,baseSha}' AND s.lifecycle_state='approved')
      OR (SELECT count(*) FROM rorca.governed_exact_revision_authority_snapshots a WHERE a.workspace_id=p_workspace_id
        AND (a.reference_kind,a.reference_id,a.reference_revision,a.reference_hash) IN (
          ('compiler',artifact#>>'{compiler,id}',(artifact#>>'{compiler,revision}')::bigint,artifact#>>'{compiler,hash}'),
          ('mission_policy',artifact#>>'{policy,id}',(artifact#>>'{policy,revision}')::bigint,artifact#>>'{policy,hash}'),
          ('context_policy_definition',artifact#>>'{contextPolicyDefinition,id}',(artifact#>>'{contextPolicyDefinition,revision}')::bigint,artifact#>>'{contextPolicyDefinition,hash}')))<3
      OR NOT EXISTS(SELECT 1 FROM rorca.governed_repository_authority_snapshots r WHERE r.workspace_id=p_workspace_id
        AND r.repository_id=artifact#>>'{repository,repositoryId}' AND r.remote_authority_hash=artifact#>>'{repository,remoteAuthorityHash}'
        AND r.base_sha=artifact#>>'{repository,baseSha}' AND r.current_sha=artifact#>>'{repository,currentSha}'
        AND r.expected_head_sha=artifact#>>'{repository,expectedHeadSha}' AND r.worktree_id=artifact#>>'{repository,worktreeId}')
    THEN RAISE EXCEPTION 'Mission canonical authority procedure check failed' USING ERRCODE='42501'; END IF;
  ELSIF p_operation='work-package.revise' THEN
    IF artifact->>'workspaceId' IS DISTINCT FROM p_workspace_id
      OR NOT EXISTS(SELECT 1 FROM rorca.governed_mission_heads h WHERE h.workspace_id=p_workspace_id
        AND h.mission_id=artifact->>'missionId' AND h.current_revision=(artifact->>'missionRevision')::bigint
        AND h.current_hash=artifact->>'missionHash' AND h.lifecycle_state IN('compiled','active'))
      OR NOT EXISTS(SELECT 1 FROM rorca.governed_evidence_obligation_sets o WHERE o.workspace_id=p_workspace_id
        AND o.mission_id=artifact->>'missionId' AND o.work_package_id=artifact->>'workPackageId'
        AND o.work_package_revision=(artifact->>'workPackageRevision')::bigint AND o.manifest_hash=artifact->>'evidenceObligationsHash')
    THEN RAISE EXCEPTION 'Work-package canonical authority procedure check failed' USING ERRCODE='42501'; END IF;
  ELSIF p_operation='context-policy.publish' THEN
    IF artifact IS NULL OR NOT EXISTS(SELECT 1 FROM rorca.context_policy_authority_receipts receipt
      WHERE receipt.workspace_id=p_workspace_id AND receipt.authority_receipt_id=p_request->>'authorityReceiptId'
        AND receipt.operation='publish' AND receipt.authority_ref=artifact->>'issuerAuthorityRef'
        AND receipt.artifact_hash=artifact->>'policyDefinitionHash' AND receipt.decision_state='accepted')
    THEN RAISE EXCEPTION 'Policy publication receipt procedure check failed' USING ERRCODE='42501'; END IF;
  ELSIF p_operation='context-policy.activate' THEN
    IF NOT EXISTS(SELECT 1 FROM rorca.context_policy_authority_receipts receipt
      WHERE receipt.workspace_id=p_workspace_id AND receipt.authority_receipt_id=artifact->>'authorityReceiptId'
        AND receipt.operation='activate' AND receipt.artifact_hash=artifact->>'activationHash' AND receipt.decision_state='accepted')
      OR NOT EXISTS(SELECT 1 FROM rorca.context_policy_definitions definition WHERE definition.workspace_id=p_workspace_id
        AND definition.policy_definition_id=artifact->>'definitionId' AND definition.policy_definition_version=artifact->>'definitionVersion'
        AND definition.policy_definition_hash=artifact->>'definitionHash' AND definition.lifecycle_state='published')
    THEN RAISE EXCEPTION 'Policy activation receipt procedure check failed' USING ERRCODE='42501'; END IF;
  ELSIF p_operation='lease.acquire' THEN
    IF NOT EXISTS(SELECT 1 FROM rorca.governed_execution_attempts attempt WHERE attempt.workspace_id=p_workspace_id
      AND attempt.attempt_id=artifact->>'attemptId' AND attempt.mission_id=artifact->>'missionId'
      AND attempt.work_package_id=artifact->>'workPackageId' AND attempt.work_package_revision=(artifact->>'workPackageRevision')::bigint
      AND attempt.runtime_id=artifact->>'runtimeId')
      OR NOT EXISTS(SELECT 1 FROM rorca.context_policy_activation_heads activation WHERE activation.workspace_id=p_workspace_id
        AND activation.current_hash=artifact->>'policyActivationHash' AND activation.effective_state='active')
    THEN RAISE EXCEPTION 'Lease canonical subject procedure check failed' USING ERRCODE='42501'; END IF;
  ELSIF p_operation='closeout.evaluate' THEN
    IF NOT EXISTS(SELECT 1 FROM rorca.governed_work_package_revisions work WHERE work.workspace_id=p_workspace_id
      AND work.mission_id=artifact->>'missionId' AND work.work_package_id=artifact->>'workPackageId'
      AND work.work_package_revision=(artifact->>'workPackageRevision')::bigint
      AND work.evidence_obligation_set_id=artifact->>'obligationSetId'
      AND work.evidence_obligation_manifest_hash=artifact->>'obligationSetHash'
      AND work.evidence_obligation_policy_revision::text=artifact->>'policyVersion')
    THEN RAISE EXCEPTION 'Closeout obligation procedure check failed' USING ERRCODE='42501'; END IF;
  ELSIF p_operation IN('lease.renew','lease.release','cancellation.request','cancellation.acknowledge','plan-change.propose',
    'runtime-event.ingest','evidence.ingest','retrieval-receipt.persist','context-bundle.persist','context-delta.persist',
    'continuation-budget.persist','continuation-dispatch.authorize','continuation-dispatch.consume','checkpoint.persist') THEN
    v_lease_id:=COALESCE(artifact->>'leaseId',artifact#>>'{scope,leaseId}',artifact#>>'{artifact,scope,leaseId}',
      artifact#>>'{acknowledgement,leaseId}');
    v_fence:=COALESCE(NULLIF(artifact->>'fencingToken','')::bigint,NULLIF(artifact#>>'{scope,fencingToken}','')::bigint,
      NULLIF(artifact#>>'{artifact,scope,fencingToken}','')::bigint,NULLIF(artifact#>>'{acknowledgement,fencingToken}','')::bigint);
    IF v_lease_id IS NULL OR NOT EXISTS(SELECT 1 FROM rorca.execution_leases lease WHERE lease.workspace_id=p_workspace_id
      AND lease.lease_id=v_lease_id AND lease.fencing_token=v_fence
      AND (p_operation IN('cancellation.request','cancellation.acknowledge','lease.release') OR
           (lease.state='active' AND lease.expires_at>clock_timestamp())))
    THEN RAISE EXCEPTION 'Leased mutation procedure check failed' USING ERRCODE='42501'; END IF;
  ELSIF p_operation IN('continuation-retry.claim','continuation-retry.settle') THEN
    IF NOT EXISTS(SELECT 1 FROM rorca.continuation_retry_budgets budget JOIN rorca.execution_leases lease
      ON lease.workspace_id=budget.workspace_id AND lease.lease_id=budget.lease_id
      WHERE budget.workspace_id=p_workspace_id AND budget.continuation_key=artifact->>'continuationKey'
        AND lease.state='active' AND lease.expires_at>clock_timestamp())
    THEN RAISE EXCEPTION 'Retry procedure subject check failed' USING ERRCODE='42501'; END IF;
  ELSIF p_operation LIKE 'continuation-outbox.%' THEN
    IF NOT EXISTS(SELECT 1 FROM rorca.continuation_dispatches dispatch JOIN rorca.continuation_dispatch_outbox outbox
      ON outbox.workspace_id=dispatch.workspace_id AND outbox.dispatch_id=dispatch.dispatch_id
      WHERE dispatch.workspace_id=p_workspace_id AND dispatch.dispatch_id=artifact->>'dispatchId')
    THEN RAISE EXCEPTION 'Dispatch outbox procedure subject check failed' USING ERRCODE='42501'; END IF;
  END IF;
  PERFORM set_config('rorca.migration_mode',COALESCE(prior_migration_mode,''),TRUE);

  INSERT INTO rorca.wave2_runtime_mutation_capabilities
    (transaction_id,backend_pid,database_user,workspace_id,operation,request_hash,subject_hash,request_json)
  VALUES(txid_current(),pg_backend_pid(),session_user,p_workspace_id,p_operation,p_request_hash,p_subject_hash,p_request)
  ON CONFLICT(transaction_id,backend_pid,database_user,workspace_id,operation) DO UPDATE
    SET request_hash=EXCLUDED.request_hash,subject_hash=EXCLUDED.subject_hash,request_json=EXCLUDED.request_json,issued_at=statement_timestamp();
END $$;
REVOKE ALL ON FUNCTION rorca.authorize_wave2_runtime_mutation_v1(TEXT,TEXT,TEXT,TEXT,JSONB) FROM PUBLIC;

CREATE OR REPLACE FUNCTION rorca.guard_wave2_runtime_canonical_dml() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=rorca,pg_catalog AS $$
DECLARE row_workspace TEXT;
DECLARE permitted TEXT[];
DECLARE capability rorca.wave2_runtime_mutation_capabilities%ROWTYPE;
BEGIN
  IF session_user=current_user THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  row_workspace:=COALESCE(to_jsonb(NEW)->>'workspace_id',to_jsonb(OLD)->>'workspace_id');
  permitted:=CASE TG_TABLE_NAME
    WHEN 'governed_missions' THEN ARRAY['mission.compile']
    WHEN 'governed_mission_versions' THEN ARRAY['mission.compile']
    WHEN 'governed_mission_heads' THEN ARRAY['mission.compile']
    WHEN 'governed_work_packages' THEN ARRAY['work-package.revise']
    WHEN 'governed_work_package_revisions' THEN ARRAY['work-package.revise']
    WHEN 'governed_work_package_dependencies' THEN ARRAY['work-package.revise']
    WHEN 'governed_work_package_heads' THEN ARRAY['work-package.revise']
    WHEN 'execution_lease_slots' THEN ARRAY['lease.acquire','lease.release','context-policy.activate','cancellation.request']
    WHEN 'execution_leases' THEN ARRAY['lease.acquire','lease.renew','lease.release','cancellation.request']
    WHEN 'execution_lease_events' THEN ARRAY['lease.acquire','lease.renew','lease.release','cancellation.request']
    WHEN 'context_policy_definitions' THEN ARRAY['context-policy.publish']
    WHEN 'context_policy_activations' THEN ARRAY['context-policy.activate']
    WHEN 'context_policy_activation_heads' THEN ARRAY['context-policy.activate']
    WHEN 'context_checkpoints' THEN ARRAY['checkpoint.persist']
    WHEN 'context_scope_heads' THEN ARRAY['checkpoint.persist']
    WHEN 'context_retrieval_receipts' THEN ARRAY['retrieval-receipt.persist']
    WHEN 'context_retrieval_sources' THEN ARRAY['retrieval-receipt.persist']
    WHEN 'context_bundles' THEN ARRAY['context-bundle.persist']
    WHEN 'context_bundle_deltas' THEN ARRAY['context-delta.persist']
    WHEN 'continuation_retry_budgets' THEN ARRAY['continuation-budget.persist','continuation-retry.claim','continuation-retry.settle']
    WHEN 'continuation_retry_events' THEN ARRAY['continuation-retry.claim','continuation-retry.settle']
    WHEN 'continuation_quarantines' THEN ARRAY['continuation-retry.claim','continuation-retry.settle']
    WHEN 'continuation_dispatches' THEN ARRAY['continuation-dispatch.authorize','continuation-dispatch.consume','continuation-outbox.settle']
    WHEN 'continuation_dispatch_consumptions' THEN ARRAY['continuation-dispatch.consume']
    WHEN 'continuation_dispatch_outbox' THEN ARRAY['continuation-dispatch.consume','continuation-outbox.claim','continuation-outbox.authorize-send','continuation-outbox.accept','continuation-outbox.settle']
    WHEN 'continuation_dispatch_outcomes' THEN ARRAY['continuation-outbox.settle']
    WHEN 'continuation_dispatch_acceptances' THEN ARRAY['continuation-outbox.accept']
    WHEN 'runtime_event_stream_heads' THEN ARRAY['runtime-event.ingest']
    WHEN 'runtime_events' THEN ARRAY['runtime-event.ingest']
    WHEN 'runtime_event_conflicts' THEN ARRAY['runtime-event.ingest']
    WHEN 'ssdlc_lifecycle_evidence' THEN ARRAY['evidence.ingest']
    WHEN 'governed_closeout_evaluations' THEN ARRAY['closeout.evaluate']
    WHEN 'execution_cancellation_requests' THEN ARRAY['cancellation.request']
    WHEN 'execution_cancellation_acknowledgements' THEN ARRAY['cancellation.acknowledge']
    WHEN 'plan_change_proposals' THEN ARRAY['plan-change.propose']
    WHEN 'plan_change_proposal_heads' THEN ARRAY['plan-change.propose','plan-change.review']
    WHEN 'plan_change_proposal_reviews' THEN ARRAY['plan-change.review']
    WHEN 'mission_control_idempotency' THEN ARRAY['mission.compile','work-package.revise','lease.acquire','lease.renew','lease.release',
      'context-policy.publish','context-policy.activate','retrieval-receipt.persist','context-bundle.persist','context-delta.persist',
      'continuation-budget.persist','continuation-dispatch.authorize','checkpoint.persist','closeout.evaluate','cancellation.request',
      'cancellation.acknowledge','plan-change.propose','plan-change.review','context-epoch-retirement.evaluate']
    WHEN 'mission_control_replay_conflicts' THEN ARRAY['mission.compile','work-package.revise','lease.acquire','lease.renew','lease.release',
      'context-policy.publish','context-policy.activate','retrieval-receipt.persist','context-bundle.persist','context-delta.persist',
      'continuation-budget.persist','continuation-dispatch.authorize','checkpoint.persist','closeout.evaluate','cancellation.request',
      'cancellation.acknowledge','plan-change.propose','plan-change.review','context-epoch-retirement.evaluate']
    WHEN 'mission_control_audit' THEN ARRAY['mission.compile','work-package.revise','lease.acquire','lease.renew','lease.release',
      'context-policy.publish','context-policy.activate','retrieval-receipt.persist','context-bundle.persist','context-delta.persist',
      'continuation-budget.persist','continuation-dispatch.authorize','continuation-dispatch.consume','checkpoint.persist','runtime-event.ingest',
      'evidence.ingest','closeout.evaluate','cancellation.request','cancellation.acknowledge','plan-change.propose','plan-change.review',
      'context-epoch-retirement.evaluate','mutation-rejection.audit']
    WHEN 'context_epoch_retirement_evaluations' THEN ARRAY['context-epoch-retirement.evaluate']
    ELSE ARRAY[]::TEXT[] END;
  SELECT * INTO capability FROM rorca.wave2_runtime_mutation_capabilities c
   WHERE c.transaction_id=txid_current() AND c.backend_pid=pg_backend_pid() AND c.database_user=session_user
     AND c.workspace_id=row_workspace AND c.operation=ANY(permitted) ORDER BY c.issued_at DESC LIMIT 1;
  IF capability.operation IS NULL OR current_setting('rorca.workspace_id',TRUE) IS DISTINCT FROM row_workspace THEN
    RAISE EXCEPTION 'Direct runtime canonical DML denied; exact governed procedure capability required' USING ERRCODE='42501';
  END IF;
  -- Every authority-bearing row is bound to exact request identity and CAS
  -- values. A caller cannot reuse a valid transaction capability to mint an
  -- extra revision or rewrite a mutable head.
  IF TG_OP='INSERT' AND TG_TABLE_NAME='governed_mission_versions'
     AND (to_jsonb(NEW)->'payload_json' IS DISTINCT FROM capability.request_json->'mission'
       OR to_jsonb(NEW)->>'mission_id' IS DISTINCT FROM capability.request_json#>>'{mission,missionId}'
       OR to_jsonb(NEW)->>'mission_revision' IS DISTINCT FROM capability.request_json#>>'{mission,missionRevision}'
       OR to_jsonb(NEW)->>'mission_hash' IS DISTINCT FROM capability.request_json#>>'{mission,missionHash}') THEN
    RAISE EXCEPTION 'Mission revision differs from exact authorized request' USING ERRCODE='42501';
  ELSIF TG_TABLE_NAME='governed_missions'
     AND (to_jsonb(NEW)->>'mission_id' IS DISTINCT FROM capability.request_json#>>'{mission,missionId}'
       OR (TG_OP='INSERT' AND to_jsonb(NEW)->>'created_by' IS DISTINCT FROM capability.request_json#>>'{mission,createdBy}')) THEN
    RAISE EXCEPTION 'Mission subject differs from authorized request' USING ERRCODE='42501';
  ELSIF TG_TABLE_NAME='governed_mission_heads' AND (
       to_jsonb(NEW)->>'mission_id' IS DISTINCT FROM capability.request_json#>>'{mission,missionId}'
       OR to_jsonb(NEW)->>'current_revision' IS DISTINCT FROM capability.request_json#>>'{mission,missionRevision}'
       OR to_jsonb(NEW)->>'current_hash' IS DISTINCT FROM capability.request_json#>>'{mission,missionHash}'
       OR to_jsonb(NEW)->>'lifecycle_state'<>'compiled'
       OR (TG_OP='INSERT' AND to_jsonb(NEW)->>'state_version'<>'1')
       OR (TG_OP='UPDATE' AND (to_jsonb(OLD)->>'state_version' IS DISTINCT FROM capability.request_json->>'expectedStateVersion'
         OR (to_jsonb(NEW)->>'state_version')::bigint<>(to_jsonb(OLD)->>'state_version')::bigint+1))) THEN
    RAISE EXCEPTION 'Mission head transition differs from exact authorized CAS' USING ERRCODE='42501';
  ELSIF TG_OP='INSERT' AND TG_TABLE_NAME='governed_work_package_revisions'
     AND (to_jsonb(NEW)->'payload_json' IS DISTINCT FROM capability.request_json->'value'
       OR to_jsonb(NEW)->>'mission_id' IS DISTINCT FROM capability.request_json#>>'{value,missionId}'
       OR to_jsonb(NEW)->>'work_package_id' IS DISTINCT FROM capability.request_json#>>'{value,workPackageId}'
       OR to_jsonb(NEW)->>'work_package_revision' IS DISTINCT FROM capability.request_json#>>'{value,workPackageRevision}'
       OR to_jsonb(NEW)->>'work_package_hash' IS DISTINCT FROM capability.request_json#>>'{value,workPackageHash}') THEN
    RAISE EXCEPTION 'Work-package revision differs from exact authorized request' USING ERRCODE='42501';
  ELSIF TG_TABLE_NAME='governed_work_packages'
     AND (to_jsonb(NEW)->>'mission_id' IS DISTINCT FROM capability.request_json#>>'{value,missionId}'
       OR to_jsonb(NEW)->>'work_package_id' IS DISTINCT FROM capability.request_json#>>'{value,workPackageId}'
       OR (TG_OP='INSERT' AND to_jsonb(NEW)->>'created_by' IS DISTINCT FROM capability.request_json#>>'{value,createdBy}')) THEN
    RAISE EXCEPTION 'Work-package subject differs from authorized request' USING ERRCODE='42501';
  ELSIF TG_TABLE_NAME='governed_work_package_heads' AND (
       to_jsonb(NEW)->>'mission_id' IS DISTINCT FROM capability.request_json#>>'{value,missionId}'
       OR to_jsonb(NEW)->>'work_package_id' IS DISTINCT FROM capability.request_json#>>'{value,workPackageId}'
       OR to_jsonb(NEW)->>'current_revision' IS DISTINCT FROM capability.request_json#>>'{value,workPackageRevision}'
       OR to_jsonb(NEW)->>'current_hash' IS DISTINCT FROM capability.request_json#>>'{value,workPackageHash}'
       OR to_jsonb(NEW)->>'lifecycle_state' IS DISTINCT FROM capability.request_json#>>'{value,state}'
       OR (TG_OP='INSERT' AND to_jsonb(NEW)->>'state_version'<>'1')
       OR (TG_OP='UPDATE' AND (to_jsonb(OLD)->>'state_version' IS DISTINCT FROM capability.request_json->>'expectedStateVersion'
         OR (to_jsonb(NEW)->>'state_version')::bigint<>(to_jsonb(OLD)->>'state_version')::bigint+1))) THEN
    RAISE EXCEPTION 'Work-package head transition differs from exact authorized CAS' USING ERRCODE='42501';
  ELSIF TG_OP='INSERT' AND TG_TABLE_NAME='context_policy_definitions'
     AND to_jsonb(NEW)->'body_json' IS DISTINCT FROM capability.request_json->'policy' THEN
    RAISE EXCEPTION 'Policy payload differs from authorized request' USING ERRCODE='42501';
  ELSIF TG_OP='INSERT' AND TG_TABLE_NAME='context_policy_activations'
     AND (to_jsonb(NEW)->>'activation_id' IS DISTINCT FROM capability.request_json->>'activationId'
       OR to_jsonb(NEW)->>'activation_revision' IS DISTINCT FROM capability.request_json->>'activationRevision'
       OR to_jsonb(NEW)->>'activation_hash' IS DISTINCT FROM capability.request_json->>'activationHash'
       OR to_jsonb(NEW)->>'authority_receipt_id' IS DISTINCT FROM capability.request_json->>'authorityReceiptId'
       OR to_jsonb(NEW)->>'state' IS DISTINCT FROM capability.request_json->>'state') THEN
    RAISE EXCEPTION 'Policy activation differs from authorized receipt subject' USING ERRCODE='42501';
  ELSIF TG_TABLE_NAME='context_policy_activation_heads' AND (
       to_jsonb(NEW)->>'activation_id' IS DISTINCT FROM capability.request_json->>'activationId'
       OR to_jsonb(NEW)->>'current_revision' IS DISTINCT FROM capability.request_json->>'activationRevision'
       OR to_jsonb(NEW)->>'current_hash' IS DISTINCT FROM capability.request_json->>'activationHash'
       OR to_jsonb(NEW)->>'effective_state' IS DISTINCT FROM capability.request_json->>'state'
       OR (TG_OP='INSERT' AND to_jsonb(NEW)->>'state_version'<>'1')
       OR (TG_OP='UPDATE' AND (to_jsonb(NEW)->>'state_version')::bigint<>(to_jsonb(OLD)->>'state_version')::bigint+1)) THEN
    RAISE EXCEPTION 'Activation head differs from exact authorized revision' USING ERRCODE='42501';
  ELSIF TG_OP='INSERT' AND TG_TABLE_NAME='execution_leases'
     AND (to_jsonb(NEW)->>'lease_id' IS DISTINCT FROM capability.request_json->>'leaseId'
       OR to_jsonb(NEW)->>'attempt_id' IS DISTINCT FROM capability.request_json->>'attemptId'
       OR to_jsonb(NEW)->>'runtime_id' IS DISTINCT FROM capability.request_json->>'runtimeId'
       OR to_jsonb(NEW)->>'state'<>'active' OR to_jsonb(NEW)->>'state_version'<>'1') THEN
    RAISE EXCEPTION 'Lease row differs from authorized attempt subject' USING ERRCODE='42501';
  ELSIF TG_TABLE_NAME='execution_leases' AND TG_OP='UPDATE'
     AND COALESCE(to_jsonb(NEW)->>'lease_id',to_jsonb(OLD)->>'lease_id') IS DISTINCT FROM
       COALESCE(capability.request_json->>'leaseId',capability.request_json#>>'{acknowledgement,leaseId}') THEN
    RAISE EXCEPTION 'Lease transition differs from authorized exact lease' USING ERRCODE='42501';
  ELSIF TG_TABLE_NAME='plan_change_proposal_heads' AND (
       to_jsonb(NEW)->>'proposal_id' IS DISTINCT FROM capability.request_json->>'proposalId'
       OR (capability.operation='plan-change.propose' AND (TG_OP<>'INSERT' OR to_jsonb(NEW)->>'current_state'<>'proposed' OR to_jsonb(NEW)->>'state_version'<>'1'))
       OR (capability.operation='plan-change.review' AND (TG_OP<>'UPDATE'
         OR to_jsonb(NEW)->>'current_state' IS DISTINCT FROM capability.request_json->>'decision'
         OR to_jsonb(OLD)->>'state_version' IS DISTINCT FROM capability.request_json->>'expectedStateVersion'
         OR (to_jsonb(NEW)->>'state_version')::bigint<>(to_jsonb(OLD)->>'state_version')::bigint+1))) THEN
    RAISE EXCEPTION 'Proposal head differs from exact authorized transition' USING ERRCODE='42501';
  ELSIF TG_OP='INSERT' AND TG_TABLE_NAME='governed_closeout_evaluations'
     AND (to_jsonb(NEW)->>'evaluation_id' IS DISTINCT FROM capability.request_json->>'evaluationId'
       OR to_jsonb(NEW)->>'obligation_set_id' IS DISTINCT FROM capability.request_json->>'obligationSetId'
       OR to_jsonb(NEW)->>'obligation_manifest_hash' IS DISTINCT FROM capability.request_json->>'obligationSetHash') THEN
    RAISE EXCEPTION 'Closeout row differs from authorized obligation subject' USING ERRCODE='42501';
  ELSIF TG_OP='INSERT' AND TG_TABLE_NAME='execution_cancellation_requests'
     AND (to_jsonb(NEW)->>'cancellation_id' IS DISTINCT FROM capability.request_json->>'cancellationId'
       OR to_jsonb(NEW)->>'lease_id' IS DISTINCT FROM capability.request_json->>'leaseId') THEN
    RAISE EXCEPTION 'Cancellation row differs from authorized lease subject' USING ERRCODE='42501';
  ELSIF TG_OP='INSERT' AND TG_TABLE_NAME='plan_change_proposals'
     AND (to_jsonb(NEW)->>'proposal_id' IS DISTINCT FROM capability.request_json->>'proposalId'
       OR to_jsonb(NEW)->>'base_hash' IS DISTINCT FROM capability.request_json->>'baseHash') THEN
    RAISE EXCEPTION 'Proposal row differs from authorized base subject' USING ERRCODE='42501';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
REVOKE ALL ON FUNCTION rorca.guard_wave2_runtime_canonical_dml() FROM PUBLIC;

DO $$
DECLARE table_name TEXT;
DECLARE runtime_user TEXT:=current_setting('rorca.runtime_database_user',TRUE);
BEGIN
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.authorize_wave2_runtime_mutation_v1(TEXT,TEXT,TEXT,TEXT,JSONB) TO %I',runtime_user);
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
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON rorca.%I FOR EACH ROW EXECUTE FUNCTION rorca.guard_wave2_runtime_canonical_dml()',
      'aa_wave2_capability_'||table_name,table_name);
    EXECUTE format('REVOKE DELETE,TRUNCATE ON rorca.%I FROM %I',table_name,runtime_user);
  END LOOP;
  -- Attempts are host/migration imports, never application-runtime authority.
  EXECUTE format('REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON rorca.governed_execution_attempts FROM %I',runtime_user);
END $$;

UPDATE rorca.wave2_schema_readiness SET migration_version=20260729152000,
  contract_source_digest='sha256:1111a20f8b6e8cfca7ddcf8861069989bdd7b7c4b52c5b12e26cb2ff8ad6bbfb',
  installed_at=clock_timestamp()
WHERE singleton=TRUE AND state='ready' AND migration_version=20260729151000
 AND contract_source_digest='sha256:ee4bb819784530868104f7f1a25e68d15105ca14ab8578d536055ade69992b2d';
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM rorca.wave2_schema_readiness WHERE singleton=TRUE AND state='ready' AND migration_version=20260729152000) THEN
  RAISE EXCEPTION 'Wave 2 final-review remediation readiness transition failed closed' USING ERRCODE='55000';
 END IF;
END $$;
