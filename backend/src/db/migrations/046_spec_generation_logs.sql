CREATE TABLE IF NOT EXISTS spec_generation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spec_slug TEXT NOT NULL,
  model TEXT NOT NULL,
  provider TEXT,
  duration_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  context_summary TEXT NOT NULL,
  error TEXT,
  error_category TEXT,
  status TEXT NOT NULL DEFAULT 'completed',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_spec_generation_logs_slug ON spec_generation_logs(spec_slug);
