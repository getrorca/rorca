-- 072: Add merge_status and merge_commit_sha columns to pipeline_runs
-- Supports post-run auto-merge feature (US-004)

ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS merge_status VARCHAR(20) DEFAULT NULL;
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS merge_commit_sha VARCHAR(64) DEFAULT NULL;
