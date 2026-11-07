-- Typed dependency/capability admission and atomic workspace/runtime/global quota reservations.
CREATE TABLE rorca.managed_capability_snapshots (
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  snapshot_id TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL CHECK(snapshot_hash ~ '^sha256:[0-9a-f]{64}$'),
  policy_version TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN('supervisor','worker')),
  principal_id TEXT NOT NULL,
  provider_auth_reference_id TEXT NOT NULL,
  provider_budget_id TEXT NOT NULL,
  rate_limit_identity TEXT NOT NULL,
  circuit_identity TEXT NOT NULL,
  process_identity TEXT NOT NULL,
  queue_identity TEXT NOT NULL,
  dependencies_json JSONB NOT NULL CHECK(jsonb_typeof(dependencies_json)='array' AND octet_length(dependencies_json::text)<=262144),
  observed_at TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ NOT NULL,
  decision_source TEXT NOT NULL CHECK(decision_source='canonical_snapshot'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,snapshot_id),
  UNIQUE(workspace_id,snapshot_hash),
  CHECK(valid_until>observed_at),
  CHECK(dependencies_json::text !~* 'raw.?prompt|raw.?transcript|password|secret|bearer.?token|private.?key|authorization')
);
CREATE INDEX managed_capability_current_idx ON rorca.managed_capability_snapshots(workspace_id,runtime_id,role,valid_until DESC);

CREATE TABLE rorca.managed_quota_policies (
  scope_type TEXT NOT NULL CHECK(scope_type IN('global','workspace','runtime')),
  scope_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  policy_hash TEXT NOT NULL CHECK(policy_hash ~ '^sha256:[0-9a-f]{64}$'),
  hard_limits_json JSONB NOT NULL CHECK(jsonb_typeof(hard_limits_json)='object'),
  effective_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  state TEXT NOT NULL CHECK(state IN('active','superseded','revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_type,scope_id,policy_version),
  UNIQUE(scope_type,scope_id,policy_hash),
  CHECK((scope_type='global' AND scope_id='*') OR (scope_type<>'global' AND scope_id<>'*')),
  CHECK(expires_at IS NULL OR expires_at>effective_at),
  CHECK(hard_limits_json ?& ARRAY['cpuMillis','memoryBytes','executionConcurrency','continuationConcurrency','eventCount','contextBytes','contextTokens','storageBytes','storageObjects','retrySpend','providerTokens','providerMicrounits'])
);
CREATE UNIQUE INDEX managed_quota_one_active_scope_idx ON rorca.managed_quota_policies(scope_type,scope_id) WHERE state='active';

CREATE TABLE rorca.managed_quota_reservations (
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  reservation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(request_hash ~ '^sha256:[0-9a-f]{64}$'),
  attempt_id TEXT NOT NULL,
  generation BIGINT NOT NULL CHECK(generation>=0),
  runtime_id TEXT NOT NULL,
  capability_snapshot_hash TEXT NOT NULL CHECK(capability_snapshot_hash ~ '^sha256:[0-9a-f]{64}$'),
  quota_policy_version TEXT NOT NULL,
  quota_json JSONB NOT NULL CHECK(jsonb_typeof(quota_json)='object'),
  state TEXT NOT NULL CHECK(state IN('active','released','fenced','expired')),
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  release_reason_code TEXT,
  PRIMARY KEY(workspace_id,reservation_id),
  UNIQUE(workspace_id,attempt_id,generation),
  FOREIGN KEY(workspace_id,attempt_id) REFERENCES rorca.governed_execution_attempts(workspace_id,attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,capability_snapshot_hash) REFERENCES rorca.managed_capability_snapshots(workspace_id,snapshot_hash) ON DELETE RESTRICT,
  CHECK(expires_at>reserved_at),
  CHECK(quota_json ?& ARRAY['cpuMillis','memoryBytes','executionConcurrency','continuationConcurrency','eventCount','contextBytes','contextTokens','storageBytes','storageObjects','retrySpend','providerTokens','providerMicrounits'])
);
CREATE INDEX managed_quota_active_workspace_idx ON rorca.managed_quota_reservations(workspace_id,state,expires_at);
CREATE INDEX managed_quota_active_runtime_idx ON rorca.managed_quota_reservations(runtime_id,state,expires_at);

CREATE TABLE rorca.managed_admission_audit (
  audit_id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  generation BIGINT NOT NULL,
  reservation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(request_hash ~ '^sha256:[0-9a-f]{64}$'),
  outcome TEXT NOT NULL CHECK(outcome IN('admitted','duplicate','blocked','replay_conflict','fenced')),
  reason_code TEXT NOT NULL,
  capability_snapshot_hash TEXT NOT NULL CHECK(capability_snapshot_hash ~ '^sha256:[0-9a-f]{64}$'),
  quota_policy_version TEXT NOT NULL,
  redacted_diagnostic_json JSONB NOT NULL CHECK(jsonb_typeof(redacted_diagnostic_json)='object' AND octet_length(redacted_diagnostic_json::text)<=32768),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK(redacted_diagnostic_json::text !~* 'prompt|transcript|password|secret|credential|bearer|private.?key|authorization|approval')
);

ALTER TABLE rorca.managed_capability_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.managed_capability_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE rorca.managed_quota_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.managed_quota_reservations FORCE ROW LEVEL SECURITY;
ALTER TABLE rorca.managed_admission_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.managed_admission_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY managed_capability_workspace_read ON rorca.managed_capability_snapshots FOR SELECT USING(workspace_id=current_setting('rorca.workspace_id',true));
CREATE POLICY managed_quota_reservation_workspace_read ON rorca.managed_quota_reservations FOR SELECT USING(workspace_id=current_setting('rorca.workspace_id',true));
CREATE POLICY managed_admission_workspace_read ON rorca.managed_admission_audit FOR SELECT USING(workspace_id=current_setting('rorca.workspace_id',true));
CREATE POLICY managed_capability_definer_all ON rorca.managed_capability_snapshots FOR ALL
  USING(current_user IS DISTINCT FROM session_user) WITH CHECK(current_user IS DISTINCT FROM session_user);
CREATE POLICY managed_quota_reservation_definer_all ON rorca.managed_quota_reservations FOR ALL
  USING(current_user IS DISTINCT FROM session_user) WITH CHECK(current_user IS DISTINCT FROM session_user);
CREATE POLICY managed_admission_definer_all ON rorca.managed_admission_audit FOR ALL
  USING(current_user IS DISTINCT FROM session_user) WITH CHECK(current_user IS DISTINCT FROM session_user);

CREATE POLICY wave3a_definer_writer_identity_read ON rorca.wave2_canonical_writer_identities FOR SELECT
  USING(current_user IS DISTINCT FROM session_user);
CREATE POLICY wave3a_definer_execution_lease_read ON rorca.execution_leases FOR SELECT
  USING(current_user IS DISTINCT FROM session_user);
CREATE POLICY wave3a_definer_execution_lease_lock ON rorca.execution_leases FOR UPDATE
  USING(current_user IS DISTINCT FROM session_user) WITH CHECK(current_user IS DISTINCT FROM session_user);
CREATE POLICY wave3a_definer_cancellation_read ON rorca.execution_cancellation_requests FOR SELECT
  USING(current_user IS DISTINCT FROM session_user);
CREATE TRIGGER managed_capability_snapshots_immutable BEFORE UPDATE OR DELETE ON rorca.managed_capability_snapshots
FOR EACH ROW EXECUTE FUNCTION rorca.w2_reject_immutable_mutation();
CREATE TRIGGER managed_capability_snapshots_no_truncate BEFORE TRUNCATE ON rorca.managed_capability_snapshots
FOR EACH STATEMENT EXECUTE FUNCTION rorca.w2_reject_immutable_truncate();
CREATE TRIGGER managed_admission_audit_immutable BEFORE UPDATE OR DELETE ON rorca.managed_admission_audit
FOR EACH ROW EXECUTE FUNCTION rorca.w2_reject_immutable_mutation();
CREATE TRIGGER managed_admission_audit_no_truncate BEFORE TRUNCATE ON rorca.managed_admission_audit
FOR EACH STATEMENT EXECUTE FUNCTION rorca.w2_reject_immutable_truncate();

CREATE FUNCTION rorca.persist_managed_capability_snapshot_v1(p_snapshot JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,rorca AS $$
DECLARE existing managed_capability_snapshots%ROWTYPE;
BEGIN
 IF session_user NOT IN(SELECT database_user FROM rorca.wave2_canonical_writer_identities) THEN RAISE EXCEPTION 'Canonical writer principal required' USING ERRCODE='42501'; END IF;
 IF p_snapshot->>'schemaVersion'<>'rorca.managed-capability-snapshot.v1' OR p_snapshot->>'decisionSource'<>'canonical_snapshot'
    OR p_snapshot->>'role' NOT IN('supervisor','worker') OR p_snapshot->>'snapshotHash' !~ '^sha256:[0-9a-f]{64}$'
    OR jsonb_typeof(p_snapshot->'dependencies')<>'array' THEN RAISE EXCEPTION 'Invalid capability snapshot' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('rorca-wave3a-capability-role:'||(p_snapshot->>'workspaceId'),0));
 SELECT * INTO existing FROM rorca.managed_capability_snapshots WHERE workspace_id=p_snapshot->>'workspaceId' AND snapshot_id=p_snapshot->>'snapshotId';
 IF FOUND THEN
   IF existing.snapshot_hash=p_snapshot->>'snapshotHash' AND existing.dependencies_json=p_snapshot->'dependencies' THEN RETURN TRUE; END IF;
   RAISE EXCEPTION 'Capability snapshot replay conflict' USING ERRCODE='40001';
 END IF;
 IF EXISTS(SELECT 1 FROM rorca.managed_capability_snapshots other WHERE other.workspace_id=p_snapshot->>'workspaceId'
   AND other.role<>p_snapshot->>'role' AND (other.principal_id=p_snapshot->>'principalId'
     OR other.provider_auth_reference_id=p_snapshot->>'providerAuthReferenceId'
     OR other.provider_budget_id=p_snapshot->>'providerBudgetId'
     OR other.rate_limit_identity=p_snapshot->>'rateLimitIdentity'
     OR other.circuit_identity=p_snapshot->>'circuitIdentity'
     OR other.process_identity=p_snapshot->>'processIdentity'
     OR other.queue_identity=p_snapshot->>'queueIdentity')) THEN
   RAISE EXCEPTION 'Supervisor/worker capability failure domains must be distinct' USING ERRCODE='42501';
 END IF;
 INSERT INTO rorca.managed_capability_snapshots(workspace_id,snapshot_id,snapshot_hash,policy_version,runtime_id,provider_id,role,principal_id,
   provider_auth_reference_id,provider_budget_id,rate_limit_identity,circuit_identity,process_identity,queue_identity,dependencies_json,observed_at,valid_until,decision_source)
 VALUES(p_snapshot->>'workspaceId',p_snapshot->>'snapshotId',p_snapshot->>'snapshotHash',p_snapshot->>'policyVersion',p_snapshot->>'runtimeId',
   p_snapshot->>'providerId',p_snapshot->>'role',p_snapshot->>'principalId',p_snapshot->>'providerAuthReferenceId',p_snapshot->>'providerBudgetId',
   p_snapshot->>'rateLimitIdentity',p_snapshot->>'circuitIdentity',p_snapshot->>'processIdentity',p_snapshot->>'queueIdentity',p_snapshot->'dependencies',
   (p_snapshot->>'observedAt')::TIMESTAMPTZ,(p_snapshot->>'validUntil')::TIMESTAMPTZ,p_snapshot->>'decisionSource');
 RETURN FALSE;
END;
$$;

CREATE FUNCTION rorca.reserve_managed_executor_quota_v1(
  p_workspace_id TEXT,p_runtime_id TEXT,p_attempt_id TEXT,p_generation BIGINT,p_lease_id TEXT,p_fencing_token BIGINT,
  p_reservation_id TEXT,p_request_hash TEXT,p_capability_snapshot_hash TEXT,p_quota_policy_version TEXT,
  p_quota JSONB,p_expires_at TIMESTAMPTZ
) RETURNS TABLE(admitted BOOLEAN,duplicate BOOLEAN,reason_code TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,rorca AS $$
DECLARE
  existing managed_quota_reservations%ROWTYPE;
  dimension TEXT;
  requested NUMERIC;
  used_global NUMERIC;
  used_workspace NUMERIC;
  used_runtime NUMERIC;
  global_limit NUMERIC;
  workspace_limit NUMERIC;
  runtime_limit NUMERIC;
  snapshot managed_capability_snapshots%ROWTYPE;
  active_lease execution_leases%ROWTYPE;
BEGIN
  IF session_user NOT IN(SELECT database_user FROM rorca.wave2_canonical_writer_identities) THEN
    RAISE EXCEPTION 'Canonical writer principal required' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM rorca.wave3a_schema_readiness WHERE singleton=TRUE AND state='ready' AND migration_version=20260804182000) THEN
    RAISE EXCEPTION 'Wave 3A capability admission schema is not ready' USING ERRCODE='55000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('wave3a-global-quota',0));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id,0));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_runtime_id,0));

  SELECT * INTO existing FROM rorca.managed_quota_reservations
   WHERE workspace_id=p_workspace_id AND reservation_id=p_reservation_id;
  IF FOUND THEN
    IF existing.request_hash=p_request_hash AND existing.quota_json=p_quota
       AND existing.attempt_id=p_attempt_id AND existing.generation=p_generation THEN
      INSERT INTO rorca.managed_admission_audit(workspace_id,runtime_id,attempt_id,generation,reservation_id,request_hash,outcome,reason_code,capability_snapshot_hash,quota_policy_version,redacted_diagnostic_json)
      VALUES(p_workspace_id,p_runtime_id,p_attempt_id,p_generation,p_reservation_id,p_request_hash,'duplicate','idempotent_replay',p_capability_snapshot_hash,p_quota_policy_version,'{}');
      RETURN QUERY SELECT TRUE,TRUE,'idempotent_replay'::TEXT; RETURN;
    END IF;
    INSERT INTO rorca.managed_admission_audit(workspace_id,runtime_id,attempt_id,generation,reservation_id,request_hash,outcome,reason_code,capability_snapshot_hash,quota_policy_version,redacted_diagnostic_json)
    VALUES(p_workspace_id,p_runtime_id,p_attempt_id,p_generation,p_reservation_id,p_request_hash,'replay_conflict','changed_reservation_replay',p_capability_snapshot_hash,p_quota_policy_version,'{}');
    RETURN QUERY SELECT FALSE,FALSE,'reservation_replay_conflict'::TEXT; RETURN;
  END IF;

  SELECT * INTO active_lease FROM rorca.execution_leases
   WHERE workspace_id=p_workspace_id AND lease_id=p_lease_id AND attempt_id=p_attempt_id
     AND runtime_id=p_runtime_id AND fencing_token=p_fencing_token AND state='active' AND expires_at>clock_timestamp()
   FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT FALSE,FALSE,'fence_lost'::TEXT; RETURN; END IF;

  SELECT * INTO snapshot FROM rorca.managed_capability_snapshots
   WHERE workspace_id=p_workspace_id AND snapshot_hash=p_capability_snapshot_hash
     AND runtime_id=p_runtime_id AND role='worker' AND decision_source='canonical_snapshot'
     AND observed_at<=clock_timestamp() AND valid_until>clock_timestamp();
  IF NOT FOUND THEN RETURN QUERY SELECT FALSE,FALSE,'capability_snapshot_stale'::TEXT; RETURN; END IF;

  IF EXISTS(
    SELECT 1 FROM jsonb_array_elements(snapshot.dependencies_json) dep
    WHERE NOT(dep ?& ARRAY['dependencyId','requirement','contractVersion','compatibleContractVersions','status','observedAt','validUntil','rateLimit','circuit','quota','fallback'])
       OR dep->>'status' IN('unknown','unavailable')
       OR NOT((dep->'compatibleContractVersions') ? (dep->>'contractVersion'))
       OR (dep->'circuit'->>'state')='open'
       OR COALESCE((dep->'quota'->>'available')::BOOLEAN,FALSE)=FALSE
       OR COALESCE((dep->'quota'->>'headroom')::NUMERIC,0)<=0
       OR (dep->>'validUntil')::TIMESTAMPTZ<=clock_timestamp()
       OR (COALESCE((dep->'rateLimit'->>'remaining')::NUMERIC,0)<=0 AND (dep->'rateLimit'->>'resetAt')::TIMESTAMPTZ>clock_timestamp())
  ) THEN RETURN QUERY SELECT FALSE,FALSE,'dependency_unhealthy'::TEXT; RETURN; END IF;

  IF NOT EXISTS(SELECT 1 FROM rorca.managed_quota_policies WHERE state='active' AND scope_type='global' AND scope_id='*' AND policy_version=p_quota_policy_version AND effective_at<=clock_timestamp() AND (expires_at IS NULL OR expires_at>clock_timestamp()))
    OR NOT EXISTS(SELECT 1 FROM rorca.managed_quota_policies WHERE state='active' AND scope_type='workspace' AND scope_id=p_workspace_id AND policy_version=p_quota_policy_version AND effective_at<=clock_timestamp() AND (expires_at IS NULL OR expires_at>clock_timestamp()))
    OR NOT EXISTS(SELECT 1 FROM rorca.managed_quota_policies WHERE state='active' AND scope_type='runtime' AND scope_id=p_runtime_id AND policy_version=p_quota_policy_version AND effective_at<=clock_timestamp() AND (expires_at IS NULL OR expires_at>clock_timestamp())) THEN
    RETURN QUERY SELECT FALSE,FALSE,'quota_policy_missing'::TEXT; RETURN;
  END IF;

  FOREACH dimension IN ARRAY ARRAY['cpuMillis','memoryBytes','executionConcurrency','continuationConcurrency','eventCount','contextBytes','contextTokens','storageBytes','storageObjects','retrySpend','providerTokens','providerMicrounits'] LOOP
    requested := (p_quota->>dimension)::NUMERIC;
    SELECT (hard_limits_json->>dimension)::NUMERIC INTO global_limit
      FROM rorca.managed_quota_policies WHERE state='active' AND policy_version=p_quota_policy_version AND scope_type='global' AND scope_id='*';
    SELECT (hard_limits_json->>dimension)::NUMERIC INTO workspace_limit
      FROM rorca.managed_quota_policies WHERE state='active' AND policy_version=p_quota_policy_version AND scope_type='workspace' AND scope_id=p_workspace_id;
    SELECT (hard_limits_json->>dimension)::NUMERIC INTO runtime_limit
      FROM rorca.managed_quota_policies WHERE state='active' AND policy_version=p_quota_policy_version AND scope_type='runtime' AND scope_id=p_runtime_id;
    SELECT COALESCE(sum((quota_json->>dimension)::NUMERIC),0) INTO used_global
      FROM rorca.managed_quota_reservations WHERE state='active' AND expires_at>clock_timestamp();
    SELECT COALESCE(sum((quota_json->>dimension)::NUMERIC),0) INTO used_workspace
      FROM rorca.managed_quota_reservations WHERE state='active' AND expires_at>clock_timestamp() AND workspace_id=p_workspace_id;
    SELECT COALESCE(sum((quota_json->>dimension)::NUMERIC),0) INTO used_runtime
      FROM rorca.managed_quota_reservations WHERE state='active' AND expires_at>clock_timestamp() AND runtime_id=p_runtime_id;
    IF requested+used_global>global_limit OR requested+used_workspace>workspace_limit OR requested+used_runtime>runtime_limit THEN
      INSERT INTO rorca.managed_admission_audit(workspace_id,runtime_id,attempt_id,generation,reservation_id,request_hash,outcome,reason_code,capability_snapshot_hash,quota_policy_version,redacted_diagnostic_json)
      VALUES(p_workspace_id,p_runtime_id,p_attempt_id,p_generation,p_reservation_id,p_request_hash,'blocked','quota_exhausted',p_capability_snapshot_hash,p_quota_policy_version,jsonb_build_object('dimension',dimension));
      RETURN QUERY SELECT FALSE,FALSE,('quota_exhausted:'||dimension)::TEXT; RETURN;
    END IF;
  END LOOP;

  INSERT INTO rorca.managed_quota_reservations(workspace_id,reservation_id,request_hash,attempt_id,generation,runtime_id,capability_snapshot_hash,quota_policy_version,quota_json,state,expires_at)
  VALUES(p_workspace_id,p_reservation_id,p_request_hash,p_attempt_id,p_generation,p_runtime_id,p_capability_snapshot_hash,p_quota_policy_version,p_quota,'active',LEAST(p_expires_at,active_lease.expires_at));
  INSERT INTO rorca.managed_admission_audit(workspace_id,runtime_id,attempt_id,generation,reservation_id,request_hash,outcome,reason_code,capability_snapshot_hash,quota_policy_version,redacted_diagnostic_json)
  VALUES(p_workspace_id,p_runtime_id,p_attempt_id,p_generation,p_reservation_id,p_request_hash,'admitted','atomic_quota_reserved',p_capability_snapshot_hash,p_quota_policy_version,'{}');
  RETURN QUERY SELECT TRUE,FALSE,'admitted'::TEXT;
END;
$$;
REVOKE ALL ON FUNCTION rorca.persist_managed_capability_snapshot_v1(JSONB) FROM PUBLIC,authenticated,anon;
REVOKE ALL ON FUNCTION rorca.reserve_managed_executor_quota_v1(TEXT,TEXT,TEXT,BIGINT,TEXT,BIGINT,TEXT,TEXT,TEXT,TEXT,JSONB,TIMESTAMPTZ) FROM PUBLIC,authenticated,anon;
DO $$
DECLARE writer_user TEXT:=current_setting('rorca.canonical_writer_database_user',TRUE);
BEGIN
 IF writer_user IS NULL OR writer_user='' THEN RAISE EXCEPTION 'Canonical writer principal setting is required' USING ERRCODE='42501'; END IF;
 EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.persist_managed_capability_snapshot_v1(JSONB) TO %I',writer_user);
 EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.reserve_managed_executor_quota_v1(TEXT,TEXT,TEXT,BIGINT,TEXT,BIGINT,TEXT,TEXT,TEXT,TEXT,JSONB,TIMESTAMPTZ) TO %I',writer_user);
END $$;

REVOKE ALL PRIVILEGES ON rorca.managed_capability_snapshots,rorca.managed_quota_policies,rorca.managed_quota_reservations,rorca.managed_admission_audit FROM PUBLIC,authenticated,anon;
DO $$
DECLARE runtime_user TEXT:=current_setting('rorca.runtime_database_user',TRUE);
BEGIN
 IF runtime_user IS NULL OR runtime_user='' THEN RAISE EXCEPTION 'Runtime principal setting is required' USING ERRCODE='42501'; END IF;
 EXECUTE format('GRANT SELECT(workspace_id,snapshot_id,snapshot_hash,policy_version,runtime_id,provider_id,role,observed_at,valid_until,created_at) ON rorca.managed_capability_snapshots TO %I',runtime_user);
 EXECUTE format('GRANT SELECT(workspace_id,reservation_id,request_hash,attempt_id,generation,runtime_id,capability_snapshot_hash,quota_policy_version,state,reserved_at,expires_at,release_reason_code) ON rorca.managed_quota_reservations TO %I',runtime_user);
END $$;

UPDATE rorca.wave3a_schema_readiness SET migration_version=20260804181000,installed_at=clock_timestamp()
WHERE singleton=TRUE AND state='installing' AND migration_version=20260804180000;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM rorca.wave3a_schema_readiness WHERE singleton=TRUE AND state='installing' AND migration_version=20260804181000)
THEN RAISE EXCEPTION 'Wave 3A capability/quota readiness transition failed closed' USING ERRCODE='55000'; END IF; END $$;
