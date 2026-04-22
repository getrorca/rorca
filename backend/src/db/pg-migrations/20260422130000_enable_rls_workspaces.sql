-- 20260422130000_enable_rls_workspaces.sql
-- Enable Supabase Row Level Security on rorca.workspaces using the
-- SECURITY DEFINER helper added in 20260422120000_add_auth_id_and_workspace_members.sql.
--
-- NOTE: FORCE ROW LEVEL SECURITY is intentionally deferred.
-- The `rorca` pool user currently owns this table and bypasses RLS as the owner.
-- Forcing RLS now would break existing pool-based routes that have not yet been
-- migrated to per-user Supabase clients. A dedicated hardening story will add
-- FORCE RLS after the route migration to `withUserClient()` is complete.

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workspace_select_own ON workspaces;
CREATE POLICY workspace_select_own
  ON workspaces
  FOR SELECT
  TO authenticated
  USING (
    id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );

DROP POLICY IF EXISTS workspace_insert_authenticated ON workspaces;
CREATE POLICY workspace_insert_authenticated
  ON workspaces
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS workspace_update_admin ON workspaces;
CREATE POLICY workspace_update_admin
  ON workspaces
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM workspace_members wm
      WHERE wm.workspace_id = workspaces.id
        AND wm.user_auth_id = auth.uid()
        AND wm.role IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM workspace_members wm
      WHERE wm.workspace_id = workspaces.id
        AND wm.user_auth_id = auth.uid()
        AND wm.role IN ('owner', 'admin')
    )
  );

DROP POLICY IF EXISTS workspace_delete_owner ON workspaces;
CREATE POLICY workspace_delete_owner
  ON workspaces
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM workspace_members wm
      WHERE wm.workspace_id = workspaces.id
        AND wm.user_auth_id = auth.uid()
        AND wm.role = 'owner'
    )
  );
