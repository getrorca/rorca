-- 022_token_usage.sql — Token usage analytics

CREATE TABLE IF NOT EXISTS token_usage (
  id SERIAL PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES pipeline_runs(id),
  story_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT,
  model TEXT NOT NULL DEFAULT 'unknown',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_token_usage_run ON token_usage(run_id);
CREATE INDEX IF NOT EXISTS idx_token_usage_workspace ON token_usage(workspace_id);
CREATE INDEX IF NOT EXISTS idx_token_usage_recorded ON token_usage(recorded_at);
CREATE INDEX IF NOT EXISTS idx_token_usage_model ON token_usage(model);
