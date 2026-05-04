BEGIN;

ALTER TABLE pipeline_runs
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT UNIQUE;

ALTER TABLE pipeline_runs
  ADD COLUMN IF NOT EXISTS agent_type TEXT DEFAULT 'claude';

ALTER TABLE pipeline_runs
  ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;

ALTER TABLE pipeline_runs
  ADD COLUMN IF NOT EXISTS summary TEXT;

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_idempotency_key
  ON pipeline_runs (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_agent_stale
  ON pipeline_runs (agent_type, status, last_heartbeat_at)
  WHERE agent_type = 'pi';

ALTER TABLE pipeline_runs
  DROP CONSTRAINT IF EXISTS pipeline_runs_status_check;

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

COMMIT;
