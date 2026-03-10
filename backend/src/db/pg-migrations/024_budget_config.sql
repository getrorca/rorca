-- 024_budget_config.sql — Budget alerts and hard spending caps

CREATE TABLE IF NOT EXISTS budget_config (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  alert_threshold_usd REAL,
  hard_cap_usd REAL,
  period TEXT NOT NULL DEFAULT 'monthly' CHECK(period IN ('daily', 'weekly', 'monthly')),
  notify_emails JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_budget_config_workspace ON budget_config(workspace_id);
