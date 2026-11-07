-- AAV-007: durable, replay-safe projection of OMP JSONL-RPC orchestration events.
-- Payloads remain carried by the existing wal_events/LISTEN/SSE envelope.
CREATE TABLE rorca.orchestration_events (
  id BIGSERIAL PRIMARY KEY,
  source_key TEXT NOT NULL UNIQUE CHECK(source_key ~ '^sha256:[0-9a-f]{64}$'),
  request_hash TEXT NOT NULL,
  sequence BIGINT NOT NULL CHECK(sequence > 0),
  wal_event_id INTEGER NOT NULL UNIQUE REFERENCES rorca.wal_events(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  story_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  process_identity TEXT NOT NULL,
  spec_id TEXT NOT NULL,
  spec_version INTEGER NOT NULL CHECK(spec_version > 0),
  spec_hash TEXT NOT NULL CHECK(spec_hash ~ '^sha256:[0-9a-f]{64}$'),
  rpc_type TEXT NOT NULL,
  mapped_kind TEXT CHECK(mapped_kind IN('agent_started','task_started','agent_progress','agent_completed','agent_failed')),
  payload JSONB NOT NULL CHECK(payload->>'schemaVersion'='rorca.orchestration-event.v1'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(request_hash, sequence)
);

CREATE INDEX orchestration_events_identity_idx
  ON rorca.orchestration_events(run_id, story_id, attempt_id, sequence);
CREATE INDEX orchestration_events_unknown_idx
  ON rorca.orchestration_events(request_hash, sequence) WHERE mapped_kind IS NULL;

ALTER TABLE rorca.orchestration_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE rorca.orchestration_events FROM PUBLIC, authenticated, anon;
