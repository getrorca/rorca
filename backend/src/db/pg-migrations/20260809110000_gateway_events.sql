-- HMG-010: durable projection for the closed Hermes gateway event family.
-- The existing wal_events/LISTEN/SSE envelope remains the only transport.
CREATE TABLE rorca.gateway_events (
  id BIGSERIAL PRIMARY KEY,
  source_key TEXT NOT NULL UNIQUE CHECK(source_key ~ '^sha256:[0-9a-f]{64}$'),
  sequence BIGINT NOT NULL CHECK(sequence > 0),
  wal_event_id INTEGER NOT NULL UNIQUE REFERENCES rorca.wal_events(id) ON DELETE CASCADE,
  event_kind TEXT NOT NULL CHECK(event_kind IN(
    'mission_draft_ready','decision_required','gate_blocked','source_drift','run_completed','release_ready'
  )),
  workspace_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  spec_id TEXT NOT NULL,
  spec_version INTEGER NOT NULL CHECK(spec_version > 0),
  spec_hash TEXT NOT NULL CHECK(spec_hash ~ '^sha256:[0-9a-f]{64}$'),
  run_id TEXT,
  story_id TEXT,
  attempt_id TEXT,
  payload JSONB NOT NULL CHECK(payload->>'schemaVersion'='rorca.gateway-event.v1'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(workspace_id, mission_id, sequence)
);

CREATE INDEX gateway_events_spec_identity_idx
  ON rorca.gateway_events(workspace_id, spec_id, spec_version, sequence);
CREATE INDEX gateway_events_run_identity_idx
  ON rorca.gateway_events(run_id, story_id, attempt_id, sequence) WHERE run_id IS NOT NULL;

ALTER TABLE rorca.gateway_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE rorca.gateway_events FROM PUBLIC, authenticated, anon;
