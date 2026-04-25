-- 20260425052000_enable_rls_provider_defaults_openrouter_prefs.sql
-- Harden provider defaults and OpenRouter provider prefs.
--
-- Design notes:
-- - `provider_defaults` is user + workspace scoped. Members may read their own default,
--   but only workspace admins/owners may write it from the app layer.
-- - `openrouter_provider_prefs` now supports optional workspace overrides:
--   * workspace_id IS NULL => global default, readable by authenticated users,
--     writable only by platform admins via is_admin(auth.uid())
--   * workspace_id IS NOT NULL => workspace override, readable by members,
--     writable by workspace admins/owners
--
-- NOTE: FORCE ROW LEVEL SECURITY is intentionally deferred.

SET search_path TO rorca, public;

ALTER TABLE provider_defaults ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS provider_defaults_select_owner ON provider_defaults;
CREATE POLICY provider_defaults_select_owner
  ON provider_defaults
  FOR SELECT
  TO authenticated
  USING (
    user_id IN (
      SELECT u.id
      FROM users u
      WHERE u.auth_id = auth.uid()
    )
    AND workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );

DROP POLICY IF EXISTS provider_defaults_insert_workspace_admin ON provider_defaults;
CREATE POLICY provider_defaults_insert_workspace_admin
  ON provider_defaults
  FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id IN (
      SELECT u.id
      FROM users u
      WHERE u.auth_id = auth.uid()
    )
    AND EXISTS (
      SELECT 1
      FROM workspace_members wm
      WHERE wm.workspace_id = provider_defaults.workspace_id
        AND wm.user_auth_id = auth.uid()
        AND wm.role IN ('owner', 'admin')
    )
  );

DROP POLICY IF EXISTS provider_defaults_update_workspace_admin ON provider_defaults;
CREATE POLICY provider_defaults_update_workspace_admin
  ON provider_defaults
  FOR UPDATE
  TO authenticated
  USING (
    user_id IN (
      SELECT u.id
      FROM users u
      WHERE u.auth_id = auth.uid()
    )
    AND EXISTS (
      SELECT 1
      FROM workspace_members wm
      WHERE wm.workspace_id = provider_defaults.workspace_id
        AND wm.user_auth_id = auth.uid()
        AND wm.role IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    user_id IN (
      SELECT u.id
      FROM users u
      WHERE u.auth_id = auth.uid()
    )
    AND EXISTS (
      SELECT 1
      FROM workspace_members wm
      WHERE wm.workspace_id = provider_defaults.workspace_id
        AND wm.user_auth_id = auth.uid()
        AND wm.role IN ('owner', 'admin')
    )
  );

DROP POLICY IF EXISTS provider_defaults_delete_workspace_admin ON provider_defaults;
CREATE POLICY provider_defaults_delete_workspace_admin
  ON provider_defaults
  FOR DELETE
  TO authenticated
  USING (
    user_id IN (
      SELECT u.id
      FROM users u
      WHERE u.auth_id = auth.uid()
    )
    AND EXISTS (
      SELECT 1
      FROM workspace_members wm
      WHERE wm.workspace_id = provider_defaults.workspace_id
        AND wm.user_auth_id = auth.uid()
        AND wm.role IN ('owner', 'admin')
    )
  );

ALTER TABLE openrouter_provider_prefs
  ADD COLUMN IF NOT EXISTS workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE openrouter_provider_prefs
  DROP CONSTRAINT IF EXISTS openrouter_provider_prefs_model_id_key;

DROP INDEX IF EXISTS idx_or_provider_prefs_model;
CREATE INDEX IF NOT EXISTS idx_or_provider_prefs_workspace_model
  ON openrouter_provider_prefs (workspace_id, model_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_or_provider_prefs_global_model
  ON openrouter_provider_prefs (model_id)
  WHERE workspace_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_or_provider_prefs_workspace_model_unique
  ON openrouter_provider_prefs (workspace_id, model_id)
  WHERE workspace_id IS NOT NULL;

ALTER TABLE openrouter_provider_prefs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS openrouter_provider_prefs_select_scope ON openrouter_provider_prefs;
CREATE POLICY openrouter_provider_prefs_select_scope
  ON openrouter_provider_prefs
  FOR SELECT
  TO authenticated
  USING (
    workspace_id IS NULL
    OR workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );

DROP POLICY IF EXISTS openrouter_provider_prefs_insert_scope ON openrouter_provider_prefs;
CREATE POLICY openrouter_provider_prefs_insert_scope
  ON openrouter_provider_prefs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (workspace_id IS NULL AND is_admin(auth.uid()))
    OR EXISTS (
      SELECT 1
      FROM workspace_members wm
      WHERE wm.workspace_id = openrouter_provider_prefs.workspace_id
        AND wm.user_auth_id = auth.uid()
        AND wm.role IN ('owner', 'admin')
    )
  );

DROP POLICY IF EXISTS openrouter_provider_prefs_update_scope ON openrouter_provider_prefs;
CREATE POLICY openrouter_provider_prefs_update_scope
  ON openrouter_provider_prefs
  FOR UPDATE
  TO authenticated
  USING (
    (workspace_id IS NULL AND is_admin(auth.uid()))
    OR EXISTS (
      SELECT 1
      FROM workspace_members wm
      WHERE wm.workspace_id = openrouter_provider_prefs.workspace_id
        AND wm.user_auth_id = auth.uid()
        AND wm.role IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    (workspace_id IS NULL AND is_admin(auth.uid()))
    OR EXISTS (
      SELECT 1
      FROM workspace_members wm
      WHERE wm.workspace_id = openrouter_provider_prefs.workspace_id
        AND wm.user_auth_id = auth.uid()
        AND wm.role IN ('owner', 'admin')
    )
  );

DROP POLICY IF EXISTS openrouter_provider_prefs_delete_scope ON openrouter_provider_prefs;
CREATE POLICY openrouter_provider_prefs_delete_scope
  ON openrouter_provider_prefs
  FOR DELETE
  TO authenticated
  USING (
    (workspace_id IS NULL AND is_admin(auth.uid()))
    OR EXISTS (
      SELECT 1
      FROM workspace_members wm
      WHERE wm.workspace_id = openrouter_provider_prefs.workspace_id
        AND wm.user_auth_id = auth.uid()
        AND wm.role IN ('owner', 'admin')
    )
  );

SET search_path TO public;
