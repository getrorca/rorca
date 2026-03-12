-- 062_spec_generation_logs_enrich.sql — Add enrichment tracking to spec_generation_logs
-- Supports POST /api/specs/:id/enrich which annotates user stories with retrieved context.

ALTER TABLE spec_generation_logs ADD COLUMN IF NOT EXISTS enriched BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE spec_generation_logs ADD COLUMN IF NOT EXISTS retrieval_method TEXT;
ALTER TABLE spec_generation_logs ADD COLUMN IF NOT EXISTS context_summary_json JSONB;

CREATE INDEX IF NOT EXISTS idx_spec_generation_logs_enriched
  ON spec_generation_logs (spec_slug, enriched);
