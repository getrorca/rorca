-- Track PTY liveness metadata separately from raw terminal bytes.
-- Heartbeats and completion-marker state are metadata; they must not be mixed
-- into run_pty_output_chunks, which is reserved for raw node-pty output bytes.

ALTER TABLE run_pty_sessions
  ADD COLUMN IF NOT EXISTS completion_marker TEXT;

ALTER TABLE run_pty_sessions
  ADD COLUMN IF NOT EXISTS completion_marker_seen_at TIMESTAMPTZ;

ALTER TABLE run_pty_sessions
  ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;

-- last_output_at means that raw PTY bytes were observed, not merely that the
-- process was spawned and remains alive.
ALTER TABLE run_pty_sessions
  ALTER COLUMN last_output_at DROP NOT NULL;

ALTER TABLE run_pty_sessions
  ALTER COLUMN last_output_at DROP DEFAULT;

CREATE INDEX IF NOT EXISTS idx_run_pty_sessions_completion_marker
  ON run_pty_sessions (completion_marker_seen_at)
  WHERE completion_marker_seen_at IS NOT NULL;
