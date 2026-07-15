-- Wake SSE output streams immediately after durable output commits.
-- Notifications contain only the run ID; raw bytes remain in replay tables.

CREATE OR REPLACE FUNCTION notify_run_output_event()
RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('run_output_events', json_build_object('runId', NEW.run_id)::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS run_output_chunks_notify ON run_output_chunks;
CREATE TRIGGER run_output_chunks_notify
  AFTER INSERT ON run_output_chunks
  FOR EACH ROW EXECUTE FUNCTION notify_run_output_event();

DROP TRIGGER IF EXISTS run_pty_output_chunks_notify ON run_pty_output_chunks;
CREATE TRIGGER run_pty_output_chunks_notify
  AFTER INSERT ON run_pty_output_chunks
  FOR EACH ROW EXECUTE FUNCTION notify_run_output_event();
