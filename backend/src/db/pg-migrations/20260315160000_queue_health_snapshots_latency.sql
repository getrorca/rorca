-- US-005: Add pickup latency metrics to queue_health_snapshots.
-- avg_pickup_seconds  — mean time from job creation to job start (pipeline:run + pipeline:retry only)
-- p95_pickup_seconds  — 95th percentile of the same metric
-- Both are computed over a 24-hour rolling window from pgboss.archive and may be NULL
-- when fewer than 1 completed pipeline job exists in that window.
ALTER TABLE queue_health_snapshots
  ADD COLUMN IF NOT EXISTS avg_pickup_seconds FLOAT,
  ADD COLUMN IF NOT EXISTS p95_pickup_seconds FLOAT;
