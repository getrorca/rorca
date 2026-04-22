-- 20260422140000_enable_rls_direction_layers_wal_events.sql
-- Enable Supabase Row Level Security on rorca.direction_layers and rorca.wal_events.
--
-- direction_layers has a mixed visibility model:
--   - Global L1/L2 rows use workspace_id IS NULL and remain readable by all authenticated users.
--   - Workspace-scoped layers are limited to rows whose workspace_id is in get_user_workspace_ids(auth.uid()).
--   - Global mutations are admin-only.
--
-- wal_events are workspace-scoped and limited to the caller's workspace memberships.
--
-- NOTE: FORCE ROW LEVEL SECURITY is intentionally deferred.
-- The `rorca` pool user currently owns these tables and bypasses RLS as the owner.
-- Forcing RLS now would break existing pool-based routes that have not yet been
-- migrated to per-user Supabase clients / JWT-propagated sessions.

CREATE OR REPLACE FUNCTION is_admin(p_auth_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = rorca, public
AS $$
DECLARE
  v_is_admin BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM users u
    WHERE u.auth_id = p_auth_id
      AND u.role = 'admin'
  ) INTO v_is_admin;

  RETURN COALESCE(v_is_admin, FALSE);
END;
$$;

ALTER FUNCTION is_admin(UUID) OWNER TO postgres;

ALTER TABLE direction_layers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS direction_layers_select_global_or_workspace ON direction_layers;
CREATE POLICY direction_layers_select_global_or_workspace
  ON direction_layers
  FOR SELECT
  TO authenticated
  USING (
    workspace_id IS NULL
    OR workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );

DROP POLICY IF EXISTS direction_layers_insert_workspace_or_admin_global ON direction_layers;
CREATE POLICY direction_layers_insert_workspace_or_admin_global
  ON direction_layers
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (
      workspace_id IS NOT NULL
      AND workspace_id IN (
        SELECT workspace_id
        FROM get_user_workspace_ids(auth.uid())
      )
    )
    OR (
      workspace_id IS NULL
      AND is_admin(auth.uid())
    )
  );

DROP POLICY IF EXISTS direction_layers_update_workspace_or_admin_global ON direction_layers;
CREATE POLICY direction_layers_update_workspace_or_admin_global
  ON direction_layers
  FOR UPDATE
  TO authenticated
  USING (
    (
      workspace_id IS NOT NULL
      AND workspace_id IN (
        SELECT workspace_id
        FROM get_user_workspace_ids(auth.uid())
      )
    )
    OR (
      workspace_id IS NULL
      AND is_admin(auth.uid())
    )
  )
  WITH CHECK (
    (
      workspace_id IS NOT NULL
      AND workspace_id IN (
        SELECT workspace_id
        FROM get_user_workspace_ids(auth.uid())
      )
    )
    OR (
      workspace_id IS NULL
      AND is_admin(auth.uid())
    )
  );

DROP POLICY IF EXISTS direction_layers_delete_workspace_or_admin_global ON direction_layers;
CREATE POLICY direction_layers_delete_workspace_or_admin_global
  ON direction_layers
  FOR DELETE
  TO authenticated
  USING (
    (
      workspace_id IS NOT NULL
      AND workspace_id IN (
        SELECT workspace_id
        FROM get_user_workspace_ids(auth.uid())
      )
    )
    OR (
      workspace_id IS NULL
      AND is_admin(auth.uid())
    )
  );

ALTER TABLE wal_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wal_events_select_workspace_member ON wal_events;
CREATE POLICY wal_events_select_workspace_member
  ON wal_events
  FOR SELECT
  TO authenticated
  USING (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );

DROP POLICY IF EXISTS wal_events_insert_workspace_member ON wal_events;
CREATE POLICY wal_events_insert_workspace_member
  ON wal_events
  FOR INSERT
  TO authenticated
  WITH CHECK (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );
