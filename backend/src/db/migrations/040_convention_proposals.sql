-- CA-005: Convention proposals persistence table
-- Stores convention inference results for human review before applying
CREATE TABLE IF NOT EXISTS convention_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  proposal_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_convention_proposals_workspace ON convention_proposals(workspace_id, status);
