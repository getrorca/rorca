-- Migration 068: Add worker_id column to pipeline_runs
-- Tracks which worker process handled each run — used by zero-downtime rolling deploy tests
-- to assert no duplicate execution (each run handled by exactly one worker).

ALTER TABLE pipeline_runs
  ADD COLUMN IF NOT EXISTS worker_id UUID;
