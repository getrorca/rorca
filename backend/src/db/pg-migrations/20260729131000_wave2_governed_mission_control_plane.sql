-- Wave 2 governed mission control plane authority schema.
-- Additive, forward-only, application-owned PostgreSQL state. pg-boss remains transport only.
-- The migration runner owns the transaction and schema_migrations marker.

CREATE OR REPLACE FUNCTION rorca.w2_reject_immutable_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'wave2 immutable authority rows cannot be updated or deleted' USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION rorca.w2_reject_immutable_truncate()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'wave2 immutable authority tables cannot be truncated' USING ERRCODE = '55000';
END;
$$;

CREATE TABLE rorca.wave2_schema_readiness (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  contract_version TEXT NOT NULL CHECK (contract_version ~ '^1\.[0-9]+\.[0-9]+$'),
  contract_source_digest TEXT NOT NULL CHECK (contract_source_digest ~ '^sha256:[0-9a-f]{64}$'),
  migration_version BIGINT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('ready','disabled','superseded')),
  installed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO rorca.wave2_schema_readiness(contract_version, contract_source_digest, migration_version, state)
VALUES ('1.0.0','sha256:4006224b9a3b6e062b85aa85309fa7e5afd489f318f280f9b9f9780593e42a3f',20260729131000,'ready');

CREATE TABLE rorca.governed_missions (
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  mission_id TEXT NOT NULL CHECK (octet_length(mission_id) BETWEEN 2 AND 128),
  created_by TEXT NOT NULL CHECK (octet_length(created_by) BETWEEN 2 AND 128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, mission_id)
);
CREATE TABLE rorca.governed_mission_versions (
  workspace_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  mission_revision INTEGER NOT NULL CHECK (mission_revision > 0),
  mission_hash TEXT NOT NULL CHECK (mission_hash ~ '^sha256:[0-9a-f]{64}$'),
  contract_version TEXT NOT NULL CHECK (contract_version ~ '^1\.[0-9]+\.[0-9]+$'),
  canonical_spec_id TEXT NOT NULL,
  canonical_spec_version INTEGER NOT NULL CHECK (canonical_spec_version > 0),
  canonical_spec_hash TEXT NOT NULL CHECK (canonical_spec_hash ~ '^sha256:[0-9a-f]{64}$'),
  canonical_spec_path TEXT NOT NULL CHECK (canonical_spec_path !~ '(^|/)\.\.(/|$)' AND canonical_spec_path !~ '^/'),
  repository_id TEXT NOT NULL,
  base_sha TEXT NOT NULL CHECK (base_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  payload_json JSONB NOT NULL CHECK (jsonb_typeof(payload_json)='object' AND octet_length(payload_json::text)<=262144 AND payload_json::text !~* 'context.?epoch|legacy.?epoch'),
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  created_by TEXT NOT NULL,
  PRIMARY KEY (workspace_id, mission_id, mission_revision),
  UNIQUE (workspace_id, mission_id, mission_hash),
  FOREIGN KEY (workspace_id, mission_id) REFERENCES rorca.governed_missions(workspace_id, mission_id) ON DELETE RESTRICT
);
CREATE TABLE rorca.governed_mission_heads (
  workspace_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  current_revision INTEGER NOT NULL CHECK (current_revision > 0),
  current_hash TEXT NOT NULL CHECK (current_hash ~ '^sha256:[0-9a-f]{64}$'),
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('compiled','active','superseded','rejected')),
  state_version BIGINT NOT NULL DEFAULT 1 CHECK (state_version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, mission_id),
  FOREIGN KEY (workspace_id, mission_id, current_revision) REFERENCES rorca.governed_mission_versions(workspace_id, mission_id, mission_revision) ON DELETE RESTRICT
);

CREATE TABLE rorca.governed_work_packages (
  workspace_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  work_package_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, mission_id, work_package_id),
  FOREIGN KEY (workspace_id, mission_id) REFERENCES rorca.governed_missions(workspace_id, mission_id) ON DELETE RESTRICT
);
CREATE TABLE rorca.governed_work_package_revisions (
  workspace_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  work_package_id TEXT NOT NULL,
  work_package_revision INTEGER NOT NULL CHECK (work_package_revision > 0),
  work_package_hash TEXT NOT NULL CHECK (work_package_hash ~ '^sha256:[0-9a-f]{64}$'),
  mission_revision INTEGER NOT NULL CHECK (mission_revision > 0),
  mission_hash TEXT NOT NULL CHECK (mission_hash ~ '^sha256:[0-9a-f]{64}$'),
  story_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  base_sha TEXT NOT NULL CHECK (base_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  allowed_path_manifest_hash TEXT NOT NULL CHECK (allowed_path_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  required_path_manifest_hash TEXT NOT NULL CHECK (required_path_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  validation_manifest_hash TEXT NOT NULL CHECK (validation_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  authority_ceiling_hash TEXT NOT NULL CHECK (authority_ceiling_hash ~ '^sha256:[0-9a-f]{64}$'),
  payload_json JSONB NOT NULL CHECK (jsonb_typeof(payload_json)='object' AND octet_length(payload_json::text)<=262144 AND payload_json::text !~* 'context.?epoch|legacy.?epoch'),
  proposal_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, mission_id, work_package_id, work_package_revision),
  UNIQUE (workspace_id, mission_id, work_package_id, work_package_hash),
  FOREIGN KEY (workspace_id, mission_id, work_package_id) REFERENCES rorca.governed_work_packages(workspace_id, mission_id, work_package_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, mission_id, mission_revision) REFERENCES rorca.governed_mission_versions(workspace_id, mission_id, mission_revision) ON DELETE RESTRICT
);
CREATE TABLE rorca.governed_work_package_dependencies (
  workspace_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  work_package_id TEXT NOT NULL,
  work_package_revision INTEGER NOT NULL,
  dependency_order INTEGER NOT NULL CHECK (dependency_order >= 0),
  dependency_work_package_id TEXT NOT NULL,
  dependency_revision INTEGER NOT NULL CHECK (dependency_revision > 0),
  PRIMARY KEY (workspace_id, mission_id, work_package_id, work_package_revision, dependency_order),
  UNIQUE (workspace_id, mission_id, work_package_id, work_package_revision, dependency_work_package_id),
  CHECK (work_package_id <> dependency_work_package_id),
  FOREIGN KEY (workspace_id, mission_id, work_package_id, work_package_revision) REFERENCES rorca.governed_work_package_revisions(workspace_id, mission_id, work_package_id, work_package_revision) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, mission_id, dependency_work_package_id, dependency_revision) REFERENCES rorca.governed_work_package_revisions(workspace_id, mission_id, work_package_id, work_package_revision) ON DELETE RESTRICT
);
CREATE TABLE rorca.governed_work_package_heads (
  workspace_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  work_package_id TEXT NOT NULL,
  current_revision INTEGER NOT NULL CHECK (current_revision > 0),
  current_hash TEXT NOT NULL CHECK (current_hash ~ '^sha256:[0-9a-f]{64}$'),
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('proposed','accepted','active','superseded','cancelled')),
  state_version BIGINT NOT NULL DEFAULT 1 CHECK (state_version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, mission_id, work_package_id),
  FOREIGN KEY (workspace_id, mission_id, work_package_id, current_revision) REFERENCES rorca.governed_work_package_revisions(workspace_id, mission_id, work_package_id, work_package_revision) ON DELETE RESTRICT
);

CREATE TABLE rorca.governed_execution_attempts (
  workspace_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  work_package_id TEXT NOT NULL,
  work_package_revision INTEGER NOT NULL,
  run_id BIGINT NOT NULL,
  story_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  generation BIGINT NOT NULL CHECK (generation >= 0),
  manifest_hash TEXT NOT NULL CHECK (manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  repository_id TEXT NOT NULL,
  worktree_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, attempt_id),
  UNIQUE (workspace_id, run_id, story_id, generation),
  FOREIGN KEY (workspace_id, mission_id, work_package_id, work_package_revision) REFERENCES rorca.governed_work_package_revisions(workspace_id, mission_id, work_package_id, work_package_revision) ON DELETE RESTRICT
);
CREATE TABLE rorca.execution_lease_slots (
  workspace_id TEXT NOT NULL,
  lease_slot_key TEXT NOT NULL CHECK (lease_slot_key ~ '^sha256:[0-9a-f]{64}$'),
  last_fence BIGINT NOT NULL DEFAULT 0 CHECK (last_fence >= 0),
  active_lease_id TEXT,
  state_version BIGINT NOT NULL DEFAULT 1 CHECK (state_version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, lease_slot_key)
);
CREATE TABLE rorca.execution_leases (
  workspace_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  lease_slot_key TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  fencing_token BIGINT NOT NULL CHECK (fencing_token > 0),
  work_package_revision INTEGER NOT NULL,
  runtime_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  base_sha TEXT NOT NULL CHECK (base_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  current_sha TEXT NOT NULL CHECK (current_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  worktree_id TEXT NOT NULL,
  policy_definition_hash TEXT NOT NULL CHECK (policy_definition_hash ~ '^sha256:[0-9a-f]{64}$'),
  policy_activation_hash TEXT NOT NULL CHECK (policy_activation_hash ~ '^sha256:[0-9a-f]{64}$'),
  checkpoint_hash TEXT NOT NULL CHECK (checkpoint_hash ~ '^sha256:[0-9a-f]{64}$'),
  bundle_hash TEXT NOT NULL CHECK (bundle_hash ~ '^sha256:[0-9a-f]{64}$'),
  cancellation_id TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('proposed','active','released','expired','cancelled','superseded')),
  state_version BIGINT NOT NULL DEFAULT 1 CHECK (state_version > 0),
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^sha256:[0-9a-f]{64}$'),
  PRIMARY KEY (workspace_id, lease_id),
  UNIQUE (workspace_id, lease_slot_key, fencing_token),
  FOREIGN KEY (workspace_id, lease_slot_key) REFERENCES rorca.execution_lease_slots(workspace_id, lease_slot_key) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, attempt_id) REFERENCES rorca.governed_execution_attempts(workspace_id, attempt_id) ON DELETE RESTRICT,
  CHECK (expires_at > issued_at)
);
CREATE UNIQUE INDEX execution_leases_one_active_slot ON rorca.execution_leases(workspace_id, lease_slot_key) WHERE state='active';
CREATE TABLE rorca.execution_lease_events (
  id BIGSERIAL PRIMARY KEY, workspace_id TEXT NOT NULL, lease_id TEXT NOT NULL, fencing_token BIGINT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('acquired','renewed','released','expired','cancellation_requested','cancelled','superseded','taken_over','rejected')),
  prior_state TEXT, next_state TEXT NOT NULL, reason_code TEXT NOT NULL, event_hash TEXT NOT NULL CHECK (event_hash ~ '^sha256:[0-9a-f]{64}$'),
  database_time TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (workspace_id, lease_id) REFERENCES rorca.execution_leases(workspace_id, lease_id) ON DELETE RESTRICT
);

CREATE TABLE rorca.context_policy_definitions (
  workspace_id TEXT NOT NULL, policy_definition_id TEXT NOT NULL, policy_definition_version TEXT NOT NULL,
  policy_definition_hash TEXT NOT NULL CHECK (policy_definition_hash ~ '^sha256:[0-9a-f]{64}$'),
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('draft','validated','published','superseded','rejected','revoked')),
  body_json JSONB NOT NULL CHECK (jsonb_typeof(body_json)='object' AND octet_length(body_json::text)<=262144 AND body_json::text !~* '"(?:run|lease|generation|session|cursor|git|worktree)'),
  issuer_authority_ref TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, policy_definition_id, policy_definition_version), UNIQUE(workspace_id, policy_definition_hash),
  FOREIGN KEY (workspace_id) REFERENCES rorca.workspaces(id) ON DELETE RESTRICT
);
CREATE TABLE rorca.context_policy_activations (
  workspace_id TEXT NOT NULL, activation_id TEXT NOT NULL, activation_revision INTEGER NOT NULL CHECK (activation_revision>0),
  activation_hash TEXT NOT NULL CHECK (activation_hash ~ '^sha256:[0-9a-f]{64}$'), policy_definition_id TEXT NOT NULL,
  policy_definition_version TEXT NOT NULL, scope_key TEXT NOT NULL CHECK (scope_key ~ '^sha256:[0-9a-f]{64}$'),
  scope_json JSONB NOT NULL CHECK (jsonb_typeof(scope_json)='object' AND scope_json::text !~* 'context.?epoch|legacy.?epoch'),
  effective_values_hash TEXT NOT NULL CHECK (effective_values_hash ~ '^sha256:[0-9a-f]{64}$'), authority_receipt_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('proposed','verified','active','superseded','rejected','revoked')),
  activated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), expires_at TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, activation_id, activation_revision), UNIQUE(workspace_id, activation_hash),
  FOREIGN KEY (workspace_id, policy_definition_id, policy_definition_version) REFERENCES rorca.context_policy_definitions(workspace_id, policy_definition_id, policy_definition_version) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX context_policy_one_active_scope ON rorca.context_policy_activations(workspace_id, scope_key) WHERE state='active';

CREATE TABLE rorca.context_scope_heads (
  workspace_id TEXT NOT NULL, scope_key TEXT NOT NULL CHECK (scope_key ~ '^sha256:[0-9a-f]{64}$'),
  checkpoint_id TEXT, checkpoint_sequence BIGINT NOT NULL DEFAULT -1, runtime_sequence BIGINT NOT NULL DEFAULT -1,
  canonical_state_order BIGINT NOT NULL DEFAULT -1, state_version BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(workspace_id, scope_key)
);
CREATE TABLE rorca.context_checkpoints (
  workspace_id TEXT NOT NULL, checkpoint_id TEXT NOT NULL, scope_key TEXT NOT NULL, checkpoint_sequence BIGINT NOT NULL CHECK(checkpoint_sequence>=0),
  checkpoint_hash TEXT NOT NULL CHECK(checkpoint_hash ~ '^sha256:[0-9a-f]{64}$'), trigger_type TEXT NOT NULL,
  trigger_hash TEXT NOT NULL CHECK(trigger_hash ~ '^sha256:[0-9a-f]{64}$'), lease_id TEXT NOT NULL, fencing_token BIGINT NOT NULL,
  activation_hash TEXT NOT NULL CHECK(activation_hash ~ '^sha256:[0-9a-f]{64}$'), state TEXT NOT NULL CHECK(state IN('proposed','persisted','current','superseded','rejected')),
  payload_json JSONB NOT NULL CHECK(jsonb_typeof(payload_json)='object' AND octet_length(payload_json::text)<=262144 AND payload_json::text !~* 'context.?epoch|legacy.?epoch'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(workspace_id,checkpoint_id),
  UNIQUE(workspace_id,scope_key,checkpoint_sequence), UNIQUE(workspace_id,scope_key,trigger_hash),
  FOREIGN KEY(workspace_id,scope_key) REFERENCES rorca.context_scope_heads(workspace_id,scope_key) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,lease_id) REFERENCES rorca.execution_leases(workspace_id,lease_id) ON DELETE RESTRICT
);
CREATE TABLE rorca.context_retrieval_receipts (
  workspace_id TEXT NOT NULL, receipt_id TEXT NOT NULL, retrieval_key TEXT NOT NULL CHECK(retrieval_key ~ '^sha256:[0-9a-f]{64}$'),
  scope_key TEXT NOT NULL, checkpoint_id TEXT NOT NULL, activation_hash TEXT NOT NULL CHECK(activation_hash ~ '^sha256:[0-9a-f]{64}$'),
  required_complete BOOLEAN NOT NULL, status TEXT NOT NULL CHECK(status IN('requested','assembling','completed','degraded','failed','rejected')),
  reason_code TEXT NOT NULL, retryable BOOLEAN NOT NULL, request_hash TEXT NOT NULL CHECK(request_hash ~ '^sha256:[0-9a-f]{64}$'),
  payload_json JSONB NOT NULL CHECK(octet_length(payload_json::text)<=262144 AND payload_json::text !~* 'context.?epoch|legacy.?epoch'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), finished_at TIMESTAMPTZ,
  PRIMARY KEY(workspace_id,receipt_id), UNIQUE(workspace_id,retrieval_key),
  CHECK(status <> 'degraded' OR required_complete),
  FOREIGN KEY(workspace_id,checkpoint_id) REFERENCES rorca.context_checkpoints(workspace_id,checkpoint_id) ON DELETE RESTRICT
);
CREATE TABLE rorca.context_retrieval_sources (
  workspace_id TEXT NOT NULL, receipt_id TEXT NOT NULL, source_order INTEGER NOT NULL CHECK(source_order>=0),
  context_class TEXT NOT NULL CHECK(context_class IN('required','advisory')), source_type TEXT NOT NULL, stable_source_id TEXT NOT NULL,
  source_version TEXT NOT NULL, content_hash TEXT NOT NULL CHECK(content_hash ~ '^sha256:[0-9a-f]{64}$'), freshness TEXT NOT NULL,
  excluded BOOLEAN NOT NULL, redaction_hash TEXT NOT NULL CHECK(redaction_hash ~ '^sha256:[0-9a-f]{64}$'),
  PRIMARY KEY(workspace_id,receipt_id,source_order), UNIQUE(workspace_id,receipt_id,context_class,source_type,stable_source_id,source_version,content_hash),
  FOREIGN KEY(workspace_id,receipt_id) REFERENCES rorca.context_retrieval_receipts(workspace_id,receipt_id) ON DELETE RESTRICT
);
CREATE TABLE rorca.context_bundles (
  workspace_id TEXT NOT NULL, bundle_id TEXT NOT NULL, bundle_hash TEXT NOT NULL CHECK(bundle_hash ~ '^sha256:[0-9a-f]{64}$'),
  scope_key TEXT NOT NULL, checkpoint_id TEXT NOT NULL, receipt_id TEXT NOT NULL, required_manifest_hash TEXT NOT NULL CHECK(required_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  advisory_manifest_hash TEXT NOT NULL CHECK(advisory_manifest_hash ~ '^sha256:[0-9a-f]{64}$'), serialized_bytes INTEGER NOT NULL CHECK(serialized_bytes BETWEEN 1 AND 4194304),
  token_count INTEGER NOT NULL CHECK(token_count BETWEEN 0 AND 64000), expires_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL CHECK(state IN('assembled','verified','active','superseded','rejected','stale')),
  payload_json JSONB NOT NULL CHECK(jsonb_typeof(payload_json)='object' AND payload_json ? 'requiredContext' AND payload_json ? 'advisoryMemory' AND payload_json::text !~* 'context.?epoch|legacy.?epoch'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(workspace_id,bundle_id), UNIQUE(workspace_id,bundle_hash),
  FOREIGN KEY(workspace_id,checkpoint_id) REFERENCES rorca.context_checkpoints(workspace_id,checkpoint_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,receipt_id) REFERENCES rorca.context_retrieval_receipts(workspace_id,receipt_id) ON DELETE RESTRICT
);
CREATE TABLE rorca.context_bundle_deltas (
  workspace_id TEXT NOT NULL, delta_id TEXT NOT NULL, delta_key TEXT NOT NULL CHECK(delta_key ~ '^sha256:[0-9a-f]{64}$'),
  base_bundle_id TEXT NOT NULL, base_bundle_hash TEXT NOT NULL CHECK(base_bundle_hash ~ '^sha256:[0-9a-f]{64}$'),
  target_bundle_id TEXT NOT NULL, target_bundle_hash TEXT NOT NULL CHECK(target_bundle_hash ~ '^sha256:[0-9a-f]{64}$'),
  operations_hash TEXT NOT NULL CHECK(operations_hash ~ '^sha256:[0-9a-f]{64}$'), chain_depth INTEGER NOT NULL CHECK(chain_depth BETWEEN 1 AND 8),
  state TEXT NOT NULL CHECK(state IN('proposed','verified','applied','rejected','stale','superseded')), fallback_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(workspace_id,delta_id), UNIQUE(workspace_id,delta_key),
  FOREIGN KEY(workspace_id,base_bundle_id) REFERENCES rorca.context_bundles(workspace_id,bundle_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,target_bundle_id) REFERENCES rorca.context_bundles(workspace_id,bundle_id) ON DELETE RESTRICT
);
CREATE TABLE rorca.continuation_retry_budgets (
  workspace_id TEXT NOT NULL, continuation_key TEXT NOT NULL CHECK(continuation_key ~ '^sha256:[0-9a-f]{64}$'),
  retrieval_max INTEGER NOT NULL CHECK(retrieval_max BETWEEN 1 AND 5), retrieval_spent INTEGER NOT NULL DEFAULT 0 CHECK(retrieval_spent BETWEEN 0 AND 5),
  transport_max INTEGER NOT NULL CHECK(transport_max BETWEEN 1 AND 3), transport_spent INTEGER NOT NULL DEFAULT 0 CHECK(transport_spent BETWEEN 0 AND 3),
  in_flight_owner TEXT, retry_fence BIGINT NOT NULL DEFAULT 0, retry_expires_at TIMESTAMPTZ, next_retry_at TIMESTAMPTZ,
  permanent_conflict_count INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL CHECK(state IN('open','in_flight','backoff','closed','exhausted','quarantined')),
  reason_code TEXT NOT NULL, state_version BIGINT NOT NULL DEFAULT 1, PRIMARY KEY(workspace_id,continuation_key)
);
CREATE TABLE rorca.continuation_dispatches (
  workspace_id TEXT NOT NULL, dispatch_id TEXT NOT NULL, continuation_key TEXT NOT NULL, scope_key TEXT NOT NULL,
  lease_id TEXT NOT NULL, fencing_token BIGINT NOT NULL, checkpoint_id TEXT NOT NULL, receipt_id TEXT NOT NULL, bundle_id TEXT NOT NULL,
  activation_hash TEXT NOT NULL CHECK(activation_hash ~ '^sha256:[0-9a-f]{64}$'), rendered_payload_hash TEXT NOT NULL CHECK(rendered_payload_hash ~ '^sha256:[0-9a-f]{64}$'),
  first_verification_hash TEXT NOT NULL CHECK(first_verification_hash ~ '^sha256:[0-9a-f]{64}$'), cas_verification_hash TEXT CHECK(cas_verification_hash ~ '^sha256:[0-9a-f]{64}$'),
  authorization_expires_at TIMESTAMPTZ NOT NULL, state TEXT NOT NULL CHECK(state IN('proposed','lease_verified','authorized','dispatched','settled','rejected','expired','failed','quarantined')),
  reason_code TEXT NOT NULL, state_version BIGINT NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,dispatch_id), UNIQUE(workspace_id,continuation_key),
  FOREIGN KEY(workspace_id,lease_id) REFERENCES rorca.execution_leases(workspace_id,lease_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,checkpoint_id) REFERENCES rorca.context_checkpoints(workspace_id,checkpoint_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,receipt_id) REFERENCES rorca.context_retrieval_receipts(workspace_id,receipt_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,bundle_id) REFERENCES rorca.context_bundles(workspace_id,bundle_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,continuation_key) REFERENCES rorca.continuation_retry_budgets(workspace_id,continuation_key) ON DELETE RESTRICT
);
CREATE TABLE rorca.continuation_dispatch_consumptions (
  workspace_id TEXT NOT NULL, dispatch_id TEXT NOT NULL, continuation_key TEXT NOT NULL, consumed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  lease_verification_hash TEXT NOT NULL CHECK(lease_verification_hash ~ '^sha256:[0-9a-f]{64}$'),
  PRIMARY KEY(workspace_id,dispatch_id), UNIQUE(workspace_id,continuation_key),
  FOREIGN KEY(workspace_id,dispatch_id) REFERENCES rorca.continuation_dispatches(workspace_id,dispatch_id) ON DELETE RESTRICT
);
CREATE TABLE rorca.continuation_quarantines (
  workspace_id TEXT NOT NULL, quarantine_id TEXT NOT NULL, continuation_key TEXT NOT NULL, reason_code TEXT NOT NULL,
  evidence_hash TEXT NOT NULL CHECK(evidence_hash ~ '^sha256:[0-9a-f]{64}$'), opened_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  state TEXT NOT NULL CHECK(state IN('open','reconciled','resolved')), PRIMARY KEY(workspace_id,quarantine_id),
  UNIQUE(workspace_id,continuation_key), FOREIGN KEY(workspace_id,continuation_key) REFERENCES rorca.continuation_retry_budgets(workspace_id,continuation_key) ON DELETE RESTRICT
);

CREATE TABLE rorca.runtime_event_stream_heads (
  workspace_id TEXT NOT NULL, attempt_id TEXT NOT NULL, runtime_generation BIGINT NOT NULL,
  last_runtime_sequence BIGINT NOT NULL DEFAULT -1, last_canonical_state_order BIGINT NOT NULL DEFAULT -1,
  last_host_receipt_order BIGINT NOT NULL DEFAULT -1, state_version BIGINT NOT NULL DEFAULT 1,
  PRIMARY KEY(workspace_id,attempt_id,runtime_generation),
  FOREIGN KEY(workspace_id,attempt_id) REFERENCES rorca.governed_execution_attempts(workspace_id,attempt_id) ON DELETE RESTRICT
);
CREATE TABLE rorca.runtime_events (
  workspace_id TEXT NOT NULL, event_id TEXT NOT NULL, attempt_id TEXT NOT NULL, runtime_generation BIGINT NOT NULL,
  runtime_sequence BIGINT NOT NULL CHECK(runtime_sequence>=0), canonical_state_order BIGINT NOT NULL CHECK(canonical_state_order>=0),
  host_receipt_order BIGINT NOT NULL CHECK(host_receipt_order>=0), event_type TEXT NOT NULL, event_hash TEXT NOT NULL CHECK(event_hash ~ '^sha256:[0-9a-f]{64}$'),
  payload_hash TEXT NOT NULL CHECK(payload_hash ~ '^sha256:[0-9a-f]{64}$'), trust_class TEXT NOT NULL CHECK(trust_class IN('runtime_asserted','host_observed','automated_test','provider_verified','provider_human')),
  reason_code TEXT NOT NULL, payload_json JSONB NOT NULL CHECK(octet_length(payload_json::text)<=65536 AND payload_json::text !~* 'context.?epoch|legacy.?epoch|password|private.?key|attestation|signature|raw.?prompt|raw.?transcript'),
  observed_at TIMESTAMPTZ NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,event_id), UNIQUE(workspace_id,attempt_id,runtime_generation,runtime_sequence),
  FOREIGN KEY(workspace_id,attempt_id,runtime_generation) REFERENCES rorca.runtime_event_stream_heads(workspace_id,attempt_id,runtime_generation) ON DELETE RESTRICT
);
CREATE TABLE rorca.runtime_event_conflicts (
  id BIGSERIAL PRIMARY KEY, workspace_id TEXT NOT NULL, event_id TEXT NOT NULL, existing_hash TEXT, incoming_hash TEXT NOT NULL,
  reason_code TEXT NOT NULL, database_time TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), correlation_id TEXT NOT NULL
);

ALTER TABLE rorca.ssdlc_lifecycle_evidence
  ADD COLUMN governed_contract_id TEXT,
  ADD COLUMN governed_contract_hash TEXT,
  ADD COLUMN governed_mission_id TEXT,
  ADD COLUMN governed_work_package_id TEXT,
  ADD COLUMN governed_attempt_id TEXT,
  ADD COLUMN governed_lease_id TEXT,
  ADD COLUMN governed_fencing_token BIGINT,
  ADD COLUMN governed_activation_hash TEXT,
  ADD COLUMN governed_checkpoint_id TEXT,
  ADD COLUMN governed_repository_id TEXT,
  ADD COLUMN governed_worktree_id TEXT,
  ADD COLUMN governed_observer_id TEXT;
ALTER TABLE rorca.ssdlc_lifecycle_evidence ADD CONSTRAINT ssdlc_wave2_complete_subject_ck CHECK (
  governed_contract_id IS NULL OR (
    governed_contract_id='rorca.evidence-envelope.v1' AND governed_contract_hash ~ '^sha256:[0-9a-f]{64}$'
    AND governed_mission_id IS NOT NULL AND governed_work_package_id IS NOT NULL AND governed_attempt_id IS NOT NULL
    AND governed_lease_id IS NOT NULL AND governed_fencing_token > 0 AND governed_activation_hash ~ '^sha256:[0-9a-f]{64}$'
    AND governed_checkpoint_id IS NOT NULL AND governed_repository_id IS NOT NULL AND governed_worktree_id IS NOT NULL AND governed_observer_id IS NOT NULL
  )
);

CREATE TABLE rorca.governed_closeout_evaluations (
  workspace_id TEXT NOT NULL, evaluation_id TEXT NOT NULL, attempt_id TEXT NOT NULL, lease_id TEXT NOT NULL, fencing_token BIGINT NOT NULL,
  work_package_id TEXT NOT NULL, work_package_revision INTEGER NOT NULL, policy_activation_hash TEXT NOT NULL CHECK(policy_activation_hash ~ '^sha256:[0-9a-f]{64}$'),
  checkpoint_hash TEXT NOT NULL CHECK(checkpoint_hash ~ '^sha256:[0-9a-f]{64}$'), evidence_manifest_hash TEXT NOT NULL CHECK(evidence_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  resolver_version TEXT NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN('eligible','blocked','failed','cancelled','expired','conflicted','stale','reconciliation_required')),
  missing_evidence JSONB NOT NULL DEFAULT '[]', conflicting_evidence JSONB NOT NULL DEFAULT '[]', subject_hash TEXT NOT NULL CHECK(subject_hash ~ '^sha256:[0-9a-f]{64}$'),
  story_closeout_decision_id TEXT, decision_time TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), payload_hash TEXT NOT NULL CHECK(payload_hash ~ '^sha256:[0-9a-f]{64}$'),
  PRIMARY KEY(workspace_id,evaluation_id), UNIQUE(workspace_id,attempt_id,subject_hash),
  FOREIGN KEY(workspace_id,attempt_id) REFERENCES rorca.governed_execution_attempts(workspace_id,attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,lease_id) REFERENCES rorca.execution_leases(workspace_id,lease_id) ON DELETE RESTRICT
);
CREATE TABLE rorca.execution_cancellation_requests (
  workspace_id TEXT NOT NULL, cancellation_id TEXT NOT NULL, attempt_id TEXT NOT NULL, lease_id TEXT NOT NULL, fencing_token BIGINT NOT NULL,
  requester_authority_ref TEXT NOT NULL, reason_code TEXT NOT NULL, requested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), deadline_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL CHECK(state IN('requested','acknowledged','graceful','forced_expiry','lost_runtime','conflicted')),
  request_hash TEXT NOT NULL CHECK(request_hash ~ '^sha256:[0-9a-f]{64}$'), PRIMARY KEY(workspace_id,cancellation_id),
  FOREIGN KEY(workspace_id,attempt_id) REFERENCES rorca.governed_execution_attempts(workspace_id,attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,lease_id) REFERENCES rorca.execution_leases(workspace_id,lease_id) ON DELETE RESTRICT
);
CREATE TABLE rorca.execution_cancellation_acknowledgements (
  workspace_id TEXT NOT NULL, acknowledgement_id TEXT NOT NULL, cancellation_id TEXT NOT NULL, runtime_id TEXT NOT NULL,
  lease_id TEXT NOT NULL, fencing_token BIGINT NOT NULL, classification TEXT NOT NULL CHECK(classification IN('accepted','duplicate','late','wrong_runtime','wrong_fence','contradictory')),
  acknowledgement_hash TEXT NOT NULL CHECK(acknowledgement_hash ~ '^sha256:[0-9a-f]{64}$'), received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,acknowledgement_id), UNIQUE(workspace_id,cancellation_id,acknowledgement_hash),
  FOREIGN KEY(workspace_id,cancellation_id) REFERENCES rorca.execution_cancellation_requests(workspace_id,cancellation_id) ON DELETE RESTRICT
);
CREATE TABLE rorca.plan_change_proposals (
  workspace_id TEXT NOT NULL, proposal_id TEXT NOT NULL, mission_id TEXT NOT NULL, work_package_id TEXT NOT NULL,
  base_revision INTEGER NOT NULL, base_hash TEXT NOT NULL CHECK(base_hash ~ '^sha256:[0-9a-f]{64}$'), diff_hash TEXT NOT NULL CHECK(diff_hash ~ '^sha256:[0-9a-f]{64}$'),
  proposer_runtime_id TEXT NOT NULL, rationale TEXT NOT NULL CHECK(octet_length(rationale)<=4000), impact_hash TEXT NOT NULL CHECK(impact_hash ~ '^sha256:[0-9a-f]{64}$'),
  requested_paths_hash TEXT NOT NULL CHECK(requested_paths_hash ~ '^sha256:[0-9a-f]{64}$'), dependencies_hash TEXT NOT NULL CHECK(dependencies_hash ~ '^sha256:[0-9a-f]{64}$'),
  validation_hash TEXT NOT NULL CHECK(validation_hash ~ '^sha256:[0-9a-f]{64}$'), state TEXT NOT NULL CHECK(state IN('proposed','under_review','accepted','rejected','stale')),
  requests_merge BOOLEAN NOT NULL DEFAULT FALSE CHECK(NOT requests_merge), requests_deployment BOOLEAN NOT NULL DEFAULT FALSE CHECK(NOT requests_deployment),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(workspace_id,proposal_id),
  UNIQUE(workspace_id,work_package_id,base_revision,diff_hash)
);

CREATE TABLE rorca.mission_control_idempotency (
  workspace_id TEXT NOT NULL, principal_id TEXT NOT NULL, operation TEXT NOT NULL, idempotency_key_hash TEXT NOT NULL CHECK(idempotency_key_hash ~ '^sha256:[0-9a-f]{64}$'),
  request_hash TEXT NOT NULL CHECK(request_hash ~ '^sha256:[0-9a-f]{64}$'), subject_hash TEXT NOT NULL CHECK(subject_hash ~ '^sha256:[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK(status IN('in_flight','completed','failed','quarantined')), response_hash TEXT CHECK(response_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), completed_at TIMESTAMPTZ,
  PRIMARY KEY(workspace_id,principal_id,operation,idempotency_key_hash)
);
CREATE TABLE rorca.mission_control_replay_conflicts (
  id BIGSERIAL PRIMARY KEY, workspace_id TEXT NOT NULL, operation TEXT NOT NULL, subject_hash TEXT NOT NULL,
  existing_hash TEXT, incoming_hash TEXT NOT NULL, dimension TEXT NOT NULL, reason_code TEXT NOT NULL,
  actor_id TEXT NOT NULL, correlation_id TEXT NOT NULL, database_time TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE rorca.mission_control_audit (
  id BIGSERIAL PRIMARY KEY, workspace_id TEXT NOT NULL, operation TEXT NOT NULL, actor_id TEXT NOT NULL, authority_source TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(request_hash ~ '^sha256:[0-9a-f]{64}$'), subject_hash TEXT NOT NULL CHECK(subject_hash ~ '^sha256:[0-9a-f]{64}$'),
  decision TEXT NOT NULL, evidence_hash TEXT, result_code TEXT NOT NULL, correlation_id TEXT NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}' CHECK(octet_length(metadata_json::text)<=16384 AND metadata_json::text !~* 'password|secret|token|credential|prompt|transcript|attestation|signature'),
  database_time TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE rorca.context_epoch_projection_reads (
  id BIGSERIAL PRIMARY KEY, workspace_id TEXT NOT NULL, bundle_id TEXT NOT NULL, dispatch_id TEXT,
  server_version TEXT NOT NULL, client_version TEXT NOT NULL, outcome TEXT NOT NULL,
  database_time TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), correlation_id TEXT NOT NULL
);
CREATE TABLE rorca.context_epoch_write_rejections (
  id BIGSERIAL PRIMARY KEY, workspace_id TEXT, route_class TEXT NOT NULL, reason_code TEXT NOT NULL DEFAULT 'deprecated_context_epoch_write',
  database_time TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), correlation_id TEXT NOT NULL
);
CREATE TABLE rorca.context_contract_release_history (
  contract_version TEXT PRIMARY KEY, release_sha TEXT NOT NULL CHECK(release_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  write_current BOOLEAN NOT NULL, released_at TIMESTAMPTZ NOT NULL, contract_hash TEXT NOT NULL CHECK(contract_hash ~ '^sha256:[0-9a-f]{64}$')
);
CREATE TABLE rorca.context_epoch_client_migrations (
  client_id TEXT NOT NULL, fixture_id TEXT NOT NULL, source_hash TEXT NOT NULL CHECK(source_hash ~ '^sha256:[0-9a-f]{64}$'),
  migrated BOOLEAN NOT NULL, reviewer_receipt_id TEXT NOT NULL, observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(client_id,fixture_id)
);
CREATE TABLE rorca.context_epoch_retirement_evaluations (
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  evaluation_id TEXT NOT NULL, next_major_version TEXT NOT NULL, evaluated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  release_gate_passed BOOLEAN NOT NULL, age_gate_passed BOOLEAN NOT NULL, zero_use_gate_passed BOOLEAN NOT NULL,
  clients_gate_passed BOOLEAN NOT NULL, fixtures_gate_passed BOOLEAN NOT NULL, break_markers_gate_passed BOOLEAN NOT NULL,
  independent_review_gate_passed BOOLEAN NOT NULL, eligible BOOLEAN NOT NULL,
  packet_hash TEXT NOT NULL CHECK(packet_hash ~ '^sha256:[0-9a-f]{64}$'),
  PRIMARY KEY(workspace_id,evaluation_id),
  CHECK(eligible = (release_gate_passed AND age_gate_passed AND zero_use_gate_passed AND clients_gate_passed AND fixtures_gate_passed AND break_markers_gate_passed AND independent_review_gate_passed))
);

-- Query indexes are tied to bounded service operations and recovery scans.
CREATE INDEX governed_mission_versions_history_idx ON rorca.governed_mission_versions(workspace_id,mission_id,mission_revision DESC);
CREATE INDEX governed_work_package_revision_story_idx ON rorca.governed_work_package_revisions(workspace_id,mission_id,story_id,work_package_revision DESC);
CREATE INDEX execution_leases_recovery_idx ON rorca.execution_leases(workspace_id,state,expires_at);
CREATE INDEX context_checkpoints_scope_idx ON rorca.context_checkpoints(workspace_id,scope_key,checkpoint_sequence DESC);
CREATE INDEX context_receipts_status_idx ON rorca.context_retrieval_receipts(workspace_id,status,created_at);
CREATE INDEX context_bundles_expiry_idx ON rorca.context_bundles(workspace_id,state,expires_at);
CREATE INDEX continuation_dispatch_recovery_idx ON rorca.continuation_dispatches(workspace_id,state,authorization_expires_at);
CREATE INDEX continuation_retry_recovery_idx ON rorca.continuation_retry_budgets(workspace_id,state,next_retry_at,retry_expires_at);
CREATE INDEX runtime_events_attempt_order_idx ON rorca.runtime_events(workspace_id,attempt_id,event_type,host_receipt_order);
CREATE INDEX mission_control_audit_subject_idx ON rorca.mission_control_audit(workspace_id,subject_hash,database_time DESC);
CREATE INDEX epoch_reads_time_idx ON rorca.context_epoch_projection_reads(database_time,workspace_id);

-- All workspace records are RLS-scoped. Application-owner bypass is not treated as authority;
-- service checks, composite FKs, CAS, and immutable triggers remain mandatory.
DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'governed_missions','governed_mission_versions','governed_mission_heads','governed_work_packages',
    'governed_work_package_revisions','governed_work_package_dependencies','governed_work_package_heads',
    'governed_execution_attempts','execution_lease_slots','execution_leases','execution_lease_events',
    'context_policy_definitions','context_policy_activations','context_scope_heads','context_checkpoints',
    'context_retrieval_receipts','context_retrieval_sources','context_bundles','context_bundle_deltas',
    'continuation_retry_budgets','continuation_dispatches','continuation_dispatch_consumptions','continuation_quarantines',
    'runtime_event_stream_heads','runtime_events','runtime_event_conflicts','governed_closeout_evaluations',
    'execution_cancellation_requests','execution_cancellation_acknowledgements','plan_change_proposals',
    'mission_control_idempotency','mission_control_replay_conflicts','mission_control_audit',
    'context_epoch_projection_reads','context_epoch_write_rejections','context_epoch_retirement_evaluations'
  ] LOOP
    EXECUTE format('ALTER TABLE rorca.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON rorca.%I USING (EXISTS (SELECT 1 FROM rorca.workspace_members wm WHERE wm.workspace_id=%I.workspace_id AND wm.user_auth_id::text=COALESCE(NULLIF(current_setting(''request.jwt.claim.sub'',true),''''),(NULLIF(current_setting(''request.jwt.claims'',true),'''')::jsonb->>''sub'')))) WITH CHECK (EXISTS (SELECT 1 FROM rorca.workspace_members wm WHERE wm.workspace_id=%I.workspace_id AND wm.user_auth_id::text=COALESCE(NULLIF(current_setting(''request.jwt.claim.sub'',true),''''),(NULLIF(current_setting(''request.jwt.claims'',true),'''')::jsonb->>''sub''))))',
      'w2_workspace_member_'||table_name, table_name, table_name, table_name
    );
  END LOOP;
END;
$$;

-- Immutable payload/event/audit tables reject UPDATE, DELETE and statement TRUNCATE.
DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'governed_missions','governed_mission_versions','governed_work_packages','governed_work_package_revisions',
    'governed_work_package_dependencies','governed_execution_attempts','execution_lease_events',
    'context_policy_definitions','context_policy_activations','context_checkpoints','context_retrieval_receipts',
    'context_retrieval_sources','context_bundles','context_bundle_deltas','continuation_dispatch_consumptions',
    'continuation_quarantines','runtime_events','runtime_event_conflicts','governed_closeout_evaluations',
    'execution_cancellation_requests','execution_cancellation_acknowledgements','plan_change_proposals',
    'mission_control_replay_conflicts','mission_control_audit','context_epoch_projection_reads',
    'context_epoch_write_rejections','context_contract_release_history','context_epoch_client_migrations','context_epoch_retirement_evaluations'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON rorca.%I FOR EACH ROW EXECUTE FUNCTION rorca.w2_reject_immutable_mutation()', 'w2_immutable_'||table_name, table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON rorca.%I FOR EACH STATEMENT EXECUTE FUNCTION rorca.w2_reject_immutable_truncate()', 'w2_no_truncate_'||table_name, table_name);
  END LOOP;
END;
$$;

COMMENT ON TABLE rorca.governed_closeout_evaluations IS 'Non-authoritative closeout eligibility proposal; only existing StoryCloseoutDecision.accepted establishes story completion.';
COMMENT ON TABLE rorca.context_epoch_projection_reads IS 'Bounded telemetry only; ContextEpoch has no authority table, writer, lifecycle, current pointer, or lease role.';
COMMENT ON TABLE rorca.continuation_dispatch_consumptions IS 'One-use CAS boundary; a committed consumption may be reconciled but never sent again.';
