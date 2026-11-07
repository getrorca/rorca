-- Create the tenant membership authority required by Release-1 RLS policies.
-- Identity and role authority remain pre-provisioned; this migration owns only
-- the application table and refuses to weaken its foreign-key constraints.

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_auth_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, user_auth_id)
);
