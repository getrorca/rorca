-- 20260811110000_lifecycle_reconciliation.sql
-- Exact-revision historical reconciliation and pre-staging software qualification.
-- Both artifacts are append-only observations; neither grants merge, deployment,
-- production, or human approval authority.

CREATE TABLE IF NOT EXISTS ssdlc_reconciliation_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  spec_slug TEXT NOT NULL CHECK (btrim(spec_slug) <> ''),
  spec_revision_hash TEXT NOT NULL CHECK (spec_revision_hash ~ '^sha256:[0-9a-f]{64}$'),
  compiled_plan_id BIGINT REFERENCES ssdlc_compiled_plans(id) ON DELETE RESTRICT,
  preview_hash TEXT NOT NULL CHECK (preview_hash ~ '^sha256:[0-9a-f]{64}$'),
  idempotency_key TEXT NOT NULL CHECK (btrim(idempotency_key) <> ''),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^sha256:[0-9a-f]{64}$'),
  result_hash TEXT NOT NULL CHECK (result_hash ~ '^sha256:[0-9a-f]{64}$'),
  delivery_status TEXT NOT NULL CHECK (delivery_status IN (
    'unknown', 'in_progress', 'failed', 'completed', 'operator_attested', 'superseded'
  )),
  assurance_status TEXT NOT NULL CHECK (assurance_status IN (
    'not_evaluated', 'partial', 'complete', 'stale', 'blocked'
  )),
  story_summary JSONB NOT NULL CHECK (jsonb_typeof(story_summary) = 'object'),
  stage_evidence JSONB NOT NULL CHECK (jsonb_typeof(stage_evidence) = 'array'),
  source_evidence JSONB NOT NULL CHECK (jsonb_typeof(source_evidence) = 'array'),
  unresolved_gaps JSONB NOT NULL CHECK (jsonb_typeof(unresolved_gaps) = 'array'),
  operator_attestation JSONB CHECK (operator_attestation IS NULL OR jsonb_typeof(operator_attestation) = 'object'),
  created_by TEXT NOT NULL CHECK (btrim(created_by) <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ssdlc_reconciliation_idempotency_unique UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_ssdlc_reconciliation_spec_revision
  ON ssdlc_reconciliation_receipts (workspace_id, spec_slug, spec_revision_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS ssdlc_release_qualifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  spec_slug TEXT NOT NULL CHECK (btrim(spec_slug) <> ''),
  spec_revision_hash TEXT NOT NULL CHECK (spec_revision_hash ~ '^sha256:[0-9a-f]{64}$'),
  compiled_plan_id BIGINT REFERENCES ssdlc_compiled_plans(id) ON DELETE RESTRICT,
  run_id BIGINT REFERENCES pipeline_runs(id) ON DELETE SET NULL,
  head_sha TEXT NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40,64}$'),
  idempotency_key TEXT NOT NULL CHECK (btrim(idempotency_key) <> ''),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^sha256:[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'blocked')),
  mechanisms JSONB NOT NULL CHECK (jsonb_typeof(mechanisms) = 'array'),
  check_results JSONB NOT NULL CHECK (jsonb_typeof(check_results) = 'array'),
  evidence_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_ids) = 'array'),
  readiness JSONB NOT NULL CHECK (jsonb_typeof(readiness) = 'object'),
  receipt_hash TEXT NOT NULL CHECK (receipt_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_by TEXT NOT NULL CHECK (btrim(created_by) <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ssdlc_release_qualification_idempotency_unique UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_ssdlc_release_qualification_spec_revision
  ON ssdlc_release_qualifications (workspace_id, spec_slug, spec_revision_hash, created_at DESC);

ALTER TABLE ssdlc_lifecycle_evidence DROP CONSTRAINT IF EXISTS ssdlc_evidence_status_check;
ALTER TABLE ssdlc_lifecycle_evidence ADD CONSTRAINT ssdlc_evidence_status_check CHECK (evidence_status IN (
  'passed', 'failed', 'story_caused_failure', 'unrelated_baseline', 'environment_credential_blocker',
  'skipped_with_rationale', 'unknown'
));

CREATE OR REPLACE FUNCTION reject_ssdlc_reconciliation_artifact_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'SSDLC reconciliation and qualification artifacts are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ssdlc_reconciliation_receipts_append_only ON ssdlc_reconciliation_receipts;
CREATE TRIGGER trg_ssdlc_reconciliation_receipts_append_only
  BEFORE UPDATE OR DELETE ON ssdlc_reconciliation_receipts
  FOR EACH ROW EXECUTE FUNCTION reject_ssdlc_reconciliation_artifact_mutation();

DROP TRIGGER IF EXISTS trg_ssdlc_release_qualifications_append_only ON ssdlc_release_qualifications;
CREATE TRIGGER trg_ssdlc_release_qualifications_append_only
  BEFORE UPDATE OR DELETE ON ssdlc_release_qualifications
  FOR EACH ROW EXECUTE FUNCTION reject_ssdlc_reconciliation_artifact_mutation();
