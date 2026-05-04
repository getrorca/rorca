-- PG-022: Add pinned column to memories table for memory curation.
-- Pinned memories are always included in story prompts regardless of vector similarity.

ALTER TABLE memories ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false;

-- Index for fast retrieval of pinned memories per workspace
CREATE INDEX IF NOT EXISTS idx_memories_pinned
  ON memories (workspace_id) WHERE pinned = true AND deleted_at IS NULL;

-- Full-text search support for content filtering.
-- Generated tsvector columns are not portable across all local AGE-enabled
-- Postgres builds used by Rorca, so maintain the search document via trigger.
ALTER TABLE memories ADD COLUMN IF NOT EXISTS tsv tsvector;

UPDATE memories
SET tsv = to_tsvector('english', content)
WHERE tsv IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'memories_tsv_update'
  ) THEN
    CREATE TRIGGER memories_tsv_update
      BEFORE INSERT OR UPDATE ON memories
      FOR EACH ROW
      EXECUTE FUNCTION tsvector_update_trigger(tsv, 'pg_catalog.english', content);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_memories_tsv ON memories USING GIN (tsv);
