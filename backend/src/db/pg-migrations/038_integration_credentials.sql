-- 038_integration_credentials.sql — OAuth-based provider tokens

CREATE TABLE IF NOT EXISTS integration_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  encrypted_token TEXT NOT NULL,
  scopes TEXT DEFAULT '',
  provider_username TEXT,
  provider_user_id TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_integration_credentials_user_id ON integration_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_integration_credentials_provider ON integration_credentials(provider);
