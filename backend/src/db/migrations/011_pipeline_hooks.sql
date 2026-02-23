-- V2-018: Pipeline hooks for pre/post run/story shell commands
CREATE TABLE IF NOT EXISTS pipeline_hooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  hook_type TEXT NOT NULL CHECK(hook_type IN ('pre_run','post_run','pre_story','post_story')),
  command TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
