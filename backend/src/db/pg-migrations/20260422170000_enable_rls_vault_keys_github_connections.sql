-- 20260422170000_enable_rls_vault_keys_github_connections.sql
-- Add workspace scoping and enable Supabase RLS for vault/api key storage and
-- GitHub OAuth connections.

ALTER TABLE api_key_vault
  ADD COLUMN IF NOT EXISTS workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE github_connections
  ADD COLUMN IF NOT EXISTS workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_api_key_vault_workspace_id
  ON api_key_vault(workspace_id);

CREATE INDEX IF NOT EXISTS idx_github_connections_workspace_id
  ON github_connections(workspace_id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM api_key_vault akv
    WHERE akv.workspace_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot enable workspace-scoped RLS on api_key_vault: found rows with NULL workspace_id. Backfill workspace_id first.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM github_connections gc
    WHERE gc.workspace_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot enable workspace-scoped RLS on github_connections: found rows with NULL workspace_id. Backfill workspace_id first.';
  END IF;
END $$;

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
