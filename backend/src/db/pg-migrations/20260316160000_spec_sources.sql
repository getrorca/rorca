-- Track the origin/source of spec files (e.g. 'github' for webhook-discovered specs)
CREATE TABLE IF NOT EXISTS spec_sources (
  spec_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'local',
  source_repo TEXT,
  source_ref TEXT,
  source_sha TEXT,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (spec_id, workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_spec_sources_workspace ON spec_sources(workspace_id);
CREATE INDEX IF NOT EXISTS idx_spec_sources_source ON spec_sources(source);
