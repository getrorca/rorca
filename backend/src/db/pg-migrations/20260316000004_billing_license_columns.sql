-- 20260316000004_billing_license_columns.sql
-- BL-004: Add license key activation columns to subscriptions table
-- Supports offline license activation alongside Stripe subscriptions.

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS license_key TEXT;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_subscriptions_license_key ON subscriptions(license_key) WHERE license_key IS NOT NULL;
