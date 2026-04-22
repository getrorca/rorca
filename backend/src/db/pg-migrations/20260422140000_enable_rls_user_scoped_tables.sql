-- Enable Supabase Row Level Security for user-scoped tables.
--
-- NOTE:
-- These tables still reference local users(id) via `user_id`; Supabase auth identity
-- is linked through users.auth_id. Policies therefore compare `auth.uid()` against
-- a matching users.auth_id row, rather than a direct table UUID column.
--
-- NOTE:
-- FORCE ROW LEVEL SECURITY is intentionally deferred. The backend pool role still
-- needs owner/service-style access while route migration to per-user Supabase clients
-- is in progress.

ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_settings_select_own ON user_settings;
CREATE POLICY user_settings_select_own
  ON user_settings
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM users u
      WHERE u.id = user_settings.user_id
        AND u.auth_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS user_settings_insert_own ON user_settings;
CREATE POLICY user_settings_insert_own
  ON user_settings
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM users u
      WHERE u.id = user_settings.user_id
        AND u.auth_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS user_settings_update_own ON user_settings;
CREATE POLICY user_settings_update_own
  ON user_settings
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM users u
      WHERE u.id = user_settings.user_id
        AND u.auth_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM users u
      WHERE u.id = user_settings.user_id
        AND u.auth_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS user_settings_delete_own ON user_settings;
CREATE POLICY user_settings_delete_own
  ON user_settings
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM users u
      WHERE u.id = user_settings.user_id
        AND u.auth_id = auth.uid()
    )
  );

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notification_preferences_select_scoped ON notification_preferences;
CREATE POLICY notification_preferences_select_scoped
  ON notification_preferences
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM users u
      WHERE u.id = notification_preferences.user_id
        AND u.auth_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS notification_preferences_insert_scoped ON notification_preferences;
CREATE POLICY notification_preferences_insert_scoped
  ON notification_preferences
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM users u
      WHERE u.id = notification_preferences.user_id
        AND u.auth_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS notification_preferences_update_scoped ON notification_preferences;
CREATE POLICY notification_preferences_update_scoped
  ON notification_preferences
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM users u
      WHERE u.id = notification_preferences.user_id
        AND u.auth_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM users u
      WHERE u.id = notification_preferences.user_id
        AND u.auth_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS notification_preferences_delete_scoped ON notification_preferences;
CREATE POLICY notification_preferences_delete_scoped
  ON notification_preferences
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM users u
      WHERE u.id = notification_preferences.user_id
        AND u.auth_id = auth.uid()
    )
  );

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notifications_select_own ON notifications;
CREATE POLICY notifications_select_own
  ON notifications
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM users u
      WHERE u.id = notifications.user_id
        AND u.auth_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS notifications_insert_own ON notifications;
CREATE POLICY notifications_insert_own
  ON notifications
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM users u
      WHERE u.id = notifications.user_id
        AND u.auth_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS notifications_update_own ON notifications;
CREATE POLICY notifications_update_own
  ON notifications
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM users u
      WHERE u.id = notifications.user_id
        AND u.auth_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM users u
      WHERE u.id = notifications.user_id
        AND u.auth_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS notifications_delete_own ON notifications;
CREATE POLICY notifications_delete_own
  ON notifications
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM users u
      WHERE u.id = notifications.user_id
        AND u.auth_id = auth.uid()
    )
  );

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS subscriptions_select_own ON subscriptions;
CREATE POLICY subscriptions_select_own
  ON subscriptions
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM users u
      WHERE u.id = subscriptions.user_id
        AND u.auth_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS subscriptions_insert_own ON subscriptions;
CREATE POLICY subscriptions_insert_own
  ON subscriptions
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM users u
      WHERE u.id = subscriptions.user_id
        AND u.auth_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS subscriptions_update_own ON subscriptions;
CREATE POLICY subscriptions_update_own
  ON subscriptions
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM users u
      WHERE u.id = subscriptions.user_id
        AND u.auth_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM users u
      WHERE u.id = subscriptions.user_id
        AND u.auth_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS subscriptions_delete_own ON subscriptions;
CREATE POLICY subscriptions_delete_own
  ON subscriptions
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM users u
      WHERE u.id = subscriptions.user_id
        AND u.auth_id = auth.uid()
    )
  );
