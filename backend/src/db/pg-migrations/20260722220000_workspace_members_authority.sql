-- Canonical workspace membership authority required by Release-1 RLS policies.
-- This table must exist before 20260723150000_release_one_core_rls.sql on every
-- fresh PostgreSQL installation; prior environments supplied it out of band.

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_auth_id UUID NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (workspace_id, user_auth_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_members_user_auth_id
  ON workspace_members (user_auth_id, workspace_id);

-- RLS policies execute as the authenticated request role. Grant only the table
-- capabilities those policies expose; service/owner connections retain their
-- existing authority and pg-boss remains untouched.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    GRANT USAGE ON SCHEMA rorca TO authenticated;
    GRANT SELECT ON workspace_members, users, teams, team_members TO authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON team_invites TO authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON workspaces, direction_layers, api_key_vault TO authenticated;
    GRANT SELECT, INSERT ON wal_events TO authenticated;
  END IF;
END $$;
