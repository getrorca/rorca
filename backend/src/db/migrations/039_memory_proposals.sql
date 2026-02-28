-- CIE-014: Memory proposals persistence table
-- Stores synthesis proposals for review/dismiss/return-later flow
CREATE TABLE IF NOT EXISTS memory_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id TEXT NOT NULL UNIQUE,
  run_id INTEGER NOT NULL REFERENCES pipeline_runs(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  rule TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  source_story TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'dismissed')),
  proposed_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_memory_proposals_workspace ON memory_proposals(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_memory_proposals_run ON memory_proposals(run_id);
