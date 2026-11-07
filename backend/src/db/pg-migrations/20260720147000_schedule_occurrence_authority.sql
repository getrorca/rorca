-- Application-owned schedule occurrence claims. pg-boss remains dispatch only.
-- This migration never creates, alters, or deletes pgboss.* objects.

CREATE TABLE IF NOT EXISTS pipeline_schedule_occurrences (
  id BIGSERIAL PRIMARY KEY,
  schedule_id INTEGER NOT NULL REFERENCES pipeline_schedules(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  scheduled_for TIMESTAMPTZ NOT NULL,
  request_key TEXT NOT NULL UNIQUE CHECK (char_length(request_key) BETWEEN 8 AND 200),
  status TEXT NOT NULL CHECK (status IN ('claimed', 'dispatched')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  run_id BIGINT REFERENCES pipeline_runs(id) ON DELETE SET NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_attempt_at TIMESTAMPTZ,
  dispatched_at TIMESTAMPTZ,
  last_error_code TEXT,
  UNIQUE (schedule_id, scheduled_for),
  CHECK ((status = 'dispatched') = (dispatched_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_pipeline_schedule_occurrences_reconcile
  ON pipeline_schedule_occurrences(status, claimed_at)
  WHERE status = 'claimed';
