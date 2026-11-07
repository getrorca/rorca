-- 20260718120000_webhook_replay_provenance.sql
-- Bind explicit DLQ replay to the exact provider-authenticated delivery ledger.
-- Historical rows remain non-replayable until a fresh signed provider redelivery
-- creates verified provenance; no unverifiable data is backfilled.

ALTER TABLE webhook_events
  ADD COLUMN IF NOT EXISTS payload_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS verification_method TEXT,
  ADD COLUMN IF NOT EXISTS signature_verified_at TIMESTAMPTZ;

ALTER TABLE webhook_events
  DROP CONSTRAINT IF EXISTS webhook_event_verified_provenance_check,
  ADD CONSTRAINT webhook_event_verified_provenance_check CHECK (
    (payload_sha256 IS NULL AND verification_method IS NULL AND signature_verified_at IS NULL)
    OR (
      payload_sha256 ~ '^[0-9a-f]{64}$'
      AND verification_method ~ '^(github-hmac-sha256|linear-signature|vercel-signature|slack-signature)$'
      AND verification_method = CASE provider
        WHEN 'github' THEN 'github-hmac-sha256'
        WHEN 'linear' THEN 'linear-signature'
        WHEN 'vercel' THEN 'vercel-signature'
        WHEN 'slack' THEN 'slack-signature'
      END
      AND signature_verified_at IS NOT NULL
    )
  );

ALTER TABLE webhook_dlq
  ADD COLUMN IF NOT EXISTS payload_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS verification_method TEXT;

ALTER TABLE webhook_dlq
  DROP CONSTRAINT IF EXISTS webhook_dlq_verified_provenance_check,
  ADD CONSTRAINT webhook_dlq_verified_provenance_check CHECK (
    (payload_sha256 IS NULL AND verification_method IS NULL)
    OR (
      payload_sha256 ~ '^[0-9a-f]{64}$'
      AND verification_method ~ '^(github-hmac-sha256|linear-signature|vercel-signature|slack-signature)$'
      AND verification_method = CASE provider
        WHEN 'github' THEN 'github-hmac-sha256'
        WHEN 'linear' THEN 'linear-signature'
        WHEN 'vercel' THEN 'vercel-signature'
        WHEN 'slack' THEN 'slack-signature'
      END
    )
  );

CREATE INDEX IF NOT EXISTS idx_webhook_dlq_workspace_resolution
  ON webhook_dlq (workspace_id, resolved_at, created_at DESC);
