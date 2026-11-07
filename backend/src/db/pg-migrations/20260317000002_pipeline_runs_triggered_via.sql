-- Track how each pipeline run was triggered:
--   'queue'   — promoted from the run queue by advanceQueue()
--   'run_now' — direct user trigger (default)
-- Used by the worker to select the correct concurrency limit
-- (queue_max_concurrent vs run_now_max_concurrent from US-001).

ALTER TABLE pipeline_runs
ADD COLUMN IF NOT EXISTS triggered_via VARCHAR(16) NOT NULL DEFAULT 'run_now';
