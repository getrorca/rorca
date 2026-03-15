-- 20260314120000_add_story_results_reason.sql
-- Adds a `reason` column to story_results for tracking why a story was skipped/excluded.
-- Used by the pipeline trigger to pre-seed previously_passed stories with reason='previously_passed',
-- allowing the UI to show a resume badge and the execution engine to skip re-emitting WAL events.
ALTER TABLE story_results ADD COLUMN IF NOT EXISTS reason TEXT;
