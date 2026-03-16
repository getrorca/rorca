-- Add review_config JSONB column to workspace_github_webhooks
-- Stores: default reviewers, team reviewers, conditional rules, CODEOWNERS-style path rules
ALTER TABLE workspace_github_webhooks ADD COLUMN IF NOT EXISTS review_config JSONB DEFAULT '{}';
