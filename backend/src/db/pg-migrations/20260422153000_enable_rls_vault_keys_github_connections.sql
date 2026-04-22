-- 20260422153000_enable_rls_vault_keys_github_connections.sql
-- Enable workspace-scoped RLS for encrypted API keys and GitHub connections.

ALTER TABLE api_key_vault
  ADD COLUMN IF NOT EXISTS workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_api_key_vault_workspace_id
  ON api_key_vault(workspace_id);

ALTER TABLE github_connections
  ADD COLUMN IF NOT EXISTS workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_github_connections_workspace_id
  ON github_connections(workspace_id);

ALTER TABLE api_key_vault ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vault_keys_select_workspace_member ON api_key_vault;
CREATE POLICY vault_keys_select_workspace_member
  ON api_key_vault
  FOR SELECT
  TO authenticated
  USING (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );

DROP POLICY IF EXISTS vault_keys_insert_workspace_admin ON api_key_vault;
CREATE POLICY vault_keys_insert_workspace_admin
  ON api_key_vault
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM workspace_members wm
      WHERE wm.workspace_id = api_key_vault.workspace_id
        AND wm.user_auth_id = auth.uid()
        AND wm.role IN ('owner', 'admin')
    )
  );

DROP POLICY IF EXISTS vault_keys_update_workspace_admin ON api_key_vault;
CREATE POLICY vault_keys_update_workspace_admin
  ON api_key_vault
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM workspace_members wm
      WHERE wm.workspace_id = api_key_vault.workspace_id
        AND wm.user_auth_id = auth.uid()
        AND wm.role IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM workspace_members wm
      WHERE wm.workspace_id = api_key_vault.workspace_id
        AND wm.user_auth_id = auth.uid()
        AND wm.role IN ('owner', 'admin')
    )
  );

DROP POLICY IF EXISTS vault_keys_delete_workspace_admin ON api_key_vault;
CREATE POLICY vault_keys_delete_workspace_admin
  ON api_key_vault
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM workspace_members wm
      WHERE wm.workspace_id = api_key_vault.workspace_id
        AND wm.user_auth_id = auth.uid()
        AND wm.role IN ('owner', 'admin')
    )
  );

ALTER TABLE github_connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS github_connections_workspace_member_all ON github_connections;
CREATE POLICY github_connections_workspace_member_all
  ON github_connections
  FOR ALL
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
