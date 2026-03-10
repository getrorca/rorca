-- 011_pipeline_hooks.sql — Pre/post run/story shell commands + webhooks

CREATE TABLE IF NOT EXISTS pipeline_hooks (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  hook_type TEXT NOT NULL CHECK(hook_type IN ('pre_run','post_run','pre_story','post_story')),
  command TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  webhook_url TEXT,
  encrypted_webhook_secret TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
