-- story_output_chunks — Per-story prose output storage
--
-- Stores human-readable prose extracted from stream-json log files.
-- Written by StoryLogFollower which tails log files during execution,
-- parses stream-json assistant events, and extracts text content.
--
-- Design:
--   • chunk is TEXT — prose content (not raw bytes/ANSI like run_output_chunks)
--   • sequence is monotonically increasing per (run_id, story_id) for ordered replay
--   • UNIQUE(run_id, story_id, sequence) prevents duplicate inserts on retry
--   • Index on (run_id, story_id, sequence) for fast range scans during streaming

CREATE TABLE IF NOT EXISTS story_output_chunks (
  id         BIGSERIAL PRIMARY KEY,
  run_id     BIGINT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  story_id   TEXT NOT NULL,
  chunk      TEXT NOT NULL,
  sequence   INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, story_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_story_output_chunks_run_story_seq
  ON story_output_chunks (run_id, story_id, sequence);
