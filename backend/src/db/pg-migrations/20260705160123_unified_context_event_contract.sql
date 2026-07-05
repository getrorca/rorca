-- Migration: 20260705160123_unified_context_event_contract
-- Purpose: Brownfield-compatible UCC-007 unified context event payload contract.

CREATE TABLE IF NOT EXISTS context_events (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  occurred_at TIMESTAMPTZ DEFAULT NULL,
  workspace_id TEXT DEFAULT NULL,
  event_type TEXT DEFAULT NULL,
  payload JSONB DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS memory_candidates (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  workspace_id TEXT DEFAULT NULL,
  payload JSONB DEFAULT NULL
);

ALTER TABLE context_events
  ADD COLUMN IF NOT EXISTS payload_schema_version TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS source_system TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS tool_name TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS host_application TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS session_id TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS repo_path_hash TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS git_branch TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS git_sha TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS related_files JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS capture_policy JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS trust_tier TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS provenance JSONB DEFAULT NULL;

ALTER TABLE memory_candidates
  ADD COLUMN IF NOT EXISTS context_event_id BIGINT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS event_type TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS payload_schema_version TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS source_system TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS tool_name TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS host_application TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS session_id TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS repo_path_hash TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS git_branch TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS git_sha TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS related_files JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS capture_policy JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS trust_tier TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS provenance JSONB DEFAULT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'context_events_event_type_ucc007_check'
  ) THEN
    ALTER TABLE context_events
      ADD CONSTRAINT context_events_event_type_ucc007_check
      CHECK (event_type IS NULL OR event_type IN ('agent_cli_session', 'ide_session', 'shell_command', 'editor_activity', 'explicit_memory', 'git_commit', 'ci_pr'))
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'memory_candidates_event_type_ucc007_check'
  ) THEN
    ALTER TABLE memory_candidates
      ADD CONSTRAINT memory_candidates_event_type_ucc007_check
      CHECK (event_type IS NULL OR event_type IN ('agent_cli_session', 'ide_session', 'shell_command', 'editor_activity', 'explicit_memory', 'git_commit', 'ci_pr'))
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'context_events_trust_tier_ucc007_check'
  ) THEN
    ALTER TABLE context_events
      ADD CONSTRAINT context_events_trust_tier_ucc007_check
      CHECK (trust_tier IS NULL OR trust_tier IN ('untrusted', 'local', 'verified', 'privileged'))
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'memory_candidates_trust_tier_ucc007_check'
  ) THEN
    ALTER TABLE memory_candidates
      ADD CONSTRAINT memory_candidates_trust_tier_ucc007_check
      CHECK (trust_tier IS NULL OR trust_tier IN ('untrusted', 'local', 'verified', 'privileged'))
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'context_events_schema_version_ucc007_check'
  ) THEN
    ALTER TABLE context_events
      ADD CONSTRAINT context_events_schema_version_ucc007_check
      CHECK (payload_schema_version IS NULL OR payload_schema_version = '2026-07-ucc-007.v1')
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'memory_candidates_schema_version_ucc007_check'
  ) THEN
    ALTER TABLE memory_candidates
      ADD CONSTRAINT memory_candidates_schema_version_ucc007_check
      CHECK (payload_schema_version IS NULL OR payload_schema_version = '2026-07-ucc-007.v1')
      NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_context_events_ucc007_event_type ON context_events(event_type);
CREATE INDEX IF NOT EXISTS idx_context_events_ucc007_workspace_source ON context_events(workspace_id, source_system);
CREATE INDEX IF NOT EXISTS idx_context_events_ucc007_git_sha ON context_events(git_sha);
CREATE UNIQUE INDEX IF NOT EXISTS idx_context_events_ucc007_idempotency ON context_events(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memory_candidates_ucc007_event_type ON memory_candidates(event_type);
CREATE INDEX IF NOT EXISTS idx_memory_candidates_ucc007_context_event ON memory_candidates(context_event_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_candidates_ucc007_idempotency ON memory_candidates(idempotency_key) WHERE idempotency_key IS NOT NULL;
