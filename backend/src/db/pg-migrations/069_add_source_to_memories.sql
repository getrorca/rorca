-- US-001 (rorca-context-autohydrate): Add source column to memories table.
-- Tracks the origin identifier of a memory entry (e.g. 'git_hydration', 'scan-direction').
-- Distinct from source_type (synthesis|manual|mcp|auto-extracted|import) which tracks
-- the broad category of origin. source is a free-form identifier for the specific
-- sub-source within a source_type.

ALTER TABLE memories ADD COLUMN IF NOT EXISTS source VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_memories_source
  ON memories (source) WHERE source IS NOT NULL AND deleted_at IS NULL;
