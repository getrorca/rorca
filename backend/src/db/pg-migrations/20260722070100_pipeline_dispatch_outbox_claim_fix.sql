-- A publisher must acquire its preparing lease before the immutable payload is built.
ALTER TABLE pipeline_dispatch_publications
  DROP CONSTRAINT IF EXISTS pipeline_dispatch_publications_check1;
ALTER TABLE pipeline_dispatch_publications
  DROP CONSTRAINT IF EXISTS pipeline_dispatch_publications_payload_state_check;
ALTER TABLE pipeline_dispatch_publications
  ADD CONSTRAINT pipeline_dispatch_publications_payload_state_check
  CHECK (state IN ('reserved','preparing') OR payload IS NOT NULL);
