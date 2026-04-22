-- Enable Supabase Row Level Security on team collaboration tables.
--
-- Current schema note:
-- `teams` are linked to workspaces through `workspace_access`, not a direct
-- `teams.workspace_id` column. The SELECT policy therefore scopes teams to
-- workspaces returned by `get_user_workspace_ids(auth.uid())` via that join.
--
-- NOTE: FORCE ROW LEVEL SECURITY is intentionally deferred for the same reason
-- as workspaces: the pool user still owns these tables and existing Express
-- routes are not yet executing through per-user Supabase clients.

ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_invites ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION can_manage_team_membership(p_team_id TEXT, p_auth_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = rorca, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM workspace_access wa
    JOIN workspace_members wm
      ON wm.workspace_id = wa.workspace_id
    WHERE wa.team_id = p_team_id
      AND wm.user_auth_id = p_auth_id
      AND wm.role IN ('owner', 'admin')
  );
$$;

ALTER FUNCTION can_manage_team_membership(TEXT, UUID) OWNER TO postgres;

DROP POLICY IF EXISTS teams_select_workspace_members ON teams;
CREATE POLICY teams_select_workspace_members
  ON teams
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM workspace_access wa
      WHERE wa.team_id = teams.id
        AND wa.workspace_id IN (
          SELECT workspace_id
          FROM get_user_workspace_ids(auth.uid())
        )
    )
  );

DROP POLICY IF EXISTS team_members_select_same_workspace_members ON team_members;
CREATE POLICY team_members_select_same_workspace_members
  ON team_members
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM workspace_access target_wa
      JOIN workspace_access viewer_wa
        ON viewer_wa.workspace_id = target_wa.workspace_id
      WHERE target_wa.team_id = team_members.team_id
        AND viewer_wa.workspace_id IN (
          SELECT workspace_id
          FROM get_user_workspace_ids(auth.uid())
        )
    )
  );

DROP POLICY IF EXISTS team_members_insert_admin_only ON team_members;
CREATE POLICY team_members_insert_admin_only
  ON team_members
  FOR INSERT
  TO authenticated
  WITH CHECK (can_manage_team_membership(team_id, auth.uid()));

DROP POLICY IF EXISTS team_invites_select_creator_or_invitee ON team_invites;
CREATE POLICY team_invites_select_creator_or_invitee
  ON team_invites
  FOR SELECT
  TO authenticated
  USING (
    invited_by IN (
      SELECT u.id
      FROM users u
      WHERE u.auth_id = auth.uid()
    )
    OR lower(email) = lower(COALESCE(auth.jwt() ->> 'email', ''))
  );

DROP POLICY IF EXISTS team_invites_insert_admin_only ON team_invites;
CREATE POLICY team_invites_insert_admin_only
  ON team_invites
  FOR INSERT
  TO authenticated
  WITH CHECK (can_manage_team_membership(team_id, auth.uid()));
