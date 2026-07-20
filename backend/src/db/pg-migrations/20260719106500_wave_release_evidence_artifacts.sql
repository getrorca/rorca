-- Authenticated durable evidence referenced by wave release-readiness packets.
-- Caller-provided digest strings never become release authority until a trusted
-- operator attestation is verified by application code and persisted here.

CREATE TABLE IF NOT EXISTS wave_release_evidence_artifacts (
  id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  evidence_digest TEXT NOT NULL CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  source_revision TEXT NOT NULL CHECK (source_revision ~ '^[0-9a-f]{40,64}$'),
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN (
    'reviewer_attestation', 'ci_attestation', 'durable_db_wal', 'git_integration',
    'independent_checker', 'canary', 'soak', 'rollback', 'nonmutation',
    'wpe_evidence_bundle'
  )),
  subject_id TEXT CHECK (subject_id IS NULL OR subject_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$'),
  operator_id TEXT NOT NULL CHECK (operator_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$'),
  attested_at TIMESTAMPTZ NOT NULL,
  attestation JSONB NOT NULL CHECK (attestation->>'schemaVersion' = 'rorca.wave-release-evidence/v1'),
  authorization_digest TEXT NOT NULL CHECK (authorization_digest ~ '^sha256:[0-9a-f]{64}$'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, evidence_digest)
);

CREATE INDEX IF NOT EXISTS idx_wave_release_evidence_revision
  ON wave_release_evidence_artifacts (workspace_id, source_revision, evidence_kind);

CREATE OR REPLACE FUNCTION reject_wave_release_evidence_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'wave release evidence artifacts are append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_wave_release_evidence_immutable ON wave_release_evidence_artifacts;
CREATE TRIGGER trg_wave_release_evidence_immutable
BEFORE UPDATE OR DELETE ON wave_release_evidence_artifacts
FOR EACH ROW EXECUTE FUNCTION reject_wave_release_evidence_mutation();

-- This table stores Rorca release authority only and never mutates pgboss.*.
