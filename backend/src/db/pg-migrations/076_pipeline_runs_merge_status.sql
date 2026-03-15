-- Migration 072: Add merge_status column to pipeline_runs
-- Tracks the state of the post-run worktree auto-merge:
--   NULL     = no merge attempted (non-worktree run or not yet finished)
--   pending  = merge queued, not yet started
--   merging  = merge in progress
--   merged   = merge completed successfully
--   failed   = merge failed (code conflicts or unexpected error)
-- Used by POST /api/pipeline/runs/:runId/retry-merge to allow retrying failed merges.

ALTER TABLE pipeline_runs
  ADD COLUMN IF NOT EXISTS merge_status TEXT
    CHECK(merge_status IS NULL OR merge_status IN ('pending', 'merging', 'merged', 'failed'));

ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS merge_commit_sha TEXT DEFAULT NULL;
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS merge_error TEXT DEFAULT NULL;
