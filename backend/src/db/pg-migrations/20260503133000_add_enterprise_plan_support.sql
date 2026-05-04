-- 20260503133000_add_enterprise_plan_support.sql
--
-- Extend plan validation to recognize enterprise while preserving legacy solo.
-- This keeps billing/license flows compatible and allows route-tier plan gating
-- to honor enterprise licenses and user records.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_plan_check' AND conrelid = 'users'::regclass
  ) THEN
    ALTER TABLE users DROP CONSTRAINT users_plan_check;
  END IF;

  ALTER TABLE users ADD CONSTRAINT users_plan_check
    CHECK (plan IN ('free', 'solo', 'pro', 'team', 'enterprise'));
END$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'subscriptions_plan_check' AND conrelid = 'subscriptions'::regclass
  ) THEN
    ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_plan_check;
  END IF;

  ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_plan_check
    CHECK (plan IN ('free', 'solo', 'pro', 'team', 'enterprise'));
END$$;

UPDATE users SET plan = 'free' WHERE plan IS NULL OR plan NOT IN ('free', 'solo', 'pro', 'team', 'enterprise');
UPDATE subscriptions SET plan = 'free' WHERE plan IS NULL OR plan NOT IN ('free', 'solo', 'pro', 'team', 'enterprise');

INSERT INTO plan_quotas (plan_name, feature, quota_limit) VALUES
  ('enterprise', 'specs_per_month', -1),
  ('enterprise', 'workspaces', -1),
  ('enterprise', 'marketplace_publish', -1),
  ('enterprise', 'exa_search', -1),
  ('enterprise', 'team_members', -1),
  ('enterprise', 'pipeline_execution', -1)
ON CONFLICT (plan_name, feature) DO NOTHING;
