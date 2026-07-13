-- Privacy/consent controls for always-on universal context capture.
-- Stores operator-level capture policy and local audit summaries only; raw payloads are never persisted here.

CREATE TABLE IF NOT EXISTS context_capture_settings (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  policy_mode TEXT NOT NULL DEFAULT 'off' CHECK (policy_mode IN ('off', 'metadata-only', 'repo-and-command', 'ide-assisted', 'full')),
  paused BOOLEAN NOT NULL DEFAULT FALSE,
  redaction_policy_version TEXT NOT NULL DEFAULT '2026-07-ucc-007',
  active_integrations JSONB NOT NULL DEFAULT '{}'::jsonb,
  ignored_paths JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_event_at TIMESTAMPTZ,
  last_event_type TEXT,
  last_integration_id TEXT,
  last_redaction_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS context_capture_audit_log (
  id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('install', 'uninstall', 'pause', 'resume', 'policy_update', 'capture_submitted', 'capture_suppressed')),
  integration_id TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  redaction_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  regulated_flags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]
);

CREATE INDEX IF NOT EXISTS idx_context_capture_audit_workspace_time
  ON context_capture_audit_log(workspace_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_context_capture_settings_paused_policy
  ON context_capture_settings(paused, policy_mode);
