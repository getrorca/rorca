-- Migration: 20260714143000_context_capture_candidate_compatibility
-- Purpose: Keep UCC-008/UCC-011 candidate writes compatible with both a fresh
--          capture schema and the canonical brownfield memory_candidates table.
-- Notes: Does not touch pgboss.*. Existing candidate/history rows are unchanged.

ALTER TABLE memory_candidates
  ADD COLUMN IF NOT EXISTS payload JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS source_ref TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS rule TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS context TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS schema_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS suggested_category TEXT NOT NULL DEFAULT 'Decision',
  ADD COLUMN IF NOT EXISTS actor TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS regulated_domain BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS requires_review BOOLEAN NOT NULL DEFAULT TRUE;
