-- Migration: 20260706120000_context_event_distillation
-- Purpose: UCC-008 autonomous context-event to memory-candidate distillation.
-- Notes: Does not touch pgboss.*; queue infrastructure remains pg-boss managed.

ALTER TABLE context_events
  ADD COLUMN IF NOT EXISTS distillation_status TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS distillation_attempted_at TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS distilled_at TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS distillation_error TEXT DEFAULT NULL;

ALTER TABLE memory_candidates
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS category TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS content TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS confidence TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS candidate_hash TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS source_content_hash TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS source_event_id TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS source_session_id TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS evidence_snippets JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS review_reason TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS security_sensitive BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS default_retrieval_eligible BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS dedupe_key TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS approved_memory_id INTEGER DEFAULT NULL REFERENCES memories(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ DEFAULT NULL;

CREATE TABLE IF NOT EXISTS memory_distillation_settings (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'conservative-auto-candidates',
  operator_auto_approve BOOLEAN NOT NULL DEFAULT false,
  llm_summarization BOOLEAN NOT NULL DEFAULT false,
  max_events_per_job INTEGER NOT NULL DEFAULT 25,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'context_events_distillation_status_check'
  ) THEN
    ALTER TABLE context_events
      ADD CONSTRAINT context_events_distillation_status_check
      CHECK (distillation_status IS NULL OR distillation_status IN ('skipped', 'candidate', 'auto_approved', 'error'))
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'memory_candidates_status_ucc008_check'
  ) THEN
    ALTER TABLE memory_candidates
      ADD CONSTRAINT memory_candidates_status_ucc008_check
      CHECK (status IN ('pending', 'review_required', 'approved', 'rejected', 'auto_approved'))
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'memory_distillation_settings_mode_check'
  ) THEN
    ALTER TABLE memory_distillation_settings
      ADD CONSTRAINT memory_distillation_settings_mode_check
      CHECK (mode IN ('off', 'explicit-only', 'conservative-auto-candidates', 'trusted-auto-approve'))
      NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_context_events_distillation_pending
  ON context_events(workspace_id, id)
  WHERE distillation_status IS NULL;

CREATE INDEX IF NOT EXISTS idx_memory_candidates_status
  ON memory_candidates(workspace_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_candidates_source_session
  ON memory_candidates(workspace_id, source_session_id)
  WHERE source_session_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_candidates_ucc008_dedupe
  ON memory_candidates(workspace_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
