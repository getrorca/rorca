-- 025_api_key_vault.sql — Encrypted API key vault

CREATE TABLE IF NOT EXISTS api_key_vault (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  encrypted_key TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  spend_total_usd REAL NOT NULL DEFAULT 0.0,
  last_used_at TIMESTAMPTZ,
  base_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_key_vault_user_provider ON api_key_vault(user_id, provider);
