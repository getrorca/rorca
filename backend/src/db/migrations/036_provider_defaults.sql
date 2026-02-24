-- V2-117: Provider defaults per workspace
-- Stores the user's default provider choice per workspace
CREATE TABLE IF NOT EXISTS provider_defaults (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL, -- claude-cli | anthropic | openai-compat | openrouter
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_defaults_user_ws
  ON provider_defaults (user_id, workspace_id);
