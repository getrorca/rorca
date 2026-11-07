-- Queue stdin bytes for active PTY runs.
-- The API process records requests here; the execution-engine process claims them
-- and writes the bytes to its in-memory node-pty child.

CREATE TABLE IF NOT EXISTS run_pty_input_requests (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  input BYTEA NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length > 0),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_run_pty_input_requests_pending
  ON run_pty_input_requests (run_id, applied_at, id);
