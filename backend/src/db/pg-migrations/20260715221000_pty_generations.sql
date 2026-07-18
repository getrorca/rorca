-- Give every PTY story attempt an immutable generation identity.
-- Historical run-scoped rows remain untouched: nullable generation references
-- deliberately identify them as legacy data and a sentinel generation supplies
-- metadata for LEFT JOIN replay without rewriting bytes or sequence numbers.

CREATE TABLE IF NOT EXISTS pty_generations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id BIGINT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  story_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt >= 0),
  generation_token UUID NOT NULL DEFAULT gen_random_uuid(),
  source TEXT NOT NULL DEFAULT 'native'
    CHECK (source IN ('native', 'legacy')),
  replay_source TEXT NOT NULL DEFAULT 'generation'
    CHECK (replay_source IN ('generation', 'legacy_run_output', 'legacy_pty_output')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'superseded', 'exited', 'killed', 'failed', 'timed_out', 'legacy')),
  cwd TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  child_pid INTEGER,
  cols INTEGER NOT NULL DEFAULT 120 CHECK (cols BETWEEN 1 AND 500),
  rows INTEGER NOT NULL DEFAULT 36 CHECK (rows BETWEEN 1 AND 200),
  next_output_sequence BIGINT NOT NULL DEFAULT 1 CHECK (next_output_sequence >= 1),
  total_output_bytes BIGINT NOT NULL DEFAULT 0 CHECK (total_output_bytes >= 0),
  total_stored_bytes BIGINT NOT NULL DEFAULT 0 CHECK (total_stored_bytes >= 0),
  dropped_output_bytes BIGINT NOT NULL DEFAULT 0 CHECK (dropped_output_bytes >= 0),
  pending_input_bytes BIGINT NOT NULL DEFAULT 0 CHECK (pending_input_bytes >= 0),
  last_input_request_id BIGINT,
  last_resize_request_id BIGINT,
  checkpoint_sequence BIGINT NOT NULL DEFAULT 0 CHECK (checkpoint_sequence >= 0),
  checkpoint_at TIMESTAMPTZ,
  checkpoint_reference TEXT,
  completion_marker TEXT,
  completion_marker_seen_at TIMESTAMPTZ,
  completion_file_seen_at TIMESTAMPTZ,
  completion_file_error TEXT,
  terminal_marker_seen_at TIMESTAMPTZ,
  prompt_readiness_status TEXT,
  prompt_readiness_reason TEXT,
  prompt_ready_at TIMESTAMPTZ,
  prompt_injected_at TIMESTAMPTZ,
  exit_code INTEGER,
  exit_signal TEXT,
  archive_reference TEXT,
  archive_checksum TEXT,
  archived_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_output_at TIMESTAMPTZ,
  last_heartbeat_at TIMESTAMPTZ,
  output_truncated_at TIMESTAMPTZ,
  superseded_at TIMESTAMPTZ,
  exited_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pty_generations_identity_unique
    UNIQUE (run_id, story_id, attempt, generation_token),
  CONSTRAINT pty_generations_token_unique UNIQUE (generation_token),
  CONSTRAINT pty_generations_active_state_check
    CHECK ((is_active AND status = 'active') OR (NOT is_active AND status <> 'active')),
  CONSTRAINT pty_generations_legacy_state_check
    CHECK ((source = 'legacy' AND story_id = '__legacy__' AND attempt = 0 AND NOT is_active AND status = 'legacy')
      OR source = 'native')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pty_generations_one_active_run
  ON pty_generations (run_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_pty_generations_active_token
  ON pty_generations (run_id, generation_token) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_pty_generations_story_attempt
  ON pty_generations (run_id, story_id, attempt DESC, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_pty_generations_replay
  ON pty_generations (run_id, is_active DESC, started_at DESC, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pty_generations_one_legacy_run
  ON pty_generations (run_id) WHERE source = 'legacy';

CREATE OR REPLACE FUNCTION prevent_pty_generation_identity_update()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.story_id IS DISTINCT FROM OLD.story_id
     OR NEW.attempt IS DISTINCT FROM OLD.attempt
     OR NEW.generation_token IS DISTINCT FROM OLD.generation_token
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.replay_source IS DISTINCT FROM OLD.replay_source THEN
    RAISE EXCEPTION 'PTY generation identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pty_generation_identity_immutable ON pty_generations;
CREATE TRIGGER trg_pty_generation_identity_immutable
  BEFORE UPDATE ON pty_generations
  FOR EACH ROW EXECUTE FUNCTION prevent_pty_generation_identity_update();

ALTER TABLE run_pty_output_chunks ADD COLUMN IF NOT EXISTS generation_id UUID;
ALTER TABLE run_pty_input_requests ADD COLUMN IF NOT EXISTS generation_id UUID;
ALTER TABLE run_pty_resize_requests ADD COLUMN IF NOT EXISTS generation_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'run_pty_output_chunks_generation_fk') THEN
    ALTER TABLE run_pty_output_chunks
      ADD CONSTRAINT run_pty_output_chunks_generation_fk
      FOREIGN KEY (generation_id) REFERENCES pty_generations(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'run_pty_input_requests_generation_fk') THEN
    ALTER TABLE run_pty_input_requests
      ADD CONSTRAINT run_pty_input_requests_generation_fk
      FOREIGN KEY (generation_id) REFERENCES pty_generations(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'run_pty_resize_requests_generation_fk') THEN
    ALTER TABLE run_pty_resize_requests
      ADD CONSTRAINT run_pty_resize_requests_generation_fk
      FOREIGN KEY (generation_id) REFERENCES pty_generations(id) ON DELETE CASCADE;
  END IF;
END $$;

-- The old run-only uniqueness would reject sequence 1 in a later generation.
-- Preserve legacy uniqueness separately while giving every generation its own
-- ordered sequence space.
ALTER TABLE run_pty_output_chunks
  DROP CONSTRAINT IF EXISTS run_pty_output_chunks_run_id_sequence_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_run_pty_output_chunks_legacy_run_seq
  ON run_pty_output_chunks (run_id, sequence) WHERE generation_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_run_pty_output_chunks_generation_seq
  ON run_pty_output_chunks (generation_id, sequence) WHERE generation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_run_pty_output_chunks_generation_replay
  ON run_pty_output_chunks (generation_id, sequence, id);
CREATE INDEX IF NOT EXISTS idx_run_pty_input_requests_generation_pending
  ON run_pty_input_requests (generation_id, applied_at, id);
CREATE INDEX IF NOT EXISTS idx_run_pty_resize_requests_generation_pending
  ON run_pty_resize_requests (generation_id, applied_at, id);

-- One sentinel per existing run with any historical terminal bytes/session.
-- ON CONFLICT plus the unique identity makes migration restart safe. Existing
-- session/chunk/control rows intentionally keep generation_id NULL.
INSERT INTO pty_generations (
  run_id, workspace_id, story_id, attempt, generation_token, source,
  replay_source, is_active, status, cwd, agent_type, child_pid, cols, rows,
  next_output_sequence, total_output_bytes, total_stored_bytes,
  dropped_output_bytes, completion_marker, completion_marker_seen_at,
  completion_file_seen_at, completion_file_error, terminal_marker_seen_at,
  prompt_readiness_status, prompt_readiness_reason, prompt_ready_at,
  prompt_injected_at, exit_code, exit_signal, started_at, last_output_at,
  last_heartbeat_at, output_truncated_at, exited_at, updated_at
)
SELECT
  pr.id,
  pr.workspace_id,
  '__legacy__',
  0,
  gen_random_uuid(),
  'legacy',
  CASE WHEN EXISTS (
    SELECT 1 FROM run_pty_output_chunks pc WHERE pc.run_id = pr.id
  ) THEN 'legacy_pty_output' ELSE 'legacy_run_output' END,
  FALSE,
  'legacy',
  COALESCE(ps.cwd, w.path),
  COALESCE(ps.agent_type, pr.agent_type, pr.agent, 'unknown'),
  ps.child_pid,
  COALESCE(ps.cols, 120),
  COALESCE(ps.rows, 36),
  COALESCE((SELECT MAX(pc.sequence) + 1 FROM run_pty_output_chunks pc WHERE pc.run_id = pr.id), 1),
  COALESCE(ps.total_output_bytes, 0),
  COALESCE(ps.total_stored_bytes, 0),
  COALESCE(ps.dropped_output_bytes, 0),
  ps.completion_marker,
  ps.completion_marker_seen_at,
  ps.completion_file_seen_at,
  ps.completion_file_error,
  ps.terminal_marker_seen_at,
  ps.prompt_readiness_status,
  ps.prompt_readiness_reason,
  ps.prompt_ready_at,
  ps.prompt_injected_at,
  ps.exit_code,
  ps.exit_signal,
  COALESCE(ps.started_at, pr.started_at, pr.created_at, NOW()),
  ps.last_output_at,
  ps.last_heartbeat_at,
  ps.output_truncated_at,
  ps.exited_at,
  COALESCE(ps.updated_at, pr.finished_at, pr.started_at, pr.created_at, NOW())
FROM pipeline_runs pr
JOIN workspaces w ON w.id = pr.workspace_id
LEFT JOIN run_pty_sessions ps ON ps.run_id = pr.id
WHERE ps.run_id IS NOT NULL
   OR EXISTS (SELECT 1 FROM run_pty_output_chunks pc WHERE pc.run_id = pr.id)
   OR EXISTS (SELECT 1 FROM run_output_chunks rc WHERE rc.run_id = pr.id)
ON CONFLICT DO NOTHING;
