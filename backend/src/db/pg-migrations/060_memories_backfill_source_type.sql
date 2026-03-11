-- MST-006: Backfill source_type for existing memories rows.
-- Infers source_type from source_run_id, source_spec_id, source_story_id columns.
-- Only updates rows still set to the default 'synthesis' to avoid overwriting
-- any already-corrected values. Idempotent — safe to re-run.

-- Manual entries: no source IDs at all
UPDATE memories
SET source_type = 'manual'
WHERE source_type = 'synthesis'
  AND source_run_id IS NULL
  AND source_spec_id IS NULL
  AND source_story_id IS NULL;

-- Auto-extracted: has spec but no run (came from spec generation codebase analysis)
UPDATE memories
SET source_type = 'auto-extracted'
WHERE source_type = 'synthesis'
  AND source_spec_id IS NOT NULL
  AND source_run_id IS NULL;

-- Rows with source_run_id set remain 'synthesis' (the default) — no update needed.
