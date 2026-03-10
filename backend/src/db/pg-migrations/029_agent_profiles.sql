-- 029_agent_profiles.sql — Custom agent profiles per workspace

CREATE TABLE IF NOT EXISTS agent_profiles (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  system_prompt_override TEXT,
  allowed_tools JSONB NOT NULL DEFAULT '[]',
  model_override TEXT,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(workspace_id, name)
);
