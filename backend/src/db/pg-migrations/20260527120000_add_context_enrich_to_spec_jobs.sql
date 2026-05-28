-- Migration: allow context-enrich jobs in spec_jobs.job_type.
-- The context enrichment route and TypeScript types already emit `context-enrich`,
-- but the original spec_jobs CHECK constraint never allowed that value.
-- This widens the constraint so async context enrichment can enqueue normally.

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
          'suggest-skills',
          'suggest-models',
          'detect-dependencies',
          'knowledge-graph',
          'add-stories',
          'validate',
          'score'
        ));
  END IF;
END $$;
