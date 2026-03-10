-- 015_workspace_github_webhooks.sql — GitHub webhook configs per workspace

CREATE TABLE IF NOT EXISTS workspace_github_webhooks (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  webhook_id INTEGER,
  encrypted_webhook_secret TEXT NOT NULL,
  last_webhook_at TIMESTAMPTZ,
  auto_pr_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  auto_pr_target_branch TEXT NOT NULL DEFAULT 'main',
  auto_pr_reviewers JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
