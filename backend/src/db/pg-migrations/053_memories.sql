-- PG-020: Auto-synthesized memories from story completions
-- Stores structured memory entries extracted by LLM after each story pass/fail.
-- Soft-delete via deleted_at for undo. pgvector embedding for semantic search.

CREATE TABLE IF NOT EXISTS memories (
  id              SERIAL PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  category        TEXT NOT NULL,
  content         TEXT NOT NULL,
  source_story_id TEXT,
  source_run_id   INTEGER,
  confidence      TEXT NOT NULL DEFAULT 'medium'
                  CHECK (confidence IN ('high', 'medium', 'low')),
  related_files   JSONB NOT NULL DEFAULT '[]',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_memories_workspace
  ON memories (workspace_id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_memories_category
  ON memories (workspace_id, category) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_memories_run
  ON memories (source_run_id) WHERE source_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memories_related_files
  ON memories USING GIN (related_files);

-- Add vector embedding column if pgvector is available (non-fatal if not)
DO $$ BEGIN
  ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding vector(1536);
EXCEPTION WHEN undefined_object THEN
  RAISE NOTICE 'pgvector not available — skipping embedding column';
END $$;

-- ivfflat index on embedding for vector similarity search (only if column exists)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'memories' AND column_name = 'embedding') THEN
    CREATE INDEX IF NOT EXISTS idx_memories_embedding
      ON memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);
  END IF;
END $$;
