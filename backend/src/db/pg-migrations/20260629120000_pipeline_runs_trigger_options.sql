-- Preserve full run trigger intent for queued pipeline runs.
-- Queue promotion replays this JSON snapshot so options such as agent/model,
-- reasoning effort, merge strategy, terminal mode, story scope, and readiness
-- override do not get dropped while waiting behind active work.

ALTER TABLE pipeline_runs
  ADD COLUMN IF NOT EXISTS trigger_options JSONB NOT NULL DEFAULT '{}'::jsonb;
