-- 20260316000002_billing_trial_columns.sql — Add trial columns to subscriptions table
-- BL-002: 14-day Pro trial provisioned on first workspace registration

-- Add trial timestamp columns
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS trial_started_at TIMESTAMPTZ;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;

-- Expand status CHECK to include 'trialing'
-- Drop the old constraint first, then recreate with the new value
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_status_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_status_check
  CHECK(status IN ('active', 'canceled', 'past_due', 'incomplete', 'trialing'));
