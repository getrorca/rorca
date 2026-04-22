-- 20260422143000_enable_rls_vault_keys_github_connections.sql
-- Enable Supabase RLS for workspace-scoped secrets and GitHub OAuth connections.
-- Depends on 20260422120000_add_auth_id_and_workspace_members.sql for
-- get_user_workspace_ids(auth.uid()) and workspace_members.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = 'vault_keys'::regclass
      AND attname = 'workspace_id'
      AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'vault_keys.workspace_id is required before enabling RLS';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = 'github_connections'::regclass
      AND attname = 'workspace_id'
      AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'github_connections.workspace_id is required before enabling RLS';
  END IF;
END $$;

ALTER TABLE vault_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vault_keys_select_workspace_member ON vault_keys;
CREATE POLICY vault_keys_select_workspace_member
  ON vault_keys
  FOR SELECT
  TO authenticated
  USING (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );

DROP POLICY IF EXISTS vault_keys_insert_workspace_admin ON vault_keys;
CREATE POLICY vault_keys_insert_workspace_admin
  ON vault_keys
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM workspace_members wm
      WHERE wm.workspace_id = vault_keys.workspace_id
        AND wm.user_auth_id = auth.uid()
        AND wm.role IN ('owner', 'admin')
    )
  );

DROP POLICY IF EXISTS vault_keys_update_workspace_admin ON vault_keys;
CREATE POLICY vault_keys_update_workspace_admin
  ON vault_keys
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM workspace_members wm
      WHERE wm.workspace_id = vault_keys.workspace_id
        AND wm.user_auth_id = auth.uid()
        AND wm.role IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM workspace_members wm
      WHERE wm.workspace_id = vault_keys.workspace_id
        AND wm.user_auth_id = auth.uid()
        AND wm.role IN ('owner', 'admin')
    )
  );

DROP POLICY IF EXISTS vault_keys_delete_workspace_admin ON vault_keys;
CREATE POLICY vault_keys_delete_workspace_admin
  ON vault_keys
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM workspace_members wm
      WHERE wm.workspace_id = vault_keys.workspace_id
        AND wm.user_auth_id = auth.uid()
        AND wm.role IN ('owner', 'admin')
    )
  );

ALTER TABLE github_connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS github_connections_select_workspace_member ON github_connections;
CREATE POLICY github_connections_select_workspace_member
  ON github_connections
  FOR SELECT
  TO authenticated
  USING (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );

DROP POLICY IF EXISTS github_connections_insert_workspace_member ON github_connections;
CREATE POLICY github_connections_insert_workspace_member
  ON github_connections
  FOR INSERT
  TO authenticated
  WITH CHECK (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );

DROP POLICY IF EXISTS github_connections_update_workspace_member ON github_connections;
CREATE POLICY github_connections_update_workspace_member
  ON github_connections
  FOR UPDATE
  TO authenticated
  USING (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  )
  WITH CHECK (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );

DROP POLICY IF EXISTS github_connections_delete_workspace_member ON github_connections;
CREATE POLICY github_connections_delete_workspace_member
  ON github_connections
  FOR DELETE
  TO authenticated
  USING (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );
