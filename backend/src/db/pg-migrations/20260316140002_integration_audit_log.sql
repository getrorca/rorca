-- US-027: Integration audit log for tracking outbound API call results (GitHub, Linear, Vercel, Slack).
-- Used by commit-status-poster and future integration modules to log success/failure of external calls
-- without ever blocking the pipeline.
--
-- Note: 20260316140001 may have already created integration_audit_log with different columns.
-- This migration adds the columns needed by commit-status-poster via ADD COLUMN IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS integration_audit_log (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,             -- 'github', 'linear', 'vercel', 'slack'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add columns needed by integration-audit-log.ts route (US-024 schema)
ALTER TABLE integration_audit_log ADD COLUMN IF NOT EXISTS action TEXT;
ALTER TABLE integration_audit_log ADD COLUMN IF NOT EXISTS actor_type TEXT;
ALTER TABLE integration_audit_log ADD COLUMN IF NOT EXISTS actor_id TEXT;
ALTER TABLE integration_audit_log ADD COLUMN IF NOT EXISTS details JSONB DEFAULT '{}';

-- Add columns needed by commit-status-poster.ts (US-027 schema)
ALTER TABLE integration_audit_log ADD COLUMN IF NOT EXISTS event_type TEXT;
ALTER TABLE integration_audit_log ADD COLUMN IF NOT EXISTS status_code INTEGER;
ALTER TABLE integration_audit_log ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE integration_audit_log ADD COLUMN IF NOT EXISTS payload JSONB;

CREATE INDEX IF NOT EXISTS idx_integration_audit_log_workspace ON integration_audit_log(workspace_id);
CREATE INDEX IF NOT EXISTS idx_integration_audit_log_created ON integration_audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_integration_audit_log_ws_created
  ON integration_audit_log (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_integration_audit_log_ws_provider
  ON integration_audit_log (workspace_id, provider);
