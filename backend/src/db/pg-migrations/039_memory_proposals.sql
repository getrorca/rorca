-- 039_memory_proposals.sql — Memory synthesis proposals

CREATE TABLE IF NOT EXISTS memory_proposals (
  id SERIAL PRIMARY KEY,
  proposal_id TEXT NOT NULL UNIQUE,
  run_id INTEGER NOT NULL REFERENCES pipeline_runs(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  rule TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  source_story TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'dismissed')),
  proposed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_memory_proposals_workspace ON memory_proposals(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_memory_proposals_run ON memory_proposals(run_id);
