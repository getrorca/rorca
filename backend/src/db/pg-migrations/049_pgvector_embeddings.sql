-- PG-007: pgvector extension + embeddings table for semantic search
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS embeddings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  TEXT NOT NULL,
  source_type   TEXT NOT NULL CHECK (source_type IN ('story', 'spec', 'memory', 'archive')),
  source_id     TEXT NOT NULL,
  content_hash  TEXT NOT NULL,          -- SHA-256 hex of input text for staleness check
  embedding     vector(1536) NOT NULL,  -- text-embedding-3-small default dimension
  model         TEXT NOT NULL DEFAULT 'text-embedding-3-small',
  token_count   INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, source_type, source_id)
);

-- Index for vector similarity search (cosine distance)
CREATE INDEX IF NOT EXISTS idx_embeddings_vector ON embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Index for staleness lookups
CREATE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings (workspace_id, source_type, source_id);

-- Index for workspace-scoped queries
CREATE INDEX IF NOT EXISTS idx_embeddings_workspace ON embeddings (workspace_id);
