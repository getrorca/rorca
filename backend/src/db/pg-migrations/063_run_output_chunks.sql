-- 063_run_output_chunks.sql — Persistent run output storage
--
-- Replaces the in-memory outputBuffers Map in pipeline.ts with durable DB storage.
-- Chunks survive backend restarts; late-join SSE clients replay all existing rows.
--
-- Design:
--   • chunk is BYTEA — raw stdout/stderr bytes (may contain ANSI escape codes)
--   • sequence is monotonically increasing per run (1-based) for ordered replay
--   • UNIQUE(run_id, sequence) prevents duplicate inserts on worker retry
--   • Index on (run_id, sequence) for fast range scans during streaming

CREATE TABLE IF NOT EXISTS run_output_chunks (
  id         BIGSERIAL PRIMARY KEY,
  run_id     INT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  chunk      BYTEA NOT NULL,
  sequence   INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_run_output_chunks_run_seq
  ON run_output_chunks (run_id, sequence);
