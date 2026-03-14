-- Migration 072: Add git_memory columns and git_memory_hydrated_at to workspace_context
--
-- Context-autohydrate (migration 070) added these columns to public.workspace_context,
-- but the app's search_path resolves to rorca.workspace_context (via $user = rorca).
-- This migration ensures all three columns exist on whichever schema is active.
-- All columns use IF NOT EXISTS so this is safe to run on any DB state.

ALTER TABLE workspace_context
  ADD COLUMN IF NOT EXISTS git_memory TEXT,
  ADD COLUMN IF NOT EXISTS git_memory_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS git_memory_hydrated_at TIMESTAMPTZ;
