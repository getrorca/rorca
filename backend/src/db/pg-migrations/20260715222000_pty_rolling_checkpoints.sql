-- Rolling PTY retention with durable, generation-scoped terminal checkpoints.
-- Checkpoint blobs are deliberately isolated from the output-chunk hot path.
-- pg-boss owns its own schema and is not involved in PTY ingestion.

-- Historical transcript rows predate story-scoped capture. Keep this nullable so
-- migration never invents provenance, while all newer writers may supply it.
ALTER TABLE run_output_chunks
  ADD COLUMN IF NOT EXISTS story_id TEXT;
CREATE INDEX IF NOT EXISTS idx_run_output_chunks_run_story_seq
  ON run_output_chunks (run_id, story_id, sequence);

ALTER TABLE pty_generations
  ADD COLUMN IF NOT EXISTS first_retained_sequence BIGINT NOT NULL DEFAULT 1
    CHECK (first_retained_sequence >= 1);
ALTER TABLE pty_generations
  ADD COLUMN IF NOT EXISTS retained_output_bytes BIGINT NOT NULL DEFAULT 0
    CHECK (retained_output_bytes >= 0);
ALTER TABLE pty_generations
  ADD COLUMN IF NOT EXISTS compacted_byte_count BIGINT NOT NULL DEFAULT 0
    CHECK (compacted_byte_count >= 0);

-- Restart-safe accounting for generations captured before this migration.
UPDATE pty_generations AS generation
SET retained_output_bytes = retained.bytes
FROM (
  SELECT generation_id, COALESCE(SUM(byte_length), 0)::BIGINT AS bytes
  FROM run_pty_output_chunks
  WHERE generation_id IS NOT NULL
  GROUP BY generation_id
) AS retained
WHERE generation.id = retained.generation_id
  AND generation.retained_output_bytes = 0;

CREATE TABLE IF NOT EXISTS pty_checkpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_id UUID NOT NULL REFERENCES pty_generations(id) ON DELETE CASCADE,
  run_id BIGINT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  story_id TEXT NOT NULL,
  checkpoint_seq BIGINT NOT NULL CHECK (checkpoint_seq >= 0),
  first_retained_seq BIGINT NOT NULL CHECK (first_retained_seq >= 1),
  compacted_byte_count BIGINT NOT NULL DEFAULT 0 CHECK (compacted_byte_count >= 0),
  compressed_blob BYTEA NOT NULL CHECK (OCTET_LENGTH(compressed_blob) <= 16777216),
  checksum CHAR(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  version INTEGER NOT NULL CHECK (version > 0),
  terminal_cols INTEGER NOT NULL CHECK (terminal_cols BETWEEN 1 AND 500),
  terminal_rows INTEGER NOT NULL CHECK (terminal_rows BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (generation_id, checkpoint_seq)
);

CREATE INDEX IF NOT EXISTS idx_pty_checkpoints_generation_latest
  ON pty_checkpoints (generation_id, checkpoint_seq DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pty_checkpoints_run_story_latest
  ON pty_checkpoints (run_id, story_id, checkpoint_seq DESC);

CREATE TABLE IF NOT EXISTS pty_capture_telemetry (
  id BIGSERIAL PRIMARY KEY,
  generation_id UUID REFERENCES pty_generations(id) ON DELETE CASCADE,
  run_id BIGINT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  story_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pty_capture_telemetry_generation_created
  ON pty_capture_telemetry (generation_id, created_at DESC);
