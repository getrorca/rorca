-- Append-only publication of verified portable wave-qualification receipts.
-- Portable JSON is schema-checked again in application code before insertion.

CREATE TABLE IF NOT EXISTS wave_qualification_receipts (
  id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  report_hash TEXT NOT NULL UNIQUE CHECK (report_hash ~ '^sha256:[0-9a-f]{64}$'),
  source_revision TEXT NOT NULL CHECK (source_revision ~ '^[0-9a-f]{40,64}$'),
  source_tree TEXT NOT NULL CHECK (source_tree ~ '^[0-9a-f]{40,64}$'),
  policy_version TEXT NOT NULL CHECK (policy_version = 'wave-parallel-production-v1'),
  invariant_version TEXT NOT NULL CHECK (invariant_version = 'rorca-wave-parallel-qualification-v1'),
  issuer_id TEXT NOT NULL CHECK (issuer_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  issuer_key_id TEXT NOT NULL CHECK (issuer_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > issued_at),
  report JSONB NOT NULL CHECK (report->>'schemaVersion' = 'rorca.wave-qualification.report/v1'),
  receipt JSONB NOT NULL CHECK (receipt->>'schemaVersion' = 'rorca.wave-qualification.receipt/v1'),
  human_report TEXT NOT NULL CHECK (octet_length(human_report) BETWEEN 1 AND 524288),
  telemetry JSONB NOT NULL CHECK (jsonb_typeof(telemetry) = 'array' AND jsonb_array_length(telemetry) BETWEEN 1 AND 512),
  production_enable_available BOOLEAN NOT NULL CHECK (production_enable_available),
  verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (report_hash = receipt->>'reportHash'),
  CHECK (source_revision = receipt->>'sourceRevision'),
  CHECK (source_tree = receipt->>'sourceTree'),
  CHECK ((report->>'productionEnableAvailable')::BOOLEAN = production_enable_available)
);

CREATE INDEX IF NOT EXISTS idx_wave_qualification_receipts_workspace_verified
  ON wave_qualification_receipts (workspace_id, verified_at DESC, id DESC);

CREATE OR REPLACE FUNCTION reject_wave_qualification_receipt_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'wave qualification receipts are append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_wave_qualification_receipts_immutable ON wave_qualification_receipts;
CREATE TRIGGER trg_wave_qualification_receipts_immutable
BEFORE UPDATE OR DELETE ON wave_qualification_receipts
FOR EACH ROW EXECUTE FUNCTION reject_wave_qualification_receipt_mutation();
