CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  path TEXT NOT NULL,
  domains TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS direction_layers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT,
  domain TEXT,
  layer INTEGER NOT NULL CHECK(layer IN (1,2,3)),
  content_yaml TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_direction_layers_unique
  ON direction_layers(layer, COALESCE(workspace_id,''), COALESCE(domain,''));

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spec_path TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  status TEXT NOT NULL CHECK(status IN ('running','paused','done','failed')),
  pid INTEGER,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS story_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES pipeline_runs(id),
  story_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pass','fail','skip','retry')),
  retries INTEGER NOT NULL DEFAULT 0,
  log_path TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS wal_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  event_type TEXT NOT NULL,
  workspace_id TEXT,
  spec_id TEXT,
  story_id TEXT,
  actor TEXT NOT NULL DEFAULT 'ralph',
  payload TEXT
);
