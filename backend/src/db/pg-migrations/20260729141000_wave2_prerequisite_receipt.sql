-- Make exact ROR-24/Wave 1 verification a durable prerequisite of every Wave 2 mutation.

CREATE TABLE rorca.wave2_prerequisite_receipts (
  receipt_hash TEXT PRIMARY KEY CHECK(receipt_hash ~ '^sha256:[0-9a-f]{64}$'),
  gate_version TEXT NOT NULL,
  gate_for TEXT NOT NULL CHECK(gate_for='ROR-23'),
  ror24_source_sha TEXT NOT NULL CHECK(ror24_source_sha ~ '^[0-9a-f]{40}$'),
  ror24_artifact_sha256 TEXT NOT NULL CHECK(ror24_artifact_sha256 ~ '^[0-9a-f]{64}$'),
  acceptance_comment_id TEXT NOT NULL,
  wave1_source_sha TEXT NOT NULL CHECK(wave1_source_sha ~ '^[0-9a-f]{40}$'),
  wave1_spec_sha256 TEXT NOT NULL CHECK(wave1_spec_sha256 ~ '^[0-9a-f]{64}$'),
  wave1_review_sha256 TEXT NOT NULL CHECK(wave1_review_sha256 ~ '^[0-9a-f]{64}$'),
  decision_json JSONB NOT NULL CHECK(jsonb_typeof(decision_json)='object'),
  verified_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(gate_version,gate_for)
);

ALTER TABLE rorca.wave2_schema_readiness ADD COLUMN prerequisite_receipt_hash TEXT;
ALTER TABLE rorca.wave2_schema_readiness ADD CONSTRAINT wave2_readiness_prerequisite_receipt_fk
  FOREIGN KEY(prerequisite_receipt_hash) REFERENCES rorca.wave2_prerequisite_receipts(receipt_hash) ON DELETE RESTRICT;

CREATE VIEW rorca.wave2_effective_readiness AS
SELECT r.contract_version,r.contract_source_digest,r.migration_version,r.state schema_state,r.prerequisite_receipt_hash,
  (r.state='ready' AND p.receipt_hash IS NOT NULL) ready,
  CASE WHEN r.state<>'ready' THEN 'schema_not_ready' WHEN p.receipt_hash IS NULL THEN 'prerequisite_receipt_missing' ELSE 'ready' END reason_code
FROM rorca.wave2_schema_readiness r LEFT JOIN rorca.wave2_prerequisite_receipts p ON p.receipt_hash=r.prerequisite_receipt_hash
WHERE r.singleton=TRUE;

CREATE TRIGGER wave2_prerequisite_receipts_immutable BEFORE UPDATE OR DELETE ON rorca.wave2_prerequisite_receipts
  FOR EACH ROW EXECUTE FUNCTION rorca.w2_reject_immutable_mutation();
CREATE TRIGGER wave2_prerequisite_receipts_no_truncate BEFORE TRUNCATE ON rorca.wave2_prerequisite_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION rorca.w2_reject_immutable_truncate();

UPDATE rorca.wave2_schema_readiness
SET migration_version=20260729141000, installed_at=clock_timestamp()
WHERE singleton=TRUE AND state='ready' AND migration_version=20260729140000
  AND contract_source_digest='sha256:25cf1b7324834d1b6233606821863f34e1e7719871bf02a327ea4c2e2ed7850c';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM rorca.wave2_effective_readiness WHERE migration_version=20260729141000
    AND contract_source_digest='sha256:25cf1b7324834d1b6233606821863f34e1e7719871bf02a327ea4c2e2ed7850c'
    AND ready=FALSE AND reason_code='prerequisite_receipt_missing') THEN
    RAISE EXCEPTION 'Wave 2 prerequisite readiness must begin fail-closed' USING ERRCODE='55000';
  END IF;
END;
$$;
