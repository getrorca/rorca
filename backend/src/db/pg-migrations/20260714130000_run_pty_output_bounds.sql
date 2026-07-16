-- Bound PTY capture accounting. Raw terminal bytes remain in PostgreSQL, but a
-- noisy or wedged process must not retain an unbounded durable transcript.
-- `total_output_bytes` counts all bytes observed; `dropped_output_bytes` makes
-- capture loss explicit rather than confusing it with a completed PTY session.

ALTER TABLE run_pty_sessions
  ADD COLUMN IF NOT EXISTS dropped_output_bytes BIGINT NOT NULL DEFAULT 0
    CHECK (dropped_output_bytes >= 0);

ALTER TABLE run_pty_sessions
  ADD COLUMN IF NOT EXISTS output_truncated_at TIMESTAMPTZ;
