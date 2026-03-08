-- PR-042: Spec publications for community marketplace
CREATE TABLE IF NOT EXISTS spec_publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spec_id TEXT NOT NULL,
  workspace_id INTEGER,
  published_by TEXT,
  sanitized_json TEXT NOT NULL,
  original_title TEXT,
  description TEXT,
  tags TEXT,
  download_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_spec_publications_spec_id ON spec_publications(spec_id);
CREATE INDEX IF NOT EXISTS idx_spec_publications_workspace_id ON spec_publications(workspace_id);
CREATE INDEX IF NOT EXISTS idx_spec_publications_created_at ON spec_publications(created_at DESC);
