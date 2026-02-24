-- V2-099: Composite indexes for common query patterns
-- These cover the hottest query paths identified via EXPLAIN QUERY PLAN audit.

-- wal_events: SSE polling uses WHERE id > ? ORDER BY id ASC — primary key covers this.
-- But filtered queries by workspace_id + event_type need composite indexes.
CREATE INDEX IF NOT EXISTS idx_wal_events_workspace_id ON wal_events(workspace_id);
CREATE INDEX IF NOT EXISTS idx_wal_events_event_type ON wal_events(event_type);
CREATE INDEX IF NOT EXISTS idx_wal_events_workspace_event ON wal_events(workspace_id, event_type);
CREATE INDEX IF NOT EXISTS idx_wal_events_spec_id ON wal_events(spec_id);
CREATE INDEX IF NOT EXISTS idx_wal_events_ts ON wal_events(ts);

-- pipeline_runs: frequently queried by (workspace_id, status) for conflict detection + listing
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_workspace_status ON pipeline_runs(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_workspace_id ON pipeline_runs(workspace_id);

-- story_results: frequently queried by run_id for run detail + comparison
CREATE INDEX IF NOT EXISTS idx_story_results_run_id ON story_results(run_id);
CREATE INDEX IF NOT EXISTS idx_story_results_run_story ON story_results(run_id, story_id);

-- spec_versions: queried by spec_slug for version history
CREATE INDEX IF NOT EXISTS idx_spec_versions_slug ON spec_versions(spec_slug);

-- token_usage: queried by run_id and workspace_id for analytics
CREATE INDEX IF NOT EXISTS idx_token_usage_run_story ON token_usage(run_id, story_id);
