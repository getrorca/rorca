-- PostgreSQL NOTIFY payloads are limited to less than 8,000 bytes. WAL rows
-- remain canonical and complete in PostgreSQL; notifications are only bounded
-- wake-up pointers that listeners hydrate after commit.

CREATE OR REPLACE FUNCTION rorca.notify_wal_event()
RETURNS trigger AS $$
BEGIN
  IF NEW.trust_provenance = 'untrusted' THEN
    PERFORM pg_notify(
      'wal_events',
      json_build_object('wal_event_id', NEW.id)::text
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Rebind explicitly so installations whose historical function resolved under
-- a different search_path cannot retain the full-row notification trigger.
DROP TRIGGER IF EXISTS wal_events_notify ON rorca.wal_events;

CREATE TRIGGER wal_events_notify
  AFTER INSERT ON rorca.wal_events
  FOR EACH ROW
  EXECUTE FUNCTION rorca.notify_wal_event();
