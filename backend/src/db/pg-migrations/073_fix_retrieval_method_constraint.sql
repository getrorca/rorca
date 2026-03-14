-- Migration 073: Fix spec_generation_logs retrieval_method check constraint
-- The original constraint only allowed pgvector/graph/fulltext/direction-only,
-- but the enrich route uses cag/rag/direction_only (underscore) as tier names.
-- This widens the constraint to accept all values the code produces.
-- Guard: only run if the retrieval_method column exists (it may be absent on DBs
-- where migration 062 was skipped due to numbering conflicts).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'spec_generation_logs' AND column_name = 'retrieval_method'
  ) THEN
    ALTER TABLE spec_generation_logs
      DROP CONSTRAINT IF EXISTS chk_spec_generation_logs_retrieval_method,
      ADD CONSTRAINT chk_spec_generation_logs_retrieval_method
        CHECK (retrieval_method IN ('pgvector', 'graph', 'fulltext', 'direction-only', 'direction_only', 'cag', 'rag', 'cache', 'none'));
  END IF;
END $$;
