-- 20260422160000_enable_rls_workspace_members.sql
-- Enable RLS on workspace_members and backfill owner membership for existing
-- workspaces so get_user_workspace_ids(auth.uid()) returns memberships.

ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workspace_members_select_workspace_member ON workspace_members;
CREATE POLICY workspace_members_select_workspace_member
  ON workspace_members
  FOR SELECT
  TO authenticated
  USING (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );

DROP POLICY IF EXISTS workspace_members_insert_workspace_admin ON workspace_members;
CREATE POLICY workspace_members_insert_workspace_admin
  ON workspace_members
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM workspace_members wm
      WHERE wm.workspace_id = workspace_members.workspace_id
        AND wm.user_auth_id = auth.uid()
        AND wm.role IN ('owner', 'admin')
    )
    OR (
      user_auth_id = auth.uid()
      AND role = 'owner'
      AND NOT EXISTS (
        SELECT 1
        FROM workspace_members wm
        WHERE wm.workspace_id = workspace_members.workspace_id
      )
    )
  );

DROP POLICY IF EXISTS workspace_members_delete_workspace_admin ON workspace_members;
CREATE POLICY workspace_members_delete_workspace_admin
  ON workspace_members
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM workspace_members wm
      WHERE wm.workspace_id = workspace_members.workspace_id
        AND wm.user_auth_id = auth.uid()
        AND wm.role IN ('owner', 'admin')
    )
  );

INSERT INTO workspace_members (workspace_id, user_auth_id, role)
SELECT w.id, admin_user.auth_id, 'owner'
FROM workspaces w
CROSS JOIN LATERAL (
  SELECT u.auth_id
  FROM users u
  WHERE u.email = 'admin@rorca.local'
    AND u.auth_id IS NOT NULL
  LIMIT 1
) AS admin_user
ON CONFLICT (workspace_id, user_auth_id) DO NOTHING;
