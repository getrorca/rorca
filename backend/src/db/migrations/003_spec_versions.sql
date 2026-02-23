CREATE TABLE IF NOT EXISTS spec_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spec_slug TEXT NOT NULL,
  version INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),
  rejection_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(spec_slug, version)
);
