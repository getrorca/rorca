-- Enable Supabase Row Level Security on user-scoped tables.
--
-- Notes:
-- - Current schema uses `user_id` on these tables, not `user_auth_id`.
--   Policies therefore resolve auth ownership through `users.auth_id`.
-- - Policies are created only when the target table exists and use
--   DROP POLICY IF EXISTS for idempotent re-runs.
-- - Service-role access is intentionally not restricted here; backend access is
--   expected to use a role with BYPASSRLS/service semantics in Supabase.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'rorca'
      AND table_name = 'user_settings'
  ) THEN
    EXECUTE 'ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY';

    EXECUTE 'DROP POLICY IF EXISTS user_settings_select_own ON user_settings';
    EXECUTE $policy$
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
        )
    $policy$;

    EXECUTE 'DROP POLICY IF EXISTS user_settings_insert_own ON user_settings';
    EXECUTE $policy$
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
        )
    $policy$;

    EXECUTE 'DROP POLICY IF EXISTS user_settings_update_own ON user_settings';
    EXECUTE $policy$
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
        )
    $policy$;

    EXECUTE 'DROP POLICY IF EXISTS user_settings_delete_own ON user_settings';
    EXECUTE $policy$
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
        )
    $policy$;
  END IF;
END $$;


DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'rorca'
      AND table_name = 'notification_subscriptions'
  ) THEN
    EXECUTE 'ALTER TABLE notification_subscriptions ENABLE ROW LEVEL SECURITY';

    EXECUTE 'DROP POLICY IF EXISTS notification_subscriptions_select_scoped ON notification_subscriptions';
    EXECUTE $policy$
      CREATE POLICY notification_subscriptions_select_scoped
        ON notification_subscriptions
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

    EXECUTE 'DROP POLICY IF EXISTS notification_subscriptions_insert_scoped ON notification_subscriptions';
    EXECUTE $policy$
      CREATE POLICY notification_subscriptions_insert_scoped
        ON notification_subscriptions
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

    EXECUTE 'DROP POLICY IF EXISTS notification_subscriptions_update_scoped ON notification_subscriptions';
    EXECUTE $policy$
      CREATE POLICY notification_subscriptions_update_scoped
        ON notification_subscriptions
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

    EXECUTE 'DROP POLICY IF EXISTS notification_subscriptions_delete_scoped ON notification_subscriptions';
    EXECUTE $policy$
      CREATE POLICY notification_subscriptions_delete_scoped
        ON notification_subscriptions
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
  END IF;
END $$;


DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'rorca'
      AND table_name = 'notification_history'
  ) THEN
    EXECUTE 'ALTER TABLE notification_history ENABLE ROW LEVEL SECURITY';

    EXECUTE 'DROP POLICY IF EXISTS notification_history_select_own ON notification_history';
    EXECUTE $policy$
      CREATE POLICY notification_history_select_own
        ON notification_history
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

    EXECUTE 'DROP POLICY IF EXISTS notification_history_insert_own ON notification_history';
    EXECUTE $policy$
      CREATE POLICY notification_history_insert_own
        ON notification_history
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

    EXECUTE 'DROP POLICY IF EXISTS notification_history_update_own ON notification_history';
    EXECUTE $policy$
      CREATE POLICY notification_history_update_own
        ON notification_history
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

    EXECUTE 'DROP POLICY IF EXISTS notification_history_delete_own ON notification_history';
    EXECUTE $policy$
      CREATE POLICY notification_history_delete_own
        ON notification_history
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


DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'rorca'
      AND table_name = 'subscriptions'
  ) THEN
    EXECUTE 'ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY';

    EXECUTE 'DROP POLICY IF EXISTS subscriptions_select_scoped ON subscriptions';
    EXECUTE $policy$
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
        )
    $policy$;

    EXECUTE 'DROP POLICY IF EXISTS subscriptions_insert_scoped ON subscriptions';
    EXECUTE $policy$
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
        )
    $policy$;

    EXECUTE 'DROP POLICY IF EXISTS subscriptions_update_scoped ON subscriptions';
    EXECUTE $policy$
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
        )
    $policy$;

    EXECUTE 'DROP POLICY IF EXISTS subscriptions_delete_scoped ON subscriptions';
    EXECUTE $policy$
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
        )
    $policy$;
  END IF;
END $$;
