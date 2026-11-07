-- 070_workspace_context_git_memory.sql
-- Add git_memory columns if they were missing from the original 002_workspace_context migration
-- (can happen when the table was created before these columns were added to migration 002)

ALTER TABLE workspace_context
  ADD COLUMN IF NOT EXISTS git_memory TEXT,
  ADD COLUMN IF NOT EXISTS git_memory_updated_at TIMESTAMPTZ;
