-- Bounded REST-to-Controller command receipts, program admission, and local release review.
-- This schema contains no target-effect transport, provider submission, credential material, or IPC address.

CREATE TABLE bounty_program_admissions (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  program_id UUID NOT NULL,
  policy_revision BIGINT NOT NULL CHECK (policy_revision > 0),
  scope JSONB NOT NULL CHECK (jsonb_typeof(scope) = 'object'),
  scope_hash TEXT NOT NULL CHECK (scope_hash ~ '^sha256:[0-9a-f]{64}$'),
  actor TEXT NOT NULL,
  admitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, program_id),
  FOREIGN KEY (workspace_id, program_id) REFERENCES bounty_programs(workspace_id, id)
);

-- All REST mutations, including preview, have one durable replay identity. Request hashes
-- bind the exact validated command; receipts never contain raw evidence or credentials.
CREATE TABLE bounty_controller_api_receipts (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  program_id UUID NOT NULL,
  mission_id UUID,
  idempotency_key TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN (
    'program.admit','mission.preview','mission.launch','mission.hold','mission.hold.release',
    'mission.pause','mission.stop','mission.kill','draft.release.review'
  )),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^sha256:[0-9a-f]{64}$'),
  response JSONB NOT NULL CHECK (jsonb_typeof(response) = 'object'),
  actor TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, program_id) REFERENCES bounty_programs(workspace_id, id),
  FOREIGN KEY (workspace_id, mission_id) REFERENCES bounty_missions(workspace_id, id)
);
CREATE INDEX bounty_controller_api_receipts_program_idx
  ON bounty_controller_api_receipts(workspace_id, program_id, created_at DESC);

-- Review is a local readiness fact only. It cannot submit, publish, send, or address a provider.
CREATE TABLE bounty_draft_release_reviews (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  program_id UUID NOT NULL,
  mission_id UUID NOT NULL,
  draft_id UUID NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approve-readiness','reject')),
  bundle_hash TEXT NOT NULL CHECK (bundle_hash ~ '^sha256:[0-9a-f]{64}$'),
  reason TEXT NOT NULL,
  actor TEXT NOT NULL,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, draft_id),
  FOREIGN KEY (workspace_id, program_id) REFERENCES bounty_programs(workspace_id, id),
  FOREIGN KEY (workspace_id, mission_id) REFERENCES bounty_missions(workspace_id, id),
  FOREIGN KEY (workspace_id, draft_id) REFERENCES bounty_report_drafts(workspace_id, id)
);

CREATE TRIGGER bounty_program_admissions_immutable BEFORE UPDATE OR DELETE ON bounty_program_admissions
FOR EACH ROW EXECUTE FUNCTION bounty_reject_append_only_mutation();
CREATE TRIGGER bounty_controller_api_receipts_immutable BEFORE UPDATE OR DELETE ON bounty_controller_api_receipts
FOR EACH ROW EXECUTE FUNCTION bounty_reject_append_only_mutation();
CREATE TRIGGER bounty_draft_release_reviews_immutable BEFORE UPDATE OR DELETE ON bounty_draft_release_reviews
FOR EACH ROW EXECUTE FUNCTION bounty_reject_append_only_mutation();
