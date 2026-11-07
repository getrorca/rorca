-- 20260704120000_pipeline_runs_task_manifest_metadata.sql
-- Persist Hermes task-manifest correlation metadata on pipeline_runs.
-- The idempotency key is stored on the run row; pg-boss still receives an
-- auto-generated UUID job id and correlates via job.data.runId/manifestId.

ALTER TABLE pipeline_runs
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

ALTER TABLE pipeline_runs
  ADD COLUMN IF NOT EXISTS task_manifest_id TEXT;

ALTER TABLE pipeline_runs
  ADD COLUMN IF NOT EXISTS task_manifest_artifacts JSONB;

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_workspace_idempotency_key
  ON pipeline_runs(workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_task_manifest_id
  ON pipeline_runs(task_manifest_id)
  WHERE task_manifest_id IS NOT NULL;
