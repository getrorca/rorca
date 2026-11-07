-- Persist the actual lane used by application-owned pipeline dispatch jobs.
-- Existing rows remain pipeline:run; no lifecycle or transport identity is rewritten.

ALTER TABLE pipeline_dispatch_publications
  DROP CONSTRAINT IF EXISTS pipeline_dispatch_publications_queue_name_check;

ALTER TABLE pipeline_dispatch_publications
  ADD CONSTRAINT pipeline_dispatch_publications_queue_name_check
  CHECK (queue_name IN ('pipeline:run', 'pipeline:run:direct'));
