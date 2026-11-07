-- Migration: 20260317100000_wal_events_listen_notify
-- Purpose: Add LISTEN/NOTIFY trigger on wal_events so SSE hub can receive
--          real-time push notifications instead of polling every 3s.

CREATE OR REPLACE FUNCTION notify_wal_event()
RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('wal_events', row_to_json(NEW)::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wal_events_notify ON wal_events;

CREATE TRIGGER wal_events_notify
  AFTER INSERT ON wal_events
  FOR EACH ROW
  EXECUTE FUNCTION notify_wal_event();
