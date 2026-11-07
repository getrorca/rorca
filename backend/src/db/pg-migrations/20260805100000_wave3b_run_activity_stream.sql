-- Wave 3B / ROR-25: runtime-neutral, projection-only run activity streams.
-- This is additive observability storage. It creates no evidence, closeout,
-- lifecycle, approval, merge, deployment, provider, or pg-boss authority.

SELECT set_config('rorca.migration_mode','on',TRUE);

CREATE TABLE rorca.run_activity_schema_readiness (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
  contract_version TEXT NOT NULL CHECK(contract_version='1.0.0'),
  migration_version BIGINT NOT NULL CHECK(migration_version=20260805100000),
  wave2_spec_sha256 TEXT NOT NULL CHECK(wave2_spec_sha256='sha256:8b6a36021eb7a2b42a141a4d7081eda77cb3f91dc157cf7c146c3b9b355b4730'),
  wave2_contract_source_digest TEXT NOT NULL CHECK(wave2_contract_source_digest='sha256:1111a20f8b6e8cfca7ddcf8861069989bdd7b7c4b52c5b12e26cb2ff8ad6bbfb'),
  wave2_migration_version BIGINT NOT NULL CHECK(wave2_migration_version=20260731157000),
  wave2_implementation_sha TEXT NOT NULL CHECK(wave2_implementation_sha='1420fb4c819aad692894da9449bc4958ed74dd49'),
  wave2_prerequisite_receipt_hash TEXT NOT NULL REFERENCES rorca.wave2_prerequisite_receipts(receipt_hash) ON DELETE RESTRICT,
  authority_effect TEXT NOT NULL DEFAULT 'none' CHECK(authority_effect='none'),
  state TEXT NOT NULL CHECK(state='ready'),
  installed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO rorca.run_activity_schema_readiness(
  singleton,contract_version,migration_version,wave2_spec_sha256,wave2_contract_source_digest,
  wave2_migration_version,wave2_implementation_sha,wave2_prerequisite_receipt_hash,state)
SELECT TRUE,'1.0.0',20260805100000,
  'sha256:8b6a36021eb7a2b42a141a4d7081eda77cb3f91dc157cf7c146c3b9b355b4730',
  r.contract_source_digest,r.migration_version,'1420fb4c819aad692894da9449bc4958ed74dd49',
  r.prerequisite_receipt_hash,'ready'
FROM rorca.wave2_schema_readiness r JOIN rorca.wave2_effective_readiness effective ON TRUE
WHERE r.singleton=TRUE AND effective.ready=TRUE
  AND r.contract_version='1.0.0'
  AND r.contract_source_digest='sha256:1111a20f8b6e8cfca7ddcf8861069989bdd7b7c4b52c5b12e26cb2ff8ad6bbfb'
  AND r.migration_version=20260731157000 AND r.prerequisite_receipt_hash IS NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM rorca.run_activity_schema_readiness WHERE singleton=TRUE AND state='ready') THEN
    RAISE EXCEPTION 'Wave 3B requires the exact independently reviewed Wave 2 readiness chain' USING ERRCODE='55000';
  END IF;
END; $$;

CREATE TABLE rorca.run_activity_streams (
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  stream_id TEXT NOT NULL,
  run_id BIGINT NOT NULL REFERENCES rorca.pipeline_runs(id) ON DELETE RESTRICT,
  attempt_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  runtime_generation BIGINT NOT NULL CHECK(runtime_generation>=0),
  mission_id TEXT NOT NULL,
  mission_revision INTEGER NOT NULL CHECK(mission_revision>0),
  work_package_id TEXT NOT NULL,
  work_package_revision INTEGER NOT NULL CHECK(work_package_revision>0),
  spec_id TEXT NOT NULL,
  spec_version INTEGER NOT NULL CHECK(spec_version>0),
  story_id TEXT NOT NULL,
  story_version INTEGER NOT NULL CHECK(story_version>0),
  lease_id TEXT NOT NULL,
  fencing_token BIGINT NOT NULL CHECK(fencing_token>0),
  policy_activation_hash TEXT NOT NULL CHECK(policy_activation_hash ~ '^sha256:[0-9a-f]{64}$'),
  repository_id TEXT NOT NULL,
  base_sha TEXT NOT NULL CHECK(base_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  current_sha TEXT NOT NULL CHECK(current_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  worktree_id TEXT NOT NULL,
  subject_hash TEXT NOT NULL CHECK(subject_hash ~ '^sha256:[0-9a-f]{64}$'),
  retention_policy_hash TEXT NOT NULL CHECK(retention_policy_hash ~ '^sha256:[0-9a-f]{64}$'),
  retention_days INTEGER NOT NULL CHECK(retention_days BETWEEN 1 AND 90),
  retention_max_records INTEGER NOT NULL CHECK(retention_max_records BETWEEN 100 AND 1000000),
  retention_max_bytes BIGINT NOT NULL CHECK(retention_max_bytes BETWEEN 1048576 AND 1073741824),
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN('active','closed','quarantined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,stream_id,runtime_generation),
  UNIQUE(workspace_id,run_id,attempt_id,runtime_generation),
  FOREIGN KEY(workspace_id,attempt_id) REFERENCES rorca.governed_execution_attempts(workspace_id,attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,lease_id) REFERENCES rorca.execution_leases(workspace_id,lease_id) ON DELETE RESTRICT
);

CREATE TABLE rorca.run_activity_stream_heads (
  workspace_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  runtime_generation BIGINT NOT NULL CHECK(runtime_generation>=0),
  first_retained_sequence BIGINT NOT NULL DEFAULT 1 CHECK(first_retained_sequence>0),
  last_sequence BIGINT NOT NULL DEFAULT 0 CHECK(last_sequence>=0),
  last_event_hash TEXT,
  retained_records BIGINT NOT NULL DEFAULT 0 CHECK(retained_records>=0),
  retained_bytes BIGINT NOT NULL DEFAULT 0 CHECK(retained_bytes>=0),
  total_records BIGINT NOT NULL DEFAULT 0 CHECK(total_records>=0),
  total_bytes BIGINT NOT NULL DEFAULT 0 CHECK(total_bytes>=0),
  state_version BIGINT NOT NULL DEFAULT 1 CHECK(state_version>0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,stream_id,runtime_generation),
  FOREIGN KEY(workspace_id,stream_id,runtime_generation) REFERENCES rorca.run_activity_streams(workspace_id,stream_id,runtime_generation) ON DELETE RESTRICT,
  CHECK((last_sequence=0 AND last_event_hash IS NULL) OR (last_sequence>0 AND last_event_hash ~ '^sha256:[0-9a-f]{64}$')),
  CHECK(retained_records<=total_records AND retained_bytes<=total_bytes),
  CHECK(first_retained_sequence<=last_sequence+1)
);

CREATE TABLE rorca.run_activity_events (
  workspace_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  runtime_generation BIGINT NOT NULL CHECK(runtime_generation>=0),
  stream_sequence BIGINT NOT NULL CHECK(stream_sequence>0),
  event_id TEXT NOT NULL,
  event_hash TEXT NOT NULL CHECK(event_hash ~ '^sha256:[0-9a-f]{64}$'),
  payload_hash TEXT NOT NULL CHECK(payload_hash ~ '^sha256:[0-9a-f]{64}$'),
  prior_event_hash TEXT NOT NULL CHECK(prior_event_hash='stream_origin' OR prior_event_hash ~ '^sha256:[0-9a-f]{64}$'),
  kind TEXT NOT NULL,
  projection_plane TEXT NOT NULL CHECK(projection_plane IN('terminal','activity','context','lease','cancellation','transport','operations','closeout')),
  source_store TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  source_record_revision TEXT NOT NULL,
  source_record_hash TEXT NOT NULL CHECK(source_record_hash ~ '^sha256:[0-9a-f]{64}$'),
  source_sequence BIGINT NOT NULL CHECK(source_sequence>=0),
  ordering_mode TEXT NOT NULL CHECK(ordering_mode IN('live_projection','historical_projection')),
  redaction_class TEXT NOT NULL CHECK(redaction_class IN('none','redacted','restricted')),
  redaction_policy_hash TEXT NOT NULL CHECK(redaction_policy_hash ~ '^sha256:[0-9a-f]{64}$'),
  restricted_reference_id TEXT,
  envelope_json JSONB NOT NULL CHECK(jsonb_typeof(envelope_json)='object' AND octet_length(envelope_json::text)<=65536),
  byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 65536),
  observed_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  database_time TIMESTAMPTZ NOT NULL,
  projected_at TIMESTAMPTZ NOT NULL,
  retain_until TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,stream_id,runtime_generation,stream_sequence),
  UNIQUE(workspace_id,event_id),
  UNIQUE(workspace_id,source_store,source_record_id,source_record_revision),
  FOREIGN KEY(workspace_id,stream_id,runtime_generation) REFERENCES rorca.run_activity_streams(workspace_id,stream_id,runtime_generation) ON DELETE RESTRICT,
  CHECK((stream_sequence=1 AND prior_event_hash='stream_origin') OR (stream_sequence>1 AND prior_event_hash ~ '^sha256:[0-9a-f]{64}$')),
  CHECK(envelope_json->>'schemaVersion'='rorca.run-stream-envelope.v1'
    AND envelope_json->>'contractId'='rorca.run-stream-envelope.v1'
    AND envelope_json->>'contractVersion'='1.0.0'
    AND envelope_json->>'eventId'=event_id AND envelope_json->>'streamId'=stream_id
    AND (envelope_json->>'runtimeGeneration')::bigint=runtime_generation
    AND (envelope_json->>'streamSequence')::bigint=stream_sequence
    AND envelope_json->>'eventHash'=event_hash AND envelope_json->>'payloadHash'=payload_hash
    AND envelope_json->>'priorEventHash'=prior_event_hash AND envelope_json->>'kind'=kind
    AND envelope_json->>'plane'=projection_plane
    AND envelope_json->'scope'->>'workspaceId'=workspace_id
    AND (envelope_json->'scope'->>'runtimeGeneration')::bigint=runtime_generation
    AND envelope_json->>'projectionOnly'='true' AND envelope_json->>'authorityEffect'='none'
    AND envelope_json->'redaction'->>'ordinaryProjectionContainsRaw'='false')
);

CREATE TABLE rorca.run_activity_ingest_batches (
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  batch_id TEXT NOT NULL,
  batch_hash TEXT NOT NULL CHECK(batch_hash ~ '^sha256:[0-9a-f]{64}$'),
  runtime_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  fencing_token BIGINT NOT NULL CHECK(fencing_token>0),
  runtime_generation BIGINT NOT NULL CHECK(runtime_generation>=0),
  first_source_sequence BIGINT NOT NULL CHECK(first_source_sequence>=0),
  event_count INTEGER NOT NULL CHECK(event_count BETWEEN 1 AND 100),
  first_stream_sequence BIGINT NOT NULL CHECK(first_stream_sequence>0),
  last_stream_sequence BIGINT NOT NULL CHECK(last_stream_sequence>=first_stream_sequence),
  response_hash TEXT NOT NULL CHECK(response_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,batch_id),
  UNIQUE(workspace_id,runtime_id,runtime_generation,first_source_sequence),
  FOREIGN KEY(workspace_id,attempt_id) REFERENCES rorca.governed_execution_attempts(workspace_id,attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,lease_id) REFERENCES rorca.execution_leases(workspace_id,lease_id) ON DELETE RESTRICT
);

CREATE TABLE rorca.run_activity_projection_conflicts (
  id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  stream_id TEXT,
  runtime_generation BIGINT CHECK(runtime_generation IS NULL OR runtime_generation>=0),
  event_id TEXT,
  existing_hash TEXT CHECK(existing_hash IS NULL OR existing_hash ~ '^sha256:[0-9a-f]{64}$'),
  incoming_hash TEXT CHECK(incoming_hash IS NULL OR incoming_hash ~ '^sha256:[0-9a-f]{64}$'),
  reason_code TEXT NOT NULL,
  dimension TEXT NOT NULL,
  retryable BOOLEAN NOT NULL DEFAULT FALSE CHECK(retryable=FALSE),
  correlation_hash TEXT NOT NULL CHECK(correlation_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE rorca.run_activity_retention_tombstones (
  tombstone_id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  runtime_generation BIGINT NOT NULL CHECK(runtime_generation>=0),
  first_pruned_sequence BIGINT NOT NULL CHECK(first_pruned_sequence>0),
  last_pruned_sequence BIGINT NOT NULL CHECK(last_pruned_sequence>=first_pruned_sequence),
  pruned_records BIGINT NOT NULL CHECK(pruned_records>0),
  pruned_bytes BIGINT NOT NULL CHECK(pruned_bytes>=0),
  event_window_hash TEXT NOT NULL CHECK(event_window_hash ~ '^sha256:[0-9a-f]{64}$'),
  archive_manifest_hash TEXT CHECK(archive_manifest_hash IS NULL OR archive_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  reason_code TEXT NOT NULL CHECK(reason_code IN('age_limit','record_limit','byte_limit','manual_bounded_retention')),
  canonical_rows_deleted BOOLEAN NOT NULL DEFAULT FALSE CHECK(canonical_rows_deleted=FALSE),
  pruned_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(workspace_id,stream_id,runtime_generation,first_pruned_sequence,last_pruned_sequence),
  FOREIGN KEY(workspace_id,stream_id,runtime_generation) REFERENCES rorca.run_activity_streams(workspace_id,stream_id,runtime_generation) ON DELETE RESTRICT
);

CREATE TABLE rorca.run_activity_archive_manifests (
  workspace_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  runtime_generation BIGINT NOT NULL CHECK(runtime_generation>=0),
  manifest_id TEXT NOT NULL,
  manifest_hash TEXT NOT NULL CHECK(manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  first_sequence BIGINT NOT NULL CHECK(first_sequence>0),
  last_sequence BIGINT NOT NULL CHECK(last_sequence>=first_sequence),
  event_window_hash TEXT NOT NULL CHECK(event_window_hash ~ '^sha256:[0-9a-f]{64}$'),
  restricted_reference_id TEXT NOT NULL,
  raw_payload_included BOOLEAN NOT NULL DEFAULT FALSE CHECK(raw_payload_included=FALSE),
  integrity_state TEXT NOT NULL CHECK(integrity_state IN('verified','corrupt','expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,manifest_id),
  UNIQUE(workspace_id,manifest_hash),
  FOREIGN KEY(workspace_id,stream_id,runtime_generation) REFERENCES rorca.run_activity_streams(workspace_id,stream_id,runtime_generation) ON DELETE RESTRICT
);

CREATE TABLE rorca.run_activity_status_plane_observations (
  workspace_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  runtime_generation BIGINT NOT NULL CHECK(runtime_generation>=0),
  plane TEXT NOT NULL CHECK(plane IN('source_config_drift','dependency_health','runtime_health','queue_outbox_freshness','lease_retry_recovery','observability_freshness','provider_operations_readiness')),
  observation_sequence BIGINT NOT NULL CHECK(observation_sequence>0),
  event_hash TEXT NOT NULL CHECK(event_hash ~ '^sha256:[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK(status IN('active','healthy','degraded','failed','stale','rejected','authorized','dispatched','settled','gap','quarantined','unknown')),
  source_class TEXT NOT NULL CHECK(source_class IN('canonical_config','dependency_probe','sandbox_resource_monitor','queue_outbox_monitor','lease_controller','observability_store','operations_controller')),
  source_identity TEXT NOT NULL,
  source_hash TEXT NOT NULL CHECK(source_hash ~ '^sha256:[0-9a-f]{64}$'),
  observed_at TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ NOT NULL CHECK(valid_until>=observed_at),
  reason_code TEXT NOT NULL,
  impact TEXT NOT NULL CHECK(octet_length(impact)<=4096),
  next_safe_action TEXT NOT NULL CHECK(octet_length(next_safe_action)<=4096),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,stream_id,runtime_generation,plane,observation_sequence),
  FOREIGN KEY(workspace_id,stream_id,runtime_generation) REFERENCES rorca.run_activity_streams(workspace_id,stream_id,runtime_generation) ON DELETE RESTRICT
);

CREATE TABLE rorca.run_activity_status_planes (
  workspace_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  runtime_generation BIGINT NOT NULL CHECK(runtime_generation>=0),
  plane TEXT NOT NULL CHECK(plane IN('source_config_drift','dependency_health','runtime_health','queue_outbox_freshness','lease_retry_recovery','observability_freshness','provider_operations_readiness')),
  observation_sequence BIGINT NOT NULL CHECK(observation_sequence>0),
  event_hash TEXT NOT NULL CHECK(event_hash ~ '^sha256:[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK(status IN('active','healthy','degraded','failed','stale','rejected','authorized','dispatched','settled','gap','quarantined','unknown')),
  source_class TEXT NOT NULL CHECK(source_class IN('canonical_config','dependency_probe','sandbox_resource_monitor','queue_outbox_monitor','lease_controller','observability_store','operations_controller')),
  source_identity TEXT NOT NULL,
  source_hash TEXT NOT NULL CHECK(source_hash ~ '^sha256:[0-9a-f]{64}$'),
  observed_at TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ NOT NULL CHECK(valid_until>=observed_at),
  reason_code TEXT NOT NULL,
  impact TEXT NOT NULL CHECK(octet_length(impact)<=4096),
  next_safe_action TEXT NOT NULL CHECK(octet_length(next_safe_action)<=4096),
  state_version BIGINT NOT NULL DEFAULT 1 CHECK(state_version>0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,stream_id,runtime_generation,plane),
  FOREIGN KEY(workspace_id,stream_id,runtime_generation,plane,observation_sequence) REFERENCES rorca.run_activity_status_plane_observations(workspace_id,stream_id,runtime_generation,plane,observation_sequence) ON DELETE RESTRICT
);

CREATE TABLE rorca.run_activity_access_audit (
  id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN('allowed','not_found','denied','invalid_cursor','gap','throttled')),
  reason_code TEXT NOT NULL,
  subject_hash TEXT NOT NULL CHECK(subject_hash ~ '^sha256:[0-9a-f]{64}$'),
  correlation_hash TEXT NOT NULL CHECK(correlation_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX run_activity_events_replay_idx ON rorca.run_activity_events(workspace_id,stream_id,runtime_generation,stream_sequence);
CREATE INDEX run_activity_events_retention_idx ON rorca.run_activity_events(workspace_id,stream_id,runtime_generation,retain_until,stream_sequence);
CREATE INDEX run_activity_events_run_idx ON rorca.run_activity_streams(workspace_id,run_id,runtime_generation DESC);
CREATE INDEX run_activity_tombstones_lookup_idx ON rorca.run_activity_retention_tombstones(workspace_id,stream_id,runtime_generation,last_pruned_sequence DESC);
CREATE INDEX run_activity_audit_workspace_idx ON rorca.run_activity_access_audit(workspace_id,created_at DESC);

CREATE OR REPLACE FUNCTION rorca.run_activity_writer_authorized_v1(p_workspace_id TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rorca,pg_catalog AS $$
  SELECT current_setting('rorca.workspace_id',TRUE)=p_workspace_id
    AND EXISTS(SELECT 1 FROM rorca.wave2_runtime_principal_identities p
      WHERE p.database_user=session_user
        AND p.grant_receipt_hash IN (
          'sha256:9bd2c3125afcf88b38010ff3a42f06d873501003812c986e2f18488d9d8d84f4',
          'sha256:af3a76e53c5f13157e10c0782d5c810428efb4e12ef4cb863b4ad04ad6f21093'
        ))
$$;
REVOKE ALL ON FUNCTION rorca.run_activity_writer_authorized_v1(TEXT) FROM PUBLIC,authenticated,anon;

CREATE OR REPLACE FUNCTION rorca.verify_run_activity_source_subject_v1(
  p_workspace_id TEXT,p_attempt_id TEXT,p_lease_id TEXT
) RETURNS TABLE(
  run_id BIGINT,mission_id TEXT,work_package_id TEXT,work_package_revision INTEGER,
  story_id TEXT,runtime_id TEXT,generation BIGINT,repository_id TEXT,base_sha TEXT,
  current_sha TEXT,worktree_id TEXT,lease_id TEXT,fencing_token BIGINT,lease_runtime_id TEXT,
  lease_state TEXT,expires_at TIMESTAMPTZ,policy_activation_hash TEXT
) LANGUAGE plpgsql SECURITY DEFINER SET search_path=rorca,pg_catalog AS $$
DECLARE prior_migration_mode TEXT:=COALESCE(current_setting('rorca.migration_mode',TRUE),'');
BEGIN
  IF NOT rorca.run_activity_writer_authorized_v1(p_workspace_id)
  THEN RAISE EXCEPTION 'Run activity source verifier principal or workspace denied' USING ERRCODE='42501'; END IF;
  PERFORM set_config('rorca.migration_mode','on',TRUE);
  RETURN QUERY SELECT a.run_id,a.mission_id,a.work_package_id,a.work_package_revision,a.story_id,
    a.runtime_id,a.generation,a.repository_id,a.base_sha,a.current_sha,a.worktree_id,
    l.lease_id,l.fencing_token,l.runtime_id,l.state,l.expires_at,l.policy_activation_hash
  FROM rorca.governed_execution_attempts a
  JOIN rorca.execution_leases l ON l.workspace_id=a.workspace_id AND l.attempt_id=a.attempt_id
  WHERE a.workspace_id=p_workspace_id AND a.attempt_id=p_attempt_id AND l.lease_id=p_lease_id
  FOR KEY SHARE OF l;
  PERFORM set_config('rorca.migration_mode',prior_migration_mode,TRUE);
END;
$$;
REVOKE ALL ON FUNCTION rorca.verify_run_activity_source_subject_v1(TEXT,TEXT,TEXT) FROM PUBLIC,authenticated,anon;

CREATE OR REPLACE FUNCTION rorca.run_activity_reject_immutable_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=rorca,pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Run activity journal is immutable' USING ERRCODE='42501';
END;
$$;

CREATE OR REPLACE FUNCTION rorca.run_activity_guard_event_retention_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=rorca,pg_catalog AS $$
BEGIN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Run activity event update denied' USING ERRCODE='42501'; END IF;
  IF current_setting('rorca.run_activity_retention',TRUE) IS DISTINCT FROM 'on'
    OR NOT EXISTS(SELECT 1 FROM rorca.run_activity_retention_tombstones t
      WHERE t.workspace_id=OLD.workspace_id AND t.stream_id=OLD.stream_id
        AND t.runtime_generation=OLD.runtime_generation
        AND OLD.stream_sequence BETWEEN t.first_pruned_sequence AND t.last_pruned_sequence)
  THEN RAISE EXCEPTION 'Run activity event delete requires an exact committed tombstone' USING ERRCODE='42501'; END IF;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION rorca.run_activity_guard_stream_identity_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=rorca,pg_catalog AS $$
BEGIN
  IF OLD.workspace_id IS DISTINCT FROM NEW.workspace_id OR OLD.stream_id IS DISTINCT FROM NEW.stream_id
    OR OLD.run_id IS DISTINCT FROM NEW.run_id OR OLD.attempt_id IS DISTINCT FROM NEW.attempt_id
    OR OLD.runtime_id IS DISTINCT FROM NEW.runtime_id OR OLD.runtime_generation IS DISTINCT FROM NEW.runtime_generation
    OR OLD.mission_id IS DISTINCT FROM NEW.mission_id OR OLD.mission_revision IS DISTINCT FROM NEW.mission_revision
    OR OLD.work_package_id IS DISTINCT FROM NEW.work_package_id OR OLD.work_package_revision IS DISTINCT FROM NEW.work_package_revision
    OR OLD.spec_id IS DISTINCT FROM NEW.spec_id OR OLD.spec_version IS DISTINCT FROM NEW.spec_version
    OR OLD.story_id IS DISTINCT FROM NEW.story_id OR OLD.story_version IS DISTINCT FROM NEW.story_version
    OR OLD.lease_id IS DISTINCT FROM NEW.lease_id OR OLD.fencing_token IS DISTINCT FROM NEW.fencing_token
    OR OLD.policy_activation_hash IS DISTINCT FROM NEW.policy_activation_hash OR OLD.repository_id IS DISTINCT FROM NEW.repository_id
    OR OLD.base_sha IS DISTINCT FROM NEW.base_sha OR OLD.current_sha IS DISTINCT FROM NEW.current_sha
    OR OLD.worktree_id IS DISTINCT FROM NEW.worktree_id OR OLD.subject_hash IS DISTINCT FROM NEW.subject_hash
    OR OLD.retention_policy_hash IS DISTINCT FROM NEW.retention_policy_hash OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN RAISE EXCEPTION 'Run activity stream identity mutation denied' USING ERRCODE='42501'; END IF;
  IF OLD.state='quarantined' AND NEW.state<>'quarantined' THEN RAISE EXCEPTION 'Run activity quarantine is persistent' USING ERRCODE='42501'; END IF;
  NEW.updated_at:=clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION rorca.run_activity_guard_head_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=rorca,pg_catalog AS $$
BEGIN
  IF OLD.workspace_id IS DISTINCT FROM NEW.workspace_id OR OLD.stream_id IS DISTINCT FROM NEW.stream_id
    OR OLD.runtime_generation IS DISTINCT FROM NEW.runtime_generation OR NEW.last_sequence<OLD.last_sequence
    OR NEW.total_records<OLD.total_records OR NEW.total_bytes<OLD.total_bytes
    OR NEW.first_retained_sequence<OLD.first_retained_sequence OR NEW.state_version<>OLD.state_version+1
  THEN RAISE EXCEPTION 'Run activity head regression or identity mutation denied' USING ERRCODE='42501'; END IF;
  NEW.updated_at:=clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION rorca.run_activity_guard_event_insert_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=rorca,pg_catalog AS $$
DECLARE head rorca.run_activity_stream_heads%ROWTYPE;
BEGIN
  SELECT * INTO STRICT head FROM rorca.run_activity_stream_heads
    WHERE workspace_id=NEW.workspace_id AND stream_id=NEW.stream_id
      AND runtime_generation=NEW.runtime_generation FOR UPDATE;
  IF NEW.stream_sequence<>head.last_sequence+1
    OR NEW.prior_event_hash IS DISTINCT FROM COALESCE(head.last_event_hash,'stream_origin')
  THEN RAISE EXCEPTION 'Run activity sequence or hash-chain insertion denied' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION rorca.run_activity_guard_plane_observation_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=rorca,pg_catalog AS $$
DECLARE event_payload JSONB;
BEGIN
  SELECT envelope_json->'payload' INTO STRICT event_payload FROM rorca.run_activity_events
    WHERE workspace_id=NEW.workspace_id AND stream_id=NEW.stream_id
      AND runtime_generation=NEW.runtime_generation AND stream_sequence=NEW.observation_sequence
      AND event_hash=NEW.event_hash AND kind='status_plane_observed' AND projection_plane='operations';
  IF event_payload->>'plane' IS DISTINCT FROM NEW.plane OR event_payload->>'status' IS DISTINCT FROM NEW.status
    OR event_payload->>'sourceClass' IS DISTINCT FROM NEW.source_class
    OR event_payload->>'sourceIdentity' IS DISTINCT FROM NEW.source_identity
    OR event_payload->>'sourceHash' IS DISTINCT FROM NEW.source_hash
    OR (event_payload->>'observedAt')::timestamptz IS DISTINCT FROM NEW.observed_at
    OR (event_payload->>'validUntil')::timestamptz IS DISTINCT FROM NEW.valid_until
    OR event_payload->>'reasonCode' IS DISTINCT FROM NEW.reason_code
    OR event_payload->>'impact' IS DISTINCT FROM NEW.impact
    OR event_payload->>'nextSafeAction' IS DISTINCT FROM NEW.next_safe_action
    OR event_payload->>'establishesStoryCompletion' IS DISTINCT FROM 'false'
  THEN RAISE EXCEPTION 'Status-plane observation does not match its redacted event' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION rorca.run_activity_guard_plane_current_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=rorca,pg_catalog AS $$
DECLARE observation rorca.run_activity_status_plane_observations%ROWTYPE;
BEGIN
  SELECT * INTO STRICT observation FROM rorca.run_activity_status_plane_observations
    WHERE workspace_id=NEW.workspace_id AND stream_id=NEW.stream_id
      AND runtime_generation=NEW.runtime_generation AND plane=NEW.plane
      AND observation_sequence=NEW.observation_sequence;
  IF observation.event_hash IS DISTINCT FROM NEW.event_hash OR observation.status IS DISTINCT FROM NEW.status
    OR observation.source_class IS DISTINCT FROM NEW.source_class
    OR observation.source_identity IS DISTINCT FROM NEW.source_identity
    OR observation.source_hash IS DISTINCT FROM NEW.source_hash
    OR observation.observed_at IS DISTINCT FROM NEW.observed_at OR observation.valid_until IS DISTINCT FROM NEW.valid_until
    OR observation.reason_code IS DISTINCT FROM NEW.reason_code OR observation.impact IS DISTINCT FROM NEW.impact
    OR observation.next_safe_action IS DISTINCT FROM NEW.next_safe_action
    OR (TG_OP='UPDATE' AND (OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
      OR OLD.stream_id IS DISTINCT FROM NEW.stream_id OR OLD.runtime_generation IS DISTINCT FROM NEW.runtime_generation
      OR OLD.plane IS DISTINCT FROM NEW.plane OR NEW.observation_sequence<=OLD.observation_sequence
      OR NEW.state_version<>OLD.state_version+1))
  THEN RAISE EXCEPTION 'Status-plane current projection mutation denied' USING ERRCODE='42501'; END IF;
  NEW.updated_at:=clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION rorca.run_activity_guard_plane_observation_retention_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=rorca,pg_catalog AS $$
BEGIN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Status-plane observation update denied' USING ERRCODE='42501'; END IF;
  IF current_setting('rorca.run_activity_retention',TRUE) IS DISTINCT FROM 'on'
    OR EXISTS(SELECT 1 FROM rorca.run_activity_status_planes p
      WHERE p.workspace_id=OLD.workspace_id AND p.stream_id=OLD.stream_id
        AND p.runtime_generation=OLD.runtime_generation AND p.plane=OLD.plane
        AND p.observation_sequence=OLD.observation_sequence)
    OR NOT EXISTS(SELECT 1 FROM rorca.run_activity_retention_tombstones t
      WHERE t.workspace_id=OLD.workspace_id AND t.stream_id=OLD.stream_id
        AND t.runtime_generation=OLD.runtime_generation
        AND OLD.observation_sequence BETWEEN t.first_pruned_sequence AND t.last_pruned_sequence)
  THEN RAISE EXCEPTION 'Status-plane observation delete requires an exact tombstone and non-current row' USING ERRCODE='42501'; END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER run_activity_event_insert_guard BEFORE INSERT ON rorca.run_activity_events
FOR EACH ROW EXECUTE FUNCTION rorca.run_activity_guard_event_insert_v1();
CREATE TRIGGER run_activity_plane_observation_guard BEFORE INSERT ON rorca.run_activity_status_plane_observations
FOR EACH ROW EXECUTE FUNCTION rorca.run_activity_guard_plane_observation_v1();
CREATE TRIGGER run_activity_plane_observation_retention_guard BEFORE UPDATE OR DELETE ON rorca.run_activity_status_plane_observations
FOR EACH ROW EXECUTE FUNCTION rorca.run_activity_guard_plane_observation_retention_v1();
CREATE TRIGGER run_activity_plane_current_guard BEFORE INSERT OR UPDATE ON rorca.run_activity_status_planes
FOR EACH ROW EXECUTE FUNCTION rorca.run_activity_guard_plane_current_v1();
CREATE TRIGGER run_activity_plane_current_delete_guard BEFORE DELETE ON rorca.run_activity_status_planes
FOR EACH ROW EXECUTE FUNCTION rorca.run_activity_reject_immutable_v1();

CREATE TRIGGER run_activity_stream_identity_guard BEFORE UPDATE ON rorca.run_activity_streams
FOR EACH ROW EXECUTE FUNCTION rorca.run_activity_guard_stream_identity_v1();
CREATE TRIGGER run_activity_stream_delete_guard BEFORE DELETE ON rorca.run_activity_streams
FOR EACH ROW EXECUTE FUNCTION rorca.run_activity_reject_immutable_v1();
CREATE TRIGGER run_activity_head_guard BEFORE UPDATE ON rorca.run_activity_stream_heads
FOR EACH ROW EXECUTE FUNCTION rorca.run_activity_guard_head_v1();
CREATE TRIGGER run_activity_head_delete_guard BEFORE DELETE ON rorca.run_activity_stream_heads
FOR EACH ROW EXECUTE FUNCTION rorca.run_activity_reject_immutable_v1();
CREATE TRIGGER run_activity_event_guard BEFORE UPDATE OR DELETE ON rorca.run_activity_events
FOR EACH ROW EXECUTE FUNCTION rorca.run_activity_guard_event_retention_v1();

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'run_activity_schema_readiness','run_activity_ingest_batches','run_activity_projection_conflicts',
    'run_activity_retention_tombstones','run_activity_archive_manifests',
    'run_activity_access_audit'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON rorca.%I FOR EACH ROW EXECUTE FUNCTION rorca.run_activity_reject_immutable_v1()',table_name||'_immutable',table_name);
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY[
    'run_activity_schema_readiness','run_activity_streams','run_activity_stream_heads','run_activity_events',
    'run_activity_ingest_batches','run_activity_projection_conflicts','run_activity_retention_tombstones',
    'run_activity_archive_manifests','run_activity_status_plane_observations','run_activity_status_planes','run_activity_access_audit'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON rorca.%I FOR EACH STATEMENT EXECUTE FUNCTION rorca.run_activity_reject_immutable_v1()',table_name||'_no_truncate',table_name);
    IF table_name<>'run_activity_schema_readiness' THEN
      EXECUTE format('ALTER TABLE rorca.%I ENABLE ROW LEVEL SECURITY',table_name);
      EXECUTE format('ALTER TABLE rorca.%I FORCE ROW LEVEL SECURITY',table_name);
      EXECUTE format('CREATE POLICY %I ON rorca.%I FOR ALL USING (rorca.run_activity_writer_authorized_v1(workspace_id)) WITH CHECK (rorca.run_activity_writer_authorized_v1(workspace_id))','run_activity_workspace_'||table_name,table_name);
    END IF;
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE rorca.%I FROM PUBLIC,authenticated,anon',table_name);
  END LOOP;
END;
$$;

DO $$
DECLARE runtime_user TEXT:=current_setting('rorca.runtime_database_user',TRUE);
DECLARE writer_user TEXT:=current_setting('rorca.canonical_writer_database_user',TRUE);
DECLARE table_name TEXT;
BEGIN
  IF runtime_user IS NULL OR runtime_user='' THEN RAISE EXCEPTION 'Runtime principal is required' USING ERRCODE='42501'; END IF;
  IF writer_user IS NULL OR writer_user='' THEN RAISE EXCEPTION 'Canonical writer is required' USING ERRCODE='42501'; END IF;
  EXECUTE format('GRANT SELECT ON TABLE rorca.run_activity_schema_readiness TO %I',runtime_user);
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.verify_run_activity_source_subject_v1(TEXT,TEXT,TEXT) TO %I',runtime_user);
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.run_activity_writer_authorized_v1(TEXT) TO %I',runtime_user);
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.run_activity_writer_authorized_v1(TEXT) TO %I',writer_user);
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.verify_run_activity_source_subject_v1(TEXT,TEXT,TEXT) TO %I',writer_user);
  EXECUTE format('GRANT SELECT ON TABLE rorca.run_activity_schema_readiness TO %I',writer_user);
  FOREACH table_name IN ARRAY ARRAY[
    'run_activity_streams','run_activity_stream_heads','run_activity_events','run_activity_ingest_batches',
    'run_activity_projection_conflicts','run_activity_retention_tombstones','run_activity_archive_manifests',
    'run_activity_status_plane_observations','run_activity_status_planes','run_activity_access_audit'
  ] LOOP
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE rorca.%I TO %I',table_name,runtime_user);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE rorca.%I TO %I',table_name,writer_user);
  END LOOP;
  EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE rorca.run_activity_projection_conflicts_id_seq TO %I',runtime_user);
  EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE rorca.run_activity_retention_tombstones_tombstone_id_seq TO %I',runtime_user);
  EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE rorca.run_activity_projection_conflicts_id_seq TO %I',writer_user);
  EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE rorca.run_activity_retention_tombstones_tombstone_id_seq TO %I',writer_user);
  EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE rorca.run_activity_access_audit_id_seq TO %I',writer_user);
  EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE rorca.run_activity_access_audit_id_seq TO %I',runtime_user);
END;
$$;
