-- Completion Protocol v1: host-owned autonomous implementation state.
-- Runtime/model output is proposal-only; accepted StoryCloseoutDecision remains
-- the sole story-completion authority. No pg-boss or delivery authority lives here.

SELECT set_config('rorca.migration_mode','on',TRUE);

CREATE TABLE rorca.completion_schema_readiness (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
  protocol_version SMALLINT NOT NULL CHECK(protocol_version=1),
  migration_version BIGINT NOT NULL CHECK(migration_version=20260804170000),
  contract_source_digest TEXT NOT NULL CHECK(contract_source_digest ~ '^sha256:[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK(state='ready'),
  installed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO rorca.completion_schema_readiness(
  singleton,protocol_version,migration_version,contract_source_digest,state)
VALUES(TRUE,1,20260804170000,'sha256:6efbecef9d1a2d6252dbf34fb870e48f95a793a1547bf505bce34e21277be2b5','ready');
REVOKE ALL PRIVILEGES ON TABLE rorca.completion_schema_readiness FROM PUBLIC,authenticated,anon;

CREATE TABLE rorca.completion_obligation_sets (
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  obligation_set_id TEXT NOT NULL,
  obligation_set_revision INTEGER NOT NULL CHECK(obligation_set_revision>0),
  artifact_hash TEXT NOT NULL CHECK(artifact_hash ~ '^sha256:[0-9a-f]{64}$'),
  attempt_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  fencing_token BIGINT NOT NULL CHECK(fencing_token>0),
  work_package_hash TEXT NOT NULL CHECK(work_package_hash ~ '^sha256:[0-9a-f]{64}$'),
  manifest_hash TEXT NOT NULL CHECK(manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK(state IN('active','superseded','rejected')),
  payload_json JSONB NOT NULL CHECK(jsonb_typeof(payload_json)='object' AND octet_length(payload_json::text)<=4194304),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,obligation_set_id,obligation_set_revision),
  UNIQUE(workspace_id,artifact_hash),
  FOREIGN KEY(workspace_id,attempt_id) REFERENCES rorca.governed_execution_attempts(workspace_id,attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,lease_id) REFERENCES rorca.execution_leases(workspace_id,lease_id) ON DELETE RESTRICT
);

CREATE TABLE rorca.completion_attempts (
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  attempt_id TEXT NOT NULL,
  protocol_version SMALLINT NOT NULL CHECK(protocol_version=1),
  scope_hash TEXT NOT NULL CHECK(scope_hash ~ '^sha256:[0-9a-f]{64}$'),
  lease_id TEXT NOT NULL,
  fencing_token BIGINT NOT NULL CHECK(fencing_token>0),
  runtime_id TEXT NOT NULL,
  obligation_set_id TEXT NOT NULL,
  obligation_set_revision INTEGER NOT NULL CHECK(obligation_set_revision>0),
  obligation_set_hash TEXT NOT NULL CHECK(obligation_set_hash ~ '^sha256:[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK(state IN('pending','loading','planning','executing','validating','self_reviewing','proposing','gate_wait','submitted','blocked','cancelled','quarantined','escalated')),
  writer_fence BIGINT NOT NULL CHECK(writer_fence>0),
  state_version BIGINT NOT NULL DEFAULT 1 CHECK(state_version>0),
  current_plan_id TEXT,
  current_plan_revision INTEGER CHECK(current_plan_revision IS NULL OR current_plan_revision>0),
  current_plan_hash TEXT CHECK(current_plan_hash IS NULL OR current_plan_hash ~ '^sha256:[0-9a-f]{64}$'),
  current_proposal_id TEXT,
  current_proposal_revision INTEGER CHECK(current_proposal_revision IS NULL OR current_proposal_revision>0),
  current_proposal_hash TEXT CHECK(current_proposal_hash IS NULL OR current_proposal_hash ~ '^sha256:[0-9a-f]{64}$'),
  current_gate_decision_id TEXT,
  current_gate_decision_hash TEXT CHECK(current_gate_decision_hash IS NULL OR current_gate_decision_hash ~ '^sha256:[0-9a-f]{64}$'),
  retry_spent INTEGER NOT NULL DEFAULT 0 CHECK(retry_spent BETWEEN 0 AND 3),
  retry_maximum INTEGER NOT NULL CHECK(retry_maximum BETWEEN 0 AND 3),
  last_failure_fingerprint TEXT CHECK(last_failure_fingerprint IS NULL OR last_failure_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  repeated_failure_count INTEGER NOT NULL DEFAULT 0 CHECK(repeated_failure_count BETWEEN 0 AND 2),
  ledger_high_water BIGINT NOT NULL DEFAULT -1 CHECK(ledger_high_water>=-1),
  ledger_high_water_hash TEXT CHECK(ledger_high_water_hash IS NULL OR ledger_high_water_hash ~ '^sha256:[0-9a-f]{64}$'),
  artifact_hash TEXT NOT NULL CHECK(artifact_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,attempt_id),
  UNIQUE(workspace_id,scope_hash),
  FOREIGN KEY(workspace_id,attempt_id) REFERENCES rorca.governed_execution_attempts(workspace_id,attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,lease_id) REFERENCES rorca.execution_leases(workspace_id,lease_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,obligation_set_id,obligation_set_revision) REFERENCES rorca.completion_obligation_sets(workspace_id,obligation_set_id,obligation_set_revision) ON DELETE RESTRICT,
  CHECK(retry_spent<=retry_maximum),
  CHECK((ledger_high_water=-1)=(ledger_high_water_hash IS NULL))
);

CREATE TABLE rorca.completion_task_plans (
  workspace_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL CHECK(plan_revision>0),
  plan_hash TEXT NOT NULL CHECK(plan_hash ~ '^sha256:[0-9a-f]{64}$'),
  prior_plan_hash TEXT,
  artifact_hash TEXT NOT NULL CHECK(artifact_hash=plan_hash),
  payload_json JSONB NOT NULL CHECK(jsonb_typeof(payload_json)='object' AND octet_length(payload_json::text)<=4194304),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,attempt_id,plan_id,plan_revision),
  UNIQUE(workspace_id,attempt_id,plan_hash),
  FOREIGN KEY(workspace_id,attempt_id) REFERENCES rorca.completion_attempts(workspace_id,attempt_id) ON DELETE RESTRICT,
  CHECK((plan_revision=1 AND prior_plan_hash IS NULL) OR (plan_revision>1 AND prior_plan_hash ~ '^sha256:[0-9a-f]{64}$'))
);

CREATE TABLE rorca.completion_task_receipts (
  workspace_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  operation_key TEXT NOT NULL CHECK(operation_key ~ '^sha256:[0-9a-f]{64}$'),
  execution_nonce TEXT NOT NULL,
  writer_fence BIGINT NOT NULL CHECK(writer_fence>0),
  receipt_type TEXT NOT NULL CHECK(receipt_type IN('claim','started','settled','validation','self_review','reconciled','uncertain','quarantined')),
  outcome TEXT NOT NULL CHECK(outcome IN('pending','succeeded','failed','cancelled','uncertain','reconciled','quarantined')),
  result_hash TEXT NOT NULL CHECK(result_hash ~ '^sha256:[0-9a-f]{64}$'),
  artifact_hash TEXT NOT NULL CHECK(artifact_hash ~ '^sha256:[0-9a-f]{64}$'),
  payload_json JSONB NOT NULL CHECK(jsonb_typeof(payload_json)='object' AND octet_length(payload_json::text)<=262144),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,receipt_id),
  UNIQUE(workspace_id,attempt_id,operation_key,receipt_type),
  FOREIGN KEY(workspace_id,attempt_id) REFERENCES rorca.completion_attempts(workspace_id,attempt_id) ON DELETE RESTRICT
);

CREATE TABLE rorca.completion_progress_entries (
  workspace_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  sequence BIGINT NOT NULL CHECK(sequence>=0),
  prior_entry_hash TEXT,
  entry_hash TEXT NOT NULL CHECK(entry_hash ~ '^sha256:[0-9a-f]{64}$'),
  writer_fence BIGINT NOT NULL CHECK(writer_fence>0),
  plan_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL CHECK(plan_revision>0),
  plan_hash TEXT NOT NULL CHECK(plan_hash ~ '^sha256:[0-9a-f]{64}$'),
  repository_sha TEXT NOT NULL CHECK(repository_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  entry_type TEXT NOT NULL CHECK(entry_type IN('attempt_reconciled','plan_persisted','batch_started','task_operation_persisted','task_settled','validation_recorded','self_review_recorded','proposal_persisted','gate_decided','continuation_authorized','closeout_submitted','attempt_settled','recovery_recorded')),
  payload_hash TEXT NOT NULL CHECK(payload_hash ~ '^sha256:[0-9a-f]{64}$'),
  artifact_hash TEXT NOT NULL CHECK(artifact_hash=entry_hash),
  payload_json JSONB NOT NULL CHECK(jsonb_typeof(payload_json)='object' AND octet_length(payload_json::text)<=65536),
  event_json JSONB NOT NULL CHECK(jsonb_typeof(event_json)='object' AND octet_length(event_json::text)<=262144),
  recorded_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,attempt_id,sequence),
  UNIQUE(workspace_id,attempt_id,entry_hash),
  FOREIGN KEY(workspace_id,attempt_id) REFERENCES rorca.completion_attempts(workspace_id,attempt_id) ON DELETE RESTRICT,
  CHECK((sequence=0 AND prior_entry_hash IS NULL) OR (sequence>0 AND prior_entry_hash ~ '^sha256:[0-9a-f]{64}$'))
);

CREATE TABLE rorca.completion_result_proposals (
  workspace_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  proposal_revision INTEGER NOT NULL CHECK(proposal_revision>0),
  proposal_hash TEXT NOT NULL CHECK(proposal_hash ~ '^sha256:[0-9a-f]{64}$'),
  disposition TEXT NOT NULL CHECK(disposition IN('ready','blocked','failed','cancelled')),
  artifact_hash TEXT NOT NULL CHECK(artifact_hash=proposal_hash),
  payload_json JSONB NOT NULL CHECK(jsonb_typeof(payload_json)='object' AND octet_length(payload_json::text)<=4194304),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,attempt_id,proposal_id,proposal_revision),
  UNIQUE(workspace_id,attempt_id,proposal_hash),
  FOREIGN KEY(workspace_id,attempt_id) REFERENCES rorca.completion_attempts(workspace_id,attempt_id) ON DELETE RESTRICT
);

CREATE TABLE rorca.completion_gate_decisions (
  workspace_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  decision_revision INTEGER NOT NULL CHECK(decision_revision>0),
  decision_hash TEXT NOT NULL CHECK(decision_hash ~ '^sha256:[0-9a-f]{64}$'),
  proposal_id TEXT NOT NULL,
  proposal_revision INTEGER NOT NULL CHECK(proposal_revision>0),
  proposal_hash TEXT NOT NULL CHECK(proposal_hash ~ '^sha256:[0-9a-f]{64}$'),
  stage TEXT NOT NULL CHECK(stage IN('controller_preflight','host_semantic')),
  outcome TEXT NOT NULL CHECK(outcome IN('rejected_contract','stale','cancelled','rejected_gate','validated','quarantined')),
  next_action TEXT NOT NULL CHECK(next_action IN('none','continue_fix','submit_closeout','escalate')),
  establishes_story_completion BOOLEAN NOT NULL DEFAULT FALSE CHECK(establishes_story_completion=FALSE),
  artifact_hash TEXT NOT NULL CHECK(artifact_hash=decision_hash),
  payload_json JSONB NOT NULL CHECK(jsonb_typeof(payload_json)='object' AND octet_length(payload_json::text)<=4194304),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,attempt_id,decision_id,decision_revision),
  UNIQUE(workspace_id,attempt_id,decision_hash),
  FOREIGN KEY(workspace_id,attempt_id) REFERENCES rorca.completion_attempts(workspace_id,attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,attempt_id,proposal_id,proposal_revision) REFERENCES rorca.completion_result_proposals(workspace_id,attempt_id,proposal_id,proposal_revision) ON DELETE RESTRICT,
  CHECK((next_action='submit_closeout')=(outcome='validated' AND stage='host_semantic'))
);

CREATE TABLE rorca.completion_continuation_directives (
  workspace_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  directive_id TEXT NOT NULL,
  directive_revision INTEGER NOT NULL CHECK(directive_revision>0),
  directive_hash TEXT NOT NULL CHECK(directive_hash ~ '^sha256:[0-9a-f]{64}$'),
  continuation_key TEXT NOT NULL CHECK(continuation_key ~ '^sha256:[0-9a-f]{64}$'),
  prior_decision_id TEXT NOT NULL,
  prior_decision_revision INTEGER NOT NULL CHECK(prior_decision_revision>0),
  state TEXT NOT NULL CHECK(state IN('authorized','dispatched','settled','expired','quarantined')),
  dispatch_id TEXT,
  dispatch_receipt_hash TEXT CHECK(dispatch_receipt_hash IS NULL OR dispatch_receipt_hash ~ '^sha256:[0-9a-f]{64}$'),
  consumption_id TEXT,
  consumption_hash TEXT CHECK(consumption_hash IS NULL OR consumption_hash ~ '^sha256:[0-9a-f]{64}$'),
  consumed_at TIMESTAMPTZ,
  artifact_hash TEXT NOT NULL CHECK(artifact_hash=directive_hash),
  payload_json JSONB NOT NULL CHECK(jsonb_typeof(payload_json)='object' AND octet_length(payload_json::text)<=4194304),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,attempt_id,directive_id,directive_revision),
  UNIQUE(workspace_id,continuation_key),
  FOREIGN KEY(workspace_id,attempt_id) REFERENCES rorca.completion_attempts(workspace_id,attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,attempt_id,prior_decision_id,prior_decision_revision) REFERENCES rorca.completion_gate_decisions(workspace_id,attempt_id,decision_id,decision_revision) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,dispatch_id) REFERENCES rorca.continuation_dispatches(workspace_id,dispatch_id) ON DELETE RESTRICT,
  CHECK((state='authorized' AND dispatch_id IS NULL AND dispatch_receipt_hash IS NULL)
    OR (state='dispatched' AND dispatch_id IS NOT NULL AND dispatch_receipt_hash IS NULL)
    OR (state IN('settled','expired','quarantined') AND dispatch_id IS NOT NULL)),
  CHECK((consumption_id IS NULL AND consumption_hash IS NULL AND consumed_at IS NULL)
    OR (consumption_id IS NOT NULL AND consumption_hash IS NOT NULL AND consumed_at IS NOT NULL AND state='settled'))
);

CREATE TABLE rorca.completion_operation_receipts (
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  operation_key TEXT NOT NULL CHECK(operation_key ~ '^sha256:[0-9a-f]{64}$'),
  attempt_id TEXT,
  operation TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(request_hash ~ '^sha256:[0-9a-f]{64}$'),
  payload_hash TEXT NOT NULL CHECK(payload_hash ~ '^sha256:[0-9a-f]{64}$'),
  response_hash TEXT NOT NULL CHECK(response_hash ~ '^sha256:[0-9a-f]{64}$'),
  outcome TEXT NOT NULL CHECK(outcome IN('accepted','rejected','duplicate','conflict','quarantined')),
  artifact_hash TEXT NOT NULL CHECK(artifact_hash ~ '^sha256:[0-9a-f]{64}$'),
  response_json JSONB NOT NULL CHECK(jsonb_typeof(response_json)='object' AND octet_length(response_json::text)<=262144),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,operation_key),
  FOREIGN KEY(workspace_id,attempt_id) REFERENCES rorca.completion_attempts(workspace_id,attempt_id) ON DELETE RESTRICT
);

CREATE TABLE rorca.completion_recovery_events (
  id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  recovery_generation BIGINT NOT NULL CHECK(recovery_generation>=0),
  event_sequence BIGINT NOT NULL CHECK(event_sequence>=0),
  event_type TEXT NOT NULL CHECK(event_type IN('db_ahead','ledger_ahead','ledger_rebuilt','suffix_quarantined','attempt_quarantined','nonce_reconciled','writer_fenced')),
  prior_hash TEXT,
  event_hash TEXT NOT NULL CHECK(event_hash ~ '^sha256:[0-9a-f]{64}$'),
  artifact_hash TEXT NOT NULL CHECK(artifact_hash=event_hash),
  payload_json JSONB NOT NULL CHECK(jsonb_typeof(payload_json)='object' AND octet_length(payload_json::text)<=262144),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(workspace_id,attempt_id,recovery_generation,event_sequence),
  UNIQUE(workspace_id,event_hash),
  FOREIGN KEY(workspace_id,attempt_id) REFERENCES rorca.completion_attempts(workspace_id,attempt_id) ON DELETE RESTRICT
);

CREATE TABLE rorca.completion_final_reports (
  workspace_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  report_id TEXT NOT NULL,
  report_hash TEXT NOT NULL CHECK(report_hash ~ '^sha256:[0-9a-f]{64}$'),
  story_closeout_decision_id TEXT NOT NULL REFERENCES rorca.story_closeout_decisions(decision_id) ON DELETE RESTRICT,
  story_attempt_result_id TEXT NOT NULL REFERENCES rorca.story_attempt_results(attempt_result_id) ON DELETE RESTRICT,
  story_manifest_hash TEXT NOT NULL REFERENCES rorca.story_execution_manifests(manifest_hash) ON DELETE RESTRICT,
  active_subject_sha TEXT NOT NULL CHECK(active_subject_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  gate_decision_id TEXT NOT NULL,
  gate_decision_hash TEXT NOT NULL CHECK(gate_decision_hash ~ '^sha256:[0-9a-f]{64}$'),
  proposal_id TEXT NOT NULL,
  proposal_hash TEXT NOT NULL CHECK(proposal_hash ~ '^sha256:[0-9a-f]{64}$'),
  final_sha TEXT NOT NULL CHECK(final_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  tree_hash TEXT NOT NULL CHECK(tree_hash ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  diff_hash TEXT NOT NULL CHECK(diff_hash ~ '^sha256:[0-9a-f]{64}$'),
  merge_ready BOOLEAN NOT NULL,
  merged BOOLEAN NOT NULL DEFAULT FALSE CHECK(merged=FALSE),
  deployed BOOLEAN NOT NULL DEFAULT FALSE CHECK(deployed=FALSE),
  production_approved BOOLEAN NOT NULL DEFAULT FALSE CHECK(production_approved=FALSE),
  artifact_hash TEXT NOT NULL CHECK(artifact_hash=report_hash),
  payload_json JSONB NOT NULL CHECK(jsonb_typeof(payload_json)='object' AND octet_length(payload_json::text)<=4194304),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,report_id),
  UNIQUE(workspace_id,attempt_id),
  UNIQUE(workspace_id,story_closeout_decision_id),
  FOREIGN KEY(workspace_id,attempt_id) REFERENCES rorca.completion_attempts(workspace_id,attempt_id) ON DELETE RESTRICT,
  CHECK(report_id=story_closeout_decision_id),
  CHECK(final_sha=active_subject_sha)
);

CREATE INDEX completion_attempts_recovery_idx ON rorca.completion_attempts(state,updated_at);
CREATE INDEX completion_task_receipts_nonce_idx ON rorca.completion_task_receipts(workspace_id,attempt_id,execution_nonce);
CREATE INDEX completion_proposals_attempt_idx ON rorca.completion_result_proposals(workspace_id,attempt_id,proposal_revision DESC);
CREATE INDEX completion_gate_attempt_idx ON rorca.completion_gate_decisions(workspace_id,attempt_id,created_at DESC);
CREATE INDEX completion_recovery_attempt_idx ON rorca.completion_recovery_events(workspace_id,attempt_id,recovery_generation,event_sequence);

CREATE OR REPLACE FUNCTION rorca.completion_reject_immutable_mutation_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=rorca,pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Completion Protocol journals are immutable' USING ERRCODE='42501';
END;
$$;

CREATE OR REPLACE FUNCTION rorca.guard_completion_attempt_state_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=rorca,pg_catalog AS $$
BEGIN
  IF TG_OP='INSERT' THEN RETURN NEW; END IF;
  IF OLD.workspace_id IS DISTINCT FROM NEW.workspace_id OR OLD.attempt_id IS DISTINCT FROM NEW.attempt_id
    OR OLD.protocol_version IS DISTINCT FROM NEW.protocol_version OR OLD.scope_hash IS DISTINCT FROM NEW.scope_hash
    OR OLD.lease_id IS DISTINCT FROM NEW.lease_id OR OLD.fencing_token IS DISTINCT FROM NEW.fencing_token
    OR OLD.runtime_id IS DISTINCT FROM NEW.runtime_id OR OLD.obligation_set_id IS DISTINCT FROM NEW.obligation_set_id
    OR OLD.obligation_set_revision IS DISTINCT FROM NEW.obligation_set_revision
    OR OLD.obligation_set_hash IS DISTINCT FROM NEW.obligation_set_hash OR OLD.created_at IS DISTINCT FROM NEW.created_at
    OR NEW.state_version<>OLD.state_version+1 OR NEW.writer_fence<OLD.writer_fence
  THEN RAISE EXCEPTION 'Completion attempt identity or CAS transition denied' USING ERRCODE='42501'; END IF;
  IF NOT (((NEW.state=OLD.state) AND (
    OLD.state NOT IN('submitted','blocked','cancelled','quarantined','escalated') OR (
      NEW.ledger_high_water=OLD.ledger_high_water+1
      AND NEW.ledger_high_water_hash IS DISTINCT FROM OLD.ledger_high_water_hash
      AND NEW.writer_fence=OLD.writer_fence
      AND NEW.current_plan_id IS NOT DISTINCT FROM OLD.current_plan_id
      AND NEW.current_plan_revision IS NOT DISTINCT FROM OLD.current_plan_revision
      AND NEW.current_plan_hash IS NOT DISTINCT FROM OLD.current_plan_hash
      AND NEW.current_proposal_id IS NOT DISTINCT FROM OLD.current_proposal_id
      AND NEW.current_proposal_revision IS NOT DISTINCT FROM OLD.current_proposal_revision
      AND NEW.current_proposal_hash IS NOT DISTINCT FROM OLD.current_proposal_hash
      AND NEW.current_gate_decision_id IS NOT DISTINCT FROM OLD.current_gate_decision_id
      AND NEW.current_gate_decision_hash IS NOT DISTINCT FROM OLD.current_gate_decision_hash
      AND NEW.retry_spent=OLD.retry_spent AND NEW.retry_maximum=OLD.retry_maximum
      AND NEW.last_failure_fingerprint IS NOT DISTINCT FROM OLD.last_failure_fingerprint
      AND NEW.repeated_failure_count=OLD.repeated_failure_count
    )
  )) OR CASE OLD.state
    WHEN 'pending' THEN NEW.state IN('loading','cancelled','quarantined','escalated')
    WHEN 'loading' THEN NEW.state IN('planning','blocked','cancelled','quarantined','escalated')
    WHEN 'planning' THEN NEW.state IN('executing','blocked','cancelled','quarantined','escalated')
    WHEN 'executing' THEN NEW.state IN('validating','blocked','cancelled','quarantined','escalated')
    WHEN 'validating' THEN NEW.state IN('self_reviewing','blocked','cancelled','quarantined','escalated')
    WHEN 'self_reviewing' THEN NEW.state IN('proposing','blocked','cancelled','quarantined','escalated')
    WHEN 'proposing' THEN NEW.state IN('gate_wait','blocked','cancelled','quarantined','escalated')
    WHEN 'gate_wait' THEN NEW.state IN('planning','submitted','blocked','cancelled','quarantined','escalated')
    ELSE FALSE END)
  THEN RAISE EXCEPTION 'Illegal Completion Protocol state transition' USING ERRCODE='55000'; END IF;
  NEW.updated_at:=clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION rorca.guard_completion_continuation_lifecycle_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=rorca,pg_catalog AS $$
DECLARE prior_migration_mode TEXT:=current_setting('rorca.migration_mode',TRUE);
DECLARE exact_subject BOOLEAN;
BEGIN
  PERFORM set_config('rorca.migration_mode','on',TRUE);
  IF TG_OP='INSERT' THEN
    SELECT EXISTS(SELECT 1 FROM rorca.completion_attempts a
      WHERE a.workspace_id=NEW.workspace_id AND a.attempt_id=NEW.attempt_id
        AND a.lease_id=NEW.payload_json->'scope'->>'leaseId'
        AND a.writer_fence=(NEW.payload_json->'scope'->>'fencingToken')::bigint
        AND NEW.payload_json->'scope'->>'workspaceId'=NEW.workspace_id
        AND NEW.payload_json->'scope'->>'attemptId'=NEW.attempt_id
        AND NEW.payload_json->>'directiveId'=NEW.directive_id
        AND (NEW.payload_json->>'directiveRevision')::integer=NEW.directive_revision
        AND NEW.payload_json->>'directiveHash'=NEW.directive_hash
        AND NEW.payload_json->>'continuationKey'=NEW.continuation_key
        AND NEW.payload_json->>'state'='authorized'
        AND NEW.state='authorized' AND NEW.dispatch_id IS NULL
        AND NEW.dispatch_receipt_hash IS NULL AND NEW.consumption_id IS NULL
    ) INTO exact_subject;
    PERFORM set_config('rorca.migration_mode',COALESCE(prior_migration_mode,''),TRUE);
    IF NOT exact_subject THEN
      RAISE EXCEPTION 'Continuation directive creation requires exact authorized scope' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.workspace_id IS DISTINCT FROM NEW.workspace_id OR OLD.attempt_id IS DISTINCT FROM NEW.attempt_id
    OR OLD.directive_id IS DISTINCT FROM NEW.directive_id OR OLD.directive_revision IS DISTINCT FROM NEW.directive_revision
    OR OLD.directive_hash IS DISTINCT FROM NEW.directive_hash OR OLD.continuation_key IS DISTINCT FROM NEW.continuation_key
    OR OLD.prior_decision_id IS DISTINCT FROM NEW.prior_decision_id
    OR OLD.prior_decision_revision IS DISTINCT FROM NEW.prior_decision_revision
    OR OLD.artifact_hash IS DISTINCT FROM NEW.artifact_hash OR OLD.payload_json IS DISTINCT FROM NEW.payload_json
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN RAISE EXCEPTION 'Continuation directive immutable subject mutation denied' USING ERRCODE='42501'; END IF;
  IF OLD.state='authorized' AND NEW.state='dispatched' AND OLD.dispatch_id IS NULL
      AND NEW.dispatch_id IS NOT NULL AND NEW.dispatch_receipt_hash IS NULL
      AND NEW.consumption_id IS NULL THEN
    SELECT EXISTS(SELECT 1 FROM rorca.continuation_dispatches d
      JOIN rorca.execution_leases l ON l.workspace_id=d.workspace_id AND l.lease_id=d.lease_id
      JOIN rorca.continuation_dispatch_consumptions c ON c.workspace_id=d.workspace_id
        AND c.dispatch_id=d.dispatch_id AND c.continuation_key=d.continuation_key
      JOIN rorca.continuation_dispatch_outbox o ON o.workspace_id=d.workspace_id
        AND o.dispatch_id=d.dispatch_id AND o.continuation_key=d.continuation_key
      WHERE d.workspace_id=NEW.workspace_id AND d.dispatch_id=NEW.dispatch_id
        AND d.continuation_key=NEW.continuation_key AND d.state IN('dispatched','settled')
        AND l.attempt_id=NEW.attempt_id AND d.lease_id=NEW.payload_json->'scope'->>'leaseId'
        AND d.fencing_token=(NEW.payload_json->'scope'->>'fencingToken')::bigint
        AND d.payload_json->'scope'=NEW.payload_json->'scope') INTO exact_subject;
  ELSIF OLD.state='dispatched' AND NEW.state='settled'
      AND OLD.dispatch_id=NEW.dispatch_id AND OLD.dispatch_receipt_hash IS NULL
      AND NEW.dispatch_receipt_hash IS NOT NULL AND NEW.consumption_id IS NULL THEN
    SELECT EXISTS(SELECT 1 FROM rorca.continuation_dispatches d
      JOIN rorca.continuation_dispatch_outbox o ON o.workspace_id=d.workspace_id
        AND o.dispatch_id=d.dispatch_id AND o.continuation_key=d.continuation_key
      JOIN rorca.continuation_dispatch_acceptances a ON a.workspace_id=o.workspace_id
        AND a.dispatch_id=o.dispatch_id AND a.acceptance_receipt_hash=o.receiver_acceptance_receipt_hash
      WHERE d.workspace_id=NEW.workspace_id AND d.dispatch_id=NEW.dispatch_id
        AND d.continuation_key=NEW.continuation_key AND d.state='settled' AND o.state='sent'
        AND a.acceptance_receipt_hash=NEW.dispatch_receipt_hash
        AND a.delivery_key=o.delivery_key AND a.payload_hash=o.payload_hash) INTO exact_subject;
  ELSIF OLD.state='settled' AND NEW.state='settled' AND OLD.dispatch_id=NEW.dispatch_id
      AND OLD.dispatch_receipt_hash=NEW.dispatch_receipt_hash
      AND OLD.consumption_id IS NULL AND NEW.consumption_id IS NOT NULL
      AND NEW.consumption_hash IS NOT NULL AND NEW.consumed_at IS NOT NULL THEN
    SELECT EXISTS(SELECT 1 FROM rorca.continuation_dispatch_acceptances a
      JOIN rorca.continuation_dispatches d ON d.workspace_id=a.workspace_id AND d.dispatch_id=a.dispatch_id
      WHERE a.workspace_id=NEW.workspace_id AND a.dispatch_id=NEW.dispatch_id
        AND a.acceptance_receipt_hash=NEW.dispatch_receipt_hash
        AND d.continuation_key=NEW.continuation_key AND d.state='settled') INTO exact_subject;
  ELSE
    exact_subject:=FALSE;
  END IF;
  PERFORM set_config('rorca.migration_mode',COALESCE(prior_migration_mode,''),TRUE);
  IF NOT exact_subject THEN
    RAISE EXCEPTION 'Continuation directive lifecycle CAS or durable receipt rejected' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION rorca.authorize_completion_protocol_mutation_v1(
  p_workspace_id TEXT,p_operation TEXT,p_request_hash TEXT,p_subject_hash TEXT,p_request JSONB
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=rorca,pg_catalog AS $$
DECLARE v_secret BYTEA;
DECLARE artifact JSONB:=p_request->'artifact';
DECLARE expected_subject TEXT;
BEGIN
  expected_subject:=COALESCE(artifact->>'contentHash',artifact->>'artifactHash',artifact->>'eventHash',artifact->>'entryHash');
  IF p_operation NOT IN('completion.activate','completion.plan','completion.task-receipt','completion.progress-entry','completion.proposal','completion.gate','completion.continuation','completion.continuation-dispatch','completion.continuation-settle','completion.continuation-consume','completion.operation-receipt','completion.recovery','completion.final-report','completion.attempt-transition')
    OR p_request_hash !~ '^sha256:[0-9a-f]{64}$' OR p_subject_hash !~ '^sha256:[0-9a-f]{64}$'
    OR jsonb_typeof(p_request)<>'object' OR jsonb_typeof(artifact)<>'object'
    OR expected_subject IS DISTINCT FROM p_subject_hash OR octet_length(p_request::text)>4194304
    OR current_setting('rorca.workspace_id',TRUE) IS DISTINCT FROM p_workspace_id
    OR NOT EXISTS(SELECT 1 FROM rorca.wave2_runtime_principal_identities i WHERE i.database_user=session_user
      AND i.grant_receipt_hash='sha256:af3a76e53c5f13157e10c0782d5c810428efb4e12ef4cb863b4ad04ad6f21093')
    OR EXISTS(SELECT 1 FROM rorca.wave2_runtime_mutation_capabilities c WHERE c.transaction_id=txid_current()
      AND c.backend_pid=pg_backend_pid() AND c.database_user=session_user AND c.workspace_id=p_workspace_id AND c.operation=p_operation)
  THEN RAISE EXCEPTION 'Completion Protocol canonical capability denied' USING ERRCODE='42501'; END IF;
  INSERT INTO rorca.wave2_runtime_mutation_capabilities
    (transaction_id,backend_pid,database_user,workspace_id,operation,request_hash,subject_hash,request_json)
  VALUES(txid_current(),pg_backend_pid(),session_user,p_workspace_id,p_operation,p_request_hash,p_subject_hash,p_request);
  SELECT secret INTO STRICT v_secret FROM rorca.wave2_canonical_capability_secrets WHERE singleton=TRUE;
  UPDATE rorca.wave2_runtime_mutation_capabilities c SET capability_mac=
    rorca.wave2_canonical_capability_mac_v3(v_secret,c.transaction_id,c.backend_pid,c.database_user,c.workspace_id,c.operation,c.request_hash,c.subject_hash,c.request_json)
  WHERE c.transaction_id=txid_current() AND c.backend_pid=pg_backend_pid() AND c.database_user=session_user
    AND c.workspace_id=p_workspace_id AND c.operation=p_operation;
  IF NOT FOUND THEN RAISE EXCEPTION 'Completion Protocol capability issuance failed' USING ERRCODE='42501'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION rorca.authorize_completion_protocol_mutation_v1(TEXT,TEXT,TEXT,TEXT,JSONB) FROM PUBLIC;

CREATE OR REPLACE FUNCTION rorca.guard_completion_protocol_dml_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=rorca,pg_catalog AS $$
DECLARE row_json JSONB:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
DECLARE capability rorca.wave2_runtime_mutation_capabilities%ROWTYPE;
DECLARE v_secret BYTEA;
DECLARE expected_mac BYTEA;
DECLARE artifact JSONB;
BEGIN
  IF session_user=current_user THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Completion Protocol deletes are forbidden' USING ERRCODE='42501'; END IF;
  SELECT * INTO capability FROM rorca.wave2_runtime_mutation_capabilities c
   WHERE c.transaction_id=txid_current() AND c.backend_pid=pg_backend_pid() AND c.database_user=session_user
     AND c.workspace_id=row_json->>'workspace_id' AND c.operation LIKE 'completion.%'
   ORDER BY c.issued_at DESC LIMIT 1;
  IF capability.operation IS NULL OR capability.capability_mac IS NULL
    OR current_setting('rorca.workspace_id',TRUE) IS DISTINCT FROM row_json->>'workspace_id'
  THEN RAISE EXCEPTION 'Exact Completion Protocol capability required' USING ERRCODE='42501'; END IF;
  SELECT secret INTO STRICT v_secret FROM rorca.wave2_canonical_capability_secrets WHERE singleton=TRUE;
  expected_mac:=rorca.wave2_canonical_capability_mac_v3(v_secret,capability.transaction_id,capability.backend_pid,
    capability.database_user,capability.workspace_id,capability.operation,capability.request_hash,capability.subject_hash,capability.request_json);
  IF expected_mac IS DISTINCT FROM capability.capability_mac THEN
    RAISE EXCEPTION 'Completion Protocol capability MAC mismatch' USING ERRCODE='42501';
  END IF;
  artifact:=capability.request_json->'artifact';
  IF NOT (CASE capability.operation
    WHEN 'completion.activate' THEN TG_TABLE_NAME=ANY(ARRAY['completion_obligation_sets','completion_attempts','completion_operation_receipts'])
    WHEN 'completion.plan' THEN TG_TABLE_NAME=ANY(ARRAY['completion_task_plans','completion_attempts','completion_operation_receipts'])
    WHEN 'completion.task-receipt' THEN TG_TABLE_NAME=ANY(ARRAY['completion_task_receipts','completion_operation_receipts'])
    WHEN 'completion.progress-entry' THEN TG_TABLE_NAME=ANY(ARRAY['completion_progress_entries','completion_attempts','completion_operation_receipts'])
    WHEN 'completion.proposal' THEN TG_TABLE_NAME=ANY(ARRAY['completion_result_proposals','completion_attempts','completion_operation_receipts'])
    WHEN 'completion.gate' THEN TG_TABLE_NAME=ANY(ARRAY['completion_gate_decisions','completion_attempts','completion_operation_receipts'])
    WHEN 'completion.continuation' THEN TG_TABLE_NAME=ANY(ARRAY['completion_continuation_directives','completion_operation_receipts'])
    WHEN 'completion.continuation-dispatch' THEN TG_TABLE_NAME=ANY(ARRAY['completion_continuation_directives','completion_operation_receipts'])
    WHEN 'completion.continuation-settle' THEN TG_TABLE_NAME=ANY(ARRAY['completion_continuation_directives','completion_operation_receipts'])
    WHEN 'completion.continuation-consume' THEN TG_TABLE_NAME=ANY(ARRAY['completion_continuation_directives','completion_operation_receipts'])
    WHEN 'completion.operation-receipt' THEN TG_TABLE_NAME='completion_operation_receipts'
    WHEN 'completion.recovery' THEN TG_TABLE_NAME=ANY(ARRAY['completion_recovery_events','completion_operation_receipts'])
    WHEN 'completion.final-report' THEN TG_TABLE_NAME=ANY(ARRAY['completion_final_reports','completion_operation_receipts'])
    WHEN 'completion.attempt-transition' THEN TG_TABLE_NAME='completion_attempts'
    ELSE FALSE END)
  THEN RAISE EXCEPTION 'Completion Protocol capability does not authorize this table' USING ERRCODE='42501'; END IF;
  IF TG_TABLE_NAME='completion_attempts' THEN
    IF COALESCE(artifact->'scope'->>'attemptId',artifact->>'attemptId') IS DISTINCT FROM row_json->>'attempt_id'
      OR COALESCE(artifact->'scope'->>'fencingToken',artifact->>'writerFence') IS DISTINCT FROM row_json->>'writer_fence'
    THEN RAISE EXCEPTION 'Completion attempt mutation subject mismatch' USING ERRCODE='42501'; END IF;
  ELSIF row_json->>'artifact_hash' IS DISTINCT FROM capability.subject_hash THEN
    RAISE EXCEPTION 'Completion Protocol artifact subject mismatch' USING ERRCODE='42501';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER completion_attempt_state_guard BEFORE INSERT OR UPDATE ON rorca.completion_attempts
FOR EACH ROW EXECUTE FUNCTION rorca.guard_completion_attempt_state_v1();
CREATE TRIGGER completion_continuation_lifecycle_guard
BEFORE INSERT OR UPDATE ON rorca.completion_continuation_directives
FOR EACH ROW EXECUTE FUNCTION rorca.guard_completion_continuation_lifecycle_v1();

CREATE OR REPLACE FUNCTION rorca.completion_final_report_authority_subject_v1(
  p_workspace_id TEXT,p_attempt_id TEXT,p_report JSONB
) RETURNS TABLE(story_attempt_result_id TEXT,story_manifest_hash TEXT,active_subject_sha TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=rorca,pg_catalog AS $$
DECLARE prior_migration_mode TEXT:=current_setting('rorca.migration_mode',TRUE);
BEGIN
  PERFORM set_config('rorca.migration_mode','on',TRUE);
  RETURN QUERY SELECT s.attempt_result_id,s.manifest_hash,s.payload->'activeSubjectRevision'->>'commitSha'
  FROM rorca.story_closeout_decisions s
  JOIN rorca.story_attempt_results ar ON ar.attempt_result_id=s.attempt_result_id
    AND ar.workspace_id=s.workspace_id AND ar.manifest_hash=s.manifest_hash
  JOIN rorca.story_execution_manifests m ON m.manifest_hash=s.manifest_hash
    AND m.workspace_id=s.workspace_id AND m.spec_id=s.spec_id AND m.run_id=s.run_id
    AND m.story_id=s.story_id AND m.attempt=s.attempt
  JOIN rorca.governed_execution_attempts ge
    ON ge.workspace_id=s.workspace_id AND ge.run_id=s.run_id AND ge.story_id=s.story_id
    AND ge.manifest_hash=s.manifest_hash
  JOIN rorca.governed_work_package_revisions w
    ON w.workspace_id=ge.workspace_id AND w.mission_id=ge.mission_id
    AND w.work_package_id=ge.work_package_id AND w.work_package_revision=ge.work_package_revision
  WHERE s.decision_id=p_report->>'storyCloseoutDecisionId' AND s.workspace_id=p_workspace_id
    AND ge.attempt_id=p_attempt_id AND s.status='accepted'
    AND s.spec_id=w.payload_json->'spec'->>'specId' AND s.story_id=w.payload_json->'spec'->>'storyId'
    AND s.attempt=ge.generation+1
    AND ar.payload->>'manifestHash'=s.manifest_hash
    AND ar.payload->'identity'->>'workspaceId'=s.workspace_id
    AND ar.payload->'identity'->>'specId'=s.spec_id
    AND (ar.payload->'identity'->>'runId')::bigint=s.run_id
    AND ar.payload->'identity'->>'storyId'=s.story_id
    AND (ar.payload->'identity'->>'attempt')::integer=s.attempt
    AND s.payload->>'decisionId'=s.decision_id AND s.payload->>'status'='accepted'
    AND s.payload->'activeSubjectRevision'->>'commitSha'=p_report->>'finalSha'
    AND ge.current_sha=p_report->>'finalSha'
    AND p_report->>'storyCloseoutDecisionStatus'='accepted'
    AND p_report->'scope'->>'workspaceId'=p_workspace_id
    AND p_report->'scope'->>'attemptId'=p_attempt_id
    AND p_report->'scope'->'repository'->>'currentSha'=p_report->>'finalSha'
  ;
  PERFORM set_config('rorca.migration_mode',COALESCE(prior_migration_mode,''),TRUE);
END;
$$;
REVOKE ALL ON FUNCTION rorca.completion_final_report_authority_subject_v1(TEXT,TEXT,JSONB) FROM PUBLIC;

CREATE OR REPLACE FUNCTION rorca.guard_completion_final_report_authority_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=rorca,pg_catalog AS $$
DECLARE prior_migration_mode TEXT:=current_setting('rorca.migration_mode',TRUE);
DECLARE exact_accepted_subject BOOLEAN;
BEGIN
  PERFORM set_config('rorca.migration_mode','on',TRUE);
  SELECT EXISTS(SELECT 1
    FROM rorca.completion_final_report_authority_subject_v1(NEW.workspace_id,NEW.attempt_id,NEW.payload_json) a
    JOIN rorca.completion_attempts ca ON ca.workspace_id=NEW.workspace_id AND ca.attempt_id=NEW.attempt_id
    JOIN rorca.completion_gate_decisions d ON d.workspace_id=ca.workspace_id AND d.attempt_id=ca.attempt_id
      AND d.decision_id=NEW.gate_decision_id AND d.decision_hash=NEW.gate_decision_hash
    JOIN rorca.completion_result_proposals p ON p.workspace_id=d.workspace_id AND p.attempt_id=d.attempt_id
      AND p.proposal_id=d.proposal_id AND p.proposal_revision=d.proposal_revision
      AND p.proposal_id=NEW.proposal_id AND p.proposal_hash=NEW.proposal_hash
    WHERE a.story_attempt_result_id=NEW.story_attempt_result_id
      AND a.story_manifest_hash=NEW.story_manifest_hash
      AND a.active_subject_sha=NEW.active_subject_sha AND NEW.active_subject_sha=NEW.final_sha
      AND NEW.report_id=NEW.story_closeout_decision_id
      AND NEW.payload_json->>'storyCloseoutDecisionId'=NEW.story_closeout_decision_id
      AND NEW.payload_json->>'gateDecisionId'=NEW.gate_decision_id
      AND NEW.payload_json->>'gateDecisionHash'=NEW.gate_decision_hash
      AND NEW.payload_json->>'proposalId'=NEW.proposal_id
      AND NEW.payload_json->>'proposalHash'=NEW.proposal_hash
      AND NEW.payload_json->>'treeHash'=NEW.tree_hash AND NEW.payload_json->>'diffHash'=NEW.diff_hash
      AND NEW.payload_json->'scope'=d.payload_json->'scope' AND NEW.payload_json->'scope'=p.payload_json->'scope'
      AND NEW.payload_json->'scope'->>'leaseId'=ca.lease_id
      AND (NEW.payload_json->'scope'->>'fencingToken')::bigint=ca.writer_fence
      AND p.payload_json->>'resultSha'=NEW.final_sha
      AND p.payload_json->>'treeHash'=NEW.tree_hash AND p.payload_json->>'diffHash'=NEW.diff_hash
      AND d.payload_json->>'proposalId'=p.proposal_id AND d.payload_json->>'proposalHash'=p.proposal_hash
      AND d.payload_json->>'stage'='host_semantic' AND d.payload_json->>'outcome'='validated'
      AND d.payload_json->>'nextAction'='submit_closeout'
      AND d.payload_json->>'establishesStoryCompletion'='false'
  ) INTO exact_accepted_subject;
  PERFORM set_config('rorca.migration_mode',COALESCE(prior_migration_mode,''),TRUE);
  IF NOT exact_accepted_subject THEN
    RAISE EXCEPTION 'Final report requires exact accepted StoryCloseoutDecision subject' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER completion_final_report_authority BEFORE INSERT ON rorca.completion_final_reports
FOR EACH ROW EXECUTE FUNCTION rorca.guard_completion_final_report_authority_v1();

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'completion_obligation_sets','completion_attempts','completion_task_plans','completion_task_receipts',
    'completion_progress_entries','completion_result_proposals','completion_gate_decisions',
    'completion_continuation_directives','completion_operation_receipts','completion_recovery_events','completion_final_reports'
  ] LOOP
    EXECUTE format('ALTER TABLE rorca.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE rorca.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE rorca.%I FROM PUBLIC,authenticated,anon',table_name);
    EXECUTE format('CREATE POLICY %I ON rorca.%I FOR ALL USING (current_setting(''rorca.workspace_id'',TRUE)=workspace_id AND EXISTS(SELECT 1 FROM rorca.wave2_canonical_writer_identities i WHERE i.database_user=current_user)) WITH CHECK (current_setting(''rorca.workspace_id'',TRUE)=workspace_id AND EXISTS(SELECT 1 FROM rorca.wave2_canonical_writer_identities i WHERE i.database_user=current_user))','completion_protocol_writer_'||table_name,table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON rorca.%I FOR EACH ROW EXECUTE FUNCTION rorca.guard_completion_protocol_dml_v1()','completion_capability_'||table_name,table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON rorca.%I FOR EACH STATEMENT EXECUTE FUNCTION rorca.completion_reject_immutable_mutation_v1()','completion_no_truncate_'||table_name,table_name);
    IF table_name NOT IN('completion_attempts','completion_continuation_directives') THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON rorca.%I FOR EACH ROW EXECUTE FUNCTION rorca.completion_reject_immutable_mutation_v1()','completion_immutable_'||table_name,table_name);
    ELSIF table_name='completion_continuation_directives' THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON rorca.%I FOR EACH ROW EXECUTE FUNCTION rorca.completion_reject_immutable_mutation_v1()','completion_immutable_'||table_name,table_name);
    END IF;
  END LOOP;
END;
$$;

-- Existing closeout journals are relied on as immutable completion authority.
CREATE TRIGGER story_attempt_results_completion_immutable BEFORE UPDATE OR DELETE ON rorca.story_attempt_results
FOR EACH ROW EXECUTE FUNCTION rorca.completion_reject_immutable_mutation_v1();
CREATE TRIGGER story_attempt_results_completion_no_truncate BEFORE TRUNCATE ON rorca.story_attempt_results
FOR EACH STATEMENT EXECUTE FUNCTION rorca.completion_reject_immutable_mutation_v1();
CREATE TRIGGER story_closeout_decisions_completion_immutable BEFORE UPDATE OR DELETE ON rorca.story_closeout_decisions
FOR EACH ROW EXECUTE FUNCTION rorca.completion_reject_immutable_mutation_v1();
CREATE TRIGGER story_closeout_decisions_completion_no_truncate BEFORE TRUNCATE ON rorca.story_closeout_decisions
FOR EACH STATEMENT EXECUTE FUNCTION rorca.completion_reject_immutable_mutation_v1();
CREATE TRIGGER completion_schema_readiness_immutable BEFORE UPDATE OR DELETE ON rorca.completion_schema_readiness
FOR EACH ROW EXECUTE FUNCTION rorca.completion_reject_immutable_mutation_v1();
CREATE TRIGGER completion_schema_readiness_no_truncate BEFORE TRUNCATE ON rorca.completion_schema_readiness
FOR EACH STATEMENT EXECUTE FUNCTION rorca.completion_reject_immutable_mutation_v1();


DO $$
DECLARE writer_user TEXT:=current_setting('rorca.canonical_writer_database_user',TRUE);
DECLARE runtime_user TEXT:=current_setting('rorca.runtime_database_user',TRUE);
DECLARE table_name TEXT;
BEGIN
  IF writer_user IS NULL OR writer_user='' THEN RAISE EXCEPTION 'Canonical writer is required' USING ERRCODE='42501'; END IF;
  IF runtime_user IS NULL OR runtime_user='' THEN RAISE EXCEPTION 'Runtime principal is required' USING ERRCODE='42501'; END IF;
  EXECUTE format('GRANT SELECT ON TABLE rorca.completion_schema_readiness TO %I',runtime_user);
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.authorize_completion_protocol_mutation_v1(TEXT,TEXT,TEXT,TEXT,JSONB) TO %I',writer_user);
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.completion_final_report_authority_subject_v1(TEXT,TEXT,JSONB) TO %I',writer_user);
  FOREACH table_name IN ARRAY ARRAY[
    'completion_obligation_sets','completion_attempts','completion_task_plans','completion_task_receipts',
    'completion_progress_entries','completion_result_proposals','completion_gate_decisions',
    'completion_continuation_directives','completion_operation_receipts','completion_recovery_events','completion_final_reports'
  ] LOOP
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON TABLE rorca.%I TO %I',table_name,writer_user);
  END LOOP;
  EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE rorca.completion_recovery_events_id_seq TO %I',writer_user);
END;
$$;

