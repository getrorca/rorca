-- CAF-002: CI autofix run tracking table
-- Tracks each autofix attempt per commit SHA to implement infinite loop guard

CREATE TABLE IF NOT EXISTS ci_autofix_runs (
  id            SERIAL PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  head_sha      VARCHAR(40) NOT NULL,
  branch_name   TEXT,
  check_run_id  BIGINT,
  check_run_name TEXT,
  spec_path     TEXT NOT NULL,
  run_id        INTEGER REFERENCES pipeline_runs(id) ON DELETE SET NULL,
  annotation_count INTEGER NOT NULL DEFAULT 0,
  agent_type    TEXT NOT NULL DEFAULT 'claude',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for the infinite loop guard: COUNT(*) WHERE head_sha = $1 AND workspace_id = $2
CREATE INDEX IF NOT EXISTS idx_ci_autofix_runs_sha_ws
  ON ci_autofix_runs (workspace_id, head_sha);
