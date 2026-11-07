-- Migration 064: worker_heartbeat
-- Tracks the running state of the standalone pg-boss worker process.
-- The worker upserts its heartbeat every 30 s; the health endpoint checks
-- last_seen < 60 s to decide if the worker is active.

CREATE TABLE IF NOT EXISTS worker_heartbeat (
  worker_id   UUID         PRIMARY KEY,
  pid         INT          NOT NULL,
  hostname    VARCHAR(255) NOT NULL,
  started_at  TIMESTAMPTZ  NOT NULL,
  last_seen   TIMESTAMPTZ  NOT NULL
);
