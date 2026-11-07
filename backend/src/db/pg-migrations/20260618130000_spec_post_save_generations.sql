-- 20260618130000_spec_post_save_generations.sql — Latest-wins post-save work generations.
-- Adds a durable save generation token and distinct superseded job state.

ALTER TABLE spec_jobs
  ADD COLUMN IF NOT EXISTS save_generation BIGINT;

ALTER TABLE spec_generation_logs
  ADD COLUMN IF NOT EXISTS save_generation BIGINT;

ALTER TABLE spec_jobs
  DROP CONSTRAINT IF EXISTS spec_jobs_status_check,
  ADD CONSTRAINT spec_jobs_status_check
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'superseded'));

CREATE INDEX IF NOT EXISTS idx_spec_jobs_post_save_generation
  ON spec_jobs(workspace_id, spec_id, save_generation)
  WHERE job_type IN ('enrich', 'match-skills');

CREATE INDEX IF NOT EXISTS idx_spec_generation_logs_slug_save_generation
  ON spec_generation_logs(spec_slug, save_generation);
