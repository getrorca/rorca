-- Migration: 20260706140000_external_memory_imports
-- Purpose: UCC-011 provenance and idempotency metadata for external memory/trace imports.
-- Notes: Adapters stage only pending memory_candidates; no pgboss.* tables are touched.

ALTER TABLE memory_candidates
  ADD COLUMN IF NOT EXISTS external_import_id TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS source_vendor TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS source_original_id TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS import_adapter TEXT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_memory_candidates_external_import_vendor
  ON memory_candidates(workspace_id, source_vendor, created_at DESC)
  WHERE source_vendor IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_candidates_external_import_idempotency
  ON memory_candidates(workspace_id, external_import_id, dedupe_key)
  WHERE external_import_id IS NOT NULL AND dedupe_key IS NOT NULL;
