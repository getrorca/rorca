-- Add pi-native external orchestration fields to pipeline_runs.
-- New statuses support externally-owned run lifecycle transitions.

ALTER TABLE pipeline_runs
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS summary TEXT;

DROP INDEX IF EXISTS idx_pipeline_runs_idempotency_key;
CREATE UNIQUE INDEX idx_pipeline_runs_idempotency_key
  ON pipeline_runs(idempotency_key);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_pi_stale_scan
  ON pipeline_runs(agent_type, status, last_heartbeat_at);

ALTER TABLE pipeline_runs DROP CONSTRAINT IF EXISTS pipeline_runs_status_check;

ALTER TABLE pipeline_runs
  ADD CONSTRAINT pipeline_runs_status_check
  CHECK (
    status IN (
      'queued',
      'running',
      'paused',
      'pi_native',
      'cancelling',
      'done',
      'passed',
      'failed',
      'partial_failure',
      'cancelled',
      'stale'
    )
  );
