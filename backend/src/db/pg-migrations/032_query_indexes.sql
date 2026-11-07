-- 032_query_indexes.sql — Composite indexes for common query patterns

CREATE INDEX IF NOT EXISTS idx_wal_events_workspace_id ON wal_events(workspace_id);
CREATE INDEX IF NOT EXISTS idx_wal_events_event_type ON wal_events(event_type);
CREATE INDEX IF NOT EXISTS idx_wal_events_workspace_event ON wal_events(workspace_id, event_type);
CREATE INDEX IF NOT EXISTS idx_wal_events_spec_id ON wal_events(spec_id);
CREATE INDEX IF NOT EXISTS idx_wal_events_ts ON wal_events(ts);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_workspace_status ON pipeline_runs(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_workspace_id ON pipeline_runs(workspace_id);

CREATE INDEX IF NOT EXISTS idx_story_results_run_id ON story_results(run_id);
CREATE INDEX IF NOT EXISTS idx_story_results_run_story ON story_results(run_id, story_id);

CREATE INDEX IF NOT EXISTS idx_spec_versions_slug ON spec_versions(spec_slug);

CREATE INDEX IF NOT EXISTS idx_token_usage_run_story ON token_usage(run_id, story_id);
