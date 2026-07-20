-- Governed staged production opt-in for wave-parallel execution.
-- Additive only: existing run rows, queue jobs, pass flags and workspace defaults are
-- deliberately untouched. pg-boss owns its schema and is not referenced here.

ALTER TABLE pipeline_runs
  ADD COLUMN IF NOT EXISTS orchestration_mode TEXT,
  ADD COLUMN IF NOT EXISTS wave_policy JSONB,
  ADD COLUMN IF NOT EXISTS wave_policy_fence TEXT,
  ADD COLUMN IF NOT EXISTS wave_qualification_receipt_id BIGINT REFERENCES wave_qualification_receipts(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS wave_source_revision TEXT,
  ADD COLUMN IF NOT EXISTS wave_rollout_cohort TEXT;

ALTER TABLE pipeline_runs
  ADD CONSTRAINT pipeline_runs_orchestration_mode_check
    CHECK (orchestration_mode IS NULL OR orchestration_mode IN ('sequential', 'wave-parallel')),
  ADD CONSTRAINT pipeline_runs_wave_policy_shape_check
    CHECK (wave_policy IS NULL OR (
      wave_policy->>'schemaVersion' = 'rorca.wave-production-policy/v1'
      AND wave_policy->>'fencingPolicy' = 'dispatch-boundary-v1'
    )),
  ADD CONSTRAINT pipeline_runs_wave_policy_fence_check
    CHECK (wave_policy_fence IS NULL OR wave_policy_fence ~ '^sha256:[0-9a-f]{64}$'),
  ADD CONSTRAINT pipeline_runs_wave_source_revision_check
    CHECK (wave_source_revision IS NULL OR wave_source_revision ~ '^[0-9a-f]{40,64}$');

CREATE TABLE IF NOT EXISTS wave_parallel_rollout_controls (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE RESTRICT,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  qualification_receipt_id BIGINT REFERENCES wave_qualification_receipts(id) ON DELETE RESTRICT,
  cohort TEXT NOT NULL DEFAULT 'none' CHECK (cohort ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  workspace_allowlist TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  run_allowlist BIGINT[] NOT NULL DEFAULT ARRAY[]::BIGINT[],
  max_parallelism INTEGER NOT NULL DEFAULT 1 CHECK (max_parallelism BETWEEN 1 AND 4),
  max_active_wave_runs INTEGER NOT NULL DEFAULT 1 CHECK (max_active_wave_runs BETWEEN 1 AND 16),
  max_active_wave_runs_per_workspace INTEGER NOT NULL DEFAULT 1 CHECK (max_active_wave_runs_per_workspace BETWEEN 1 AND 4),
  max_cpu_percent NUMERIC(5,2) NOT NULL DEFAULT 70 CHECK (max_cpu_percent BETWEEN 1 AND 100),
  max_memory_percent NUMERIC(5,2) NOT NULL DEFAULT 70 CHECK (max_memory_percent BETWEEN 1 AND 100),
  max_error_rate NUMERIC(6,5) NOT NULL DEFAULT 0 CHECK (max_error_rate BETWEEN 0 AND 1),
  observed_cpu_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (observed_cpu_percent BETWEEN 0 AND 100),
  observed_memory_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (observed_memory_percent BETWEEN 0 AND 100),
  observed_error_rate NUMERIC(6,5) NOT NULL DEFAULT 0 CHECK (observed_error_rate BETWEEN 0 AND 1),
  halted BOOLEAN NOT NULL DEFAULT FALSE,
  draining BOOLEAN NOT NULL DEFAULT FALSE,
  rationale TEXT NOT NULL DEFAULT 'Sequential production default' CHECK (octet_length(rationale) BETWEEN 1 AND 2048),
  updated_by TEXT NOT NULL DEFAULT 'system' CHECK (octet_length(updated_by) BETWEEN 1 AND 256),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (NOT enabled OR qualification_receipt_id IS NOT NULL),
  CHECK (NOT (halted AND draining))
);

CREATE TABLE IF NOT EXISTS wave_parallel_governance_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  run_id BIGINT REFERENCES pipeline_runs(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'enable', 'deny', 'receipt_verification', 'cohort_change',
    'automatic_halt', 'rollback', 'drain', 'cancel'
  )),
  actor TEXT NOT NULL CHECK (octet_length(actor) BETWEEN 1 AND 256),
  rationale TEXT NOT NULL CHECK (octet_length(rationale) BETWEEN 1 AND 2048),
  receipt_hash TEXT CHECK (receipt_hash IS NULL OR receipt_hash ~ '^sha256:[0-9a-f]{64}$'),
  source_revision TEXT CHECK (source_revision IS NULL OR source_revision ~ '^[0-9a-f]{40,64}$'),
  requested_policy JSONB NOT NULL CHECK (jsonb_typeof(requested_policy) = 'object'),
  effective_policy JSONB NOT NULL CHECK (jsonb_typeof(effective_policy) = 'object'),
  rollout_cohort TEXT,
  fencing_policy TEXT NOT NULL CHECK (fencing_policy = 'dispatch-boundary-v1'),
  outcome TEXT NOT NULL CHECK (outcome IN ('allowed', 'denied', 'halted', 'draining', 'recorded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wave_parallel_audit_workspace_created
  ON wave_parallel_governance_audit (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_active_wave_governance
  ON pipeline_runs (workspace_id, status)
  WHERE orchestration_mode = 'wave-parallel' AND status IN ('queued', 'starting', 'running');

CREATE OR REPLACE FUNCTION reject_wave_parallel_audit_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'wave parallel governance audit is append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_wave_parallel_audit_immutable ON wave_parallel_governance_audit;
CREATE TRIGGER trg_wave_parallel_audit_immutable
BEFORE UPDATE OR DELETE ON wave_parallel_governance_audit
FOR EACH ROW EXECUTE FUNCTION reject_wave_parallel_audit_mutation();
