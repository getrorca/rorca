-- Immutable assignments and proposal-only outputs for the separate bwrap bounty lane.
-- Workers never connect to this database; trusted lane/controller code owns these rows.

ALTER TABLE bounty_application_outbox DROP CONSTRAINT bounty_outbox_fixed_queue;
ALTER TABLE bounty_application_outbox
  ADD CONSTRAINT bounty_outbox_fixed_queue CHECK (queue_name IN (
    'bounty:control','bounty:work','bounty:reconcile','bounty:isolated-proposal'
  )),
  ADD CONSTRAINT bounty_isolated_outbox_complete CHECK (
    queue_name <> 'bounty:isolated-proposal' OR
    (work_package_id IS NOT NULL AND package_hash IS NOT NULL AND contract_revision IS NOT NULL AND mission_epoch IS NOT NULL)
  );

ALTER TABLE bounty_attempts
  ADD CONSTRAINT bounty_attempts_runtime_lineage UNIQUE (workspace_id, id, work_package_id);

CREATE TABLE bounty_worker_runtime_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  mission_id UUID NOT NULL,
  work_package_id UUID NOT NULL,
  attempt_id UUID NOT NULL,
  route_package_hash TEXT NOT NULL CHECK (route_package_hash ~ '^sha256:[0-9a-f]{64}$'),
  immutable_payload_hash TEXT NOT NULL CHECK (immutable_payload_hash ~ '^sha256:[0-9a-f]{64}$'),
  runtime_policy_hash TEXT NOT NULL CHECK (runtime_policy_hash ~ '^sha256:[0-9a-f]{64}$'),
  worker_executable_hash TEXT NOT NULL CHECK (worker_executable_hash ~ '^sha256:[0-9a-f]{64}$'),
  target_broker_socket_identity TEXT NOT NULL CHECK (target_broker_socket_identity ~ '^sha256:[0-9a-f]{64}$'),
  provider_policy_hash TEXT NOT NULL CHECK (provider_policy_hash ~ '^sha256:[0-9a-f]{64}$'),
  provider_exact_origin_hash TEXT NOT NULL CHECK (provider_exact_origin_hash ~ '^sha256:[0-9a-f]{64}$'),
  proposal_schema_hash TEXT NOT NULL CHECK (proposal_schema_hash ~ '^sha256:[0-9a-f]{64}$'),
  context_nonce UUID NOT NULL,
  authority_epoch BIGINT NOT NULL CHECK (authority_epoch > 0),
  capability_expires_at TIMESTAMPTZ NOT NULL,
  assignment_body JSONB NOT NULL CHECK (jsonb_typeof(assignment_body) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, mission_id, work_package_id, attempt_id),
  UNIQUE (workspace_id, attempt_id),
  UNIQUE (context_nonce),
  FOREIGN KEY (workspace_id, mission_id) REFERENCES bounty_missions(workspace_id, id),
  FOREIGN KEY (workspace_id, work_package_id) REFERENCES bounty_work_packages(workspace_id, id),
  FOREIGN KEY (workspace_id, attempt_id, work_package_id) REFERENCES bounty_attempts(workspace_id, id, work_package_id)
);

CREATE TABLE bounty_worker_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  mission_id UUID NOT NULL,
  work_package_id UUID NOT NULL,
  attempt_id UUID NOT NULL,
  assignment_id UUID NOT NULL,
  immutable_payload_hash TEXT NOT NULL CHECK (immutable_payload_hash ~ '^sha256:[0-9a-f]{64}$'),
  proposal_hash TEXT NOT NULL CHECK (proposal_hash ~ '^sha256:[0-9a-f]{64}$'),
  disposition TEXT NOT NULL DEFAULT 'proposal-only' CHECK (disposition = 'proposal-only'),
  authority_effect TEXT NOT NULL DEFAULT 'none' CHECK (authority_effect = 'none'),
  evidence_admission BOOLEAN NOT NULL DEFAULT FALSE CHECK (evidence_admission = FALSE),
  finding_admission BOOLEAN NOT NULL DEFAULT FALSE CHECK (finding_admission = FALSE),
  proposal_body JSONB NOT NULL CHECK (
    jsonb_typeof(proposal_body) = 'object'
    AND proposal_body->>'disposition' = 'proposal-only'
    AND proposal_body->>'authorityEffect' = 'none'
    AND proposal_body->'evidenceAdmission' = 'false'::jsonb
    AND proposal_body->'findingAdmission' = 'false'::jsonb
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, attempt_id),
  UNIQUE (proposal_hash),
  FOREIGN KEY (workspace_id, mission_id) REFERENCES bounty_missions(workspace_id, id),
  FOREIGN KEY (workspace_id, work_package_id) REFERENCES bounty_work_packages(workspace_id, id),
  FOREIGN KEY (workspace_id, attempt_id) REFERENCES bounty_attempts(workspace_id, id),
  FOREIGN KEY (workspace_id, assignment_id, mission_id, work_package_id, attempt_id)
    REFERENCES bounty_worker_runtime_assignments(workspace_id, id, mission_id, work_package_id, attempt_id)
);

CREATE FUNCTION bounty_reject_worker_runtime_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable proposals/assignments', TG_TABLE_NAME USING ERRCODE = '55000';
END $$;
CREATE TRIGGER bounty_worker_runtime_assignments_immutable BEFORE UPDATE OR DELETE ON bounty_worker_runtime_assignments
FOR EACH ROW EXECUTE FUNCTION bounty_reject_worker_runtime_mutation();
CREATE TRIGGER bounty_worker_proposals_immutable BEFORE UPDATE OR DELETE ON bounty_worker_proposals
FOR EACH ROW EXECUTE FUNCTION bounty_reject_worker_runtime_mutation();

CREATE INDEX bounty_worker_assignment_dispatch_idx ON bounty_worker_runtime_assignments(workspace_id, mission_id, work_package_id, created_at);
