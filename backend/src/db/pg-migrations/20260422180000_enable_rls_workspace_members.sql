-- 20260422180000_enable_rls_workspace_members.sql
-- Enable RLS on workspace_members and seed owner memberships for existing workspaces.

ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workspace_members_select_member ON workspace_members;
CREATE POLICY workspace_members_select_member
  ON workspace_members
  FOR SELECT
  TO authenticated
  USING (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );

DROP POLICY IF EXISTS workspace_members_insert_owner_admin ON workspace_members;
CREATE POLICY workspace_members_insert_owner_admin
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
    OR NOT EXISTS (
      SELECT 1
      FROM workspace_members wm_existing
      WHERE wm_existing.workspace_id = workspace_members.workspace_id
    )
  );

DROP POLICY IF EXISTS workspace_members_delete_owner_admin ON workspace_members;
CREATE POLICY workspace_members_delete_owner_admin
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
SELECT w.id, u.supabase_id, 'owner'
FROM workspaces w
JOIN users u ON u.email = 'admin@rorca.local'
WHERE u.supabase_id IS NOT NULL
ON CONFLICT (workspace_id, user_auth_id) DO NOTHING;
