-- 008_github_connections.sql — GitHub OAuth connections

CREATE TABLE IF NOT EXISTS github_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  github_user_id TEXT NOT NULL,
  encrypted_token TEXT NOT NULL,
  scopes TEXT NOT NULL,
  github_username TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_github_connections_user_id ON github_connections(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_github_connections_github_user_id ON github_connections(github_user_id);
