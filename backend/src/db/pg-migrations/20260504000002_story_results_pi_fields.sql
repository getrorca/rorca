BEGIN;

ALTER TABLE story_results
  ADD COLUMN IF NOT EXISTS exit_code INTEGER;

ALTER TABLE story_results
  ADD COLUMN IF NOT EXISTS stderr_tail TEXT;

ALTER TABLE story_results
  ADD COLUMN IF NOT EXISTS commit_sha TEXT;

ALTER TABLE story_results
  ADD COLUMN IF NOT EXISTS duration_ms INTEGER;

ALTER TABLE story_results
  ADD COLUMN IF NOT EXISTS resolved_model TEXT;

COMMIT;
