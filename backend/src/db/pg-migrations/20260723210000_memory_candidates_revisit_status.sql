-- Restore the review lifecycle state used by the governed revisit endpoints.
-- The later constraint-alignment migration preserved conflict/deferred but
-- accidentally omitted the already-supported revisit state.

ALTER TABLE memory_candidates
  DROP CONSTRAINT IF EXISTS memory_candidates_review_status_check;

ALTER TABLE memory_candidates
  ADD CONSTRAINT memory_candidates_review_status_check
  CHECK (review_status IN (
    'pending', 'approved', 'rejected', 'superseded', 'duplicate',
    'conflict', 'deferred', 'revisit'
  ));
