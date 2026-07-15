-- Bound execution-engine callback retries and fallback replay to exactly one
-- persisted row per generated ingest key. Legacy writers may continue using NULL.

ALTER TABLE wal_events
  ADD COLUMN IF NOT EXISTS ingest_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_wal_events_ingest_key_unique
  ON wal_events (ingest_key)
  WHERE ingest_key IS NOT NULL;

ALTER TABLE story_results
  ADD COLUMN IF NOT EXISTS ingest_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_story_results_ingest_key_unique
  ON story_results (ingest_key)
  WHERE ingest_key IS NOT NULL;
