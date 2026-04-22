-- 20260422170000_enable_rls_teams.sql
-- Enable Supabase Row Level Security for team collaboration tables.
--
-- This migration adds the missing workspace scoping column to `teams` so the
-- requested policies can be expressed directly and consistently with the rest
-- of the workspace-scoped RLS rollout.

ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_teams_workspace_id ON teams(workspace_id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'rorca'
      AND table_name = 'teams'
      AND column_name = 'workspace_id'
  ) THEN
    UPDATE teams t
    SET workspace_id = wa.workspace_id
    FROM workspace_access wa
    WHERE wa.team_id = t.id
      AND t.workspace_id IS NULL;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION can_manage_team_membership(p_auth_id UUID, p_team_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = rorca, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM team_members tm
    JOIN users u ON u.id = tm.user_id
    WHERE tm.team_id = p_team_id
      AND u.auth_id = p_auth_id
      AND tm.role = 'admin'
  );
$$;

ALTER FUNCTION can_manage_team_membership(UUID, TEXT) OWNER TO postgres;

ALTER TABLE teams ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS teams_select_workspace_member ON teams;
CREATE POLICY teams_select_workspace_member
  ON teams
  FOR SELECT
  TO authenticated
  USING (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );

ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS team_members_select_same_workspace_member ON team_members;
CREATE POLICY team_members_select_same_workspace_member
  ON team_members
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM teams t
      WHERE t.id = team_members.team_id
        AND t.workspace_id IN (
          SELECT workspace_id
          FROM get_user_workspace_ids(auth.uid())
        )
    )
  );

DROP POLICY IF EXISTS team_members_insert_workspace_admin ON team_members;
CREATE POLICY team_members_insert_workspace_admin
  ON team_members
  FOR INSERT
  TO authenticated
  WITH CHECK (
    can_manage_team_membership(auth.uid(), team_id)
  );

ALTER TABLE team_invites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS team_invites_select_creator_or_invitee ON team_invites;
CREATE POLICY team_invites_select_creator_or_invitee
  ON team_invites
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM users u
      WHERE u.id = team_invites.invited_by
        AND u.auth_id = auth.uid()
    )
    OR lower(team_invites.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );

DROP POLICY IF EXISTS team_invites_insert_workspace_admin ON team_invites;
CREATE POLICY team_invites_insert_workspace_admin
  ON team_invites
  FOR INSERT
  TO authenticated
  WITH CHECK (
    can_manage_team_membership(auth.uid(), team_id)
    AND EXISTS (
      SELECT 1
      FROM users u
      WHERE u.id = team_invites.invited_by
        AND u.auth_id = auth.uid()
    )
  );
