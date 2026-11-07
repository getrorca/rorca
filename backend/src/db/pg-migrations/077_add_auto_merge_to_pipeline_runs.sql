-- Migration 074: Add auto_merge column to pipeline_runs
-- Tracks whether a run should auto-merge its worktree branch to main on completion.
-- Only applicable to worktree-based runs (auto_merge=true requires autoWorktree=true).
-- Default true for backwards compatibility with existing worktree runs.

ALTER TABLE pipeline_runs
  ADD COLUMN IF NOT EXISTS auto_merge BOOLEAN NOT NULL DEFAULT true;
