-- 20260319120000_billing_trial_support.sql
-- BL-009: Add trial support columns to subscriptions table.
-- Adds trial_ends_at column and expands status CHECK to include 'trialing'.

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;

-- Drop the old CHECK constraint and recreate with 'trialing' included.
-- The constraint name from 035_billing.sql is auto-generated; use a safe approach.
DO $$
BEGIN
  -- Remove existing check constraint on status column (if any)
  ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_status_check;
  -- Re-add with trialing included
  ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_status_check
    CHECK (status IN ('active', 'canceled', 'past_due', 'incomplete', 'trialing'));
EXCEPTION WHEN OTHERS THEN
  -- Constraint may not exist or may have a different name; ignore
  NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_subscriptions_trial_ends_at
  ON subscriptions(trial_ends_at)
  WHERE trial_ends_at IS NOT NULL;
