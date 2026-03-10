-- 037_review_tokens.sql — Share-for-review tokens

CREATE TABLE IF NOT EXISTS review_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  spec_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_review_tokens_hash ON review_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_review_tokens_spec ON review_tokens(spec_id, workspace_id);
