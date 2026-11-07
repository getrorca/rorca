-- 20260618160000_spec_post_save_workflow_v1_queues.sql — Align v1 post-save workflow stages and spec job queues.
-- Adds the memory synthesis spec job type and narrows workflow stage statuses to the
-- v1 transition set: pending, queued, running, completed, failed, skipped.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'rorca'
      AND table_name = 'spec_jobs'
  ) THEN
    ALTER TABLE rorca.spec_jobs
      DROP CONSTRAINT IF EXISTS spec_jobs_job_type_check,
      ADD CONSTRAINT spec_jobs_job_type_check
        CHECK (job_type IN (
          'enrich',
          'context-enrich',
          'match-skills',
          'memory-synthesis',
          'suggest-skills',
          'suggest-models',
          'detect-dependencies',
          'knowledge-graph',
          'add-stories',
          'validate',
          'score'
        ));
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'rorca'
      AND table_name = 'spec_post_save_workflow_stages'
  ) THEN
    UPDATE rorca.spec_post_save_workflow_stages
    SET status = 'skipped',
        reason = COALESCE(NULLIF(reason, ''), 'superseded_by_newer_save'),
        finished_at = COALESCE(finished_at, NOW()),
        updated_at = NOW()
    WHERE status = 'superseded';

    ALTER TABLE rorca.spec_post_save_workflow_stages
      DROP CONSTRAINT IF EXISTS spec_post_save_workflow_stages_status_check,
      ADD CONSTRAINT spec_post_save_workflow_stages_status_check
        CHECK (status IN ('pending', 'queued', 'running', 'completed', 'failed', 'skipped'));
  END IF;
END $$;
