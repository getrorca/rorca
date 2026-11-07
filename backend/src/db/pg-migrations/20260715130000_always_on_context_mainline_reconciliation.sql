-- Wave 1: reconcile production-ready Always-On Context behavior with the
-- canonical CCS context_events/memory_candidates schema already on main.
--
-- This migration is additive. It deliberately does not introduce UCC's former
-- parallel status/category/content candidate columns, does not rewrite historic
-- rows, and never touches pgboss.* (pg-boss owns its schema and partitions).

ALTER TABLE context_events
  ADD COLUMN IF NOT EXISTS payload_schema_version TEXT,
  ADD COLUMN IF NOT EXISTS tool_name TEXT,
  ADD COLUMN IF NOT EXISTS host_application TEXT,
  ADD COLUMN IF NOT EXISTS session_id TEXT,
  ADD COLUMN IF NOT EXISTS repo_path_hash TEXT,
  ADD COLUMN IF NOT EXISTS git_branch TEXT,
  ADD COLUMN IF NOT EXISTS git_sha TEXT,
  ADD COLUMN IF NOT EXISTS capture_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS distillation_status TEXT,
  ADD COLUMN IF NOT EXISTS distillation_attempted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS distilled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS distillation_error TEXT;

ALTER TABLE memory_candidates
  ADD COLUMN IF NOT EXISTS payload_schema_version TEXT,
  ADD COLUMN IF NOT EXISTS tool_name TEXT,
  ADD COLUMN IF NOT EXISTS host_application TEXT,
  ADD COLUMN IF NOT EXISTS session_id TEXT,
  ADD COLUMN IF NOT EXISTS repo_path_hash TEXT,
  ADD COLUMN IF NOT EXISTS git_branch TEXT,
  ADD COLUMN IF NOT EXISTS git_sha TEXT,
  ADD COLUMN IF NOT EXISTS capture_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS candidate_hash TEXT,
  ADD COLUMN IF NOT EXISTS source_content_hash TEXT,
  ADD COLUMN IF NOT EXISTS source_event_id TEXT,
  ADD COLUMN IF NOT EXISTS source_session_id TEXT,
  ADD COLUMN IF NOT EXISTS evidence_snippets JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS review_reason TEXT,
  ADD COLUMN IF NOT EXISTS default_retrieval_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS dedupe_key TEXT,
  ADD COLUMN IF NOT EXISTS external_import_id TEXT,
  ADD COLUMN IF NOT EXISTS source_vendor TEXT,
  ADD COLUMN IF NOT EXISTS source_original_id TEXT,
  ADD COLUMN IF NOT EXISTS import_adapter TEXT;

CREATE TABLE IF NOT EXISTS memory_distillation_settings (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'conservative-auto-candidates'
    CHECK (mode IN ('off', 'explicit-only', 'conservative-auto-candidates', 'trusted-auto-approve')),
  operator_auto_approve BOOLEAN NOT NULL DEFAULT FALSE,
  llm_summarization BOOLEAN NOT NULL DEFAULT FALSE,
  max_events_per_job INTEGER NOT NULL DEFAULT 25 CHECK (max_events_per_job BETWEEN 1 AND 100),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS context_capture_settings (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  policy_mode TEXT NOT NULL DEFAULT 'off'
    CHECK (policy_mode IN ('off', 'metadata-only', 'repo-and-command', 'ide-assisted', 'full')),
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
  event_type TEXT NOT NULL CHECK (event_type IN (
    'install', 'uninstall', 'pause', 'resume', 'policy_update',
    'capture_submitted', 'capture_suppressed'
  )),
  integration_id TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  redaction_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  regulated_flags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'context_events_distillation_status_mainline_check'
  ) THEN
    ALTER TABLE context_events
      ADD CONSTRAINT context_events_distillation_status_mainline_check
      CHECK (distillation_status IS NULL OR distillation_status IN ('skipped', 'candidate', 'auto_approved', 'error'))
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'memory_candidates_default_retrieval_mainline_check'
  ) THEN
    ALTER TABLE memory_candidates
      ADD CONSTRAINT memory_candidates_default_retrieval_mainline_check
      CHECK (NOT default_retrieval_eligible OR review_status = 'approved')
      NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_context_events_distillation_pending
  ON context_events(workspace_id, id)
  WHERE distillation_status IS NULL;

CREATE INDEX IF NOT EXISTS idx_memory_candidates_source_session
  ON memory_candidates(workspace_id, source_session_id)
  WHERE source_session_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_candidates_always_on_dedupe
  ON memory_candidates(workspace_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memory_candidates_external_import_vendor
  ON memory_candidates(workspace_id, source_vendor, created_at DESC)
  WHERE source_vendor IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_candidates_external_import_idempotency
  ON memory_candidates(workspace_id, external_import_id, dedupe_key)
  WHERE external_import_id IS NOT NULL AND dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_context_capture_audit_workspace_time
  ON context_capture_audit_log(workspace_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_context_capture_settings_paused_policy
  ON context_capture_settings(paused, policy_mode);
