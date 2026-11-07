-- 063_enrich_spec_logs_v2.sql — Complete enrichment columns for spec_generation_logs + direction_layers embedding
-- Extends the partial 062 migration:
--   1. Adds CHECK constraint on retrieval_method (was missing in 062)
--   2. Adds context_summary JSONB column (062 used context_summary_json)
--   3. Adds embedding vector(1536) to direction_layers for pgvector queries
-- All operations are idempotent (IF NOT EXISTS / IF EXISTS guards).

-- Ensure pgvector extension is available
CREATE EXTENSION IF NOT EXISTS vector;

-- spec_generation_logs: Add CHECK constraint on retrieval_method if not already constrained
-- PostgreSQL does not support IF NOT EXISTS for constraints, so we check pg_constraint first
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'spec_generation_logs'::regclass
      AND conname = 'chk_spec_generation_logs_retrieval_method'
  ) THEN
    ALTER TABLE spec_generation_logs
      ADD CONSTRAINT chk_spec_generation_logs_retrieval_method
      CHECK (retrieval_method IN ('pgvector','graph','fulltext','direction-only'));
  END IF;
END;
$$;

-- spec_generation_logs: Add context_summary JSONB column (canonical name per US-002 spec)
-- (062 added context_summary_json — this adds the canonical context_summary alias column)
ALTER TABLE spec_generation_logs ADD COLUMN IF NOT EXISTS context_summary JSONB;

-- direction_layers: Add embedding column for pgvector semantic search (US-001 retrieval cascade)
ALTER TABLE direction_layers ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- Index for direction_layers vector similarity search
CREATE INDEX IF NOT EXISTS idx_direction_layers_embedding
  ON direction_layers USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);
