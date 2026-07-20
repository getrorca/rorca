-- Generation-aware PTY operations, compatibility, and independent retention.
-- This migration is additive so old servers continue to finish and replay old
-- captures. It intentionally never touches the pg-boss managed schema.

CREATE TABLE IF NOT EXISTS pty_recovery_schema_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  minimum_reader_version INTEGER NOT NULL CHECK (minimum_reader_version > 0),
  mutation_state TEXT NOT NULL CHECK (mutation_state IN ('ready', 'blocked')),
  diagnostic TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO pty_recovery_schema_state
  (singleton, schema_version, minimum_reader_version, mutation_state, diagnostic)
VALUES (TRUE, 1, 1, 'ready', 'PTY recovery operations schema v1 is ready')
ON CONFLICT (singleton) DO NOTHING;

-- Every independently retained artifact has the same explicit safety guard.
-- Active generations are additionally protected by every runtime prune query.
ALTER TABLE run_pty_output_chunks
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS referenced_by_manifest BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE pty_checkpoints
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS referenced_by_manifest BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE pty_transcript_events
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS referenced_by_manifest BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE pty_raw_archive_segments
  ADD COLUMN IF NOT EXISTS referenced_by_manifest BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE pty_raw_archive_manifests
  ADD COLUMN IF NOT EXISTS referenced_by_manifest BOOLEAN NOT NULL DEFAULT FALSE;

-- Transcript events remain immutable, but retention may remove completed,
-- unreferenced rows. Sequence gaps are part of the transcript read contract.
DROP TRIGGER IF EXISTS trg_pty_transcript_no_mutation ON pty_transcript_events;
DROP TRIGGER IF EXISTS trg_pty_transcript_no_update ON pty_transcript_events;
CREATE TRIGGER trg_pty_transcript_no_update
  BEFORE UPDATE ON pty_transcript_events
  FOR EACH ROW EXECUTE FUNCTION reject_pty_transcript_mutation();

CREATE INDEX IF NOT EXISTS idx_run_pty_output_chunks_retention
  ON run_pty_output_chunks (completed_at, generation_id)
  WHERE completed_at IS NOT NULL AND NOT referenced_by_manifest;
CREATE INDEX IF NOT EXISTS idx_pty_checkpoints_retention
  ON pty_checkpoints (completed_at, generation_id)
  WHERE completed_at IS NOT NULL AND NOT referenced_by_manifest;
CREATE INDEX IF NOT EXISTS idx_pty_transcript_events_retention
  ON pty_transcript_events (completed_at, generation_id)
  WHERE completed_at IS NOT NULL AND NOT referenced_by_manifest;
CREATE INDEX IF NOT EXISTS idx_pty_raw_archive_segments_retention
  ON pty_raw_archive_segments (completed_at, generation_id)
  WHERE completed_at IS NOT NULL AND NOT referenced_by_manifest;

-- Durable byte telemetry is content-free. Labels are constrained to one closed,
-- bounded enum and cannot carry generation tokens, prompts, paths, or output.
ALTER TABLE pty_capture_telemetry
  ADD COLUMN IF NOT EXISTS byte_class TEXT,
  ADD COLUMN IF NOT EXISTS byte_count BIGINT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pty_capture_telemetry_byte_class_check') THEN
    ALTER TABLE pty_capture_telemetry
      ADD CONSTRAINT pty_capture_telemetry_byte_class_check CHECK (
        byte_class IS NULL OR byte_class IN (
          'observed', 'archived', 'transcripted', 'compacted', 'dropped', 'unrecoverable'
        )
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pty_capture_telemetry_byte_count_check') THEN
    ALTER TABLE pty_capture_telemetry
      ADD CONSTRAINT pty_capture_telemetry_byte_count_check
      CHECK (byte_count IS NULL OR byte_count >= 0);
  END IF;
END $$;
