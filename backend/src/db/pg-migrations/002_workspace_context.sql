-- 002_workspace_context.sql — Cached git memory + schema snapshots

CREATE TABLE IF NOT EXISTS workspace_context (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  schema_snapshot TEXT,
  schema_snapshot_at TIMESTAMPTZ,
  schema_table_count INTEGER DEFAULT 0,
  git_memory TEXT,
  git_memory_updated_at TIMESTAMPTZ,
  last_ingested_commit_hash TEXT,
  git_commit_count INTEGER DEFAULT 0
);
