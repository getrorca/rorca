-- V2-070: Custom agent profiles per workspace
CREATE TABLE IF NOT EXISTS agent_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  system_prompt_override TEXT,
  allowed_tools TEXT NOT NULL DEFAULT '[]',  -- JSON array of MCP tool names; empty = all
  model_override TEXT,
  is_active INTEGER NOT NULL DEFAULT 0,      -- only one active per workspace
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id, name)
);
