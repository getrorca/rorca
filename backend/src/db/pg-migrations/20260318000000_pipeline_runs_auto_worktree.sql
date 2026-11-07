-- US-005: Store auto_worktree on pipeline_runs at queue time so advanceQueue()
-- can preserve worktree isolation when promoting queued runs to active.
-- Default false for existing rows (non-worktree runs).

ALTER TABLE pipeline_runs
ADD COLUMN IF NOT EXISTS auto_worktree BOOLEAN NOT NULL DEFAULT false;
