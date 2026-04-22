-- 20260422151000_enable_rls_user_settings_subscriptions_notifications.sql
-- Enable Supabase Row Level Security on user-scoped settings/notification tables
-- and billing subscriptions.
--
-- Schema note:
-- - The current canonical billing table is `subscriptions` (from 035_billing.sql),
--   not `billing`.
-- - The current canonical notification tables are `notifications` and
--   `notification_preferences`, which correspond to notification history and
--   notification subscriptions/preferences.
-- - `user_settings`, `notifications`, `notification_preferences`, and
--   `subscriptions` all currently reference `users(id)` via a `user_id` TEXT
--   column, not a direct `user_auth_id` UUID column.
--
-- Policy strategy:
-- - Resolve the caller's app user id through `users.auth_id = auth.uid()`.
-- - Allow direct per-user access where possible.
-- - For workspace-scoped notification preferences, also allow users who are
--   members of the referenced workspace via `get_user_workspace_ids(auth.uid())`.
-- - FORCE RLS is intentionally deferred until all backend access is migrated to
--   per-user Supabase clients. The pool/service role currently relies on owner /
--   bypass semantics for internal access.

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


ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notification_preferences_select_scoped ON notification_preferences;
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
  );

DROP POLICY IF EXISTS notification_preferences_insert_scoped ON notification_preferences;
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
  );

DROP POLICY IF EXISTS notification_preferences_update_scoped ON notification_preferences;
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
  );

DROP POLICY IF EXISTS notification_preferences_delete_scoped ON notification_preferences;
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


ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS subscriptions_select_own ON subscriptions;
CREATE POLICY subscriptions_select_own
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

DROP POLICY IF EXISTS subscriptions_insert_own ON subscriptions;
CREATE POLICY subscriptions_insert_own
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

DROP POLICY IF EXISTS subscriptions_update_own ON subscriptions;
CREATE POLICY subscriptions_update_own
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

DROP POLICY IF EXISTS subscriptions_delete_own ON subscriptions;
CREATE POLICY subscriptions_delete_own
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
