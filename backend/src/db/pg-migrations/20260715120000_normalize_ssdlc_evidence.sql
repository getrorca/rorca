-- 20260715120000_normalize_ssdlc_evidence.sql
-- LFC-005: immutable normalized lifecycle evidence provenance, trust, and revision identity.
-- Extends the existing LFC-002 ledger; large output remains in its canonical chunk/log storage.

ALTER TABLE ssdlc_lifecycle_evidence
  ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'completion_signal',
  ADD COLUMN IF NOT EXISTS classification TEXT NOT NULL DEFAULT 'completion',
  ADD COLUMN IF NOT EXISTS evidence_status TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS trust_level TEXT NOT NULL DEFAULT 'host_observed',
  ADD COLUMN IF NOT EXISTS confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS excerpt TEXT,
  ADD COLUMN IF NOT EXISTS release_identity JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS phase_subject_type TEXT,
  ADD COLUMN IF NOT EXISTS phase_subject_value TEXT,
  ADD COLUMN IF NOT EXISTS revision_mismatch BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS lineage_verified BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS actor TEXT,
  ADD COLUMN IF NOT EXISTS rationale TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ssdlc_evidence_source_type_check') THEN
    ALTER TABLE ssdlc_lifecycle_evidence ADD CONSTRAINT ssdlc_evidence_source_type_check CHECK (source_type IN (
      'story_result', 'story_commit', 'wal_validation', 'github_check', 'completion_signal',
      'gitreins_judgment', 'manual_qa', 'staging_result', 'deployment_proof', 'memory_closeout'
    ));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ssdlc_evidence_classification_check') THEN
    ALTER TABLE ssdlc_lifecycle_evidence ADD CONSTRAINT ssdlc_evidence_classification_check CHECK (classification IN (
      'validation', 'revision', 'completion', 'risk_judgment', 'qa', 'staging', 'deployment', 'memory_closeout'
    ));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ssdlc_evidence_status_check') THEN
    ALTER TABLE ssdlc_lifecycle_evidence ADD CONSTRAINT ssdlc_evidence_status_check CHECK (evidence_status IN (
      'passed', 'story_caused_failure', 'unrelated_baseline', 'environment_credential_blocker',
      'skipped_with_rationale', 'unknown'
    ));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ssdlc_evidence_trust_check') THEN
    ALTER TABLE ssdlc_lifecycle_evidence ADD CONSTRAINT ssdlc_evidence_trust_check CHECK (
      trust_level IN ('host_observed', 'provider_verified', 'authenticated_manual', 'agent_proposed')
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ssdlc_evidence_confidence_check') THEN
    ALTER TABLE ssdlc_lifecycle_evidence ADD CONSTRAINT ssdlc_evidence_confidence_check CHECK (
      confidence >= 0 AND confidence <= 1
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ssdlc_evidence_excerpt_bound_check') THEN
    ALTER TABLE ssdlc_lifecycle_evidence ADD CONSTRAINT ssdlc_evidence_excerpt_bound_check CHECK (
      excerpt IS NULL OR octet_length(excerpt) <= 8192
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ssdlc_evidence_source_ref_bound_check') THEN
    ALTER TABLE ssdlc_lifecycle_evidence ADD CONSTRAINT ssdlc_evidence_source_ref_bound_check CHECK (
      source_ref IS NULL OR octet_length(source_ref) <= 4096
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ssdlc_evidence_release_identity_check') THEN
    ALTER TABLE ssdlc_lifecycle_evidence ADD CONSTRAINT ssdlc_evidence_release_identity_check CHECK (
      jsonb_typeof(release_identity) = 'object'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ssdlc_evidence_phase_subject_check') THEN
    ALTER TABLE ssdlc_lifecycle_evidence ADD CONSTRAINT ssdlc_evidence_phase_subject_check CHECK (
      (phase_subject_type IS NULL AND phase_subject_value IS NULL)
      OR
      (phase_subject_type IN ('spec_hash', 'commit_sha', 'artifact_digest', 'deployment_id')
        AND phase_subject_value IS NOT NULL AND btrim(phase_subject_value) <> '')
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ssdlc_evidence_manual_provenance_check') THEN
    ALTER TABLE ssdlc_lifecycle_evidence ADD CONSTRAINT ssdlc_evidence_manual_provenance_check CHECK (
      (source_type = 'manual_qa'
        AND trust_level = 'authenticated_manual'
        AND actor IS NOT NULL AND btrim(actor) <> ''
        AND rationale IS NOT NULL AND btrim(rationale) <> ''
        AND source_ref IS NOT NULL AND btrim(source_ref) <> '')
      OR
      (source_type <> 'manual_qa' AND actor IS NULL AND rationale IS NULL)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ssdlc_evidence_automated_trust_check') THEN
    ALTER TABLE ssdlc_lifecycle_evidence ADD CONSTRAINT ssdlc_evidence_automated_trust_check CHECK (
      source_type NOT IN ('gitreins_judgment', 'github_check', 'staging_result', 'deployment_proof')
      OR trust_level IN ('host_observed', 'provider_verified')
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ssdlc_evidence_gate_resolution
  ON ssdlc_lifecycle_evidence (
    workspace_id, spec_slug, phase_id, gate_id, evidence_status, trust_level, revision_mismatch, observed_at DESC
  );

CREATE INDEX IF NOT EXISTS idx_ssdlc_evidence_subject
  ON ssdlc_lifecycle_evidence (workspace_id, subject_type, subject_value, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_ssdlc_evidence_source_event
  ON ssdlc_lifecycle_evidence (workspace_id, source_system, source_idempotency_key, payload_hash);
