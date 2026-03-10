-- 040_convention_proposals.sql — Convention inference results for review

CREATE TABLE IF NOT EXISTS convention_proposals (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  proposal_json JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_convention_proposals_workspace ON convention_proposals(workspace_id, status);
