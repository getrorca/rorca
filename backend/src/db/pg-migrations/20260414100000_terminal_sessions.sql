-- OCT-004: Terminal sessions and persistent output storage
--
-- Creates tables for persisting interactive terminal sessions across backend restarts.
-- Frontend can reconnect to existing sessions by session_id.
--
-- Design:
--   • terminal_sessions — session metadata (workspace, cwd, dimensions, status)
--   • terminal_output_chunks — scrollback buffer (mirrors run_output_chunks pattern)
--   • session_id is UUID primary key for secure session identification
--   • workspace_id FK ensures sessions are scoped to workspaces
--   • status enum tracks lifecycle (active, exited, killed)
--   • terminal_output_chunks.sequence is monotonically increasing per session (1-based)
--   • data is TEXT to store terminal output (ANSI escape codes preserved)

CREATE TABLE IF NOT EXISTS terminal_sessions (
  session_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  cwd              TEXT NOT NULL,
  rows             INTEGER NOT NULL DEFAULT 24,
  cols             INTEGER NOT NULL DEFAULT 80,
  status           TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'exited', 'killed')),
  exit_code        INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  exited_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_terminal_sessions_workspace_id
  ON terminal_sessions(workspace_id);

CREATE INDEX IF NOT EXISTS idx_terminal_sessions_status
  ON terminal_sessions(status);

CREATE TABLE IF NOT EXISTS terminal_output_chunks (
  id           BIGSERIAL PRIMARY KEY,
  session_id   UUID NOT NULL REFERENCES terminal_sessions(session_id) ON DELETE CASCADE,
  sequence     BIGINT NOT NULL,
  data         TEXT NOT NULL,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_terminal_output_chunks_session_seq
  ON terminal_output_chunks(session_id, sequence);
