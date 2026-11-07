-- Fenced RorcaManagedExecutor generation lifecycle, host evidence, proposals, and recovery.
CREATE TABLE rorca.managed_executor_generations (
  workspace_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(request_hash ~ '^sha256:[0-9a-f]{64}$'),
  request_json JSONB NOT NULL CHECK(jsonb_typeof(request_json)='object' AND octet_length(request_json::text)<=262144),
  attempt_id TEXT NOT NULL,
  generation BIGINT NOT NULL CHECK(generation>=0),
  lease_id TEXT NOT NULL,
  fencing_token BIGINT NOT NULL CHECK(fencing_token>0),
  runtime_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  worker_principal_id TEXT NOT NULL,
  work_package_id TEXT NOT NULL,
  work_package_revision INTEGER NOT NULL CHECK(work_package_revision>0),
  repository_id TEXT NOT NULL,
  base_sha TEXT NOT NULL CHECK(base_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  current_sha TEXT NOT NULL CHECK(current_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  expected_head_sha TEXT NOT NULL CHECK(expected_head_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  worktree_id TEXT NOT NULL,
  allowed_path_manifest_hash TEXT NOT NULL CHECK(allowed_path_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  required_path_manifest_hash TEXT NOT NULL CHECK(required_path_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  changed_path_manifest_hash TEXT NOT NULL CHECK(changed_path_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  forbidden_path_manifest_hash TEXT NOT NULL CHECK(forbidden_path_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  policy_activation_hash TEXT NOT NULL CHECK(policy_activation_hash ~ '^sha256:[0-9a-f]{64}$'),
  checkpoint_hash TEXT NOT NULL CHECK(checkpoint_hash ~ '^sha256:[0-9a-f]{64}$'),
  bundle_hash TEXT NOT NULL CHECK(bundle_hash ~ '^sha256:[0-9a-f]{64}$'),
  capability_snapshot_hash TEXT NOT NULL CHECK(capability_snapshot_hash ~ '^sha256:[0-9a-f]{64}$'),
  quota_reservation_id TEXT NOT NULL,
  launch_token TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN('prepared','released','running','result_persisted','closeout_pending','cancelled','expired','lost','conflicting','quarantined')),
  process_identity TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count>=0 AND retry_count<=8),
  last_evidence_hash TEXT CHECK(last_evidence_hash IS NULL OR last_evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  prepared_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  released_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(workspace_id,request_hash),
  UNIQUE(workspace_id,attempt_id,generation),
  UNIQUE(workspace_id,launch_token),
  FOREIGN KEY(workspace_id,attempt_id) REFERENCES rorca.governed_execution_attempts(workspace_id,attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,lease_id) REFERENCES rorca.execution_leases(workspace_id,lease_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,quota_reservation_id) REFERENCES rorca.managed_quota_reservations(workspace_id,reservation_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,capability_snapshot_hash) REFERENCES rorca.managed_capability_snapshots(workspace_id,snapshot_hash) ON DELETE RESTRICT,
  CHECK(expires_at>prepared_at),
  CHECK(request_json::text !~* 'context.?epoch|password|secret|bearer.?token|private.?key|authorization|raw.?prompt|raw.?transcript|human.?receipt')
);
CREATE UNIQUE INDEX managed_executor_one_released_generation_idx ON rorca.managed_executor_generations(workspace_id,work_package_id,work_package_revision)
WHERE state IN('released','running');
CREATE INDEX managed_executor_recovery_idx ON rorca.managed_executor_generations(state,expires_at,updated_at);

CREATE TABLE rorca.managed_executor_state_events (
  event_id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  prior_state TEXT,
  next_state TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  evidence_hash TEXT CHECK(evidence_hash IS NULL OR evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  database_time TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(workspace_id,request_hash) REFERENCES rorca.managed_executor_generations(workspace_id,request_hash) ON DELETE RESTRICT
);

CREATE TABLE rorca.managed_executor_result_proposals (
  workspace_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  proposal_hash TEXT NOT NULL CHECK(proposal_hash ~ '^sha256:[0-9a-f]{64}$'),
  proposal_json JSONB NOT NULL CHECK(jsonb_typeof(proposal_json)='object' AND octet_length(proposal_json::text)<=65536
    AND proposal_json::text !~* 'context.?epoch|password|secret|credential|bearer|private.?key|authorization|raw.?prompt|raw.?transcript|human.?receipt'),
  status TEXT NOT NULL CHECK(status IN('succeeded','failed','cancelled','timed_out','output_limited','provider_failed','validation_failed','fenced')),
  evidence_hash TEXT NOT NULL CHECK(evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  host_observation_hash TEXT NOT NULL CHECK(host_observation_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,request_hash),
  UNIQUE(workspace_id,proposal_hash),
  FOREIGN KEY(workspace_id,request_hash) REFERENCES rorca.managed_executor_generations(workspace_id,request_hash) ON DELETE RESTRICT,
  CHECK(proposal_json->>'closeoutAuthority'='none' AND proposal_json->>'storyLifecycleAuthority'='none'
    AND proposal_json->>'mergeAuthority'='none' AND proposal_json->>'deploymentAuthority'='none')
);

CREATE TABLE rorca.managed_provider_failure_observations (
  workspace_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN('supervisor','worker')),
  principal_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  attempt_id TEXT,
  generation BIGINT,
  capability_snapshot_hash TEXT NOT NULL CHECK(capability_snapshot_hash ~ '^sha256:[0-9a-f]{64}$'),
  failure_class TEXT NOT NULL CHECK(failure_class IN('spawn','authentication','binary','rate_limit','circuit','timeout','provider','process_lost')),
  diagnostic_hash TEXT NOT NULL CHECK(diagnostic_hash ~ '^sha256:[0-9a-f]{64}$'),
  provider_changed_under_attempt BOOLEAN NOT NULL CHECK(provider_changed_under_attempt=FALSE),
  synthetic_success BOOLEAN NOT NULL CHECK(synthetic_success=FALSE),
  closeout_evidence BOOLEAN NOT NULL CHECK(closeout_evidence=FALSE),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,observation_id),
  FOREIGN KEY(workspace_id,capability_snapshot_hash) REFERENCES rorca.managed_capability_snapshots(workspace_id,snapshot_hash) ON DELETE RESTRICT
);

ALTER TABLE rorca.managed_executor_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.managed_executor_generations FORCE ROW LEVEL SECURITY;
ALTER TABLE rorca.managed_executor_state_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.managed_executor_state_events FORCE ROW LEVEL SECURITY;
ALTER TABLE rorca.managed_executor_result_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.managed_executor_result_proposals FORCE ROW LEVEL SECURITY;
ALTER TABLE rorca.managed_provider_failure_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.managed_provider_failure_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY managed_generation_workspace_read ON rorca.managed_executor_generations FOR SELECT USING(workspace_id=current_setting('rorca.workspace_id',true));
CREATE POLICY managed_state_event_workspace_read ON rorca.managed_executor_state_events FOR SELECT USING(workspace_id=current_setting('rorca.workspace_id',true));
CREATE POLICY managed_result_workspace_read ON rorca.managed_executor_result_proposals FOR SELECT USING(workspace_id=current_setting('rorca.workspace_id',true));
CREATE POLICY managed_provider_failure_workspace_read ON rorca.managed_provider_failure_observations FOR SELECT USING(workspace_id=current_setting('rorca.workspace_id',true));
CREATE POLICY managed_generation_definer_all ON rorca.managed_executor_generations FOR ALL
  USING(current_user IS DISTINCT FROM session_user) WITH CHECK(current_user IS DISTINCT FROM session_user);
CREATE POLICY managed_state_event_definer_all ON rorca.managed_executor_state_events FOR ALL
  USING(current_user IS DISTINCT FROM session_user) WITH CHECK(current_user IS DISTINCT FROM session_user);
CREATE POLICY managed_result_definer_all ON rorca.managed_executor_result_proposals FOR ALL
  USING(current_user IS DISTINCT FROM session_user) WITH CHECK(current_user IS DISTINCT FROM session_user);
CREATE POLICY managed_provider_failure_definer_all ON rorca.managed_provider_failure_observations FOR ALL
  USING(current_user IS DISTINCT FROM session_user) WITH CHECK(current_user IS DISTINCT FROM session_user);

CREATE TRIGGER managed_executor_state_events_immutable BEFORE UPDATE OR DELETE ON rorca.managed_executor_state_events FOR EACH ROW EXECUTE FUNCTION rorca.w2_reject_immutable_mutation();
CREATE TRIGGER managed_executor_state_events_no_truncate BEFORE TRUNCATE ON rorca.managed_executor_state_events FOR EACH STATEMENT EXECUTE FUNCTION rorca.w2_reject_immutable_truncate();
CREATE TRIGGER managed_executor_result_proposals_immutable BEFORE UPDATE OR DELETE ON rorca.managed_executor_result_proposals FOR EACH ROW EXECUTE FUNCTION rorca.w2_reject_immutable_mutation();
CREATE TRIGGER managed_executor_result_proposals_no_truncate BEFORE TRUNCATE ON rorca.managed_executor_result_proposals FOR EACH STATEMENT EXECUTE FUNCTION rorca.w2_reject_immutable_truncate();
CREATE TRIGGER managed_provider_failures_immutable BEFORE UPDATE OR DELETE ON rorca.managed_provider_failure_observations FOR EACH ROW EXECUTE FUNCTION rorca.w2_reject_immutable_mutation();
CREATE TRIGGER managed_provider_failures_no_truncate BEFORE TRUNCATE ON rorca.managed_provider_failure_observations FOR EACH STATEMENT EXECUTE FUNCTION rorca.w2_reject_immutable_truncate();

CREATE FUNCTION rorca.prepare_managed_executor_generation_v1(p_request JSONB)
RETURNS TABLE(launch_token TEXT,released BOOLEAN,replayed BOOLEAN,reason_code TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,rorca AS $$
DECLARE existing managed_executor_generations%ROWTYPE; reservation managed_quota_reservations%ROWTYPE; lease execution_leases%ROWTYPE; token TEXT;
BEGIN
  IF session_user NOT IN(SELECT database_user FROM rorca.wave2_canonical_writer_identities) THEN RAISE EXCEPTION 'Canonical writer principal required' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM rorca.wave3a_schema_readiness WHERE singleton=TRUE AND state='ready' AND migration_version=20260804182000) THEN RAISE EXCEPTION 'Wave 3A schema is not ready' USING ERRCODE='55000'; END IF;
  IF p_request->>'schemaVersion'<>'rorca.managed-executor.v1' OR p_request->>'requestHash' !~ '^sha256:[0-9a-f]{64}$'
    OR p_request ?| ARRAY['contextEpoch','secret','credentials','authorization','rawPrompt','rawTranscript']
    OR (p_request->>'parallelism')::INTEGER<>1 OR (p_request->>'autoMerge')::BOOLEAN<>FALSE OR (p_request->>'branchOnly')::BOOLEAN<>TRUE OR (p_request->>'deploymentAuthority')::BOOLEAN<>FALSE THEN
    RAISE EXCEPTION 'Invalid or authority-widening managed request' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request->>'workspaceId',0));
  SELECT * INTO existing FROM rorca.managed_executor_generations WHERE workspace_id=p_request->>'workspaceId' AND request_hash=p_request->>'requestHash';
  IF FOUND THEN RETURN QUERY SELECT existing.launch_token,existing.state IN('released','running'),TRUE,'idempotent_replay'::TEXT; RETURN; END IF;
  IF EXISTS(SELECT 1 FROM rorca.managed_executor_generations WHERE workspace_id=p_request->>'workspaceId' AND attempt_id=p_request->>'attemptId' AND generation=(p_request->>'generation')::BIGINT) THEN
    RETURN QUERY SELECT ''::TEXT,FALSE,FALSE,'duplicate_launch'::TEXT; RETURN;
  END IF;
  SELECT * INTO reservation FROM rorca.managed_quota_reservations WHERE workspace_id=p_request->>'workspaceId' AND reservation_id=p_request->>'quotaReservationId'
    AND request_hash=p_request->>'requestHash' AND attempt_id=p_request->>'attemptId' AND generation=(p_request->>'generation')::BIGINT
    AND capability_snapshot_hash=p_request->>'capabilitySnapshotHash' AND state='active' AND expires_at>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT ''::TEXT,FALSE,FALSE,'quota_exhausted'::TEXT; RETURN; END IF;
  SELECT * INTO lease FROM rorca.execution_leases WHERE workspace_id=p_request->>'workspaceId' AND lease_id=p_request->>'leaseId'
    AND attempt_id=p_request->>'attemptId' AND fencing_token=(p_request->>'fencingToken')::BIGINT AND runtime_id=p_request->>'runtimeId'
    AND policy_activation_hash=p_request->>'policyActivationHash' AND checkpoint_hash=p_request->>'checkpointHash' AND bundle_hash=p_request->>'bundleHash'
    AND base_sha=p_request->>'baseSha' AND current_sha=p_request->>'currentSha' AND worktree_id=p_request->>'worktreeId'
    AND state='active' AND expires_at>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT ''::TEXT,FALSE,FALSE,'fence_lost'::TEXT; RETURN; END IF;
  IF EXISTS(SELECT 1 FROM rorca.execution_cancellation_requests WHERE workspace_id=p_request->>'workspaceId' AND attempt_id=p_request->>'attemptId' AND lease_id=p_request->>'leaseId' AND fencing_token=(p_request->>'fencingToken')::BIGINT AND state<>'conflicted') THEN
    RETURN QUERY SELECT ''::TEXT,FALSE,FALSE,'cancelled'::TEXT; RETURN;
  END IF;
  token := gen_random_uuid()::TEXT;
  INSERT INTO rorca.managed_executor_generations(workspace_id,request_hash,request_json,attempt_id,generation,lease_id,fencing_token,runtime_id,provider_id,worker_principal_id,
    work_package_id,work_package_revision,repository_id,base_sha,current_sha,expected_head_sha,worktree_id,allowed_path_manifest_hash,required_path_manifest_hash,changed_path_manifest_hash,forbidden_path_manifest_hash,
    policy_activation_hash,checkpoint_hash,bundle_hash,capability_snapshot_hash,quota_reservation_id,launch_token,state,released_at,expires_at)
  SELECT p_request->>'workspaceId',p_request->>'requestHash',p_request,p_request->>'attemptId',(p_request->>'generation')::BIGINT,p_request->>'leaseId',(p_request->>'fencingToken')::BIGINT,
    p_request->>'runtimeId',p_request->>'providerId',snapshot.principal_id,p_request->>'workPackageId',(p_request->>'workPackageRevision')::INTEGER,p_request->>'repositoryId',p_request->>'baseSha',p_request->>'currentSha',
    p_request->>'expectedHeadSha',p_request->>'worktreeId',p_request->>'allowedPathManifestHash',p_request->>'requiredPathManifestHash',p_request->>'changedPathManifestHash',p_request->>'forbiddenPathManifestHash',
    p_request->>'policyActivationHash',p_request->>'checkpointHash',p_request->>'bundleHash',p_request->>'capabilitySnapshotHash',p_request->>'quotaReservationId',token,'released',clock_timestamp(),LEAST((p_request->>'leaseExpiresAt')::TIMESTAMPTZ,reservation.expires_at)
  FROM rorca.managed_capability_snapshots snapshot WHERE snapshot.workspace_id=p_request->>'workspaceId' AND snapshot.snapshot_hash=p_request->>'capabilitySnapshotHash' AND snapshot.role='worker' AND snapshot.valid_until>clock_timestamp();
  IF NOT FOUND THEN RETURN QUERY SELECT ''::TEXT,FALSE,FALSE,'capability_snapshot_stale'::TEXT; RETURN; END IF;
  INSERT INTO rorca.managed_executor_state_events(workspace_id,request_hash,prior_state,next_state,reason_code)
    VALUES(p_request->>'workspaceId',p_request->>'requestHash','prepared','released','atomic_preparation_release');
  RETURN QUERY SELECT token,TRUE,FALSE,'released'::TEXT;
EXCEPTION WHEN unique_violation THEN
  RETURN QUERY SELECT ''::TEXT,FALSE,FALSE,'duplicate_launch'::TEXT;
END;
$$;

CREATE FUNCTION rorca.revalidate_managed_executor_generation_v1(p_workspace_id TEXT,p_request_hash TEXT,p_phase TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,rorca AS $$
DECLARE generation_row managed_executor_generations%ROWTYPE;
BEGIN
  IF session_user NOT IN(SELECT database_user FROM rorca.wave2_canonical_writer_identities) THEN RAISE EXCEPTION 'Canonical writer principal required' USING ERRCODE='42501'; END IF;
  IF p_phase NOT IN('launch','commit','result','closeout') THEN RAISE EXCEPTION 'Invalid revalidation phase' USING ERRCODE='22023'; END IF;
  SELECT * INTO generation_row FROM rorca.managed_executor_generations WHERE workspace_id=p_workspace_id AND request_hash=p_request_hash FOR UPDATE;
  IF NOT FOUND OR generation_row.state IN('cancelled','expired','conflicting','quarantined') OR generation_row.expires_at<=clock_timestamp()
    OR NOT EXISTS(SELECT 1 FROM rorca.execution_leases lease WHERE lease.workspace_id=p_workspace_id AND lease.lease_id=generation_row.lease_id AND lease.attempt_id=generation_row.attempt_id
      AND lease.fencing_token=generation_row.fencing_token AND lease.runtime_id=generation_row.runtime_id AND lease.state='active' AND lease.expires_at>clock_timestamp()
      AND lease.base_sha=generation_row.base_sha AND lease.current_sha=generation_row.current_sha AND lease.worktree_id=generation_row.worktree_id
      AND lease.policy_activation_hash=generation_row.policy_activation_hash AND lease.checkpoint_hash=generation_row.checkpoint_hash AND lease.bundle_hash=generation_row.bundle_hash)
    OR EXISTS(SELECT 1 FROM rorca.execution_cancellation_requests cancellation WHERE cancellation.workspace_id=p_workspace_id AND cancellation.attempt_id=generation_row.attempt_id
      AND cancellation.lease_id=generation_row.lease_id AND cancellation.fencing_token=generation_row.fencing_token) THEN
    UPDATE rorca.managed_executor_generations SET state=CASE WHEN state='cancelled' THEN state ELSE 'expired' END,updated_at=clock_timestamp()
      WHERE workspace_id=p_workspace_id AND request_hash=p_request_hash AND state NOT IN('cancelled','quarantined');
    RETURN FALSE;
  END IF;
  RETURN TRUE;
END;
$$;

CREATE FUNCTION rorca.transition_managed_executor_generation_v1(p_workspace_id TEXT,p_request_hash TEXT,p_from_states TEXT[],p_to_state TEXT,p_evidence_hash TEXT DEFAULT NULL)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,rorca AS $$
DECLARE changed INTEGER;
BEGIN
 IF session_user NOT IN(SELECT database_user FROM rorca.wave2_canonical_writer_identities) THEN RAISE EXCEPTION 'Canonical writer principal required' USING ERRCODE='42501'; END IF;
 IF p_to_state NOT IN('prepared','released','running','result_persisted','closeout_pending','cancelled','expired','lost','conflicting','quarantined') THEN RAISE EXCEPTION 'Invalid state' USING ERRCODE='22023'; END IF;
 UPDATE rorca.managed_executor_generations SET state=p_to_state,last_evidence_hash=COALESCE(p_evidence_hash,last_evidence_hash),updated_at=clock_timestamp()
  WHERE workspace_id=p_workspace_id AND request_hash=p_request_hash AND state=ANY(p_from_states);
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed=1 THEN INSERT INTO rorca.managed_executor_state_events(workspace_id,request_hash,prior_state,next_state,reason_code,evidence_hash)
  VALUES(p_workspace_id,p_request_hash,array_to_string(p_from_states,','),p_to_state,'canonical_state_transition',p_evidence_hash); END IF;
 RETURN changed=1;
END;
$$;

CREATE FUNCTION rorca.bind_managed_executor_process_v1(p_workspace_id TEXT,p_request_hash TEXT,p_process_identity TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,rorca AS $$
DECLARE changed INTEGER;
BEGIN
 IF session_user NOT IN(SELECT database_user FROM rorca.wave2_canonical_writer_identities) THEN RAISE EXCEPTION 'Canonical writer principal required' USING ERRCODE='42501'; END IF;
 IF p_process_identity IS NULL OR length(p_process_identity)<8 OR length(p_process_identity)>256 THEN RAISE EXCEPTION 'Invalid process identity' USING ERRCODE='22023'; END IF;
 UPDATE rorca.managed_executor_generations SET process_identity=p_process_identity,updated_at=clock_timestamp()
 WHERE workspace_id=p_workspace_id AND request_hash=p_request_hash AND state='running' AND (process_identity IS NULL OR process_identity=p_process_identity);
 GET DIAGNOSTICS changed=ROW_COUNT;
 RETURN changed=1;
END;
$$;
CREATE FUNCTION rorca.load_managed_executor_generation_v1(p_workspace_id TEXT,p_request_hash TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path=pg_catalog,rorca AS $$
DECLARE result JSONB;
BEGIN
 IF session_user NOT IN(SELECT database_user FROM rorca.wave2_canonical_writer_identities) THEN RAISE EXCEPTION 'Canonical writer principal required' USING ERRCODE='42501'; END IF;
 SELECT jsonb_build_object('request',generation.request_json,'state',generation.state,'launchToken',generation.launch_token,
   'processIdentity',generation.process_identity,'resultProposal',proposal.proposal_json,'quarantined',generation.state='quarantined')
 INTO result FROM rorca.managed_executor_generations generation
 LEFT JOIN rorca.managed_executor_result_proposals proposal USING(workspace_id,request_hash)
 WHERE generation.workspace_id=p_workspace_id AND generation.request_hash=p_request_hash;
 RETURN result;
END;
$$;

CREATE FUNCTION rorca.list_recoverable_managed_executor_generations_v1(p_workspace_id TEXT,p_limit INTEGER)
RETURNS SETOF JSONB LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path=pg_catalog,rorca AS $$
BEGIN
 IF session_user NOT IN(SELECT database_user FROM rorca.wave2_canonical_writer_identities)
    AND (session_user NOT IN(SELECT database_user FROM rorca.wave2_runtime_principal_identities)
         OR current_setting('rorca.workspace_id',TRUE) IS DISTINCT FROM p_workspace_id)
 THEN RAISE EXCEPTION 'Exact workspace runtime or canonical writer principal required' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT jsonb_build_object('request',generation.request_json,'state',generation.state,'launchToken','',
   'processIdentity',generation.process_identity,'resultProposal',proposal.proposal_json,'quarantined',generation.state='quarantined')
 FROM rorca.managed_executor_generations generation
 LEFT JOIN rorca.managed_executor_result_proposals proposal USING(workspace_id,request_hash)
 WHERE generation.workspace_id=p_workspace_id
 ORDER BY generation.updated_at,generation.request_hash LIMIT LEAST(GREATEST(p_limit,1),100);
END;
$$;

CREATE FUNCTION rorca.persist_managed_executor_result_proposal_v1(p_workspace_id TEXT,p_proposal JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,rorca AS $$
DECLARE existing managed_executor_result_proposals%ROWTYPE; proposal_hash TEXT;
BEGIN
 IF session_user NOT IN(SELECT database_user FROM rorca.wave2_canonical_writer_identities) THEN RAISE EXCEPTION 'Canonical writer principal required' USING ERRCODE='42501'; END IF;
 IF p_proposal->>'requestHash' !~ '^sha256:[0-9a-f]{64}$' OR p_proposal->>'evidenceHash' !~ '^sha256:[0-9a-f]{64}$'
    OR p_proposal->>'hostObservationHash' !~ '^sha256:[0-9a-f]{64}$'
    OR p_proposal->>'closeoutAuthority'<>'none' OR p_proposal->>'storyLifecycleAuthority'<>'none'
    OR p_proposal->>'mergeAuthority'<>'none' OR p_proposal->>'deploymentAuthority'<>'none'
    OR p_proposal::TEXT ~* 'context.?epoch|password|secret|credential|bearer|private.?key|authorization|raw.?prompt|raw.?transcript|human.?receipt' THEN
   RAISE EXCEPTION 'Invalid or authority-widening result proposal' USING ERRCODE='22023';
 END IF;
 proposal_hash := 'sha256:'||encode(digest(convert_to(p_proposal::TEXT,'UTF8'),'sha256'),'hex');
 SELECT * INTO existing FROM rorca.managed_executor_result_proposals WHERE workspace_id=p_workspace_id AND request_hash=p_proposal->>'requestHash';
 IF FOUND THEN
   IF existing.proposal_json=p_proposal THEN RETURN TRUE; END IF;
   RAISE EXCEPTION 'Managed result proposal replay conflict' USING ERRCODE='40001';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM rorca.managed_executor_generations generation
   WHERE generation.workspace_id=p_workspace_id AND generation.request_hash=p_proposal->>'requestHash'
     AND generation.attempt_id=p_proposal->>'attemptId' AND generation.generation=(p_proposal->>'generation')::BIGINT
     AND generation.lease_id=p_proposal->>'leaseId' AND generation.fencing_token=(p_proposal->>'fencingToken')::BIGINT
     AND generation.state IN('running','lost')) THEN
   RAISE EXCEPTION 'Managed result proposal lost exact generation fence' USING ERRCODE='55000';
 END IF;
 INSERT INTO rorca.managed_executor_result_proposals(workspace_id,request_hash,proposal_hash,proposal_json,status,evidence_hash,host_observation_hash)
 VALUES(p_workspace_id,p_proposal->>'requestHash',proposal_hash,p_proposal,p_proposal->>'status',p_proposal->>'evidenceHash',p_proposal->>'hostObservationHash');
 RETURN FALSE;
END;
$$;

CREATE FUNCTION rorca.load_wave3a_readiness_v1() RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path=pg_catalog,rorca AS $$
DECLARE result JSONB;
BEGIN
 IF session_user NOT IN(SELECT database_user FROM rorca.wave2_canonical_writer_identities)
    AND session_user NOT IN(SELECT database_user FROM rorca.wave2_runtime_principal_identities)
 THEN RAISE EXCEPTION 'Runtime or canonical writer principal required' USING ERRCODE='42501'; END IF;
 SELECT to_jsonb(readiness) INTO result FROM rorca.wave3a_schema_readiness readiness
 WHERE singleton=TRUE AND state='ready' AND migration_version=20260804182000;
 RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION rorca.load_wave3a_readiness_v1() FROM PUBLIC,authenticated,anon;
REVOKE ALL ON FUNCTION rorca.bind_managed_executor_process_v1(TEXT,TEXT,TEXT) FROM PUBLIC,authenticated,anon;
REVOKE ALL ON FUNCTION rorca.load_managed_executor_generation_v1(TEXT,TEXT) FROM PUBLIC,authenticated,anon;
REVOKE ALL ON FUNCTION rorca.list_recoverable_managed_executor_generations_v1(TEXT,INTEGER) FROM PUBLIC,authenticated,anon;
REVOKE ALL ON FUNCTION rorca.persist_managed_executor_result_proposal_v1(TEXT,JSONB) FROM PUBLIC,authenticated,anon;
REVOKE ALL ON FUNCTION rorca.prepare_managed_executor_generation_v1(JSONB) FROM PUBLIC,authenticated,anon;
REVOKE ALL ON FUNCTION rorca.revalidate_managed_executor_generation_v1(TEXT,TEXT,TEXT) FROM PUBLIC,authenticated,anon;
REVOKE ALL ON FUNCTION rorca.transition_managed_executor_generation_v1(TEXT,TEXT,TEXT[],TEXT,TEXT) FROM PUBLIC,authenticated,anon;
DO $$
DECLARE writer_user TEXT:=current_setting('rorca.canonical_writer_database_user',TRUE);
BEGIN
 IF writer_user IS NULL OR writer_user='' THEN RAISE EXCEPTION 'Canonical writer principal setting is required' USING ERRCODE='42501'; END IF;
 EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.load_wave3a_readiness_v1() TO %I',writer_user);
 EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.bind_managed_executor_process_v1(TEXT,TEXT,TEXT) TO %I',writer_user);
 EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.load_managed_executor_generation_v1(TEXT,TEXT) TO %I',writer_user);
 EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.list_recoverable_managed_executor_generations_v1(TEXT,INTEGER) TO %I',writer_user);
 EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.persist_managed_executor_result_proposal_v1(TEXT,JSONB) TO %I',writer_user);
 EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.prepare_managed_executor_generation_v1(JSONB) TO %I',writer_user);
 EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.revalidate_managed_executor_generation_v1(TEXT,TEXT,TEXT) TO %I',writer_user);
 EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.transition_managed_executor_generation_v1(TEXT,TEXT,TEXT[],TEXT,TEXT) TO %I',writer_user);
END $$;
REVOKE ALL PRIVILEGES ON rorca.managed_executor_generations,rorca.managed_executor_state_events,rorca.managed_executor_result_proposals,rorca.managed_provider_failure_observations FROM PUBLIC,authenticated,anon;
DO $$
DECLARE runtime_user TEXT:=current_setting('rorca.runtime_database_user',TRUE);
BEGIN
 IF runtime_user IS NULL OR runtime_user='' THEN RAISE EXCEPTION 'Runtime principal setting is required' USING ERRCODE='42501'; END IF;
 EXECUTE format('GRANT SELECT(workspace_id,request_hash,attempt_id,generation,lease_id,fencing_token,runtime_id,provider_id,work_package_id,work_package_revision,repository_id,base_sha,current_sha,expected_head_sha,worktree_id,policy_activation_hash,checkpoint_hash,bundle_hash,capability_snapshot_hash,quota_reservation_id,state,process_identity,last_evidence_hash,prepared_at,released_at,updated_at,expires_at) ON rorca.managed_executor_generations TO %I',runtime_user);
 EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.load_wave3a_readiness_v1() TO %I',runtime_user);
 EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.list_recoverable_managed_executor_generations_v1(TEXT,INTEGER) TO %I',runtime_user);
END $$;

UPDATE rorca.wave3a_schema_readiness SET migration_version=20260804182000,state='ready',installed_at=clock_timestamp()
WHERE singleton=TRUE AND state='installing' AND migration_version=20260804181000;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM rorca.wave3a_schema_readiness WHERE singleton=TRUE AND state='ready' AND migration_version=20260804182000)
THEN RAISE EXCEPTION 'Wave 3A managed generation readiness transition failed closed' USING ERRCODE='55000'; END IF; END $$;
CREATE TRIGGER wave3a_schema_readiness_update_immutable BEFORE UPDATE ON rorca.wave3a_schema_readiness FOR EACH ROW EXECUTE FUNCTION rorca.w2_reject_immutable_mutation();
