-- GR2-004: Track memory freshness separately from creation time.
-- Supports recency-aware retrieval, curated pin updates, and graph projection metadata.

ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

UPDATE memories
   SET updated_at = created_at
 WHERE updated_at IS NULL;

ALTER TABLE memories
  ALTER COLUMN updated_at SET DEFAULT NOW();

ALTER TABLE memories
  ALTER COLUMN updated_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memories_workspace_updated_at
  ON memories (workspace_id, updated_at DESC)
  WHERE deleted_at IS NULL;
