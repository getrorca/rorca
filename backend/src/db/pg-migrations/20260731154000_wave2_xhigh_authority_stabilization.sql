-- Wave 2 X-High authority stabilization: cryptographically bound canonical
-- transition surface, receiver payload transport, exact worker ownership, and
-- cross-fence repair-effect reconciliation. Forward-only.

SELECT set_config('rorca.migration_mode','on',TRUE);

-- Pin pgcrypto HMAC behind an owner-only wrapper regardless of extension schema.
DO $$
DECLARE crypto_schema TEXT;
BEGIN
  SELECT n.nspname INTO crypto_schema FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace
   WHERE e.extname='pgcrypto';
  IF crypto_schema IS NULL THEN RAISE EXCEPTION 'pgcrypto is required for canonical capability HMAC' USING ERRCODE='55000'; END IF;
  IF crypto_schema<>'rorca' THEN
    EXECUTE format($fn$
      CREATE OR REPLACE FUNCTION rorca.hmac(BYTEA,BYTEA,TEXT) RETURNS BYTEA
      LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS 'SELECT %I.hmac($1,$2,$3)'
    $fn$,crypto_schema);
    EXECUTE format($fn$
      CREATE OR REPLACE FUNCTION rorca.digest(BYTEA,TEXT) RETURNS BYTEA
      LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS 'SELECT %I.digest($1,$2)'
    $fn$,crypto_schema);
    REVOKE ALL ON FUNCTION rorca.hmac(BYTEA,BYTEA,TEXT) FROM PUBLIC;
    REVOKE ALL ON FUNCTION rorca.digest(BYTEA,TEXT) FROM PUBLIC;
  END IF;
END $$;

CREATE TABLE rorca.wave2_canonical_capability_secrets(
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
  secret BYTEA NOT NULL CHECK(octet_length(secret)=32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO rorca.wave2_canonical_capability_secrets(singleton,secret)
VALUES(TRUE,rorca.digest(clock_timestamp()::text||':'||txid_current()::text||':'||random()::text,'sha256'));
ALTER TABLE rorca.wave2_canonical_capability_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.wave2_canonical_capability_secrets FORCE ROW LEVEL SECURITY;
CREATE POLICY wave2_capability_secret_definer_read ON rorca.wave2_canonical_capability_secrets
  FOR SELECT USING(current_user IS DISTINCT FROM session_user);
REVOKE ALL ON rorca.wave2_canonical_capability_secrets FROM PUBLIC;

ALTER TABLE rorca.wave2_runtime_mutation_capabilities
  ADD COLUMN capability_mac BYTEA,
  ADD COLUMN effect_counts JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(effect_counts)='object');
CREATE OR REPLACE FUNCTION rorca.wave2_canonical_capability_mac_v3(
  p_secret BYTEA,p_transaction_id BIGINT,p_backend_pid INTEGER,p_database_user TEXT,p_workspace_id TEXT,
  p_operation TEXT,p_request_hash TEXT,p_subject_hash TEXT,p_request JSONB
) RETURNS BYTEA LANGUAGE sql IMMUTABLE STRICT SET search_path=rorca,pg_catalog AS $$
  SELECT rorca.hmac(convert_to(concat_ws(E'\x1f',p_transaction_id::text,p_backend_pid::text,p_database_user,
    p_workspace_id,p_operation,p_request_hash,p_subject_hash,p_request::text),'UTF8'),p_secret,'sha256')
$$;
REVOKE ALL ON FUNCTION rorca.wave2_canonical_capability_mac_v3(BYTEA,BIGINT,INTEGER,TEXT,TEXT,TEXT,TEXT,TEXT,JSONB) FROM PUBLIC;

CREATE OR REPLACE FUNCTION rorca.authorize_wave2_canonical_writer_mutation_v3(
  p_workspace_id TEXT,p_operation TEXT,p_request_hash TEXT,p_subject_hash TEXT,p_request JSONB
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=rorca,pg_catalog AS $$
DECLARE v_secret BYTEA;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM rorca.wave2_runtime_principal_identities i WHERE i.database_user=session_user
    AND i.grant_receipt_hash='sha256:af3a76e53c5f13157e10c0782d5c810428efb4e12ef4cb863b4ad04ad6f21093')
    OR EXISTS(SELECT 1 FROM rorca.wave2_runtime_mutation_capabilities capability
      WHERE capability.transaction_id=txid_current() AND capability.backend_pid=pg_backend_pid()
        AND capability.database_user=session_user AND capability.workspace_id=p_workspace_id
        AND capability.operation=p_operation)
  THEN RAISE EXCEPTION 'Canonical writer identity denied or operation capability already issued' USING ERRCODE='42501'; END IF;
  PERFORM rorca.authorize_wave2_runtime_mutation_v1(p_workspace_id,p_operation,p_request_hash,p_subject_hash,p_request);
  SELECT secret INTO STRICT v_secret FROM rorca.wave2_canonical_capability_secrets WHERE singleton=TRUE;
  UPDATE rorca.wave2_runtime_mutation_capabilities capability SET capability_mac=
    rorca.wave2_canonical_capability_mac_v3(v_secret,capability.transaction_id,capability.backend_pid,
      capability.database_user,capability.workspace_id,capability.operation,capability.request_hash,
      capability.subject_hash,capability.request_json)
  WHERE capability.transaction_id=txid_current() AND capability.backend_pid=pg_backend_pid()
    AND capability.database_user=session_user AND capability.workspace_id=p_workspace_id AND capability.operation=p_operation;
  IF NOT FOUND THEN RAISE EXCEPTION 'Canonical capability issuance failed' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION rorca.authorize_wave2_canonical_writer_mutation_v3(TEXT,TEXT,TEXT,TEXT,JSONB) FROM PUBLIC;
DO $$ DECLARE writer_user TEXT:=current_setting('rorca.canonical_writer_database_user',TRUE); BEGIN
  EXECUTE format('REVOKE EXECUTE ON FUNCTION rorca.authorize_wave2_canonical_writer_mutation_v2(TEXT,TEXT,TEXT,TEXT,JSONB) FROM %I',writer_user);
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.authorize_wave2_canonical_writer_mutation_v3(TEXT,TEXT,TEXT,TEXT,JSONB) TO %I',writer_user);
END $$;

CREATE TABLE rorca.wave2_canonical_dml_effect_receipts(
  transaction_id BIGINT NOT NULL,
  backend_pid INTEGER NOT NULL,
  database_user TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  relation_name TEXT NOT NULL,
  dml_operation TEXT NOT NULL CHECK(dml_operation IN('INSERT','UPDATE')),
  row_hash TEXT NOT NULL CHECK(row_hash ~ '^sha256:[0-9a-f]{64}$'),
  request_hash TEXT NOT NULL CHECK(request_hash ~ '^sha256:[0-9a-f]{64}$'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(transaction_id,backend_pid,database_user,workspace_id,operation,relation_name,dml_operation,row_hash)
);
ALTER TABLE rorca.wave2_canonical_dml_effect_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.wave2_canonical_dml_effect_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY wave2_canonical_effect_definer_insert ON rorca.wave2_canonical_dml_effect_receipts
  FOR INSERT WITH CHECK(current_user IS DISTINCT FROM session_user);
REVOKE ALL ON rorca.wave2_canonical_dml_effect_receipts FROM PUBLIC;

-- One relation map is shared by selection and effect recording. A trigger may
-- never select a capability that is valid only for a different relation.
CREATE OR REPLACE FUNCTION rorca.wave2_canonical_relation_operations_v3(p_relation TEXT)
RETURNS TEXT[] LANGUAGE sql IMMUTABLE STRICT SET search_path=rorca,pg_catalog AS $$
 SELECT CASE p_relation
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
    WHEN 'mission_control_idempotency' THEN ARRAY['mission.compile','work-package.revise','lease.acquire','lease.renew','lease.release','context-policy.publish','context-policy.activate','retrieval-receipt.persist','context-bundle.persist','context-delta.persist','continuation-budget.persist','continuation-dispatch.authorize','checkpoint.persist','closeout.evaluate','cancellation.request','cancellation.acknowledge','plan-change.propose','plan-change.review','context-epoch-retirement.evaluate']
    WHEN 'mission_control_replay_conflicts' THEN ARRAY['mission.compile','work-package.revise','lease.acquire','lease.renew','lease.release','context-policy.publish','context-policy.activate','retrieval-receipt.persist','context-bundle.persist','context-delta.persist','continuation-budget.persist','continuation-dispatch.authorize','checkpoint.persist','closeout.evaluate','cancellation.request','cancellation.acknowledge','plan-change.propose','plan-change.review','context-epoch-retirement.evaluate']
    WHEN 'mission_control_audit' THEN ARRAY['mission.compile','work-package.revise','lease.acquire','lease.renew','lease.release','context-policy.publish','context-policy.activate','retrieval-receipt.persist','context-bundle.persist','context-delta.persist','continuation-budget.persist','continuation-dispatch.authorize','continuation-dispatch.consume','checkpoint.persist','runtime-event.ingest','evidence.ingest','closeout.evaluate','cancellation.request','cancellation.acknowledge','plan-change.propose','plan-change.review','context-epoch-retirement.evaluate','mutation-rejection.audit']
    WHEN 'context_epoch_retirement_evaluations' THEN ARRAY['context-epoch-retirement.evaluate']
    ELSE ARRAY[]::TEXT[] END
$$;
REVOKE ALL ON FUNCTION rorca.wave2_canonical_relation_operations_v3(TEXT) FROM PUBLIC;

-- One unified trigger is mandatory on every mutable canonical base relation.
-- It selects one operation+relation capability, verifies its DB-owned HMAC,
-- exact request/subject, old/new transition and changed-column ceiling, then
-- atomically consumes that capability's bounded relation/DML cardinality.
CREATE OR REPLACE FUNCTION rorca.guard_wave2_canonical_dml_v3() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=rorca,pg_catalog AS $$
DECLARE capability rorca.wave2_runtime_mutation_capabilities%ROWTYPE;
DECLARE v_secret BYTEA;
DECLARE expected_mac BYTEA;
DECLARE row_json JSONB:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
DECLARE old_json JSONB:=CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
DECLARE request_json JSONB;
DECLARE artifact JSONB;
DECLARE changed_columns TEXT[]:=ARRAY[]::TEXT[];
DECLARE allowed_columns TEXT[]:=ARRAY[]::TEXT[];
DECLARE identity_ok BOOLEAN:=FALSE;
DECLARE row_hash TEXT;
DECLARE permitted_operations TEXT[];
DECLARE effect_key TEXT;
DECLARE maximum_effects INTEGER:=1;
DECLARE capability_matches INTEGER:=0;
BEGIN
  IF session_user=current_user THEN IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Canonical deletes are forbidden' USING ERRCODE='42501'; END IF;
  permitted_operations:=rorca.wave2_canonical_relation_operations_v3(TG_TABLE_NAME);
  SELECT count(*) INTO capability_matches FROM rorca.wave2_runtime_mutation_capabilities c
   WHERE c.transaction_id=txid_current() AND c.backend_pid=pg_backend_pid() AND c.database_user=session_user
     AND c.workspace_id=row_json->>'workspace_id' AND c.operation=ANY(permitted_operations);
  IF capability_matches<>1 THEN
    RAISE EXCEPTION 'Exactly one operation+relation capability is required' USING ERRCODE='42501';
  END IF;
  SELECT * INTO capability FROM rorca.wave2_runtime_mutation_capabilities c
   WHERE c.transaction_id=txid_current() AND c.backend_pid=pg_backend_pid() AND c.database_user=session_user
     AND c.workspace_id=row_json->>'workspace_id' AND c.operation=ANY(permitted_operations)
   ORDER BY c.issued_at DESC,c.operation DESC LIMIT 1;
  IF capability.operation IS NULL OR capability.capability_mac IS NULL
    OR current_setting('rorca.workspace_id',TRUE) IS DISTINCT FROM row_json->>'workspace_id'
  THEN RAISE EXCEPTION 'Exact canonical HMAC capability required' USING ERRCODE='42501'; END IF;
  SELECT secret INTO STRICT v_secret FROM rorca.wave2_canonical_capability_secrets WHERE singleton=TRUE;
  expected_mac:=rorca.wave2_canonical_capability_mac_v3(v_secret,capability.transaction_id,capability.backend_pid,
    capability.database_user,capability.workspace_id,capability.operation,capability.request_hash,
    capability.subject_hash,capability.request_json);
  IF expected_mac IS DISTINCT FROM capability.capability_mac THEN
    RAISE EXCEPTION 'Canonical capability MAC mismatch' USING ERRCODE='42501';
  END IF;
  request_json:=capability.request_json;
  artifact:=COALESCE(request_json->'mission',request_json->'value',request_json->'policy',request_json->'artifact',
    request_json->'acknowledgement',request_json);

  identity_ok:=CASE TG_TABLE_NAME
    WHEN 'governed_missions' THEN row_json->>'mission_id'=artifact->>'missionId'
    WHEN 'governed_mission_versions' THEN row_json->>'mission_id'=artifact->>'missionId' AND row_json->>'mission_revision'=artifact->>'missionRevision'
    WHEN 'governed_mission_heads' THEN row_json->>'mission_id'=artifact->>'missionId'
    WHEN 'governed_work_packages' THEN row_json->>'mission_id'=artifact->>'missionId' AND row_json->>'work_package_id'=artifact->>'workPackageId'
    WHEN 'governed_work_package_revisions' THEN row_json->>'mission_id'=artifact->>'missionId' AND row_json->>'work_package_id'=artifact->>'workPackageId' AND row_json->>'work_package_revision'=artifact->>'workPackageRevision'
    WHEN 'governed_work_package_dependencies' THEN row_json->>'mission_id'=artifact->>'missionId' AND row_json->>'work_package_id'=artifact->>'workPackageId' AND row_json->>'work_package_revision'=artifact->>'workPackageRevision'
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(artifact->'dependencies') WITH ORDINALITY d(value,ordinal)
        WHERE ordinal-1=(row_json->>'dependency_order')::bigint AND value->>'workPackageId'=row_json->>'dependency_work_package_id'
          AND value->>'revision'=row_json->>'dependency_revision' AND value->>'hash'=row_json->>'dependency_hash')
    WHEN 'governed_work_package_heads' THEN row_json->>'mission_id'=artifact->>'missionId' AND row_json->>'work_package_id'=artifact->>'workPackageId'
    WHEN 'execution_lease_slots' THEN (capability.operation='lease.acquire' AND row_json->>'active_lease_id'=artifact->>'leaseId')
      OR (capability.operation='lease.release' AND old_json->>'active_lease_id'=artifact->>'leaseId' AND row_json->>'active_lease_id' IS NULL)
      OR (TG_OP='INSERT' AND capability.operation IN('lease.acquire','context-policy.activate'))
      OR (capability.operation='cancellation.request' AND old_json->>'active_lease_id'=artifact->>'leaseId')
    WHEN 'execution_leases' THEN row_json->>'lease_id'=COALESCE(artifact->>'leaseId',request_json->>'leaseId')
      OR (capability.operation='lease.acquire' AND TG_OP='UPDATE' AND row_json->>'state'='expired')
    WHEN 'execution_lease_events' THEN row_json->>'lease_id'=COALESCE(artifact->>'leaseId',request_json->>'leaseId')
    WHEN 'context_policy_definitions' THEN row_json->>'policy_definition_id'=artifact->>'policyDefinitionId' AND row_json->>'policy_definition_version'=artifact->>'policyDefinitionVersion'
    WHEN 'context_policy_activations' THEN row_json->>'activation_id'=artifact->>'activationId' AND row_json->>'activation_revision'=artifact->>'activationRevision'
    WHEN 'context_policy_activation_heads' THEN row_json->>'activation_id'=artifact->>'activationId'
    WHEN 'context_scope_heads' THEN capability.operation='checkpoint.persist'
    WHEN 'context_checkpoints' THEN row_json->>'checkpoint_id'=artifact->>'checkpointId' AND row_json->>'lease_id'=artifact#>>'{scope,leaseId}'
    WHEN 'context_retrieval_receipts' THEN row_json->>'receipt_id'=artifact->>'receiptId' AND row_json->>'lease_id' IS NULL
    WHEN 'context_retrieval_sources' THEN row_json->>'receipt_id'=artifact->>'receiptId'
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(artifact->'sources') WITH ORDINALITY source(value,ordinal)
        WHERE ordinal-1=(row_json->>'source_order')::bigint
          AND value->>'contextClass'=row_json->>'context_class' AND value->>'sourceType'=row_json->>'source_type'
          AND value->>'stableSourceId'=row_json->>'stable_source_id' AND value->>'sourceVersion'=row_json->>'source_version'
          AND value->>'contentHash'=row_json->>'content_hash' AND value->>'freshness'=row_json->>'freshness'
          AND (value->>'excluded')::boolean=(row_json->>'excluded')::boolean
          AND COALESCE(value->>'redactionHash','')=COALESCE(row_json->>'redaction_hash',''))
    WHEN 'context_bundles' THEN row_json->>'bundle_id'=artifact->>'bundleId'
    WHEN 'context_bundle_deltas' THEN row_json->>'delta_id'=artifact->>'deltaId'
    WHEN 'continuation_retry_budgets' THEN row_json->>'continuation_key'=artifact->>'continuationKey'
    WHEN 'continuation_retry_events' THEN row_json->>'continuation_key'=artifact->>'continuationKey'
    WHEN 'continuation_quarantines' THEN row_json->>'continuation_key'=artifact->>'continuationKey'
    WHEN 'continuation_dispatches' THEN row_json->>'dispatch_id'=artifact->>'dispatchId'
      AND (capability.operation<>'continuation-outbox.settle' OR row_json->>'state'=artifact->>'dispatchState')
    WHEN 'continuation_dispatch_consumptions' THEN row_json->>'dispatch_id'=artifact->>'dispatchId' AND row_json->>'continuation_key'=artifact->>'continuationKey'
    WHEN 'continuation_dispatch_outbox' THEN row_json->>'dispatch_id'=artifact->>'dispatchId'
    WHEN 'continuation_dispatch_outcomes' THEN row_json->>'dispatch_id'=artifact->>'dispatchId' AND row_json->>'claim_fence'=artifact->>'claimFence'
      AND row_json->>'transport_accepted'=artifact->>'transportAccepted' AND COALESCE(row_json->>'transport_receipt_hash','')=COALESCE(artifact->>'transportReceiptHash','')
      AND row_json->>'outcome_hash'=artifact->>'outcomeHash' AND row_json->>'outcome_state'=artifact->>'effectiveOutcome'
      AND row_json->>'reason_code'=artifact->>'effectiveReason'
    WHEN 'continuation_dispatch_acceptances' THEN row_json->>'dispatch_id'=artifact->>'dispatchId' AND row_json->>'claim_fence'=artifact->>'claimFence'
      AND row_json->>'send_authorization_hash'=artifact->>'sendAuthorizationHash' AND row_json->>'delivery_key'=artifact->>'deliveryKey'
      AND row_json->>'payload_hash'=artifact->>'payloadHash' AND row_json->>'receiver_id'=artifact->>'receiverPrincipalId'
      AND row_json->>'acceptance_receipt_hash'=artifact->>'acceptanceReceiptHash'
    WHEN 'runtime_event_stream_heads' THEN row_json->>'attempt_id'=artifact#>>'{scope,attemptId}' AND row_json->>'runtime_generation'=artifact#>>'{scope,runtimeGeneration}'
    WHEN 'runtime_events' THEN row_json->>'event_id'=artifact->>'eventId' AND row_json->>'attempt_id'=artifact#>>'{scope,attemptId}'
    WHEN 'runtime_event_conflicts' THEN row_json->>'event_id'=artifact->>'eventId'
    WHEN 'ssdlc_lifecycle_evidence' THEN row_json->>'source_idempotency_key'=artifact->>'evidenceId' AND row_json->>'governed_attempt_id'=artifact->>'attemptId'
    WHEN 'governed_closeout_evaluations' THEN row_json->>'evaluation_id'=artifact->>'evaluationId' AND row_json->>'attempt_id'=artifact->>'attemptId'
    WHEN 'execution_cancellation_requests' THEN row_json->>'cancellation_id'=artifact->>'cancellationId' AND row_json->>'lease_id'=artifact->>'leaseId'
    WHEN 'execution_cancellation_acknowledgements' THEN row_json->>'acknowledgement_id'=artifact->>'acknowledgementId' AND row_json->>'lease_id'=artifact->>'leaseId'
    WHEN 'plan_change_proposals' THEN row_json->>'proposal_id'=artifact->>'proposalId' AND row_json->>'lease_id'=artifact->>'leaseId'
    WHEN 'plan_change_proposal_heads' THEN row_json->>'proposal_id'=artifact->>'proposalId'
    WHEN 'plan_change_proposal_reviews' THEN row_json->>'proposal_id'=artifact->>'proposalId'
    WHEN 'mission_control_idempotency' THEN row_json->>'operation'=capability.operation AND row_json->>'request_hash'=capability.request_hash AND row_json->>'subject_hash'=capability.subject_hash
    WHEN 'mission_control_replay_conflicts' THEN row_json->>'operation'=capability.operation AND row_json->>'incoming_hash'=capability.request_hash AND row_json->>'subject_hash'=capability.subject_hash
    WHEN 'mission_control_audit' THEN row_json->>'operation'=
        CASE WHEN capability.operation='mutation-rejection.audit' THEN request_json->>'operation' ELSE capability.operation END
      AND row_json->>'request_hash'=capability.request_hash AND row_json->>'subject_hash'=capability.subject_hash
    WHEN 'context_epoch_retirement_evaluations' THEN row_json->>'evaluation_id'=artifact->>'evaluationId'
    ELSE FALSE END;
  IF NOT identity_ok THEN RAISE EXCEPTION 'Canonical row subject is outside exact request capability' USING ERRCODE='42501'; END IF;

  -- Exact whole-artifact and mutable-head binding. These checks and the
  -- relation selection above use the same `capability` record; no second
  -- trigger can reinterpret another request as transition authority.
  IF TG_OP='INSERT' AND TG_TABLE_NAME='governed_mission_versions' AND (
      row_json->'payload_json' IS DISTINCT FROM artifact
      OR row_json->>'mission_hash' IS DISTINCT FROM artifact->>'missionHash') THEN
    RAISE EXCEPTION 'Mission revision differs from exact authorized request' USING ERRCODE='42501';
  ELSIF TG_TABLE_NAME='governed_mission_heads' AND (
      row_json->>'current_revision' IS DISTINCT FROM artifact->>'missionRevision'
      OR row_json->>'current_hash' IS DISTINCT FROM artifact->>'missionHash'
      OR row_json->>'lifecycle_state'<>'compiled'
      OR (TG_OP='INSERT' AND row_json->>'state_version'<>'1')
      OR (TG_OP='UPDATE' AND (old_json->>'state_version' IS DISTINCT FROM request_json->>'expectedStateVersion'
        OR (row_json->>'state_version')::bigint<>(old_json->>'state_version')::bigint+1))) THEN
    RAISE EXCEPTION 'Mission head differs from exact authorized CAS' USING ERRCODE='42501';
  ELSIF TG_OP='INSERT' AND TG_TABLE_NAME='governed_work_package_revisions' AND (
      row_json->'payload_json' IS DISTINCT FROM artifact
      OR row_json->>'work_package_hash' IS DISTINCT FROM artifact->>'workPackageHash') THEN
    RAISE EXCEPTION 'Work-package revision differs from exact authorized request' USING ERRCODE='42501';
  ELSIF TG_TABLE_NAME='governed_work_package_heads' AND (
      row_json->>'current_revision' IS DISTINCT FROM artifact->>'workPackageRevision'
      OR row_json->>'current_hash' IS DISTINCT FROM artifact->>'workPackageHash'
      OR row_json->>'lifecycle_state' IS DISTINCT FROM artifact->>'state'
      OR (TG_OP='INSERT' AND row_json->>'state_version'<>'1')
      OR (TG_OP='UPDATE' AND (old_json->>'state_version' IS DISTINCT FROM request_json->>'expectedStateVersion'
        OR (row_json->>'state_version')::bigint<>(old_json->>'state_version')::bigint+1))) THEN
    RAISE EXCEPTION 'Work-package head differs from exact authorized CAS' USING ERRCODE='42501';
  ELSIF TG_OP='INSERT' AND TG_TABLE_NAME='context_policy_definitions'
      AND row_json->'body_json' IS DISTINCT FROM artifact THEN
    RAISE EXCEPTION 'Policy definition differs from exact authorized request' USING ERRCODE='42501';
  ELSIF TG_OP='INSERT' AND TG_TABLE_NAME='context_policy_activations' AND (
      row_json->>'activation_hash' IS DISTINCT FROM artifact->>'activationHash'
      OR row_json->>'authority_receipt_id' IS DISTINCT FROM artifact->>'authorityReceiptId'
      OR row_json->>'state' IS DISTINCT FROM artifact->>'state') THEN
    RAISE EXCEPTION 'Policy activation differs from exact receipt subject' USING ERRCODE='42501';
  ELSIF TG_TABLE_NAME='context_policy_activation_heads' AND (
      row_json->>'current_revision' IS DISTINCT FROM artifact->>'activationRevision'
      OR row_json->>'current_hash' IS DISTINCT FROM artifact->>'activationHash'
      OR row_json->>'effective_state' IS DISTINCT FROM artifact->>'state'
      OR (TG_OP='INSERT' AND row_json->>'state_version'<>'1')
      OR (TG_OP='UPDATE' AND (row_json->>'state_version')::bigint<>(old_json->>'state_version')::bigint+1)) THEN
    RAISE EXCEPTION 'Activation head differs from exact authorized revision' USING ERRCODE='42501';
  ELSIF TG_OP='INSERT' AND TG_TABLE_NAME='mission_control_audit'
      AND capability.operation='mutation-rejection.audit' AND row_json->>'decision'<>'blocked' THEN
    RAISE EXCEPTION 'Rejected-mutation audit cannot assert accepted authority' USING ERRCODE='42501';
  END IF;

  IF TG_OP='UPDATE' THEN
    SELECT COALESCE(array_agg(key ORDER BY key),ARRAY[]::TEXT[]) INTO changed_columns
      FROM jsonb_each(row_json) entry(key,value) WHERE value IS DISTINCT FROM old_json->key;
    allowed_columns:=CASE TG_TABLE_NAME
      WHEN 'governed_mission_heads' THEN ARRAY['current_revision','current_hash','lifecycle_state','state_version','updated_at']
      WHEN 'governed_work_package_heads' THEN ARRAY['current_revision','current_hash','lifecycle_state','state_version','updated_at']
      WHEN 'execution_lease_slots' THEN ARRAY['last_fence','active_lease_id','state_version','updated_at']
      WHEN 'execution_leases' THEN ARRAY['state','expires_at','state_version']
      WHEN 'context_policy_activation_heads' THEN ARRAY['current_revision','current_hash','effective_state','state_version','updated_at']
      WHEN 'context_scope_heads' THEN ARRAY['checkpoint_id','checkpoint_sequence','state_version','updated_at']
      WHEN 'continuation_retry_budgets' THEN ARRAY['retrieval_spent','transport_spent','in_flight_owner','retry_fence','retry_expires_at','next_retry_at','state','reason_code','permanent_conflict_count','state_version']
      WHEN 'continuation_dispatches' THEN ARRAY['state','cas_verification_hash','state_version']
      WHEN 'continuation_dispatch_outbox' THEN ARRAY['state','claim_owner','claim_fence','claim_expires_at','attempt_count','send_authorization_hash','send_authorized_at','send_authorization_expires_at','send_authorization_consumed_at','receiver_acceptance_receipt_hash','receiver_accepted_at','transport_receipt_hash','last_error_code','state_version','updated_at']
      WHEN 'runtime_event_stream_heads' THEN ARRAY['last_runtime_sequence','last_canonical_state_order','last_host_receipt_order','state_version']
      WHEN 'plan_change_proposal_heads' THEN ARRAY['current_state','state_version','updated_at']
      WHEN 'mission_control_idempotency' THEN ARRAY['status','response_hash','response_json','completed_at']
      ELSE ARRAY[]::TEXT[] END;
    IF NOT changed_columns<@allowed_columns THEN RAISE EXCEPTION 'Canonical update changes columns outside operation ceiling' USING ERRCODE='42501'; END IF;

    IF TG_TABLE_NAME='continuation_dispatch_outbox' THEN
      IF capability.operation='continuation-outbox.claim' AND NOT (
          (row_json->>'state'='claimed' AND row_json->>'claim_owner'=artifact->>'owner'
            AND (row_json->>'claim_fence')::bigint=(old_json->>'claim_fence')::bigint+1
            AND (row_json->>'attempt_count')::bigint=(old_json->>'attempt_count')::bigint+1)
          OR row_json->>'state'='quarantined') THEN
        RAISE EXCEPTION 'Outbox claim transition is not exact' USING ERRCODE='42501';
      ELSIF capability.operation='continuation-outbox.authorize-send' AND NOT (
          old_json->>'claim_owner'=artifact->>'owner' AND old_json->>'claim_fence'=artifact->>'claimFence'
          AND old_json->>'delivery_key'=artifact->>'deliveryKey' AND old_json->>'payload_hash'=artifact->>'payloadHash'
          AND row_json->>'send_authorization_hash' ~ '^sha256:[0-9a-f]{64}$') THEN
        RAISE EXCEPTION 'Outbox send authorization transition is not exact' USING ERRCODE='42501';
      ELSIF capability.operation='continuation-outbox.accept' AND NOT (
          old_json->>'claim_owner'=artifact->>'owner' AND old_json->>'claim_fence'=artifact->>'claimFence'
          AND old_json->>'send_authorization_hash'=artifact->>'sendAuthorizationHash'
          AND row_json->>'receiver_acceptance_receipt_hash'=artifact->>'acceptanceReceiptHash'
          AND (row_json->>'send_authorization_consumed_at')::timestamptz=(artifact->>'acceptedAt')::timestamptz) THEN
        RAISE EXCEPTION 'Outbox receiver acceptance transition is not exact' USING ERRCODE='42501';
      ELSIF capability.operation='continuation-outbox.settle' AND NOT (
          old_json->>'claim_owner'=artifact->>'owner' AND old_json->>'claim_fence'=artifact->>'claimFence'
          AND old_json->>'send_authorization_hash'=artifact->>'sendAuthorizationHash'
          AND row_json->>'state'=artifact->>'state') THEN
        RAISE EXCEPTION 'Outbox settlement transition is not exact' USING ERRCODE='42501';
      END IF;
    END IF;
  END IF;

  -- Consume cardinality on the same exact capability selected above. Reissuing
  -- one operation in a transaction is forbidden by the issuer, so this counter
  -- cannot be reset to authorize extra rows. Multi-row relations are bounded by
  -- and identity-checked against the exact ordered request arrays.
  effect_key:=TG_TABLE_NAME||':'||TG_OP;
  maximum_effects:=CASE TG_TABLE_NAME
    WHEN 'governed_work_package_dependencies' THEN COALESCE(jsonb_array_length(artifact->'dependencies'),0)
    WHEN 'context_retrieval_sources' THEN COALESCE(jsonb_array_length(artifact->'sources'),0)
    ELSE 1 END;
  UPDATE rorca.wave2_runtime_mutation_capabilities consumed SET effect_counts=jsonb_set(consumed.effect_counts,
      ARRAY[effect_key],to_jsonb(COALESCE((consumed.effect_counts->>effect_key)::integer,0)+1),TRUE)
   WHERE consumed.transaction_id=capability.transaction_id AND consumed.backend_pid=capability.backend_pid
     AND consumed.database_user=capability.database_user AND consumed.workspace_id=capability.workspace_id
     AND consumed.operation=capability.operation
     AND COALESCE((consumed.effect_counts->>effect_key)::integer,0)<maximum_effects;
  IF NOT FOUND THEN RAISE EXCEPTION 'Canonical capability effect cardinality exceeded' USING ERRCODE='42501'; END IF;

  row_hash:='sha256:'||encode(rorca.digest(convert_to(TG_TABLE_NAME||E'\x1f'||TG_OP||E'\x1f'||old_json::text||E'\x1f'||row_json::text,'UTF8'),'sha256'),'hex');
  INSERT INTO rorca.wave2_canonical_dml_effect_receipts(transaction_id,backend_pid,database_user,workspace_id,
    operation,relation_name,dml_operation,row_hash,request_hash)
  VALUES(txid_current(),pg_backend_pid(),session_user,row_json->>'workspace_id',capability.operation,TG_TABLE_NAME,TG_OP,row_hash,capability.request_hash);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION rorca.guard_wave2_canonical_dml_v3() FROM PUBLIC;

DO $$
DECLARE table_name TEXT;
BEGIN
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
    -- Migration 152000 installed the split V1 trigger. Remove it before
    -- exposing the writer view, then install exactly one trigger that performs
    -- relation selection, MAC/subject/old-new checks, columns, and cardinality.
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON rorca.%I','aa_wave2_capability_'||table_name,table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON rorca.%I FOR EACH ROW EXECUTE FUNCTION rorca.guard_wave2_canonical_dml_v3()',
      'aa_wave2_exact_'||table_name,table_name);
  END LOOP;
END $$;

-- Revoke broad base DML. Owner-controlled, workspace-filtered updatable views
-- preserve the application SQL shape while base triggers enforce the exact
-- cryptographic transition capability.
CREATE SCHEMA rorca_canonical_api;
REVOKE ALL ON SCHEMA rorca_canonical_api FROM PUBLIC;
DO $$
DECLARE table_name TEXT;
DECLARE writer_user TEXT:=current_setting('rorca.canonical_writer_database_user',TRUE);
DECLARE runtime_user TEXT:=current_setting('rorca.runtime_database_user',TRUE);
BEGIN
  -- Existing writer-only RLS policies reference this identity relation. Give
  -- runtime SELECT permission so PostgreSQL can evaluate the OR-ed policies;
  -- its self-only RLS policy still exposes zero writer rows.
  EXECUTE format('GRANT SELECT ON rorca.wave2_canonical_writer_identities TO %I',runtime_user);
  EXECUTE format('GRANT SELECT ON rorca.context_contract_release_history,rorca.context_epoch_client_migrations,
    rorca.context_epoch_projection_reads,rorca.execution_cancellation_effective_state TO %I',writer_user);
  EXECUTE format('GRANT USAGE ON SCHEMA rorca_canonical_api TO %I',writer_user);
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
    EXECUTE format('REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON rorca.%I FROM %I',table_name,writer_user);
    EXECUTE format('CREATE VIEW rorca_canonical_api.%I AS SELECT * FROM rorca.%I WHERE workspace_id=current_setting(''rorca.workspace_id'',TRUE)',table_name,table_name);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON rorca_canonical_api.%I TO %I',table_name,writer_user);
  END LOOP;
END $$;

-- Receiver transport stores the exact canonical bytes it accepted. Existing
-- metadata-only rows are quarantined and retained rather than fabricated.
ALTER TABLE rorca.continuation_dispatch_receiver_inbox ADD COLUMN payload_bytes BYTEA;
ALTER TABLE rorca.continuation_dispatch_receiver_inbox ADD COLUMN payload_bytes_hash TEXT CHECK(payload_bytes_hash IS NULL OR payload_bytes_hash ~ '^sha256:[0-9a-f]{64}$');
ALTER TABLE rorca.continuation_dispatch_receiver_inbox ADD COLUMN payload_size INTEGER CHECK(payload_size IS NULL OR payload_size BETWEEN 1 AND 65536);
UPDATE rorca.continuation_dispatch_receiver_inbox SET state='quarantined' WHERE payload_bytes IS NULL;
CREATE POLICY wave2_receiver_inbox_definer_insert ON rorca.continuation_dispatch_receiver_inbox
  FOR INSERT WITH CHECK(current_user IS DISTINCT FROM session_user AND receiver_principal_id='rorca-dispatch-receiver');
CREATE POLICY wave2_receiver_inbox_migration_read ON rorca.continuation_dispatch_receiver_inbox
  FOR SELECT USING(current_setting('rorca.migration_mode',TRUE)='on'
    AND EXISTS(SELECT 1 FROM rorca.wave2_database_principals p
      WHERE p.database_user=current_user AND p.principal_class='migration_owner'));
-- The receiver transition needs only the exact acceptance/outbox lineage rows.
-- A dedicated transaction-local mode avoids opening the migration-owner policy
-- over every canonical relation while the definer runs.
CREATE POLICY wave2_receiver_acceptance_definer_read ON rorca.continuation_dispatch_acceptances
  FOR SELECT USING(current_setting('rorca.receiver_transition_mode',TRUE)='on'
    AND workspace_id=current_setting('rorca.workspace_id',TRUE)
    AND current_user IS DISTINCT FROM session_user
    AND EXISTS(SELECT 1 FROM rorca.wave2_database_principals p
      WHERE p.database_user=current_user AND p.principal_class='migration_owner'));
CREATE POLICY wave2_receiver_outbox_definer_read ON rorca.continuation_dispatch_outbox
  FOR SELECT USING(current_setting('rorca.receiver_transition_mode',TRUE)='on'
    AND workspace_id=current_setting('rorca.workspace_id',TRUE)
    AND current_user IS DISTINCT FROM session_user
    AND EXISTS(SELECT 1 FROM rorca.wave2_database_principals p
      WHERE p.database_user=current_user AND p.principal_class='migration_owner'));
CREATE OR REPLACE FUNCTION rorca.insert_continuation_receiver_inbox_v2(
  p_workspace_id TEXT,p_dispatch_id TEXT,p_receiver_principal_id TEXT,p_acceptance_receipt_hash TEXT,
  p_delivery_key TEXT,p_payload_hash TEXT,p_accepted_at TIMESTAMPTZ,p_payload_bytes BYTEA,p_payload_bytes_hash TEXT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=rorca,pg_catalog AS $$
DECLARE prior_receiver_mode TEXT:=current_setting('rorca.receiver_transition_mode',TRUE);
BEGIN
  IF current_setting('rorca.workspace_id',TRUE) IS DISTINCT FROM p_workspace_id
    OR p_receiver_principal_id<>'rorca-dispatch-receiver'
  THEN RAISE EXCEPTION 'Receiver payload identity denied' USING ERRCODE='42501'; END IF;
  IF octet_length(p_payload_bytes) NOT BETWEEN 1 AND 65536
    OR p_payload_bytes_hash<>('sha256:'||encode(rorca.digest(p_payload_bytes,'sha256'),'hex'))
  THEN RAISE EXCEPTION 'Receiver payload byte digest denied' USING ERRCODE='42501'; END IF;
  PERFORM set_config('rorca.receiver_transition_mode','on',TRUE);
  IF NOT EXISTS(SELECT 1 FROM rorca.continuation_dispatch_acceptances acceptance
      JOIN rorca.continuation_dispatch_outbox outbox USING(workspace_id,dispatch_id)
      WHERE acceptance.workspace_id=p_workspace_id AND acceptance.dispatch_id=p_dispatch_id
        AND acceptance.receiver_id=p_receiver_principal_id AND acceptance.acceptance_receipt_hash=p_acceptance_receipt_hash
        AND acceptance.delivery_key=p_delivery_key AND acceptance.payload_hash=p_payload_hash AND acceptance.accepted_at=p_accepted_at
        AND outbox.send_authorization_consumed_at=p_accepted_at
        AND outbox.receiver_acceptance_receipt_hash=p_acceptance_receipt_hash AND outbox.receiver_accepted_at=p_accepted_at)
  THEN RAISE EXCEPTION 'Receiver payload acceptance lineage denied' USING ERRCODE='42501'; END IF;
  INSERT INTO rorca.continuation_dispatch_receiver_inbox(workspace_id,dispatch_id,receiver_principal_id,
    acceptance_receipt_hash,delivery_key,payload_hash,accepted_at,payload_bytes,payload_bytes_hash,payload_size)
  VALUES(p_workspace_id,p_dispatch_id,p_receiver_principal_id,p_acceptance_receipt_hash,p_delivery_key,p_payload_hash,
    p_accepted_at,p_payload_bytes,p_payload_bytes_hash,octet_length(p_payload_bytes));
  PERFORM set_config('rorca.receiver_transition_mode',COALESCE(prior_receiver_mode,''),TRUE);
END $$;
REVOKE ALL ON FUNCTION rorca.insert_continuation_receiver_inbox_v2(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,BYTEA,TEXT) FROM PUBLIC;
DO $$ DECLARE writer_user TEXT:=current_setting('rorca.canonical_writer_database_user',TRUE); BEGIN
  EXECUTE format('REVOKE EXECUTE ON FUNCTION rorca.insert_continuation_receiver_inbox_v1(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ) FROM %I',writer_user);
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.insert_continuation_receiver_inbox_v2(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,BYTEA,TEXT) TO %I',writer_user);
END $$;

-- One broker identity owns at most one application job, independent of payload.
CREATE UNIQUE INDEX spec_jobs_exact_transport_owner_uq ON rorca.spec_jobs(boss_job_id,transport_schema)
WHERE boss_job_id IS NOT NULL AND transport_schema IS NOT NULL;

-- Stable repair-effect identity spans owners and fences. A prior authorized
-- receipt is ambiguous, never safely retryable. Completed results are replayable.
ALTER TABLE rorca.spec_repair_effect_receipts DROP CONSTRAINT IF EXISTS spec_repair_effect_receipts_state_check;
ALTER TABLE rorca.spec_repair_effect_receipts DROP CONSTRAINT IF EXISTS spec_repair_effect_receipts_check;
ALTER TABLE rorca.spec_repair_effect_receipts ADD COLUMN result_json JSONB;
ALTER TABLE rorca.spec_repair_effect_receipts ADD CONSTRAINT spec_repair_effect_receipts_state_v2_check
  CHECK(state IN('authorized','completed','failed','ambiguous'));
ALTER TABLE rorca.spec_repair_effect_receipts ADD CONSTRAINT spec_repair_effect_receipts_terminal_v2_check
  CHECK((state='authorized' AND completed_at IS NULL AND result_json IS NULL)
    OR (state='completed' AND completed_at IS NOT NULL AND result_json IS NOT NULL)
    OR (state IN('failed','ambiguous') AND completed_at IS NOT NULL));
-- V1 labeled thrown external effects as failed even though they could have
-- committed before reporting the error. Preserve and conservatively quarantine
-- that history rather than treating it as safely retryable.
UPDATE rorca.spec_repair_effect_receipts SET state='ambiguous',completed_at=COALESCE(completed_at,clock_timestamp())
WHERE state='failed';
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM rorca.spec_repair_effect_receipts
    GROUP BY workspace_id,operation_id,effect_hash HAVING count(*)>1) THEN
    RAISE EXCEPTION 'Duplicate historical repair effects require governed reconciliation before stable-key upgrade'
      USING ERRCODE='55000';
  END IF;
END $$;
ALTER TABLE rorca.spec_repair_effect_receipts DROP CONSTRAINT spec_repair_effect_receipts_pkey;
ALTER TABLE rorca.spec_repair_effect_receipts ADD CONSTRAINT spec_repair_effect_receipts_pkey
  PRIMARY KEY(workspace_id,operation_id,effect_hash);

UPDATE rorca.wave2_schema_readiness SET migration_version=20260731154000,installed_at=clock_timestamp()
WHERE singleton=TRUE AND state='ready' AND migration_version=20260731153000
  AND contract_source_digest='sha256:1111a20f8b6e8cfca7ddcf8861069989bdd7b7c4b52c5b12e26cb2ff8ad6bbfb';
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM rorca.wave2_schema_readiness WHERE singleton=TRUE AND state='ready' AND migration_version=20260731154000) THEN
  RAISE EXCEPTION 'Wave 2 X-High authority readiness transition failed closed' USING ERRCODE='55000';
 END IF;
END $$;
