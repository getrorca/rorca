-- 20260316100000_add_plan_check_constraint_to_users.sql
--
-- Migration 007 created users.plan as TEXT DEFAULT 'free' without a CHECK constraint.
-- This migration adds the constraint to enforce valid plan values and adds the
-- pipeline_execution feature to plan_quotas for the requirePlan() middleware.

-- Add CHECK constraint on users.plan (idempotent via naming + DO NOTHING pattern)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_plan_check' AND conrelid = 'users'::regclass
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_plan_check
      CHECK (plan IN ('free', 'solo', 'pro', 'team'));
  END IF;
END$$;

-- Backfill any NULL or invalid plan values to 'free'
UPDATE users SET plan = 'free' WHERE plan IS NULL OR plan NOT IN ('free', 'solo', 'pro', 'team');

-- Add pipeline_execution feature to plan_quotas
-- 0 = blocked, -1 = unlimited
INSERT INTO plan_quotas (plan_name, feature, quota_limit) VALUES
  ('free',  'pipeline_execution', 0),
  ('solo',  'pipeline_execution', -1),
  ('pro',   'pipeline_execution', -1),
  ('team',  'pipeline_execution', -1)
ON CONFLICT (plan_name, feature) DO NOTHING;
