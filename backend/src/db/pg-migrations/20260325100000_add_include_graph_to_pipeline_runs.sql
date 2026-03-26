-- Add include_graph column to pipeline_runs
-- Tracks whether a pipeline run should use knowledge graph context
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS include_graph BOOLEAN NOT NULL DEFAULT false;
