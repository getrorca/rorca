-- Migration 069: Add git_memory_hydrated_at to workspace_context
-- Tracks the last time background git hydration was triggered from spec generation.
-- Used to debounce fire-and-forget hydration: only re-trigger if > 7 days since last trigger.

ALTER TABLE workspace_context
  ADD COLUMN IF NOT EXISTS git_memory_hydrated_at TIMESTAMPTZ;
