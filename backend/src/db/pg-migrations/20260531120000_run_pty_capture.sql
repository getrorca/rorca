-- Dedicated PTY capture store for pipeline runs.
-- Keeps raw terminal bytes separate from transcript-oriented run_output_chunks.

CREATE TABLE IF NOT EXISTS run_pty_sessions (
  run_id BIGINT PRIMARY KEY REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  cwd TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  rows INTEGER NOT NULL DEFAULT 36,
  cols INTEGER NOT NULL DEFAULT 120,
  child_pid INTEGER,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'exited', 'killed', 'failed', 'timed_out')),
  exit_code INTEGER,
  exit_signal TEXT,
  total_output_bytes BIGINT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_output_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  exited_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_run_pty_sessions_workspace_status
  ON run_pty_sessions (workspace_id, status);

CREATE TABLE IF NOT EXISTS run_pty_output_chunks (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES run_pty_sessions(run_id) ON DELETE CASCADE,
  sequence BIGINT NOT NULL,
  chunk BYTEA NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_run_pty_output_chunks_run_seq
  ON run_pty_output_chunks (run_id, sequence);

CREATE TABLE IF NOT EXISTS run_pty_resize_requests (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  cols INTEGER NOT NULL CHECK (cols > 0),
  rows INTEGER NOT NULL CHECK (rows > 0),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_run_pty_resize_requests_pending
  ON run_pty_resize_requests (run_id, applied_at, id);
