-- US-026: Add workflow_config JSONB column to workspace_github_webhooks.
-- Stores the GitHub Actions workflow dispatch configuration per workspace.
-- Schema: { enabled: boolean, workflow_id: string, ref: string, inputs: Record<string, string> }

ALTER TABLE workspace_github_webhooks
  ADD COLUMN IF NOT EXISTS workflow_config JSONB DEFAULT NULL;
