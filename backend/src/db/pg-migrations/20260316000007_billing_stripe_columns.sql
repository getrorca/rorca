-- 20260316000007_billing_stripe_columns.sql
-- Ensures stripe_customer_id and stripe_subscription_id columns exist on subscriptions table.
-- These columns were introduced in 035_billing.sql; this migration is a safety net for
-- environments that may have run an older schema.

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;

CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_sub_id ON subscriptions(stripe_subscription_id);
