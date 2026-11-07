-- US-022: Webhook infrastructure — DLQ and deduplication tables

-- Dead letter queue for failed webhook handler invocations
CREATE TABLE IF NOT EXISTS webhook_dlq (
  id SERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  error TEXT,
  attempts INT NOT NULL DEFAULT 0,
  delivery_id TEXT UNIQUE,
  workspace_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_webhook_dlq_provider ON webhook_dlq (provider);
CREATE INDEX IF NOT EXISTS idx_webhook_dlq_created_at ON webhook_dlq (created_at DESC);

-- Webhook event deduplication — tracks delivery IDs to prevent re-processing
CREATE TABLE IF NOT EXISTS webhook_events (
  id SERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processing', 'completed', 'failed')),
  workspace_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(provider, delivery_id)
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_lookup ON webhook_events (provider, delivery_id);
