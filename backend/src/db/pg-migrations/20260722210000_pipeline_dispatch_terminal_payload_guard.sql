-- Fail closed when a run reaches success without a prepared application-owned dispatch payload.
-- This keeps direct/legacy transport harnesses auditable without violating the outbox state constraint.

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
     SET state = CASE
           WHEN terminal_state = 'completed' AND payload IS NULL THEN 'failed'
           ELSE terminal_state
         END,
         last_error = CASE
           WHEN terminal_state = 'completed' AND payload IS NULL
             THEN COALESCE(last_error, 'terminal_without_prepared_dispatch_payload')
           ELSE last_error
         END,
         lease_owner = NULL,
         lease_expires_at = NULL,
         completed_at = COALESCE(completed_at, NOW()),
         updated_at = NOW()
   WHERE run_id = NEW.id
     AND state NOT IN ('completed','cancelled','failed');

  RETURN NEW;
END;
$$;
