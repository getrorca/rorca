-- MST-001: Add source_type column to memories table.
-- Tracks how each memory entry was created: post-run LLM synthesis, manual user input,
-- MCP tool from another project, codebase scan/echolocation, or bulk import.

ALTER TABLE memories ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'synthesis'
  CHECK (source_type IN ('synthesis', 'manual', 'mcp', 'auto-extracted', 'import'));

CREATE INDEX IF NOT EXISTS idx_memories_workspace_source_type
  ON memories (workspace_id, source_type) WHERE deleted_at IS NULL;
