-- US-024: Integration audit log table
-- Immutable append-only log of all integration actions

CREATE TABLE IF NOT EXISTS integration_audit_log (
  id            SERIAL PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
  action        TEXT NOT NULL,
  actor_type    TEXT NOT NULL CHECK (actor_type IN ('user', 'system', 'webhook')),
  actor_id      TEXT,
  details       JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Filtered pagination: workspace + time descending
CREATE INDEX IF NOT EXISTS idx_integration_audit_log_ws_created
  ON integration_audit_log (workspace_id, created_at DESC);

-- Filtered by provider within a workspace
CREATE INDEX IF NOT EXISTS idx_integration_audit_log_ws_provider
  ON integration_audit_log (workspace_id, provider);
