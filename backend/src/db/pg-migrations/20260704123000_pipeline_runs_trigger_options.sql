-- 20260704123000_pipeline_runs_trigger_options.sql
-- Persist trigger-scoped metadata for task-manifest/idempotent runs.
-- Normal Rorca application schema only; pg-boss owns and migrates pgboss.*.

ALTER TABLE pipeline_runs
  ADD COLUMN IF NOT EXISTS trigger_options JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_runs_workspace_idempotency_key_unique
  ON pipeline_runs(workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_trigger_options_manifest_hash
  ON pipeline_runs((trigger_options->>'manifestHash'))
  WHERE trigger_options ? 'manifestHash';
