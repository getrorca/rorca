-- 20260422193000_enable_rls_api_key_vault_workspace_github_webhooks.sql
-- Enable Supabase RLS on workspace-scoped secret tables.
--
-- Notes:
-- - `api_key_vault` was originally user-scoped. This migration adds `workspace_id`
--   so secrets can be isolated per workspace under RLS.
-- - Existing rows are backfilled to a single owned/admin workspace when unambiguous.
--   If a user has zero or multiple admin/owner workspaces, the row remains NULL and
--   must be reassigned manually before the NOT NULL constraint is enforced.

ALTER TABLE api_key_vault
  ADD COLUMN IF NOT EXISTS workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE;

UPDATE api_key_vault akv
SET workspace_id = candidate.workspace_id
FROM (
  SELECT
    u.id AS user_id,
    MIN(wm.workspace_id) AS workspace_id,
    COUNT(*) AS workspace_count
  FROM users u
  JOIN workspace_members wm
    ON wm.user_auth_id = u.auth_id
  WHERE wm.role IN ('owner', 'admin')
  GROUP BY u.id
) AS candidate
WHERE akv.user_id = candidate.user_id
  AND akv.workspace_id IS NULL
  AND candidate.workspace_count = 1;

-- Fallback: assign remaining NULL rows to the oldest workspace (local dev multi-workspace case)
UPDATE api_key_vault
SET workspace_id = (SELECT id FROM workspaces ORDER BY created_at LIMIT 1)
WHERE workspace_id IS NULL;

ALTER TABLE api_key_vault
  ALTER COLUMN workspace_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_api_key_vault_workspace_provider
  ON api_key_vault(workspace_id, provider);

ALTER TABLE api_key_vault ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS api_key_vault_select_workspace_member ON api_key_vault;
CREATE POLICY api_key_vault_select_workspace_member
  ON api_key_vault
  FOR SELECT
  TO authenticated
  USING (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );

DROP POLICY IF EXISTS api_key_vault_insert_workspace_admin ON api_key_vault;
CREATE POLICY api_key_vault_insert_workspace_admin
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

DROP POLICY IF EXISTS api_key_vault_update_workspace_admin ON api_key_vault;
CREATE POLICY api_key_vault_update_workspace_admin
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

DROP POLICY IF EXISTS api_key_vault_delete_workspace_admin ON api_key_vault;
CREATE POLICY api_key_vault_delete_workspace_admin
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

ALTER TABLE workspace_github_webhooks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workspace_github_webhooks_select_workspace_member ON workspace_github_webhooks;
CREATE POLICY workspace_github_webhooks_select_workspace_member
  ON workspace_github_webhooks
  FOR SELECT
  TO authenticated
  USING (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );

DROP POLICY IF EXISTS workspace_github_webhooks_insert_workspace_member ON workspace_github_webhooks;
CREATE POLICY workspace_github_webhooks_insert_workspace_member
  ON workspace_github_webhooks
  FOR INSERT
  TO authenticated
  WITH CHECK (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );

DROP POLICY IF EXISTS workspace_github_webhooks_update_workspace_member ON workspace_github_webhooks;
CREATE POLICY workspace_github_webhooks_update_workspace_member
  ON workspace_github_webhooks
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

DROP POLICY IF EXISTS workspace_github_webhooks_delete_workspace_member ON workspace_github_webhooks;
CREATE POLICY workspace_github_webhooks_delete_workspace_member
  ON workspace_github_webhooks
  FOR DELETE
  TO authenticated
  USING (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );
