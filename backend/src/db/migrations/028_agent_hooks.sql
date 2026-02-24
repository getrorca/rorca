-- V2-069: Agent hooks — shell commands triggered by Rorcha lifecycle events
CREATE TABLE IF NOT EXISTS agent_hooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'on_generate','on_approve','on_reject',
    'on_run_start','on_run_complete',
    'on_story_pass','on_story_fail'
  )),
  command TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  timeout_seconds INTEGER NOT NULL DEFAULT 30,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
