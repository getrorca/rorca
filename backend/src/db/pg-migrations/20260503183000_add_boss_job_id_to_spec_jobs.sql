SET search_path TO rorca, public;

ALTER TABLE spec_jobs
  ADD COLUMN IF NOT EXISTS boss_job_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_spec_jobs_boss_job_id
  ON spec_jobs(boss_job_id)
  WHERE boss_job_id IS NOT NULL;

SET search_path TO public;
