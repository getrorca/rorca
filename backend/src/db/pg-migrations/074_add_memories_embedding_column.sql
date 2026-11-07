-- Migration 074: Ensure memories.embedding column exists (only on DBs with pgvector)
-- Migration 053 created the memories table with embedding vector(1536),
-- but some DBs (e.g. PostgreSQL 14 without pgvector) may be missing this column.
-- Guard: only run if the vector extension is available.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    CREATE EXTENSION IF NOT EXISTS vector;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'memories' AND column_name = 'embedding'
    ) THEN
      ALTER TABLE memories ADD COLUMN embedding vector(1536);
      CREATE INDEX IF NOT EXISTS idx_memories_embedding
        ON memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);
    END IF;
  END IF;
END $$;
