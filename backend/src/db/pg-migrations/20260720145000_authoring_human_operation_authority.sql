-- Durable authoring mutation/idempotency and provider-human authority receipts.
-- Application tables only; no pgboss.* objects.

CREATE TABLE IF NOT EXISTS authoring_mutation_operations (
  receipt_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK (operation IN ('preflight','confirm','persist','persist-batch','approve','compile-legacy')),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^sha256:[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('claimed','artifact_written','wal_written','completed','recoverable_failure')),
  spec_id TEXT,
  parent_receipt_id UUID REFERENCES authoring_mutation_operations(receipt_id) ON DELETE RESTRICT,
  response_status INTEGER CHECK (response_status IS NULL OR response_status BETWEEN 200 AND 599),
  response_body JSONB CHECK (response_body IS NULL OR (jsonb_typeof(response_body) = 'object' AND octet_length(response_body::text) <= 65536)),
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE (workspace_id, operation, idempotency_key),
  CHECK ((state = 'completed') = (completed_at IS NOT NULL AND response_status IS NOT NULL AND response_body IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_authoring_mutation_recovery
  ON authoring_mutation_operations(state, updated_at)
  WHERE state <> 'completed';

CREATE TABLE IF NOT EXISTS provider_human_authority_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  purpose TEXT NOT NULL CHECK (purpose IN ('authoring_plan_confirmation','spec_set_approval','retry_approval')),
  target_hash TEXT NOT NULL CHECK (target_hash ~ '^sha256:[0-9a-f]{64}$'),
  issuer_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL CHECK (key_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  provider TEXT NOT NULL,
  provider_tenant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  normalized_command_hash TEXT NOT NULL CHECK (normalized_command_hash ~ '^sha256:[0-9a-f]{64}$'),
  ingress_idempotency_key TEXT NOT NULL,
  attestation_hash TEXT NOT NULL UNIQUE CHECK (attestation_hash ~ '^sha256:[0-9a-f]{64}$'),
  requester_actor_id TEXT,
  grants_downstream_approval BOOLEAN NOT NULL DEFAULT FALSE CHECK (grants_downstream_approval = FALSE),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (issuer_id, message_id),
  UNIQUE (workspace_id, purpose, target_hash)
);

CREATE OR REPLACE FUNCTION prevent_provider_human_receipt_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'provider human authority receipts are append-only' USING ERRCODE = '23514';
END;
$$;
DROP TRIGGER IF EXISTS trg_provider_human_receipt_append_only ON provider_human_authority_receipts;
CREATE TRIGGER trg_provider_human_receipt_append_only
BEFORE UPDATE OR DELETE ON provider_human_authority_receipts
FOR EACH ROW EXECUTE FUNCTION prevent_provider_human_receipt_mutation();
