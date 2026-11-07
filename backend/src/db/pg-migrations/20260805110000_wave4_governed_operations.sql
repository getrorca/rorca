-- Wave 4 operational pilot: governed Doctor, cost suspension, canonical inventory,
-- staged resource sagas, isolation receipts, and clean-room certificates.
-- These tables confer no provider, lifecycle, approval, merge, deployment, or production authority.

SELECT set_config('rorca.migration_mode','on',TRUE);

DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM rorca.wave3a_schema_readiness WHERE singleton=TRUE AND state='ready' AND migration_version=20260804182000)
    OR NOT EXISTS(SELECT 1 FROM rorca.run_activity_schema_readiness WHERE singleton=TRUE AND state='ready' AND migration_version=20260805100000)
  THEN RAISE EXCEPTION 'Wave 4 operations requires both exact reviewed Wave 3 packets' USING ERRCODE='55000'; END IF;
END $$;

CREATE TABLE rorca.wave4_operations_schema_readiness (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
  schema_version TEXT NOT NULL CHECK(schema_version='rorca.wave4-operations.v1'),
  migration_version BIGINT NOT NULL CHECK(migration_version=20260805110000),
  reviewed_wave3_git_sha TEXT NOT NULL CHECK(reviewed_wave3_git_sha='a66537fc3a5607a80f6b1010ebdde238d3b6ce8f'),
  wave4_spec_hash TEXT NOT NULL CHECK(wave4_spec_hash='sha256:6c67ac5993d7de4a95ed82b7ab0d2a7c68fb98ae5bc17bc7d3f3ef65938e20cd'),
  authority_effect TEXT NOT NULL DEFAULT 'none' CHECK(authority_effect='none'),
  state TEXT NOT NULL CHECK(state='ready'),
  installed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO rorca.wave4_operations_schema_readiness(singleton,schema_version,migration_version,reviewed_wave3_git_sha,wave4_spec_hash,state)
VALUES(TRUE,'rorca.wave4-operations.v1',20260805110000,'a66537fc3a5607a80f6b1010ebdde238d3b6ce8f','sha256:6c67ac5993d7de4a95ed82b7ab0d2a7c68fb98ae5bc17bc7d3f3ef65938e20cd','ready');

CREATE OR REPLACE FUNCTION rorca.wave4_ops_workspace_scope_v1(p_workspace_id TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rorca,pg_catalog AS $$
  SELECT current_setting('rorca.workspace_id',TRUE)=p_workspace_id
    AND (current_setting('rorca.migration_mode',TRUE)='on'
      OR session_user IN(SELECT database_user FROM rorca.wave2_runtime_principal_identities)
      OR session_user IN(SELECT database_user FROM rorca.wave2_canonical_writer_identities))
$$;
REVOKE ALL ON FUNCTION rorca.wave4_ops_workspace_scope_v1(TEXT) FROM PUBLIC,authenticated,anon;

CREATE OR REPLACE FUNCTION rorca.wave4_ops_reject_immutable_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=rorca,pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Wave 4 operational journal is append-only' USING ERRCODE='42501'; END $$;

CREATE TABLE rorca.wave4_doctor_definitions (
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  definition_id TEXT NOT NULL,
  definition_kind TEXT NOT NULL CHECK(definition_kind IN('check','fix')),
  subject_id TEXT NOT NULL,
  subject_revision TEXT NOT NULL,
  subject_class TEXT NOT NULL CHECK(subject_class IN('rebuildable_projection','fenced_ephemeral_runtime_state','canonical_mission','canonical_spec','canonical_evidence','canonical_closeout','canonical_lifecycle','human_decision','immutable_artifact')),
  condition_type TEXT NOT NULL CHECK(condition_type IN('healthy','drifted','missing','stale','indeterminate')),
  severity TEXT NOT NULL CHECK(severity IN('info','warning','error','critical')),
  capability TEXT NOT NULL CHECK(capability IN('observe','rebuild_projection','fence_ephemeral_state')),
  evidence_source_id TEXT NOT NULL,
  evidence_source_revision TEXT NOT NULL,
  evidence_maximum_age_ms BIGINT NOT NULL CHECK(evidence_maximum_age_ms>0),
  precondition_json JSONB NOT NULL CHECK(jsonb_typeof(precondition_json)='object' AND octet_length(precondition_json::text)<=8192),
  postcondition_json JSONB NOT NULL CHECK(jsonb_typeof(postcondition_json)='object' AND octet_length(postcondition_json::text)<=8192),
  compensation_id TEXT,
  definition_hash TEXT NOT NULL CHECK(definition_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,definition_id,subject_revision),
  UNIQUE(workspace_id,definition_hash),
  CHECK(definition_kind='check' OR (compensation_id IS NOT NULL AND subject_class IN('rebuildable_projection','fenced_ephemeral_runtime_state')))
);

CREATE TABLE rorca.wave4_doctor_invocations (
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  invocation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK(octet_length(idempotency_key) BETWEEN 1 AND 256),
  request_hash TEXT NOT NULL CHECK(request_hash ~ '^sha256:[0-9a-f]{64}$'),
  subject_id TEXT NOT NULL,
  subject_revision TEXT NOT NULL,
  check_definition_hash TEXT NOT NULL CHECK(check_definition_hash ~ '^sha256:[0-9a-f]{64}$'),
  fix_definition_hash TEXT CHECK(fix_definition_hash IS NULL OR fix_definition_hash ~ '^sha256:[0-9a-f]{64}$'),
  preview_hash TEXT NOT NULL CHECK(preview_hash ~ '^sha256:[0-9a-f]{64}$'),
  preview_expires_at TIMESTAMPTZ NOT NULL,
  fence BIGINT NOT NULL CHECK(fence>0),
  apply_requested BOOLEAN NOT NULL DEFAULT FALSE,
  maximum_attempts INTEGER NOT NULL CHECK(maximum_attempts BETWEEN 1 AND 10),
  attempts_used INTEGER NOT NULL DEFAULT 0 CHECK(attempts_used BETWEEN 0 AND maximum_attempts),
  wall_clock_budget_ms BIGINT NOT NULL CHECK(wall_clock_budget_ms>0),
  provider_cost_budget_micros BIGINT NOT NULL CHECK(provider_cost_budget_micros>=0),
  provider_cost_used_micros BIGINT NOT NULL DEFAULT 0 CHECK(provider_cost_used_micros BETWEEN 0 AND provider_cost_budget_micros),
  resource_budget_units BIGINT NOT NULL CHECK(resource_budget_units>0),
  resource_used_units BIGINT NOT NULL DEFAULT 0 CHECK(resource_used_units BETWEEN 0 AND resource_budget_units),
  rate_limit_per_minute INTEGER NOT NULL CHECK(rate_limit_per_minute>0),
  cooldown_ms BIGINT NOT NULL CHECK(cooldown_ms>=0),
  state TEXT NOT NULL CHECK(state IN('proposed','executing','verified','compensated','indeterminate','quarantined','complete')),
  result_hash TEXT CHECK(result_hash IS NULL OR result_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,invocation_id),
  UNIQUE(workspace_id,idempotency_key),
  FOREIGN KEY(workspace_id,check_definition_hash) REFERENCES rorca.wave4_doctor_definitions(workspace_id,definition_hash) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,fix_definition_hash) REFERENCES rorca.wave4_doctor_definitions(workspace_id,definition_hash) ON DELETE RESTRICT
);

CREATE TABLE rorca.wave4_doctor_transitions (
  workspace_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 8),
  transition TEXT NOT NULL CHECK(transition IN('detect','classify','propose','authority','execute','verify','outcome','escalate')),
  status TEXT NOT NULL,
  observation_hash TEXT NOT NULL CHECK(observation_hash ~ '^sha256:[0-9a-f]{64}$'),
  redacted_detail TEXT NOT NULL CHECK(octet_length(redacted_detail)<=4096),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,invocation_id,sequence),
  FOREIGN KEY(workspace_id,invocation_id) REFERENCES rorca.wave4_doctor_invocations(workspace_id,invocation_id) ON DELETE RESTRICT,
  CHECK((sequence=1 AND transition='detect') OR (sequence=2 AND transition='classify') OR (sequence=3 AND transition='propose')
    OR (sequence=4 AND transition='authority') OR (sequence=5 AND transition='execute') OR (sequence=6 AND transition='verify')
    OR (sequence=7 AND transition='outcome') OR (sequence=8 AND transition='escalate')),
  CHECK(redacted_detail !~* '(password|secret|credential|authorization|private.?key|raw.?prompt|raw.?transcript|human.?signature)\\s*[:=]')
);

CREATE OR REPLACE FUNCTION rorca.record_wave4_doctor_transition_v1(
  p_workspace_id TEXT,p_invocation_id TEXT,p_sequence INTEGER,p_transition TEXT,p_status TEXT,p_observation_hash TEXT,p_redacted_detail TEXT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=rorca,pg_catalog AS $$
DECLARE expected_sequence INTEGER; expected_transition TEXT;
BEGIN
  IF NOT rorca.wave4_ops_workspace_scope_v1(p_workspace_id) THEN RAISE EXCEPTION 'Wave 4 Doctor workspace denied' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('wave4-doctor:'||p_workspace_id||':'||p_invocation_id,0));
  SELECT COALESCE(MAX(sequence),0)+1 INTO expected_sequence FROM rorca.wave4_doctor_transitions WHERE workspace_id=p_workspace_id AND invocation_id=p_invocation_id;
  expected_transition:=(ARRAY['detect','classify','propose','authority','execute','verify','outcome','escalate'])[expected_sequence];
  IF p_sequence IS DISTINCT FROM expected_sequence OR p_transition IS DISTINCT FROM expected_transition
  THEN RAISE EXCEPTION 'Wave 4 Doctor transition skip denied' USING ERRCODE='55000'; END IF;
  INSERT INTO rorca.wave4_doctor_transitions(workspace_id,invocation_id,sequence,transition,status,observation_hash,redacted_detail)
  VALUES(p_workspace_id,p_invocation_id,p_sequence,p_transition,p_status,p_observation_hash,p_redacted_detail);
END $$;
REVOKE ALL ON FUNCTION rorca.record_wave4_doctor_transition_v1(TEXT,TEXT,INTEGER,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC,authenticated,anon;

CREATE TABLE rorca.wave4_idle_policies (
  policy_id TEXT NOT NULL, policy_version TEXT NOT NULL, policy_hash TEXT NOT NULL UNIQUE CHECK(policy_hash ~ '^sha256:[0-9a-f]{64}$'),
  hard_maxima_json JSONB NOT NULL CHECK(jsonb_typeof(hard_maxima_json)='object' AND octet_length(hard_maxima_json::text)<=16384),
  exponential_sleep_json JSONB NOT NULL CHECK(jsonb_typeof(exponential_sleep_json)='object'),
  jitter_permille INTEGER NOT NULL CHECK(jitter_permille BETWEEN 0 AND 1000), cooldown_ms BIGINT NOT NULL CHECK(cooldown_ms>=0),
  wake_sources TEXT[] NOT NULL CHECK(wake_sources @> ARRAY['canonical_event','webhook','lease_deadline','operator_request']::TEXT[]
    AND NOT wake_sources && ARRAY['heartbeat','terminal_output','elapsed_cron']::TEXT[]),
  maximum_oscillations INTEGER NOT NULL CHECK(maximum_oscillations BETWEEN 1 AND 100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(policy_id,policy_version)
);

CREATE TABLE rorca.wave4_idle_controller_states (
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT, controller_id TEXT NOT NULL,
  policy_hash TEXT NOT NULL REFERENCES rorca.wave4_idle_policies(policy_hash) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK(state IN('running','suspended','circuit_open')), usage_json JSONB NOT NULL CHECK(jsonb_typeof(usage_json)='object'),
  state_json JSONB NOT NULL CHECK(jsonb_typeof(state_json)='object' AND octet_length(state_json::text)<=32768),
  state_hash TEXT NOT NULL CHECK(state_hash ~ '^sha256:[0-9a-f]{64}$'),
  nonessential_reservations BIGINT NOT NULL DEFAULT 0 CHECK(nonessential_reservations>=0), provider_request_count BIGINT NOT NULL DEFAULT 0 CHECK(provider_request_count>=0),
  suspension_count INTEGER NOT NULL DEFAULT 0 CHECK(suspension_count>=0), wake_count INTEGER NOT NULL DEFAULT 0 CHECK(wake_count>=0), oscillations INTEGER NOT NULL DEFAULT 0 CHECK(oscillations>=0),
  escalation_hash TEXT CHECK(escalation_hash IS NULL OR escalation_hash ~ '^sha256:[0-9a-f]{64}$'),
  last_transition_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(workspace_id,controller_id),
  CHECK(state_json->>'workspaceId'=workspace_id AND state_json->>'controllerId'=controller_id
    AND state_json->>'policyHash'=policy_hash AND state_json->>'status'=state)
);
CREATE TABLE rorca.wave4_idle_wake_receipts (
  workspace_id TEXT NOT NULL, controller_id TEXT NOT NULL, wake_id TEXT NOT NULL, request_hash TEXT NOT NULL CHECK(request_hash ~ '^sha256:[0-9a-f]{64}$'),
  source TEXT NOT NULL CHECK(source IN('canonical_event','webhook','lease_deadline','operator_request','unverified')),
  authenticated BOOLEAN NOT NULL, relevant BOOLEAN NOT NULL, accepted BOOLEAN NOT NULL, reason_code TEXT NOT NULL,
  result_json JSONB NOT NULL CHECK(jsonb_typeof(result_json)='object' AND octet_length(result_json::text)<=32768),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,controller_id,wake_id), FOREIGN KEY(workspace_id,controller_id) REFERENCES rorca.wave4_idle_controller_states(workspace_id,controller_id) ON DELETE RESTRICT
);
CREATE TABLE rorca.wave4_idle_wake_source_receipts (
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  controller_id TEXT NOT NULL,
  source_receipt_id TEXT NOT NULL,
  receipt_hash TEXT NOT NULL CHECK(receipt_hash ~ '^sha256:[0-9a-f]{64}$'),
  source TEXT NOT NULL CHECK(source IN('canonical_event','webhook','lease_deadline','operator_request')),
  subject_hash TEXT NOT NULL CHECK(subject_hash ~ '^sha256:[0-9a-f]{64}$'),
  authenticated_by TEXT NOT NULL,
  relevant BOOLEAN NOT NULL CHECK(relevant),
  observed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL CHECK(expires_at>=observed_at),
  revalidation_json JSONB NOT NULL CHECK(jsonb_typeof(revalidation_json)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,controller_id,source_receipt_id)
);

CREATE TABLE rorca.wave4_resource_inventory (
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT, resource_type TEXT NOT NULL,
  external_id TEXT NOT NULL, owner_labels JSONB NOT NULL CHECK(jsonb_typeof(owner_labels)='object'), provider TEXT NOT NULL, account_id TEXT NOT NULL, region TEXT NOT NULL,
  desired_revision TEXT NOT NULL, observed_revision TEXT NOT NULL, credential_reference_id TEXT NOT NULL CHECK(credential_reference_id LIKE 'vault://%'),
  dependencies JSONB NOT NULL CHECK(jsonb_typeof(dependencies)='array'), retention_class TEXT NOT NULL CHECK(retention_class IN('ephemeral','evidence_retained','legal_hold')),
  lifecycle_status TEXT NOT NULL CHECK(lifecycle_status IN('provisioning','admitted','quarantined','offboarding','offboarded','indeterminate')),
  lineage_external_id TEXT, row_hash TEXT NOT NULL CHECK(row_hash ~ '^sha256:[0-9a-f]{64}$'), created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(workspace_id,resource_type,external_id), UNIQUE(workspace_id,row_hash), CHECK(updated_at>=created_at)
);
CREATE TABLE rorca.wave4_resource_sagas (
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT, saga_id TEXT NOT NULL, operation TEXT NOT NULL CHECK(operation IN('provision','offboard','new_identity_replacement')),
  idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL CHECK(request_hash ~ '^sha256:[0-9a-f]{64}$'), resource_type TEXT NOT NULL, external_id TEXT,
  lineage_external_id TEXT, replacement_review_hash TEXT CHECK(replacement_review_hash IS NULL OR replacement_review_hash ~ '^sha256:[0-9a-f]{64}$'),
  replacement_revalidated BOOLEAN NOT NULL DEFAULT FALSE, separately_authorized BOOLEAN NOT NULL,
  state TEXT NOT NULL CHECK(state IN('running','admitted','offboarded','blocked','indeterminate','quarantined')),
  provider_kind TEXT NOT NULL CHECK(provider_kind IN('local_fake_provider','local_fake_forgejo')), real_provider_mutation BOOLEAN NOT NULL DEFAULT FALSE CHECK(real_provider_mutation=FALSE),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(workspace_id,saga_id), UNIQUE(workspace_id,operation,idempotency_key),
  CHECK(operation<>'new_identity_replacement' OR (lineage_external_id IS NOT NULL AND replacement_review_hash IS NOT NULL AND replacement_revalidated))
);
CREATE TABLE rorca.wave4_resource_saga_stages (
  workspace_id TEXT NOT NULL, saga_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence>0), stage TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN('completed','compensated','blocked','indeterminate')), compensation_id TEXT NOT NULL, indeterminate_action TEXT NOT NULL CHECK(octet_length(indeterminate_action)<=4096),
  receipt_hash TEXT NOT NULL CHECK(receipt_hash ~ '^sha256:[0-9a-f]{64}$'), created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,saga_id,sequence), FOREIGN KEY(workspace_id,saga_id) REFERENCES rorca.wave4_resource_sagas(workspace_id,saga_id) ON DELETE RESTRICT
);
CREATE TABLE rorca.wave4_resource_discovery_observations (
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT, observation_id TEXT NOT NULL, external_id TEXT NOT NULL,
  reason_code TEXT NOT NULL, quarantined BOOLEAN NOT NULL, mutation_count INTEGER NOT NULL DEFAULT 0 CHECK(mutation_count=0), observation_hash TEXT NOT NULL CHECK(observation_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(workspace_id,observation_id)
);

CREATE OR REPLACE FUNCTION rorca.wave4_inventory_identity_guard_v1() RETURNS trigger LANGUAGE plpgsql SET search_path=rorca,pg_catalog AS $$
BEGIN
  IF OLD.workspace_id IS DISTINCT FROM NEW.workspace_id OR OLD.resource_type IS DISTINCT FROM NEW.resource_type
    OR OLD.external_id IS DISTINCT FROM NEW.external_id OR OLD.credential_reference_id IS DISTINCT FROM NEW.credential_reference_id
    OR OLD.created_at IS DISTINCT FROM NEW.created_at OR OLD.lineage_external_id IS DISTINCT FROM NEW.lineage_external_id
  THEN RAISE EXCEPTION 'Resource inventory immutable identity rewrite denied' USING ERRCODE='42501'; END IF;
  NEW.updated_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER wave4_inventory_identity_guard BEFORE UPDATE ON rorca.wave4_resource_inventory FOR EACH ROW EXECUTE FUNCTION rorca.wave4_inventory_identity_guard_v1();
CREATE TRIGGER wave4_inventory_delete_guard BEFORE DELETE ON rorca.wave4_resource_inventory FOR EACH ROW EXECUTE FUNCTION rorca.wave4_ops_reject_immutable_v1();

CREATE TABLE rorca.wave4_operations_mutation_capabilities (
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  capability_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN('doctor.transition','idle.register','idle.observe','idle.wake','resource.provision','resource.offboard','certificate.record','review.record')),
  request_hash TEXT NOT NULL CHECK(request_hash ~ '^sha256:[0-9a-f]{64}$'),
  subject_hash TEXT NOT NULL CHECK(subject_hash ~ '^sha256:[0-9a-f]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  issued_by_receipt_hash TEXT NOT NULL CHECK(issued_by_receipt_hash ~ '^sha256:[0-9a-f]{64}$'),
  PRIMARY KEY(workspace_id,capability_id)
);
CREATE TABLE rorca.wave4_resource_offboard_authorizations (
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  authorization_receipt_id TEXT NOT NULL,
  authorization_receipt_hash TEXT NOT NULL CHECK(authorization_receipt_hash ~ '^sha256:[0-9a-f]{64}$'),
  resource_type TEXT NOT NULL,
  external_id TEXT NOT NULL,
  inventory_hash TEXT NOT NULL CHECK(inventory_hash ~ '^sha256:[0-9a-f]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  issued_by_receipt_hash TEXT NOT NULL CHECK(issued_by_receipt_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,authorization_receipt_id),
  UNIQUE(workspace_id,authorization_receipt_hash)
);
CREATE OR REPLACE FUNCTION rorca.record_wave4_doctor_transition_v2(
  p_workspace_id TEXT,p_capability_id TEXT,p_request_hash TEXT,p_subject_hash TEXT,
  p_invocation_id TEXT,p_sequence INTEGER,p_transition TEXT,p_status TEXT,p_observation_hash TEXT,p_redacted_detail TEXT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=rorca,pg_catalog AS $$
DECLARE capability rorca.wave4_operations_mutation_capabilities%ROWTYPE;
DECLARE expected_sequence INTEGER; expected_transition TEXT;
BEGIN
  IF current_setting('rorca.workspace_id',TRUE) IS DISTINCT FROM p_workspace_id
    OR session_user NOT IN(SELECT database_user FROM rorca.wave2_canonical_writer_identities)
  THEN RAISE EXCEPTION 'Canonical writer workspace denied' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('wave4-doctor:'||p_workspace_id||':'||p_invocation_id,0));
  SELECT * INTO STRICT capability FROM rorca.wave4_operations_mutation_capabilities
    WHERE workspace_id=p_workspace_id AND capability_id=p_capability_id FOR UPDATE;
  IF capability.operation<>'doctor.transition' OR capability.request_hash<>p_request_hash
    OR capability.subject_hash<>p_subject_hash OR capability.expires_at<=clock_timestamp() OR capability.consumed_at IS NOT NULL
  THEN RAISE EXCEPTION 'Exact unexpired Doctor mutation capability required' USING ERRCODE='42501'; END IF;
  SELECT COALESCE(MAX(sequence),0)+1 INTO expected_sequence FROM rorca.wave4_doctor_transitions
    WHERE workspace_id=p_workspace_id AND invocation_id=p_invocation_id;
  expected_transition:=(ARRAY['detect','classify','propose','authority','execute','verify','outcome','escalate'])[expected_sequence];
  IF p_sequence IS DISTINCT FROM expected_sequence OR p_transition IS DISTINCT FROM expected_transition
  THEN RAISE EXCEPTION 'Wave 4 Doctor transition skip denied' USING ERRCODE='55000'; END IF;
  INSERT INTO rorca.wave4_doctor_transitions(workspace_id,invocation_id,sequence,transition,status,observation_hash,redacted_detail)
  VALUES(p_workspace_id,p_invocation_id,p_sequence,p_transition,p_status,p_observation_hash,p_redacted_detail);
  UPDATE rorca.wave4_operations_mutation_capabilities SET consumed_at=clock_timestamp()
    WHERE workspace_id=p_workspace_id AND capability_id=p_capability_id;
END $$;
REVOKE ALL ON FUNCTION rorca.record_wave4_doctor_transition_v2(TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER,TEXT,TEXT,TEXT,TEXT)
  FROM PUBLIC,authenticated,anon;

CREATE OR REPLACE FUNCTION rorca.apply_wave4_idle_state_v1(
  p_workspace_id TEXT,p_capability_id TEXT,p_operation TEXT,p_request_hash TEXT,p_subject_hash TEXT,
  p_controller_id TEXT,p_expected_state_hash TEXT,p_next_state JSONB,p_next_state_hash TEXT,
  p_wake_id TEXT,p_wake_request_hash TEXT,p_wake_result JSONB
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=rorca,pg_catalog AS $$
DECLARE capability rorca.wave4_operations_mutation_capabilities%ROWTYPE;
DECLARE current_hash TEXT;
BEGIN
  IF current_setting('rorca.workspace_id',TRUE) IS DISTINCT FROM p_workspace_id
    OR session_user NOT IN(SELECT database_user FROM rorca.wave2_canonical_writer_identities)
  THEN RAISE EXCEPTION 'Canonical writer idle workspace denied' USING ERRCODE='42501'; END IF;
  IF p_operation NOT IN('idle.register','idle.observe','idle.wake')
    OR p_request_hash !~ '^sha256:[0-9a-f]{64}$' OR p_subject_hash !~ '^sha256:[0-9a-f]{64}$'
    OR p_next_state_hash !~ '^sha256:[0-9a-f]{64}$' OR jsonb_typeof(p_next_state)<>'object'
    OR octet_length(p_next_state::text)>32768 OR p_next_state->>'workspaceId'<>p_workspace_id
    OR p_next_state->>'controllerId'<>p_controller_id
    OR p_next_state->>'status' NOT IN('running','suspended','circuit_open')
    OR p_next_state ?| ARRAY['authority','providerAuthority','mergeAuthority','deploymentAuthority','approvalAuthority']
  THEN RAISE EXCEPTION 'Invalid bounded idle state mutation' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('wave4-idle:'||p_workspace_id||':'||p_controller_id,0));
  SELECT * INTO STRICT capability FROM rorca.wave4_operations_mutation_capabilities
    WHERE workspace_id=p_workspace_id AND capability_id=p_capability_id FOR UPDATE;
  IF capability.operation<>p_operation OR capability.request_hash<>p_request_hash
    OR capability.subject_hash<>p_subject_hash OR capability.expires_at<=clock_timestamp() OR capability.consumed_at IS NOT NULL
  THEN RAISE EXCEPTION 'Exact unexpired idle mutation capability required' USING ERRCODE='42501'; END IF;
  SELECT state_hash INTO current_hash FROM rorca.wave4_idle_controller_states
    WHERE workspace_id=p_workspace_id AND controller_id=p_controller_id FOR UPDATE;
  IF p_expected_state_hash='state_absent' THEN
    IF current_hash IS NOT NULL OR p_operation<>'idle.register' THEN RAISE EXCEPTION 'Idle registration CAS failed' USING ERRCODE='40001'; END IF;
    INSERT INTO rorca.wave4_idle_controller_states(workspace_id,controller_id,policy_hash,state,usage_json,state_json,state_hash,
      nonessential_reservations,provider_request_count,suspension_count,wake_count,oscillations,escalation_hash,last_transition_at)
    VALUES(p_workspace_id,p_controller_id,p_next_state->>'policyHash',p_next_state->>'status',p_next_state->'usage',
      p_next_state,p_next_state_hash,(p_next_state->>'nonessentialReservations')::bigint,
      (p_next_state->>'providerRequestCount')::bigint,(p_next_state->>'suspensionCount')::integer,
      (p_next_state->>'wakeCount')::integer,(p_next_state->>'oscillations')::integer,
      p_next_state->'escalation'->>'escalationId',to_timestamp((p_next_state->>'lastTransitionAt')::double precision/1000));
  ELSE
    IF current_hash IS DISTINCT FROM p_expected_state_hash OR p_operation='idle.register'
    THEN RAISE EXCEPTION 'Idle state CAS failed' USING ERRCODE='40001'; END IF;
    UPDATE rorca.wave4_idle_controller_states SET policy_hash=p_next_state->>'policyHash',state=p_next_state->>'status',
      usage_json=p_next_state->'usage',state_json=p_next_state,state_hash=p_next_state_hash,
      nonessential_reservations=(p_next_state->>'nonessentialReservations')::bigint,
      provider_request_count=(p_next_state->>'providerRequestCount')::bigint,
      suspension_count=(p_next_state->>'suspensionCount')::integer,wake_count=(p_next_state->>'wakeCount')::integer,
      oscillations=(p_next_state->>'oscillations')::integer,escalation_hash=p_next_state->'escalation'->>'escalationId',
      last_transition_at=to_timestamp((p_next_state->>'lastTransitionAt')::double precision/1000)
    WHERE workspace_id=p_workspace_id AND controller_id=p_controller_id;
  END IF;
  IF p_operation='idle.wake' THEN
    IF p_wake_id IS NULL OR p_wake_request_hash !~ '^sha256:[0-9a-f]{64}$' OR jsonb_typeof(p_wake_result)<>'object'
    THEN RAISE EXCEPTION 'Exact wake receipt required' USING ERRCODE='22023'; END IF;
    INSERT INTO rorca.wave4_idle_wake_receipts(workspace_id,controller_id,wake_id,request_hash,source,authenticated,relevant,accepted,reason_code,result_json)
    VALUES(p_workspace_id,p_controller_id,p_wake_id,p_wake_request_hash,
      COALESCE(p_wake_result->>'verifiedSource','unverified'),p_wake_result->>'verifiedSource' IS NOT NULL,
      p_wake_result->>'verifiedSource' IS NOT NULL,(p_wake_result->>'accepted')::boolean,p_wake_result->>'reasonCode',p_wake_result);
  END IF;
  UPDATE rorca.wave4_operations_mutation_capabilities SET consumed_at=clock_timestamp()
    WHERE workspace_id=p_workspace_id AND capability_id=p_capability_id;
END $$;
REVOKE ALL ON FUNCTION rorca.apply_wave4_idle_state_v1(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,JSONB,TEXT,TEXT,TEXT,JSONB)
  FROM PUBLIC,authenticated,anon;

CREATE OR REPLACE FUNCTION rorca.claim_wave4_idle_capability_v1(
  p_workspace_id TEXT,p_operation TEXT,p_request_hash TEXT,p_subject_hash TEXT
) RETURNS TABLE(capability_id TEXT,request_hash TEXT,subject_hash TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=rorca,pg_catalog AS $$
BEGIN
  IF current_setting('rorca.workspace_id',TRUE) IS DISTINCT FROM p_workspace_id
    OR session_user NOT IN(SELECT database_user FROM rorca.wave2_canonical_writer_identities)
  THEN RAISE EXCEPTION 'Canonical writer capability claim denied' USING ERRCODE='42501'; END IF;
  RETURN QUERY SELECT capability.capability_id,capability.request_hash,capability.subject_hash
  FROM rorca.wave4_operations_mutation_capabilities capability
  WHERE capability.workspace_id=p_workspace_id AND capability.operation=p_operation
    AND capability.request_hash=p_request_hash AND capability.subject_hash=p_subject_hash
    AND capability.expires_at>clock_timestamp() AND capability.consumed_at IS NULL
  ORDER BY capability.expires_at,capability.capability_id LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'No exact preissued idle mutation capability' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION rorca.claim_wave4_idle_capability_v1(TEXT,TEXT,TEXT,TEXT)
  FROM PUBLIC,authenticated,anon;

CREATE TABLE rorca.wave4_isolation_fault_receipts (
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT, protected_workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  lane TEXT NOT NULL CHECK(lane IN('managed','fake_federated')), budget TEXT NOT NULL CHECK(budget IN('cpuMillis','memoryBytes','executionConcurrency','continuationConcurrency','eventRate','contextBytes','contextTokens','storageBytes','storageObjects','retrySpend','providerTokens','providerCurrencyMicros','rawReferences','retentionObjects','alerts')),
  before_hash TEXT NOT NULL CHECK(before_hash ~ '^sha256:[0-9a-f]{64}$'), after_hash TEXT NOT NULL CHECK(after_hash=before_hash), zero_leakage BOOLEAN NOT NULL CHECK(zero_leakage),
  provider_mutation_count INTEGER NOT NULL DEFAULT 0 CHECK(provider_mutation_count=0), receipt_hash TEXT NOT NULL CHECK(receipt_hash ~ '^sha256:[0-9a-f]{64}$'), created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,protected_workspace_id,lane,budget)
);
CREATE TABLE rorca.wave4_clean_room_certificates (
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT, certificate_hash TEXT NOT NULL CHECK(certificate_hash ~ '^sha256:[0-9a-f]{64}$'),
  lane TEXT NOT NULL CHECK(lane IN('managed','fake_federated')), source_sha TEXT NOT NULL CHECK(source_sha ~ '^[0-9a-f]{40}$'), migration_hash TEXT NOT NULL CHECK(migration_hash ~ '^sha256:[0-9a-f]{64}$'),
  contract_hash TEXT NOT NULL CHECK(contract_hash ~ '^sha256:[0-9a-f]{64}$'), spec_hash TEXT NOT NULL CHECK(spec_hash ~ '^sha256:[0-9a-f]{64}$'), artifact_set_hash TEXT NOT NULL CHECK(artifact_set_hash ~ '^sha256:[0-9a-f]{64}$'),
  tool_versions JSONB NOT NULL CHECK(jsonb_typeof(tool_versions)='object'), exact_commands JSONB NOT NULL CHECK(jsonb_typeof(exact_commands)='array'), observations JSONB NOT NULL CHECK(jsonb_typeof(observations)='array'),
  unresolved_blockers JSONB NOT NULL CHECK(jsonb_typeof(unresolved_blockers)='array'), cleanup_hash TEXT NOT NULL CHECK(cleanup_hash ~ '^sha256:[0-9a-f]{64}$'),
  provider_mutation_count INTEGER NOT NULL DEFAULT 0 CHECK(provider_mutation_count=0), production_mutation_count INTEGER NOT NULL DEFAULT 0 CHECK(production_mutation_count=0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(workspace_id,certificate_hash), UNIQUE(workspace_id,lane,source_sha)
);
CREATE TABLE rorca.wave4_operations_independent_reviews (
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT, packet_hash TEXT NOT NULL CHECK(packet_hash ~ '^sha256:[0-9a-f]{64}$'),
  reviewer_identity_hash TEXT NOT NULL CHECK(reviewer_identity_hash ~ '^sha256:[0-9a-f]{64}$'), architecture_findings INTEGER NOT NULL CHECK(architecture_findings>=0),
  security_findings INTEGER NOT NULL CHECK(security_findings>=0), operations_findings INTEGER NOT NULL CHECK(operations_findings>=0), blocking_findings INTEGER NOT NULL CHECK(blocking_findings>=0),
  verdict TEXT NOT NULL CHECK(verdict IN('accepted','blocked')), authority_effect TEXT NOT NULL DEFAULT 'none' CHECK(authority_effect='none'), created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,packet_hash,reviewer_identity_hash), CHECK(verdict='blocked' OR architecture_findings+security_findings+operations_findings+blocking_findings=0)
);

DO $$ DECLARE table_name TEXT; BEGIN
  FOREACH table_name IN ARRAY ARRAY['wave4_doctor_definitions','wave4_doctor_invocations','wave4_doctor_transitions','wave4_idle_controller_states','wave4_idle_wake_receipts','wave4_idle_wake_source_receipts','wave4_resource_inventory','wave4_resource_sagas','wave4_resource_saga_stages','wave4_resource_discovery_observations','wave4_operations_mutation_capabilities','wave4_resource_offboard_authorizations','wave4_isolation_fault_receipts','wave4_clean_room_certificates','wave4_operations_independent_reviews'] LOOP
    EXECUTE format('ALTER TABLE rorca.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE rorca.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY %I ON rorca.%I FOR ALL USING (rorca.wave4_ops_workspace_scope_v1(workspace_id)) WITH CHECK (rorca.wave4_ops_workspace_scope_v1(workspace_id))','wave4_ops_workspace_'||table_name,table_name);
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY['wave4_operations_schema_readiness','wave4_doctor_definitions','wave4_doctor_transitions','wave4_idle_policies','wave4_idle_wake_receipts','wave4_idle_wake_source_receipts','wave4_resource_sagas','wave4_resource_saga_stages','wave4_resource_discovery_observations','wave4_resource_offboard_authorizations','wave4_isolation_fault_receipts','wave4_clean_room_certificates','wave4_operations_independent_reviews'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON rorca.%I FOR EACH ROW EXECUTE FUNCTION rorca.wave4_ops_reject_immutable_v1()',table_name||'_immutable',table_name);
  END LOOP;
END $$;

DO $$ DECLARE runtime_user TEXT:=current_setting('rorca.runtime_database_user',TRUE); writer_user TEXT:=current_setting('rorca.canonical_writer_database_user',TRUE); table_name TEXT; BEGIN
  IF runtime_user IS NULL OR runtime_user='' OR writer_user IS NULL OR writer_user='' THEN RAISE EXCEPTION 'Wave 4 operational database principals required' USING ERRCODE='42501'; END IF;
  FOREACH table_name IN ARRAY ARRAY['wave4_operations_schema_readiness','wave4_doctor_definitions','wave4_doctor_invocations','wave4_doctor_transitions','wave4_idle_policies','wave4_idle_controller_states','wave4_idle_wake_receipts','wave4_idle_wake_source_receipts','wave4_resource_inventory','wave4_resource_sagas','wave4_resource_saga_stages','wave4_resource_discovery_observations','wave4_resource_offboard_authorizations','wave4_isolation_fault_receipts','wave4_clean_room_certificates','wave4_operations_independent_reviews'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE rorca.%I FROM PUBLIC,authenticated,anon,%I,%I',table_name,runtime_user,writer_user);
    EXECUTE format('GRANT SELECT ON TABLE rorca.%I TO %I',table_name,runtime_user);
    EXECUTE format('GRANT SELECT ON TABLE rorca.%I TO %I',table_name,writer_user);
  END LOOP;
  REVOKE ALL ON TABLE rorca.wave4_operations_mutation_capabilities FROM PUBLIC,authenticated,anon;
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.wave4_ops_workspace_scope_v1(TEXT) TO %I',runtime_user);
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.wave4_ops_workspace_scope_v1(TEXT) TO %I',writer_user);
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.record_wave4_doctor_transition_v2(TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER,TEXT,TEXT,TEXT,TEXT) TO %I',writer_user);
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.apply_wave4_idle_state_v1(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,JSONB,TEXT,TEXT,TEXT,JSONB) TO %I',writer_user);
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.claim_wave4_idle_capability_v1(TEXT,TEXT,TEXT,TEXT) TO %I',writer_user);
END $$;
