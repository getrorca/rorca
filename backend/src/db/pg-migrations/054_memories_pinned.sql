-- PG-022: Add pinned column to memories table for memory curation.
-- Pinned memories are always included in story prompts regardless of vector similarity.

ALTER TABLE memories ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false;

-- Index for fast retrieval of pinned memories per workspace
CREATE INDEX IF NOT EXISTS idx_memories_pinned
  ON memories (workspace_id) WHERE pinned = true AND deleted_at IS NULL;

-- Full-text search index for content filtering
ALTER TABLE memories ADD COLUMN IF NOT EXISTS tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

CREATE INDEX IF NOT EXISTS idx_memories_tsv ON memories USING GIN (tsv);
