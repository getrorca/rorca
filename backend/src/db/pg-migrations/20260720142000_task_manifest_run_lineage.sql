-- Immutable TaskManifest lineage and no-deploy authority across retries.
-- No pgboss.* objects are managed here.

ALTER TABLE pipeline_runs
  ADD COLUMN IF NOT EXISTS task_manifest_authority_version INTEGER;

ALTER TABLE pipeline_runs
  DROP CONSTRAINT IF EXISTS pipeline_runs_task_manifest_authority_v1_ck,
  ADD CONSTRAINT pipeline_runs_task_manifest_authority_v1_ck CHECK (
    task_manifest_authority_version IS NULL
    OR (
      task_manifest_authority_version = 1
      AND task_manifest_id IS NOT NULL
      AND effective_options #>> '{safety,deploy}' = 'false'
      AND COALESCE(trigger_options #>> '{policySummary,deploysAllowed}', 'false') = 'false'
      AND auto_merge = FALSE
      AND merge_strategy IN ('pr', 'draft-pr', 'branch-only')
    )
  ) NOT VALID;

CREATE TABLE IF NOT EXISTS task_manifest_run_lineage (
  run_id BIGINT PRIMARY KEY REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  root_run_id BIGINT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  parent_run_id BIGINT REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  lineage_depth INTEGER NOT NULL CHECK (lineage_depth >= 0),
  schema_version TEXT NOT NULL CHECK (schema_version = 'rorca.task-manifest-lineage.v1'),
  manifest_id TEXT NOT NULL,
  source_idempotency_key TEXT NOT NULL,
  manifest_hash TEXT NOT NULL CHECK (manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  synthetic_spec_hash TEXT NOT NULL CHECK (synthetic_spec_hash ~ '^sha256:[0-9a-f]{64}$'),
  manifest_path TEXT NOT NULL,
  synthetic_spec_path TEXT NOT NULL,
  lineage_identity_hash TEXT NOT NULL UNIQUE CHECK (lineage_identity_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (lineage_depth = 0 AND parent_run_id IS NULL AND root_run_id = run_id)
    OR
    (lineage_depth > 0 AND parent_run_id IS NOT NULL AND root_run_id <> run_id)
  ),
  CHECK (manifest_path !~ '(^/|(^|/)\.\.(/|$)|\\)'),
  CHECK (synthetic_spec_path !~ '(^/|(^|/)\.\.(/|$)|\\)')
);

CREATE OR REPLACE FUNCTION enforce_task_manifest_run_lineage_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'task-manifest run lineage is append-only'
    USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS trg_task_manifest_run_lineage_append_only ON task_manifest_run_lineage;
CREATE TRIGGER trg_task_manifest_run_lineage_append_only
BEFORE UPDATE OR DELETE ON task_manifest_run_lineage
FOR EACH ROW EXECUTE FUNCTION enforce_task_manifest_run_lineage_append_only();

-- Historical TaskManifest rows are not backfilled from mutable workspace files.
