-- 001_init.sql — Core tables: workspaces, direction_layers, pipeline_runs, story_results, wal_events

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  path TEXT NOT NULL,
  domains TEXT NOT NULL DEFAULT '[]',
  pr_template TEXT,
  pipeline_config TEXT NOT NULL DEFAULT '{}',
  roi_hours_per_story REAL NOT NULL DEFAULT 4.0,
  roi_hourly_rate REAL NOT NULL DEFAULT 75.0,
  default_parallelism INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS direction_layers (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT,
  domain TEXT,
  team_id TEXT,
  layer INTEGER NOT NULL CHECK(layer IN (0,1,2,3)),
  content_yaml TEXT NOT NULL DEFAULT '',
  preferred_model TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_direction_layers_unique
  ON direction_layers(layer, COALESCE(workspace_id,''), COALESCE(domain,''), COALESCE(team_id,''));

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id SERIAL PRIMARY KEY,
  spec_path TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  status TEXT NOT NULL CHECK(status IN ('running','paused','done','failed','partial_failure','cancelled','queued')),
  pid INTEGER,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  branch_name TEXT,
  worktree_path TEXT,
  trigger_type TEXT NOT NULL DEFAULT 'manual',
  retried_from_run_id INTEGER REFERENCES pipeline_runs(id),
  log_path TEXT,
  agent TEXT,
  agent_type TEXT,
  agent_model TEXT,
  opencode_server_pid INTEGER,
  total_input_tokens INTEGER,
  total_output_tokens INTEGER,
  total_cost_usd REAL,
  parallelism INTEGER NOT NULL DEFAULT 1,
  context_preview TEXT,
  queued_at TIMESTAMPTZ,
  queue_position INTEGER
);

CREATE TABLE IF NOT EXISTS story_results (
  id SERIAL PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES pipeline_runs(id),
  story_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pass','fail','skip','retry','timeout','excluded')),
  retries INTEGER NOT NULL DEFAULT 0,
  log_path TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  elapsed_seconds INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  model_used TEXT,
  cost_usd REAL,
  worktree_path TEXT,
  worktree_branch TEXT,
  blocked_by TEXT,
  active_skills TEXT
);

CREATE TABLE IF NOT EXISTS wal_events (
  id SERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  event_type TEXT NOT NULL,
  workspace_id TEXT,
  spec_id TEXT,
  story_id TEXT,
  actor TEXT NOT NULL DEFAULT 'ralph',
  payload JSONB
);
