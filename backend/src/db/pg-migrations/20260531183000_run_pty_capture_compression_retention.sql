-- Add compression metadata and retention-friendly accounting to PTY capture storage.
-- PTY capture stays separate from transcript-oriented run_output_chunks.

ALTER TABLE run_pty_sessions
  ADD COLUMN IF NOT EXISTS total_stored_bytes BIGINT NOT NULL DEFAULT 0;

ALTER TABLE run_pty_output_chunks
  ADD COLUMN IF NOT EXISTS compression TEXT NOT NULL DEFAULT 'identity'
    CHECK (compression IN ('identity', 'gzip'));

ALTER TABLE run_pty_output_chunks
  ADD COLUMN IF NOT EXISTS byte_length INTEGER NOT NULL DEFAULT 0
    CHECK (byte_length >= 0);

ALTER TABLE run_pty_output_chunks
  ADD COLUMN IF NOT EXISTS stored_byte_length INTEGER NOT NULL DEFAULT 0
    CHECK (stored_byte_length >= 0);

UPDATE run_pty_output_chunks
SET byte_length = OCTET_LENGTH(chunk)
WHERE byte_length = 0;

UPDATE run_pty_output_chunks
SET stored_byte_length = OCTET_LENGTH(chunk)
WHERE stored_byte_length = 0;

UPDATE run_pty_sessions AS session
SET total_stored_bytes = totals.total_stored_bytes
FROM (
  SELECT run_id, SUM(COALESCE(NULLIF(stored_byte_length, 0), OCTET_LENGTH(chunk)))::BIGINT AS total_stored_bytes
  FROM run_pty_output_chunks
  GROUP BY run_id
) AS totals
WHERE session.run_id = totals.run_id
  AND session.total_stored_bytes = 0;

CREATE INDEX IF NOT EXISTS idx_run_pty_sessions_retention
  ON run_pty_sessions (updated_at)
  WHERE status <> 'active';
