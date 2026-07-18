-- Canonical host-owned WAL outbox for governing GitHub projections.
-- Caller/API-authored rows retain the default untrusted provenance. Trusted rows
-- are bound to an exact canonical run and immutable event identity before relay.

ALTER TABLE wal_events
  ADD COLUMN IF NOT EXISTS trust_provenance TEXT NOT NULL DEFAULT 'untrusted',
  ADD COLUMN IF NOT EXISTS trusted_source TEXT,
  ADD COLUMN IF NOT EXISTS canonical_run_id BIGINT,
  ADD COLUMN IF NOT EXISTS story_result_id INTEGER,
  ADD COLUMN IF NOT EXISTS event_identity_hash TEXT,
  ADD COLUMN IF NOT EXISTS outbox_ready_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS outbox_relayed_at TIMESTAMPTZ;

ALTER TABLE wal_events
  DROP CONSTRAINT IF EXISTS wal_events_story_result_fk;
ALTER TABLE wal_events
  ADD CONSTRAINT wal_events_story_result_fk
  FOREIGN KEY (story_result_id) REFERENCES story_results(id) ON DELETE CASCADE;

ALTER TABLE wal_events
  DROP CONSTRAINT IF EXISTS wal_events_trust_provenance_ck;
ALTER TABLE wal_events
  ADD CONSTRAINT wal_events_trust_provenance_ck
  CHECK (trust_provenance IN ('untrusted', 'host'));

ALTER TABLE wal_events
  DROP CONSTRAINT IF EXISTS wal_events_host_trust_shape_ck;
ALTER TABLE wal_events
  ADD CONSTRAINT wal_events_host_trust_shape_ck
  CHECK (
    (trust_provenance = 'untrusted'
      AND trusted_source IS NULL
      AND canonical_run_id IS NULL
      AND story_result_id IS NULL
      AND event_identity_hash IS NULL
      AND outbox_ready_at IS NULL
      AND outbox_relayed_at IS NULL)
    OR
    (trust_provenance = 'host'
      AND trusted_source IN ('execution-engine', 'worker', 'story-result')
      AND canonical_run_id IS NOT NULL
      AND ((trusted_source = 'story-result' AND story_result_id IS NOT NULL)
        OR (trusted_source <> 'story-result' AND story_result_id IS NULL))
      AND ingest_key IS NOT NULL
      AND event_identity_hash ~ '^[0-9a-f]{64}$'
      AND (outbox_relayed_at IS NULL OR outbox_ready_at IS NOT NULL))
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_wal_trusted_story_result
  ON wal_events (story_result_id)
  WHERE trust_provenance = 'host' AND trusted_source = 'story-result';

CREATE INDEX IF NOT EXISTS idx_wal_trusted_unrelayed
  ON wal_events (canonical_run_id, id)
  WHERE trust_provenance = 'host'
    AND outbox_ready_at IS NOT NULL
    AND outbox_relayed_at IS NULL;

CREATE OR REPLACE FUNCTION enforce_wal_trust_immutability()
RETURNS trigger AS $$
BEGIN
  IF OLD.trust_provenance = 'untrusted' AND NEW.trust_provenance <> 'untrusted' THEN
    RAISE EXCEPTION 'caller WAL cannot be promoted to host trust';
  END IF;
  IF OLD.trust_provenance = 'host'
     AND OLD.outbox_ready_at IS NOT NULL
     AND NEW.outbox_ready_at IS DISTINCT FROM OLD.outbox_ready_at THEN
    RAISE EXCEPTION 'host WAL readiness is monotonic';
  END IF;
  IF OLD.trust_provenance = 'host'
     AND OLD.outbox_relayed_at IS NOT NULL
     AND NEW.outbox_relayed_at IS DISTINCT FROM OLD.outbox_relayed_at THEN
    RAISE EXCEPTION 'host WAL relay acknowledgement is monotonic';
  END IF;
  IF OLD.trust_provenance = 'host' AND (
    NEW.trust_provenance IS DISTINCT FROM OLD.trust_provenance
    OR NEW.trusted_source IS DISTINCT FROM OLD.trusted_source
    OR NEW.canonical_run_id IS DISTINCT FROM OLD.canonical_run_id
    OR NEW.story_result_id IS DISTINCT FROM OLD.story_result_id
    OR NEW.event_identity_hash IS DISTINCT FROM OLD.event_identity_hash
    OR NEW.ingest_key IS DISTINCT FROM OLD.ingest_key
    OR NEW.event_type IS DISTINCT FROM OLD.event_type
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.spec_id IS DISTINCT FROM OLD.spec_id
    OR NEW.story_id IS DISTINCT FROM OLD.story_id
    OR NEW.actor IS DISTINCT FROM OLD.actor
    OR NEW.payload IS DISTINCT FROM OLD.payload
    OR NEW.ts IS DISTINCT FROM OLD.ts
  ) THEN
    RAISE EXCEPTION 'host WAL identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wal_events_trust_immutability_trg ON wal_events;
CREATE TRIGGER wal_events_trust_immutability_trg
  BEFORE UPDATE ON wal_events
  FOR EACH ROW EXECUTE FUNCTION enforce_wal_trust_immutability();

-- Trusted rows are a transactional outbox: insertion alone is durable but does
-- not broadcast. The host relays only after its local ordering boundary. Public
-- untrusted WAL keeps the existing insert-trigger behavior.
CREATE OR REPLACE FUNCTION notify_wal_event()
RETURNS trigger AS $$
BEGIN
  IF NEW.trust_provenance = 'untrusted' THEN
    PERFORM pg_notify('wal_events', row_to_json(NEW)::text);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- New runs freeze the exact story scope used by terminal Check Run authority.
-- NULL is retained only for historical runs, which fail closed for governing
-- success rather than deriving scope from a mutable spec file.
ALTER TABLE pipeline_runs
  ADD COLUMN IF NOT EXISTS expected_story_ids TEXT[];

ALTER TABLE pipeline_runs
  DROP CONSTRAINT IF EXISTS pipeline_runs_expected_story_ids_ck;
ALTER TABLE pipeline_runs
  ADD CONSTRAINT pipeline_runs_expected_story_ids_ck
  CHECK (
    expected_story_ids IS NULL
    OR (
      cardinality(expected_story_ids) BETWEEN 1 AND 10000
      AND array_position(expected_story_ids, NULL) IS NULL
    )
  );
