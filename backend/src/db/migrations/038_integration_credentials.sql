-- OC-014: Integration credentials table for OAuth-based provider tokens
-- Stores encrypted tokens for integrations like GitHub Copilot that use OAuth
-- rather than API keys (those go in api_key_vault).
CREATE TABLE IF NOT EXISTS integration_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,              -- e.g. 'github_copilot'
  encrypted_token TEXT NOT NULL,       -- AES-256-GCM encrypted OAuth token
  scopes TEXT DEFAULT '',              -- OAuth scopes granted
  provider_username TEXT,              -- e.g. GitHub username for display
  provider_user_id TEXT,               -- External provider user ID
  metadata TEXT DEFAULT '{}',          -- JSON blob for provider-specific data
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_integration_credentials_user_id ON integration_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_integration_credentials_provider ON integration_credentials(provider);
