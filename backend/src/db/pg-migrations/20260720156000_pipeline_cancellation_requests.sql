-- Application-owned cancellation intent; pg-boss is notification only.

CREATE TABLE IF NOT EXISTS pipeline_run_cancellation_requests (
  run_id BIGINT PRIMARY KEY REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  requested_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  terminalized_at TIMESTAMPTZ
);
