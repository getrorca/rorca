-- 20260316000004_billing_license_columns.sql
-- Add license key activation columns to subscriptions table.
-- Used by POST /api/billing/activate-license for offline and cloud-issued license keys.

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS license_key TEXT;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
