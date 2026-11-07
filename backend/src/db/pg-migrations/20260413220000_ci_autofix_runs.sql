-- CAF-003: CI autofix run tracking table + workspace config columns
-- Tracks each autofix attempt per commit SHA for audit trail and loop guard

CREATE TABLE IF NOT EXISTS ci_autofix_runs (
  id               SERIAL PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  head_sha         VARCHAR(40) NOT NULL,
  branch_name      VARCHAR(255) NOT NULL,
  check_run_id     BIGINT NOT NULL,
  check_run_name   VARCHAR(255) NOT NULL DEFAULT '',
  spec_path        TEXT NOT NULL,
  run_id           INTEGER REFERENCES pipeline_runs(id),
  annotation_count INTEGER NOT NULL DEFAULT 0,
  agent_type       VARCHAR(20) NOT NULL DEFAULT 'claude',
  status           VARCHAR(20) NOT NULL DEFAULT 'triggered'
    CHECK (status IN ('triggered', 'completed', 'failed', 'skipped')),
  error_summary    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ci_autofix_runs_workspace_sha
  ON ci_autofix_runs (workspace_id, head_sha);

-- Workspace-level CI autofix configuration
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS ci_autofix_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS ci_autofix_check_patterns JSONB DEFAULT NULL;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS ci_autofix_max_retries INTEGER NOT NULL DEFAULT 2;
