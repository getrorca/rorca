-- 20260316000011_pipeline_runs_plan_checked_at.sql
-- BL-011: Add plan audit columns to pipeline_runs.
-- Records the plan state at trigger time so audit logs capture it.
-- Running pipelines are never aborted mid-run due to plan expiry.

ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS plan_checked_at TIMESTAMPTZ;
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS plan_at_trigger TEXT;
