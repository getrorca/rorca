-- Migration 071: worker_heartbeat — add active_jobs column
-- Tracks the number of active child execution-engine processes currently
-- managed by this worker. Written on every heartbeat tick (every 30s).

ALTER TABLE worker_heartbeat
  ADD COLUMN IF NOT EXISTS active_jobs INT NOT NULL DEFAULT 0;
