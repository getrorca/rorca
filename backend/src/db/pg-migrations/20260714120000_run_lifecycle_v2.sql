-- One authoritative backend-owned lifecycle for every pipeline run. `status`
-- remains the legacy outcome/compatibility field; clients must consume
-- lifecycle_status rather than infer phase from terminal transport or output.

ALTER TABLE pipeline_runs
  ADD COLUMN IF NOT EXISTS lifecycle_status TEXT;

ALTER TABLE pipeline_runs
  ADD COLUMN IF NOT EXISTS lifecycle_updated_at TIMESTAMPTZ;

ALTER TABLE pipeline_runs
  ADD COLUMN IF NOT EXISTS lifecycle_diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE pipeline_runs
SET lifecycle_status = CASE
  WHEN status = 'queued' THEN 'queued'
  WHEN status = 'cancelled' THEN 'cancelled'
  WHEN status = 'done' THEN 'finished'
  WHEN status IN ('failed', 'partial_failure') THEN 'failed'
  ELSE 'running'
END,
lifecycle_updated_at = COALESCE(lifecycle_updated_at, started_at, finished_at, NOW())
WHERE lifecycle_status IS NULL;

-- New canonical runs are queued, but fixtures/legacy entrypoints may insert a
-- completed or already-running compatibility status. Derive those initial
-- lifecycle values in the database instead of making API clients guess.
ALTER TABLE pipeline_runs
  ALTER COLUMN lifecycle_status DROP DEFAULT;

CREATE OR REPLACE FUNCTION pipeline_runs_assign_initial_lifecycle()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.lifecycle_status IS NULL THEN
    NEW.lifecycle_status := CASE
      WHEN NEW.status = 'queued' THEN 'queued'
      WHEN NEW.status = 'cancelled' THEN 'cancelled'
      WHEN NEW.status = 'done' THEN 'finished'
      WHEN NEW.status IN ('failed', 'partial_failure') THEN 'failed'
      ELSE 'running'
    END;
  END IF;
  NEW.lifecycle_updated_at := COALESCE(NEW.lifecycle_updated_at, NOW());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pipeline_runs_assign_initial_lifecycle_trigger ON pipeline_runs;
CREATE TRIGGER pipeline_runs_assign_initial_lifecycle_trigger
  BEFORE INSERT ON pipeline_runs
  FOR EACH ROW EXECUTE FUNCTION pipeline_runs_assign_initial_lifecycle();

ALTER TABLE pipeline_runs
  ALTER COLUMN lifecycle_status SET NOT NULL;

ALTER TABLE pipeline_runs
  DROP CONSTRAINT IF EXISTS pipeline_runs_lifecycle_status_check;

ALTER TABLE pipeline_runs
  ADD CONSTRAINT pipeline_runs_lifecycle_status_check
  CHECK (lifecycle_status IN ('queued', 'starting', 'pty_attached', 'running', 'validating', 'finished', 'failed', 'cancelled'));

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_lifecycle_status
  ON pipeline_runs (workspace_id, lifecycle_status, lifecycle_updated_at DESC);

-- Keep transport/process/bytes/semantic/marker observations diagnostically
-- distinct. None of these fields is a story or run pass signal.
ALTER TABLE run_pty_sessions
  ADD COLUMN IF NOT EXISTS prompt_readiness_status TEXT;
ALTER TABLE run_pty_sessions
  ADD COLUMN IF NOT EXISTS prompt_readiness_reason TEXT;
ALTER TABLE run_pty_sessions
  ADD COLUMN IF NOT EXISTS prompt_ready_at TIMESTAMPTZ;
ALTER TABLE run_pty_sessions
  ADD COLUMN IF NOT EXISTS prompt_injected_at TIMESTAMPTZ;
ALTER TABLE run_pty_sessions
  ADD COLUMN IF NOT EXISTS completion_file_seen_at TIMESTAMPTZ;
ALTER TABLE run_pty_sessions
  ADD COLUMN IF NOT EXISTS completion_file_error TEXT;
ALTER TABLE run_pty_sessions
  ADD COLUMN IF NOT EXISTS terminal_marker_seen_at TIMESTAMPTZ;
