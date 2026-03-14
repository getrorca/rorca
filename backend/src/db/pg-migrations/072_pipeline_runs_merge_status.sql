-- Add merge_status column to pipeline_runs for tracking auto-merge state.
-- Values: NULL (no auto-merge), 'pending', 'merging', 'merged', 'failed'
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS merge_status TEXT DEFAULT NULL;
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS merge_commit_sha TEXT DEFAULT NULL;
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS merge_error TEXT DEFAULT NULL;
