-- 20260422170000_enable_rls_direction_layers_wal_events.sql
-- Enable Supabase Row Level Security on direction_layers and wal_events.
--
-- Design notes:
-- - `direction_layers` has a mixed scope model:
--   * L1/L2 global layers use `workspace_id IS NULL` and remain readable to all
--     authenticated users.
--   * L3+ workspace layers use `workspace_id` and are readable/writable only by
--     members of that workspace.
-- - Global layer mutation is restricted to admins via `is_admin(auth.uid())`.
-- - `wal_events` is treated as workspace-scoped for user-facing access. Any
--   legacy/system rows with `workspace_id IS NULL` become invisible to
--   authenticated users under RLS, which is the intended isolation boundary.
--
-- NOTE: FORCE ROW LEVEL SECURITY is intentionally deferred.
-- The application pool/service role currently relies on owner/bypass semantics
-- for internal backend writes until all routes are migrated to per-user clients.

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
  )
  INTO v_is_admin;

  RETURN COALESCE(v_is_admin, FALSE);
END;
$$;




ALTER TABLE direction_layers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS direction_layers_select_global_or_workspace_member ON direction_layers;
CREATE POLICY direction_layers_select_global_or_workspace_member
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

DROP POLICY IF EXISTS direction_layers_insert_workspace_member_or_admin_global ON direction_layers;
CREATE POLICY direction_layers_insert_workspace_member_or_admin_global
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

DROP POLICY IF EXISTS direction_layers_update_workspace_member_or_admin_global ON direction_layers;
CREATE POLICY direction_layers_update_workspace_member_or_admin_global
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

DROP POLICY IF EXISTS direction_layers_delete_workspace_member_or_admin_global ON direction_layers;
CREATE POLICY direction_layers_delete_workspace_member_or_admin_global
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
