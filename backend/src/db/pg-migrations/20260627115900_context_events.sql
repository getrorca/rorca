-- US-004: Raw context events — the durable ledger of knowledge captured from OUTSIDE a Rorca run.
--
-- Per the Context Intelligence Platform contract (docs/context-intelligence-platform.md §3),
-- the Rorca DB is the ONLY system of record for captured knowledge. The capture sidecar
-- (rorca-capture, US-025+) submits events through the ingestion API (US-032) — never by direct
-- DB writes — and tolerates being offline via a local JSONL queue that is *idempotently* flushed
-- here once connectivity returns. The idempotency key carried by each submission is what makes
-- that flush safe to replay, so it is enforced as a uniqueness constraint at the DB boundary.
--
-- A context event is RAW provenance: it records that something happened in a source system
-- (a commit, a manual note, a server-side repo scan). It is NOT reviewed knowledge — distilled,
-- reviewable knowledge lives in memory_candidates and only ever influences retrieval after a
-- human approves it (the governance gate, US-035).

CREATE TABLE IF NOT EXISTS context_events (
  id              BIGSERIAL PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  -- Provenance: where the event came from and what it points at in that source.
  source_system   TEXT NOT NULL,                  -- e.g. 'rorca-capture', 'git', 'manual'
  source_ref      TEXT,                            -- e.g. commit SHA, file path, note id
  event_type      TEXT NOT NULL,                   -- e.g. 'commit', 'manual_note', 'file_change'
  actor           TEXT,                            -- who/what produced the event (author, user, daemon)

  -- When the event happened in the source system (NOT when Rorca ingested it — see created_at).
  occurred_at     TIMESTAMPTZ NOT NULL,

  summary         TEXT,                            -- short human-readable description
  payload         JSONB NOT NULL DEFAULT '{}',     -- redacted, structured event body (US-005 sanitizes upstream)

  -- Idempotency: the sidecar stamps each submission with a stable key so an offline queue
  -- flush (or any retry) cannot create duplicates. See unique constraint below.
  idempotency_key TEXT NOT NULL,

  -- All Context Intelligence shared contracts are version-stamped (design doc §6 / US-002)
  -- so consumers can evolve the payload shape without breaking older rows.
  schema_version  INTEGER NOT NULL DEFAULT 1,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- ingestion time
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Lifecycle/value validators: reject empty provenance and non-positive schema versions.
  CONSTRAINT context_events_source_system_not_blank CHECK (length(btrim(source_system)) > 0),
  CONSTRAINT context_events_event_type_not_blank     CHECK (length(btrim(event_type)) > 0),
  CONSTRAINT context_events_idempotency_key_not_blank CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT context_events_schema_version_positive   CHECK (schema_version >= 1),

  -- Idempotency guarantee: a given key may exist at most once per workspace.
  CONSTRAINT context_events_idempotency_unique UNIQUE (workspace_id, idempotency_key)
);

-- Review/list queues and timelines: most-recent-first within a workspace.
CREATE INDEX IF NOT EXISTS idx_context_events_workspace_occurred
  ON context_events (workspace_id, occurred_at DESC);

-- Correlate events back to their source object (e.g. all events for a commit SHA / file).
CREATE INDEX IF NOT EXISTS idx_context_events_source
  ON context_events (workspace_id, source_system, source_ref);

-- Filter a workspace's events by type.
CREATE INDEX IF NOT EXISTS idx_context_events_type
  ON context_events (workspace_id, event_type, occurred_at DESC);

-- Containment queries over the structured payload (e.g. payload @> '{"branch":"main"}').
CREATE INDEX IF NOT EXISTS idx_context_events_payload
  ON context_events USING GIN (payload);
