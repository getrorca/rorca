-- 20260316130000_integration_tokens.sql — Workspace-scoped OAuth integration tokens
-- Stores encrypted OAuth access/refresh tokens, API keys, and webhook secrets
-- for GitHub, Linear, Vercel, Slack integrations per workspace.

CREATE TABLE IF NOT EXISTS integration_tokens (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'linear', 'vercel', 'slack')),
  token_type TEXT NOT NULL CHECK (token_type IN ('oauth_access', 'oauth_refresh', 'api_key', 'webhook_secret')),
  encrypted_token TEXT NOT NULL,
  scopes TEXT[] DEFAULT '{}',
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  last_validated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(workspace_id, provider, token_type)
);

CREATE INDEX IF NOT EXISTS idx_integration_tokens_workspace ON integration_tokens(workspace_id);
CREATE INDEX IF NOT EXISTS idx_integration_tokens_provider ON integration_tokens(workspace_id, provider);
