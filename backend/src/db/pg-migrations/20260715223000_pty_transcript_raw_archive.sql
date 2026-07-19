-- Versioned structured PTY transcripts and restricted lossless raw archives.
-- Transcript rows are generation-scoped evidence; presentation rows are never
-- lifecycle authority. Raw bytes remain outside PostgreSQL in workspace-local
-- gzip segments while this manifest keeps integrity and retention metadata.

-- Composite identities support generation/run defense in depth without
-- weakening the generation primary identity.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pty_generations_id_run_unique
  ON pty_generations (id, run_id);

CREATE TABLE IF NOT EXISTS pty_transcript_heads (
  generation_id UUID PRIMARY KEY REFERENCES pty_generations(id) ON DELETE CASCADE,
  next_seq BIGINT NOT NULL DEFAULT 1 CHECK (next_seq >= 1),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pty_transcript_events (
  event_id UUID PRIMARY KEY,
  contract_version INTEGER NOT NULL DEFAULT 1 CHECK (contract_version = 1),
  generation_id UUID NOT NULL REFERENCES pty_generations(id) ON DELETE CASCADE,
  run_id BIGINT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  story_id TEXT NOT NULL,
  seq BIGINT NOT NULL CHECK (seq >= 1),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'model_message', 'tool_call', 'tool_result', 'host_notice', 'error', 'gap'
  )),
  event_source TEXT NOT NULL CHECK (event_source IN (
    'structured', 'terminal_normalized', 'host', 'recovery'
  )),
  role TEXT CHECK (role IS NULL OR role IN ('assistant', 'system', 'tool', 'host')),
  correlation_id TEXT,
  payload JSONB NOT NULL,
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes BETWEEN 1 AND 16384),
  payload_sha256 CHAR(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  redacted BOOLEAN NOT NULL DEFAULT FALSE,
  truncated BOOLEAN NOT NULL DEFAULT FALSE,
  presentation BOOLEAN NOT NULL DEFAULT FALSE,
  authoritative BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (generation_id, seq),
  CONSTRAINT pty_transcript_presentation_not_authority
    CHECK (NOT presentation OR NOT authoritative),
  CONSTRAINT pty_transcript_terminal_is_presentation
    CHECK (event_source <> 'terminal_normalized' OR presentation),
  CONSTRAINT pty_transcript_tool_correlation
    CHECK (event_type NOT IN ('tool_call', 'tool_result') OR correlation_id IS NOT NULL),
  CONSTRAINT pty_transcript_generation_identity_fk
    FOREIGN KEY (generation_id, run_id)
    REFERENCES pty_generations(id, run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pty_transcript_generation_seq
  ON pty_transcript_events (generation_id, seq);
CREATE INDEX IF NOT EXISTS idx_pty_transcript_run_generation_seq
  ON pty_transcript_events (run_id, generation_id, seq);
CREATE INDEX IF NOT EXISTS idx_pty_transcript_correlation
  ON pty_transcript_events (generation_id, correlation_id, seq)
  WHERE correlation_id IS NOT NULL;

CREATE OR REPLACE FUNCTION reject_pty_transcript_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'PTY transcript events are append-only'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pty_transcript_no_mutation ON pty_transcript_events;
DROP TRIGGER IF EXISTS trg_pty_transcript_no_update ON pty_transcript_events;
CREATE TRIGGER trg_pty_transcript_no_mutation
  BEFORE UPDATE OR DELETE ON pty_transcript_events
  FOR EACH ROW EXECUTE FUNCTION reject_pty_transcript_mutation();

CREATE TABLE IF NOT EXISTS pty_raw_archive_manifests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_version INTEGER NOT NULL DEFAULT 1 CHECK (contract_version = 1),
  generation_id UUID NOT NULL UNIQUE REFERENCES pty_generations(id) ON DELETE CASCADE,
  run_id BIGINT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  story_id TEXT NOT NULL,
  archive_root_relative TEXT NOT NULL,
  compression TEXT NOT NULL DEFAULT 'gzip' CHECK (compression = 'gzip'),
  segment_max_raw_bytes INTEGER NOT NULL CHECK (segment_max_raw_bytes BETWEEN 4096 AND 67108864),
  next_raw_offset BIGINT NOT NULL DEFAULT 0 CHECK (next_raw_offset >= 0),
  completion_state TEXT NOT NULL DEFAULT 'writing' CHECK (completion_state IN (
    'writing', 'complete', 'failed', 'interrupted', 'corrupt', 'pruned'
  )),
  restricted_evidence BOOLEAN NOT NULL DEFAULT TRUE CHECK (restricted_evidence),
  retention_days INTEGER NOT NULL CHECK (retention_days BETWEEN 1 AND 3650),
  retention_expires_at TIMESTAMPTZ NOT NULL,
  gaps JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  reconciled_at TIMESTAMPTZ,
  pruned_at TIMESTAMPTZ,
  failure_code TEXT,
  failure_message TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pty_raw_archive_generation_identity_fk
    FOREIGN KEY (generation_id, run_id)
    REFERENCES pty_generations(id, run_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pty_raw_archive_manifest_id_generation_unique
  ON pty_raw_archive_manifests (id, generation_id);

CREATE TABLE IF NOT EXISTS pty_raw_archive_segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  manifest_id UUID NOT NULL REFERENCES pty_raw_archive_manifests(id) ON DELETE CASCADE,
  generation_id UUID NOT NULL REFERENCES pty_generations(id) ON DELETE CASCADE,
  segment_index INTEGER NOT NULL CHECK (segment_index >= 0),
  relative_path TEXT NOT NULL,
  raw_start BIGINT NOT NULL CHECK (raw_start >= 0),
  raw_end BIGINT NOT NULL CHECK (raw_end >= raw_start),
  raw_size BIGINT NOT NULL CHECK (raw_size = raw_end - raw_start),
  compressed_size BIGINT NOT NULL CHECK (compressed_size >= 0),
  sha256 CHAR(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  compression TEXT NOT NULL DEFAULT 'gzip' CHECK (compression = 'gzip'),
  completion_state TEXT NOT NULL CHECK (completion_state IN (
    'complete', 'missing', 'corrupt', 'pruned'
  )),
  first_byte_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  pruned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (manifest_id, segment_index),
  UNIQUE (manifest_id, relative_path),
  CONSTRAINT pty_raw_archive_segment_generation_fk
    FOREIGN KEY (manifest_id, generation_id)
    REFERENCES pty_raw_archive_manifests(id, generation_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pty_raw_archive_manifest_retention
  ON pty_raw_archive_manifests (retention_expires_at)
  WHERE completion_state <> 'pruned';
CREATE INDEX IF NOT EXISTS idx_pty_raw_archive_segments_order
  ON pty_raw_archive_segments (manifest_id, segment_index);

-- pg-boss owns pgboss.*; this migration intentionally creates no queue tables.
