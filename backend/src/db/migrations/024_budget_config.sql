-- V2-045: Budget alerts and hard spending caps per workspace
CREATE TABLE IF NOT EXISTS budget_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  alert_threshold_usd REAL,
  hard_cap_usd REAL,
  period TEXT NOT NULL DEFAULT 'monthly' CHECK(period IN ('daily', 'weekly', 'monthly')),
  notify_emails TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_budget_config_workspace ON budget_config(workspace_id);
