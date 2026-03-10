-- 028_agent_hooks.sql — Agent lifecycle hooks

CREATE TABLE IF NOT EXISTS agent_hooks (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'on_generate','on_approve','on_reject',
    'on_run_start','on_run_complete',
    'on_story_pass','on_story_fail'
  )),
  command TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  timeout_seconds INTEGER NOT NULL DEFAULT 30,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
