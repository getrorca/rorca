-- SE-008: Track embedding provider and native dimensions per row.
-- Enables multi-provider coexistence (e.g. OpenAI 1536-dim + Google 768-dim).
-- Search filters by matching dimensions to avoid cross-provider cosine comparison.

ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'openai';
ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS dimensions INTEGER DEFAULT 1536;

-- Index for dimension-filtered vector queries
CREATE INDEX IF NOT EXISTS idx_embeddings_dimensions ON embeddings (dimensions);
