-- Immutable, trusted validation evidence and provenance for admin checkpoint recovery.
-- Callers may reference an attestation but cannot create one through a public API.

CREATE TABLE IF NOT EXISTS checkpoint_validation_attestations (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id BIGINT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  story_id TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  checkpoint_sha CHAR(40) NOT NULL CHECK (checkpoint_sha ~ '^[0-9a-f]{40}$'),
  validation_gate TEXT NOT NULL CHECK (validation_gate IN ('execution-engine', 'ci')),
  evidence_digest CHAR(64) NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  passed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > passed_at),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS checkpoint_reconciliations (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id BIGINT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  story_id TEXT NOT NULL,
  spec_id TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  checkpoint_sha CHAR(40) NOT NULL CHECK (checkpoint_sha ~ '^[0-9a-f]{40}$'),
  attestation_id UUID NOT NULL REFERENCES checkpoint_validation_attestations(id),
  attestation_digest CHAR(64) NOT NULL CHECK (attestation_digest ~ '^[0-9a-f]{64}$'),
  validation_gate TEXT NOT NULL CHECK (validation_gate IN ('execution-engine', 'ci')),
  reconciled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, run_id, story_id)
);

CREATE INDEX IF NOT EXISTS idx_checkpoint_attestations_binding
  ON checkpoint_validation_attestations (workspace_id, run_id, story_id, branch_name, checkpoint_sha);
