-- Durable independent review and separate operator activation for wave-parallel release.
-- Additive only: no existing workspace, spec, run, evidence, queue, branch, receipt,
-- rollout control, or operator audit row is rewritten or removed. pg-boss owns its schema.

CREATE TABLE IF NOT EXISTS wave_release_readiness_packets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  qualification_receipt_id BIGINT NOT NULL REFERENCES wave_qualification_receipts(id) ON DELETE RESTRICT,
  report_hash TEXT NOT NULL CHECK (report_hash ~ '^sha256:[0-9a-f]{64}$'),
  source_revision TEXT NOT NULL CHECK (source_revision ~ '^[0-9a-f]{40,64}$'),
  pull_request_number BIGINT NOT NULL CHECK (pull_request_number > 0),
  implementer_id TEXT NOT NULL CHECK (implementer_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$'),
  packet_hash TEXT NOT NULL UNIQUE CHECK (packet_hash ~ '^sha256:[0-9a-f]{64}$'),
  packet JSONB NOT NULL CHECK (packet->>'schemaVersion' = 'rorca.wave-release-readiness/v1'),
  approved BOOLEAN NOT NULL CHECK (approved),
  recorded_by TEXT NOT NULL CHECK (recorded_by ~ '^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, qualification_receipt_id, source_revision),
  CHECK (packet->'qualification'->>'reportHash' = report_hash),
  CHECK (packet->'qualification'->>'sourceRevision' = source_revision),
  CHECK (packet->'pullRequest'->>'headRevision' = source_revision),
  CHECK ((packet->'pullRequest'->>'autoMergeEnabled')::BOOLEAN = FALSE),
  CHECK ((packet->'pullRequest'->>'deploymentEnabled')::BOOLEAN = FALSE)
);

CREATE TABLE IF NOT EXISTS wave_production_activation_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  release_readiness_packet_id UUID NOT NULL UNIQUE REFERENCES wave_release_readiness_packets(id) ON DELETE RESTRICT,
  source_revision TEXT NOT NULL CHECK (source_revision ~ '^[0-9a-f]{40,64}$'),
  operator_id TEXT NOT NULL CHECK (operator_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$'),
  rationale TEXT NOT NULL CHECK (octet_length(rationale) BETWEEN 1 AND 2048),
  confirmation TEXT NOT NULL CHECK (confirmation = 'AUTHORIZE_WAVE_PARALLEL_PRODUCTION'),
  authorization_digest TEXT NOT NULL CHECK (authorization_digest ~ '^sha256:[0-9a-f]{64}$'),
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, source_revision, operator_id)
);

ALTER TABLE wave_parallel_rollout_controls
  ADD COLUMN IF NOT EXISTS release_readiness_packet_id UUID REFERENCES wave_release_readiness_packets(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS production_activation_approval_id UUID REFERENCES wave_production_activation_approvals(id) ON DELETE RESTRICT;

-- Existing rows are never rewritten. NOT VALID still checks every new insert/update,
-- while allowing an operator to inspect and explicitly retire any historical control.
ALTER TABLE wave_parallel_rollout_controls
  ADD CONSTRAINT wave_parallel_rollout_release_authority_check
  CHECK (
    NOT enabled OR (
      qualification_receipt_id IS NOT NULL
      AND release_readiness_packet_id IS NOT NULL
      AND production_activation_approval_id IS NOT NULL
    )
  ) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_wave_release_readiness_workspace_recorded
  ON wave_release_readiness_packets (workspace_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_wave_activation_workspace_approved
  ON wave_production_activation_approvals (workspace_id, approved_at DESC);

CREATE OR REPLACE FUNCTION reject_wave_release_readiness_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'wave release readiness packets are append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_wave_release_readiness_immutable ON wave_release_readiness_packets;
CREATE TRIGGER trg_wave_release_readiness_immutable
BEFORE UPDATE OR DELETE ON wave_release_readiness_packets
FOR EACH ROW EXECUTE FUNCTION reject_wave_release_readiness_mutation();

CREATE OR REPLACE FUNCTION reject_wave_production_activation_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'wave production activation approvals are append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_wave_production_activation_immutable ON wave_production_activation_approvals;
CREATE TRIGGER trg_wave_production_activation_immutable
BEFORE UPDATE OR DELETE ON wave_production_activation_approvals
FOR EACH ROW EXECUTE FUNCTION reject_wave_production_activation_mutation();
