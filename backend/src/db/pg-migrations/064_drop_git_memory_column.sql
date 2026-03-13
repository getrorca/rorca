-- Migration 064: Drop git_memory column from workspace_context
-- Git-derived knowledge is now exclusively served by the memories table
-- via memory-router.ts. The git_memory column in workspace_context is
-- no longer read or written by any code path.
-- The git_memory_updated_at column is also removed as it tracked when
-- git_memory was last updated (no longer meaningful).
-- last_ingested_commit_hash and git_commit_count are retained to support
-- delta hydration into the memories table.

ALTER TABLE workspace_context
  DROP COLUMN IF EXISTS git_memory,
  DROP COLUMN IF EXISTS git_memory_updated_at;
