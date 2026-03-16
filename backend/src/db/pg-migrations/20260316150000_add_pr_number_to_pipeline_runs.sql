-- 20260316150000_add_pr_number_to_pipeline_runs.sql
-- Stores the GitHub PR number created automatically after a worktree run completes.
-- pr_number: NULL until PR is created (or skipped/failed)
-- pr_creating: TRUE while PR creation is in progress (spinner in Run View)
-- pr_creation_error: non-NULL if PR creation failed (amber warning in Run View)

ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS pr_number INTEGER;
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS pr_creating BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS pr_creation_error TEXT;

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_pr_number ON pipeline_runs(pr_number) WHERE pr_number IS NOT NULL;
