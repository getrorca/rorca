-- Add last_heartbeat column to pipeline_runs for engine→worker liveness tracking.
-- The execution engine sends IPC heartbeats every 60s; the worker writes them here.
-- Reconciliation checks: if last_heartbeat > 2 min stale AND PID not alive → mark failed.
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS last_heartbeat TIMESTAMPTZ;
