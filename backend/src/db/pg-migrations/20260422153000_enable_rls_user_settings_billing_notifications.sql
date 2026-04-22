-- 20260422153000_enable_rls_user_settings_billing_notifications.sql
-- Enable Supabase Row Level Security on user-scoped settings/notification tables
-- and billing/subscription data. These policies intentionally use direct user
-- ownership checks where possible, and workspace membership checks for
-- workspace-scoped rows.
--
-- Notes:
-- - `user_settings` is keyed by legacy `user_id TEXT`, so the policy resolves
--   Supabase `auth.uid()` through `users.auth_id`.
-- - `notification_subscriptions`, `notification_history`, and `billing` are
--   created conditionally because some deployments may not yet have these
--   tables. This keeps the migration safe and idempotent across environments.
-- - Service-role/backend access continues to rely on role bypass/owner semantics;
--   this migration does not force RLS.

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


DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
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
          OR (
            workspace_id IS NOT NULL
            AND workspace_id IN (
              SELECT workspace_id
              FROM get_user_workspace_ids(auth.uid())
            )
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
          OR (
            workspace_id IS NOT NULL
            AND workspace_id IN (
              SELECT workspace_id
              FROM get_user_workspace_ids(auth.uid())
            )
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
          OR (
            workspace_id IS NOT NULL
            AND workspace_id IN (
              SELECT workspace_id
              FROM get_user_workspace_ids(auth.uid())
            )
          )
        )
        WITH CHECK (
          user_id IN (
            SELECT u.id
            FROM users u
            WHERE u.auth_id = auth.uid()
          )
          OR (
            workspace_id IS NOT NULL
            AND workspace_id IN (
              SELECT workspace_id
              FROM get_user_workspace_ids(auth.uid())
            )
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
          OR (
            workspace_id IS NOT NULL
            AND workspace_id IN (
              SELECT workspace_id
              FROM get_user_workspace_ids(auth.uid())
            )
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
    WHERE table_schema = 'public'
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
    WHERE table_schema = 'public'
      AND table_name = 'billing'
  ) THEN
    EXECUTE 'ALTER TABLE billing ENABLE ROW LEVEL SECURITY';

    EXECUTE 'DROP POLICY IF EXISTS billing_select_scoped ON billing';
    EXECUTE $policy$
      CREATE POLICY billing_select_scoped
        ON billing
        FOR SELECT
        TO authenticated
        USING (
          (
            user_id IS NOT NULL
            AND user_id IN (
              SELECT u.id
              FROM users u
              WHERE u.auth_id = auth.uid()
            )
          )
          OR (
            workspace_id IS NOT NULL
            AND workspace_id IN (
              SELECT workspace_id
              FROM get_user_workspace_ids(auth.uid())
            )
          )
        )
    $policy$;

    EXECUTE 'DROP POLICY IF EXISTS billing_insert_scoped ON billing';
    EXECUTE $policy$
      CREATE POLICY billing_insert_scoped
        ON billing
        FOR INSERT
        TO authenticated
        WITH CHECK (
          (
            user_id IS NOT NULL
            AND user_id IN (
              SELECT u.id
              FROM users u
              WHERE u.auth_id = auth.uid()
            )
          )
          OR (
            workspace_id IS NOT NULL
            AND workspace_id IN (
              SELECT workspace_id
              FROM get_user_workspace_ids(auth.uid())
            )
          )
        )
    $policy$;

    EXECUTE 'DROP POLICY IF EXISTS billing_update_scoped ON billing';
    EXECUTE $policy$
      CREATE POLICY billing_update_scoped
        ON billing
        FOR UPDATE
        TO authenticated
        USING (
          (
            user_id IS NOT NULL
            AND user_id IN (
              SELECT u.id
              FROM users u
              WHERE u.auth_id = auth.uid()
            )
          )
          OR (
            workspace_id IS NOT NULL
            AND workspace_id IN (
              SELECT workspace_id
              FROM get_user_workspace_ids(auth.uid())
            )
          )
        )
        WITH CHECK (
          (
            user_id IS NOT NULL
            AND user_id IN (
              SELECT u.id
              FROM users u
              WHERE u.auth_id = auth.uid()
            )
          )
          OR (
            workspace_id IS NOT NULL
            AND workspace_id IN (
              SELECT workspace_id
              FROM get_user_workspace_ids(auth.uid())
            )
          )
        )
    $policy$;

    EXECUTE 'DROP POLICY IF EXISTS billing_delete_scoped ON billing';
    EXECUTE $policy$
      CREATE POLICY billing_delete_scoped
        ON billing
        FOR DELETE
        TO authenticated
        USING (
          (
            user_id IS NOT NULL
            AND user_id IN (
              SELECT u.id
              FROM users u
              WHERE u.auth_id = auth.uid()
            )
          )
          OR (
            workspace_id IS NOT NULL
            AND workspace_id IN (
              SELECT workspace_id
              FROM get_user_workspace_ids(auth.uid())
            )
          )
        )
    $policy$;
  END IF;
END $$;
