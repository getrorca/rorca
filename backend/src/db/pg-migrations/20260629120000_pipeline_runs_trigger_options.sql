-- Store canonical trigger options for queue promotion and retry replay.
-- This keeps queued/retry runs from falling back to process-global defaults.
ALTER TABLE pipeline_runs
  ADD COLUMN IF NOT EXISTS trigger_options JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_trigger_options_gin
  ON pipeline_runs USING GIN (trigger_options);
