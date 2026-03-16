-- 20260316140000_integration_health.sql — Integration health check snapshots
-- Stores periodic health check results for connected integrations (GitHub, Linear, Vercel, Slack).
-- Populated by the integration:health-check pg-boss cron job every 5 minutes.

CREATE TABLE IF NOT EXISTS integration_health (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('healthy', 'degraded', 'disconnected')),
  error_rate NUMERIC DEFAULT 0,
  rate_limit_remaining INTEGER,
  rate_limit_max INTEGER,
  consecutive_failures INTEGER DEFAULT 0,
  last_success TIMESTAMPTZ,
  webhook_success_rate NUMERIC DEFAULT 1.0,
  last_error TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_integration_health_ws_provider ON integration_health(workspace_id, provider);
CREATE INDEX IF NOT EXISTS idx_integration_health_checked_at ON integration_health(checked_at);
