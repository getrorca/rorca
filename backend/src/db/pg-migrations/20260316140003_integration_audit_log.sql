-- US-027: Integration audit log for tracking outbound API call results (GitHub, Linear, Vercel, Slack).
-- Used by commit-status-poster and future integration modules to log success/failure of external calls
-- without ever blocking the pipeline.

CREATE TABLE IF NOT EXISTS integration_audit_log (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,             -- 'github', 'linear', 'vercel', 'slack'
  event_type TEXT NOT NULL,           -- 'commit_status_posted', 'commit_status_failed', etc.
  status_code INTEGER,                -- HTTP status code from the external API (null if network error)
  error_message TEXT,                 -- Error message if the call failed
  payload JSONB,                      -- Request payload for debugging
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_integration_audit_log_workspace ON integration_audit_log(workspace_id);
CREATE INDEX IF NOT EXISTS idx_integration_audit_log_created ON integration_audit_log(created_at);
