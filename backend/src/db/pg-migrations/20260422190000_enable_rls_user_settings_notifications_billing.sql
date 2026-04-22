-- 20260422190000_enable_rls_user_settings_notifications_billing.sql
-- Enable Supabase Row Level Security on user-scoped settings/notifications/billing tables.
--
-- Notes:
-- - This migration follows the current schema in this branch:
--     * `user_settings` (not `user_settings.user_auth_id`) stores `user_id`
--     * `notifications` / `notification_preferences` are the current notification tables
--       corresponding to notification history / subscriptions behavior
--     * `subscriptions` is the current billing table
-- - Policies bridge from auth UID -> app user row via `users.auth_id`.
-- - Workspace-aware notification preferences additionally allow access for authenticated
--   members of the same workspace when a `workspace_id` column exists in that deployment.
--   The column is optional in this branch, so those policies are created conditionally.

ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_settings_select_own ON user_settings;
CREATE POLICY user_settings_select_own
  ON user_settings
  FOR SELECT
  TO authenticated
  USING (
    user_id IN (
      SELECT u.id
      FROM users u
      WHERE u.auth_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS user_settings_insert_own ON user_settings;
CREATE POLICY user_settings_insert_own
  ON user_settings
  FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id IN (
      SELECT u.id
      FROM users u
      WHERE u.auth_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS user_settings_update_own ON user_settings;
CREATE POLICY user_settings_update_own
  ON user_settings
  FOR UPDATE
  TO authenticated
  USING (
    user_id IN (
      SELECT u.id
      FROM users u
      WHERE u.auth_id = auth.uid()
    )
  )
  WITH CHECK (
    user_id IN (
      SELECT u.id
      FROM users u
      WHERE u.auth_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS user_settings_delete_own ON user_settings;
CREATE POLICY user_settings_delete_own
  ON user_settings
  FOR DELETE
  TO authenticated
  USING (
    user_id IN (
      SELECT u.id
      FROM users u
      WHERE u.auth_id = auth.uid()
    )
  );


ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notifications_select_own ON notifications;
CREATE POLICY notifications_select_own
  ON notifications
  FOR SELECT
  TO authenticated
  USING (
    user_id IN (
      SELECT u.id
      FROM users u
      WHERE u.auth_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS notifications_insert_own ON notifications;
CREATE POLICY notifications_insert_own
  ON notifications
  FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id IN (
      SELECT u.id
      FROM users u
      WHERE u.auth_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS notifications_update_own ON notifications;
CREATE POLICY notifications_update_own
  ON notifications
  FOR UPDATE
  TO authenticated
  USING (
    user_id IN (
      SELECT u.id
      FROM users u
      WHERE u.auth_id = auth.uid()
    )
  )
  WITH CHECK (
    user_id IN (
      SELECT u.id
      FROM users u
      WHERE u.auth_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS notifications_delete_own ON notifications;
CREATE POLICY notifications_delete_own
  ON notifications
  FOR DELETE
  TO authenticated
  USING (
    user_id IN (
      SELECT u.id
      FROM users u
      WHERE u.auth_id = auth.uid()
    )
  );


ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notification_preferences_select_scoped ON notification_preferences;
DROP POLICY IF EXISTS notification_preferences_insert_scoped ON notification_preferences;
DROP POLICY IF EXISTS notification_preferences_update_scoped ON notification_preferences;
DROP POLICY IF EXISTS notification_preferences_delete_scoped ON notification_preferences;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'rorca'
      AND table_name = 'notification_preferences'
      AND column_name = 'workspace_id'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY notification_preferences_select_scoped
        ON notification_preferences
        FOR SELECT
        TO authenticated
        USING (
          user_id IN (
            SELECT u.id
            FROM users u
            WHERE u.auth_id = auth.uid()
          )
          OR workspace_id IN (
            SELECT workspace_id
            FROM get_user_workspace_ids(auth.uid())
          )
        )
    $policy$;

    EXECUTE $policy$
      CREATE POLICY notification_preferences_insert_scoped
        ON notification_preferences
        FOR INSERT
        TO authenticated
        WITH CHECK (
          user_id IN (
            SELECT u.id
            FROM users u
            WHERE u.auth_id = auth.uid()
          )
          OR workspace_id IN (
            SELECT workspace_id
            FROM get_user_workspace_ids(auth.uid())
          )
        )
    $policy$;

    EXECUTE $policy$
      CREATE POLICY notification_preferences_update_scoped
        ON notification_preferences
        FOR UPDATE
        TO authenticated
        USING (
          user_id IN (
            SELECT u.id
            FROM users u
            WHERE u.auth_id = auth.uid()
          )
          OR workspace_id IN (
            SELECT workspace_id
            FROM get_user_workspace_ids(auth.uid())
          )
        )
        WITH CHECK (
          user_id IN (
            SELECT u.id
            FROM users u
            WHERE u.auth_id = auth.uid()
          )
          OR workspace_id IN (
            SELECT workspace_id
            FROM get_user_workspace_ids(auth.uid())
          )
        )
    $policy$;

    EXECUTE $policy$
      CREATE POLICY notification_preferences_delete_scoped
        ON notification_preferences
        FOR DELETE
        TO authenticated
        USING (
          user_id IN (
            SELECT u.id
            FROM users u
            WHERE u.auth_id = auth.uid()
          )
          OR workspace_id IN (
            SELECT workspace_id
            FROM get_user_workspace_ids(auth.uid())
          )
        )
    $policy$;
  ELSE
    EXECUTE $policy$
      CREATE POLICY notification_preferences_select_scoped
        ON notification_preferences
        FOR SELECT
        TO authenticated
        USING (
          user_id IN (
            SELECT u.id
            FROM users u
            WHERE u.auth_id = auth.uid()
          )
        )
    $policy$;

    EXECUTE $policy$
      CREATE POLICY notification_preferences_insert_scoped
        ON notification_preferences
        FOR INSERT
        TO authenticated
        WITH CHECK (
          user_id IN (
            SELECT u.id
            FROM users u
            WHERE u.auth_id = auth.uid()
          )
        )
    $policy$;

    EXECUTE $policy$
      CREATE POLICY notification_preferences_update_scoped
        ON notification_preferences
        FOR UPDATE
        TO authenticated
        USING (
          user_id IN (
            SELECT u.id
            FROM users u
            WHERE u.auth_id = auth.uid()
          )
        )
        WITH CHECK (
          user_id IN (
            SELECT u.id
            FROM users u
            WHERE u.auth_id = auth.uid()
          )
        )
    $policy$;

    EXECUTE $policy$
      CREATE POLICY notification_preferences_delete_scoped
        ON notification_preferences
        FOR DELETE
        TO authenticated
        USING (
          user_id IN (
            SELECT u.id
            FROM users u
            WHERE u.auth_id = auth.uid()
          )
        )
    $policy$;
  END IF;
END $$;


ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS subscriptions_select_scoped ON subscriptions;
CREATE POLICY subscriptions_select_scoped
  ON subscriptions
  FOR SELECT
  TO authenticated
  USING (
    user_id IN (
      SELECT u.id
      FROM users u
      WHERE u.auth_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS subscriptions_insert_scoped ON subscriptions;
CREATE POLICY subscriptions_insert_scoped
  ON subscriptions
  FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id IN (
      SELECT u.id
      FROM users u
      WHERE u.auth_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS subscriptions_update_scoped ON subscriptions;
CREATE POLICY subscriptions_update_scoped
  ON subscriptions
  FOR UPDATE
  TO authenticated
  USING (
    user_id IN (
      SELECT u.id
      FROM users u
      WHERE u.auth_id = auth.uid()
    )
  )
  WITH CHECK (
    user_id IN (
      SELECT u.id
      FROM users u
      WHERE u.auth_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS subscriptions_delete_scoped ON subscriptions;
CREATE POLICY subscriptions_delete_scoped
  ON subscriptions
  FOR DELETE
  TO authenticated
  USING (
    user_id IN (
      SELECT u.id
      FROM users u
      WHERE u.auth_id = auth.uid()
    )
  );
