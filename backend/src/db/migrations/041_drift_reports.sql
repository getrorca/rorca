-- CA-006: Convention drift detection reports
CREATE TABLE IF NOT EXISTS drift_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  violations_json TEXT NOT NULL DEFAULT '[]',
  score REAL NOT NULL DEFAULT 100,
  conventions_checked INTEGER NOT NULL DEFAULT 0,
  files_sampled INTEGER NOT NULL DEFAULT 0,
  trigger_type TEXT NOT NULL DEFAULT 'manual' CHECK(trigger_type IN ('manual', 'pre-execution')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_drift_reports_workspace ON drift_reports(workspace_id, created_at DESC);
