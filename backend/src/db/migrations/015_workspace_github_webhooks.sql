CREATE TABLE IF NOT EXISTS workspace_github_webhooks (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  webhook_id INTEGER,
  encrypted_webhook_secret TEXT NOT NULL,
  last_webhook_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
