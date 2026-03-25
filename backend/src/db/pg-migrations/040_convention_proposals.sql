-- CA-005: Convention proposals table for convention discovery agent results
CREATE TABLE IF NOT EXISTS convention_proposals (
  id          SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  proposal_json TEXT NOT NULL,       -- JSON: { stack, architecture, conventions, fileGovernance, directionL3, skills }
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reject_reason TEXT,                -- Optional reason for rejection
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ           -- When approved/rejected
);

CREATE INDEX IF NOT EXISTS idx_convention_proposals_workspace ON convention_proposals(workspace_id, status);
