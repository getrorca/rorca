-- Crash-safe application-owned schedule occurrence dispatch leases.
-- pg-boss remains the single meta-tick dispatcher; its schema is untouched.

ALTER TABLE pipeline_schedule_occurrences
  ADD COLUMN IF NOT EXISTS lease_owner TEXT,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

ALTER TABLE pipeline_schedule_occurrences
  DROP CONSTRAINT IF EXISTS pipeline_schedule_occurrences_status_check,
  ADD CONSTRAINT pipeline_schedule_occurrences_status_check
    CHECK (status IN ('claimed', 'dispatching', 'dispatched', 'cancelled'));

ALTER TABLE pipeline_schedule_occurrences
  DROP CONSTRAINT IF EXISTS pipeline_schedule_occurrences_check,
  ADD CONSTRAINT pipeline_schedule_occurrences_check CHECK (
    (status = 'dispatched') = (dispatched_at IS NOT NULL)
  );

ALTER TABLE pipeline_schedule_occurrences
  DROP CONSTRAINT IF EXISTS pipeline_schedule_occurrences_lease_ck,
  ADD CONSTRAINT pipeline_schedule_occurrences_lease_ck CHECK (
    (lease_owner IS NULL) = (lease_expires_at IS NULL)
    AND (status = 'dispatching') = (lease_owner IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_pipeline_schedule_occurrences_dispatch_recovery
  ON pipeline_schedule_occurrences(status, lease_expires_at, claimed_at)
  WHERE status IN ('claimed', 'dispatching');

-- Intentionally no DB/role/schema/extension/ownership or pgboss.* management.
