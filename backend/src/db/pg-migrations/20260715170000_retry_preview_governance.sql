-- LFC-011: governed retry previews and idempotent dispatch audit.
-- This is Rorca-owned orchestration state; pg-boss tables remain managed by pg-boss.

CREATE TABLE IF NOT EXISTS pipeline_retry_previews (
  preview_hash TEXT PRIMARY KEY CHECK (preview_hash ~ '^sha256:[0-9a-f]{64}$'),
  original_run_id BIGINT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  retry_run_id BIGINT REFERENCES pipeline_runs(id) ON DELETE SET NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope_hash TEXT NOT NULL CHECK (scope_hash ~ '^sha256:[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('previewed', 'approved', 'dispatched', 'cancelled', 'refused')),
  packet JSONB NOT NULL CHECK (jsonb_typeof(packet) = 'object'),
  approval_token TEXT,
  override_record JSONB,
  refusal_reason TEXT,
  boss_job_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  dispatched_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_retry_one_dispatched_scope
  ON pipeline_retry_previews (original_run_id, scope_hash)
  WHERE status = 'dispatched';
CREATE INDEX IF NOT EXISTS idx_pipeline_retry_preview_status
  ON pipeline_retry_previews (original_run_id, status, created_at DESC);
