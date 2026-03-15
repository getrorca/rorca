-- Queue health snapshots — persists pg-boss monitor-states events for trend analysis,
-- alerting, and analytics charts (US-004 / rorca-queue-observability).
CREATE TABLE IF NOT EXISTS queue_health_snapshots (
  id                    SERIAL PRIMARY KEY,
  captured_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  total_pending         INT NOT NULL DEFAULT 0,
  total_active          INT NOT NULL DEFAULT 0,
  total_failed          INT NOT NULL DEFAULT 0,
  total_completed       INT NOT NULL DEFAULT 0,
  queue_breakdown       JSONB NOT NULL DEFAULT '[]',
  worker_id             TEXT,
  oldest_pending_seconds INT
);

CREATE INDEX IF NOT EXISTS idx_queue_health_snapshots_captured_at
  ON queue_health_snapshots (captured_at DESC);
