-- 047_programmatic_tables.sql — Tables created programmatically in SQLite db/index.ts
-- Consolidated here for Postgres: run_queue, agent_config, convention_packs, installed_skills

-- RQ-001: Run queue for queued pipeline runs
CREATE TABLE IF NOT EXISTS run_queue (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  spec_id TEXT NOT NULL,
  spec_path TEXT NOT NULL,
  parallelism INTEGER NOT NULL DEFAULT 1,
  auto_worktree BOOLEAN NOT NULL DEFAULT FALSE,
  position INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  triggered_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_run_queue_workspace_status ON run_queue(workspace_id, status);

-- OC-009: Agent config for persisting execution engine settings
CREATE TABLE IF NOT EXISTS agent_config (
  id TEXT PRIMARY KEY,
  agent_type TEXT NOT NULL DEFAULT 'claude',
  agent_model TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- CA-001: Convention packs registry
CREATE TABLE IF NOT EXISTS convention_packs (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  pack_name TEXT NOT NULL,
  pack_version TEXT NOT NULL,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pack_path TEXT NOT NULL,
  forked_from TEXT,
  UNIQUE(workspace_id, pack_name)
);

CREATE INDEX IF NOT EXISTS idx_convention_packs_workspace ON convention_packs(workspace_id);

-- SK-001: Installed skills registry
CREATE TABLE IF NOT EXISTS installed_skills (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'user',
  content TEXT NOT NULL,
  category TEXT,
  tags TEXT,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_installed_skills_name ON installed_skills(name);
