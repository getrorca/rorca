-- Add merge_strategy column to pipeline_runs so the strategy is persisted
-- from the pg-boss job payload at trigger time (not lost when job completes).
ALTER TABLE pipeline_runs
  ADD COLUMN IF NOT EXISTS merge_strategy TEXT
    CHECK (merge_strategy IS NULL OR merge_strategy IN ('direct', 'pr', 'draft-pr', 'branch-only'));
