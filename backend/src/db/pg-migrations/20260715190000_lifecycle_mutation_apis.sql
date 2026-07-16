-- LFC-014: durable network-replay identities for governed lifecycle mutations.
-- This is Rorca-owned request state; no pg-boss objects are managed here.

CREATE TABLE IF NOT EXISTS lifecycle_mutation_requests (
  id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK (btrim(operation) <> ''),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^sha256:[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
  response_status INTEGER,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT lifecycle_mutation_requests_identity_unique
    UNIQUE (workspace_id, operation, idempotency_key),
  CONSTRAINT lifecycle_mutation_requests_completion_check CHECK (
    (status = 'pending' AND response_status IS NULL AND response_body IS NULL AND completed_at IS NULL)
    OR
    (status = 'completed' AND response_status BETWEEN 200 AND 299 AND response_body IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_mutation_requests_created
  ON lifecycle_mutation_requests (workspace_id, created_at DESC);

ALTER TABLE pipeline_retry_previews
  ADD COLUMN IF NOT EXISTS preview_identity_hash TEXT,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_retry_preview_idempotency
  ON pipeline_retry_previews (workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
