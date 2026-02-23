CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  source_spec_id TEXT NOT NULL,
  brief TEXT NOT NULL,
  story_structure TEXT NOT NULL,
  direction_layers TEXT,
  story_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
