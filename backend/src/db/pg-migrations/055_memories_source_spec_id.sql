-- PG-023: Add source_spec_id column to memories table.
-- Spec-generation memory capture: when the LLM generates a spec, observations about
-- the codebase (architecture patterns, complexity hotspots, missing conventions) are
-- captured as memories tagged with the spec that produced them.

ALTER TABLE memories ADD COLUMN IF NOT EXISTS source_spec_id TEXT;

CREATE INDEX IF NOT EXISTS idx_memories_source_spec
  ON memories (source_spec_id) WHERE source_spec_id IS NOT NULL AND deleted_at IS NULL;
