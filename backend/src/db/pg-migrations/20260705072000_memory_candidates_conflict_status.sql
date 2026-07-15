-- CCS-010: Allow explicit conflict review state for memory candidates.
-- Keeps conflict candidates auditable without promoting them to durable memory.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'memory_candidates'
      AND c.conname = 'memory_candidates_review_status_check'
  ) THEN
    ALTER TABLE memory_candidates DROP CONSTRAINT memory_candidates_review_status_check;
  END IF;

  ALTER TABLE memory_candidates
    ADD CONSTRAINT memory_candidates_review_status_check
    CHECK (review_status IN (
      'pending',
      'approved',
      'rejected',
      'superseded',
      'duplicate',
      'conflict',
      'deferred'
    ));
END $$;
