-- CA-005: Convention proposals table for convention discovery agent results
CREATE TABLE IF NOT EXISTS convention_proposals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  proposal_json TEXT NOT NULL,       -- JSON: { stack, architecture, conventions, fileGovernance, directionL3, skills }
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reject_reason TEXT,                -- Optional reason for rejection
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT                   -- When approved/rejected
);

CREATE INDEX IF NOT EXISTS idx_convention_proposals_workspace ON convention_proposals(workspace_id, status);
