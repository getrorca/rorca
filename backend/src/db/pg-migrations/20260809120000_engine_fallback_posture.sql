-- MIG-006: retain the executor decision as queryable run evidence. Selection is
-- enforced by resolveExecutionOptions; these generated columns make default,
-- explicit-fallback, and retry-preserved decisions durable without duplicating
-- mutable values or rewriting historical rows.
ALTER TABLE pipeline_runs
  ADD COLUMN IF NOT EXISTS executor_selection_source TEXT
    GENERATED ALWAYS AS (trigger_options ->> 'executorSelectionSource') STORED,
  ADD COLUMN IF NOT EXISTS executor_declared_explicitly BOOLEAN
    GENERATED ALWAYS AS (
      COALESCE((trigger_options ->> 'executorDeclaredExplicitly')::boolean, false)
    ) STORED;

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_executor_selection
  ON pipeline_runs (agent_type, executor_selection_source);

COMMENT ON COLUMN pipeline_runs.executor_selection_source IS
  'MIG-006 dispatch decision: qualified-omp-default, explicit override source, or retry-preserved.';
COMMENT ON COLUMN pipeline_runs.executor_declared_explicitly IS
  'True only when the run executor came from an explicit request, manifest, or spec declaration.';
