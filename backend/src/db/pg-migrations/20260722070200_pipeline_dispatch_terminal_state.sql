-- Keep application-owned dispatch authority terminal with canonical run state.
-- pg-boss remains transport-only and is not read or modified here.

ALTER TABLE pipeline_dispatch_publications
  DROP CONSTRAINT IF EXISTS pipeline_dispatch_publications_payload_state_check;
ALTER TABLE pipeline_dispatch_publications
  ADD CONSTRAINT pipeline_dispatch_publications_payload_state_check
  CHECK (state IN ('reserved','preparing','cancelled','failed') OR payload IS NOT NULL);

CREATE OR REPLACE FUNCTION synchronize_pipeline_dispatch_terminal_state()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  terminal_state TEXT;
BEGIN
  terminal_state := CASE NEW.status
    WHEN 'done' THEN 'completed'
    WHEN 'cancelled' THEN 'cancelled'
    WHEN 'failed' THEN 'failed'
    WHEN 'partial_failure' THEN 'failed'
    ELSE NULL
  END;
  IF terminal_state IS NULL THEN
    RETURN NEW;
  END IF;
  UPDATE pipeline_dispatch_publications
     SET state = terminal_state,
         lease_owner = NULL,
         lease_expires_at = NULL,
         completed_at = COALESCE(completed_at, NOW()),
         updated_at = NOW()
   WHERE run_id = NEW.id
     AND state NOT IN ('completed','cancelled','failed');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pipeline_runs_dispatch_terminal_state ON pipeline_runs;
CREATE TRIGGER pipeline_runs_dispatch_terminal_state
AFTER UPDATE OF status ON pipeline_runs
FOR EACH ROW
WHEN (NEW.status IN ('done','cancelled','failed','partial_failure'))
EXECUTE FUNCTION synchronize_pipeline_dispatch_terminal_state();

UPDATE pipeline_dispatch_publications publication
   SET state = CASE run.status
         WHEN 'done' THEN 'completed'
         WHEN 'cancelled' THEN 'cancelled'
         ELSE 'failed'
       END,
       lease_owner = NULL,
       lease_expires_at = NULL,
       completed_at = COALESCE(publication.completed_at, run.finished_at, NOW()),
       updated_at = NOW()
  FROM pipeline_runs run
 WHERE run.id = publication.run_id
   AND run.status IN ('done','cancelled','failed','partial_failure')
   AND publication.state NOT IN ('completed','cancelled','failed');
