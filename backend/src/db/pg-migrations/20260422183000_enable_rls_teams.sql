-- 20260422183000_enable_rls_teams.sql
-- Adds workspace scoping to teams and enables Supabase RLS for teams,
-- team_members, and team_invites.

ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE;

UPDATE teams t
SET workspace_id = wa.workspace_id
FROM workspace_access wa
WHERE wa.team_id = t.id
  AND t.workspace_id IS NULL;

ALTER TABLE teams
  ALTER COLUMN workspace_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_teams_workspace_id ON teams(workspace_id);

CREATE OR REPLACE FUNCTION is_workspace_team_admin(p_team_id TEXT, p_auth_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = rorca, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM teams t
    JOIN team_members tm ON tm.team_id = t.id
    JOIN users u ON u.id = tm.user_id
    WHERE t.id = p_team_id
      AND u.auth_id = p_auth_id
      AND tm.role IN ('admin')
  )
  OR EXISTS (
    SELECT 1
    FROM teams t
    JOIN users u ON u.id = t.owner_id
    WHERE t.id = p_team_id
      AND u.auth_id = p_auth_id
  );
$$;



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
    is_workspace_team_admin(team_id, auth.uid())
  );

ALTER TABLE team_invites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS team_invites_select_inviter_or_email_match ON team_invites;
CREATE POLICY team_invites_select_inviter_or_email_match
  ON team_invites
  FOR SELECT
  TO authenticated
  USING (
    invited_by IN (
      SELECT u.id
      FROM users u
      WHERE u.auth_id = auth.uid()
    )
    OR lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );

DROP POLICY IF EXISTS team_invites_insert_workspace_admin ON team_invites;
CREATE POLICY team_invites_insert_workspace_admin
  ON team_invites
  FOR INSERT
  TO authenticated
  WITH CHECK (
    is_workspace_team_admin(team_id, auth.uid())
  );
