-- PR-044: Marketplace spec publications + FTS5 search
CREATE TABLE IF NOT EXISTS spec_publications (
  id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  publisher_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  sanitized_spec_json TEXT NOT NULL,
  redaction_count INTEGER NOT NULL DEFAULT 0,
  download_count INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'local' CHECK(source IN ('local', 'external')),
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_spec_publications_deleted ON spec_publications(deleted_at);
CREATE INDEX IF NOT EXISTS idx_spec_publications_download ON spec_publications(download_count DESC);
CREATE INDEX IF NOT EXISTS idx_spec_publications_publisher ON spec_publications(publisher_id);

-- FTS5 virtual table for full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS spec_fts USING fts5(
  publication_id UNINDEXED,
  title,
  description,
  tags
);
