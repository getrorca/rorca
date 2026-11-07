-- Wave 5 SSDLC E2E: documentative evidence classification.
-- The lifecycle plan compiler classifies intake/requirements/architecture gates
-- as 'documentation', but no evidence source could ever produce that
-- classification, so those gates were unsatisfiable. Adds the
-- documentation_review Hermes evidence kind and the 'documentation'
-- classification to the ledger constraints.

ALTER TABLE ssdlc_lifecycle_evidence
  DROP CONSTRAINT IF EXISTS ssdlc_evidence_classification_check;
ALTER TABLE ssdlc_lifecycle_evidence
  ADD CONSTRAINT ssdlc_evidence_classification_check CHECK (classification IN (
    'validation', 'revision', 'completion', 'risk_judgment', 'qa', 'documentation',
    'staging', 'deployment', 'memory_closeout', 'approval'
  ));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ssdlc_evidence_source_type_check') THEN
    ALTER TABLE ssdlc_lifecycle_evidence ADD CONSTRAINT ssdlc_evidence_source_type_check CHECK (source_type IN (
      'story_result', 'story_commit', 'wal_validation', 'github_check', 'completion_signal',
      'gitreins_judgment', 'manual_qa', 'documentation_review', 'staging_result', 'deployment_proof', 'memory_closeout'
    ));
  ELSE
    ALTER TABLE ssdlc_lifecycle_evidence DROP CONSTRAINT ssdlc_evidence_source_type_check;
    ALTER TABLE ssdlc_lifecycle_evidence ADD CONSTRAINT ssdlc_evidence_source_type_check CHECK (source_type IN (
      'story_result', 'story_commit', 'wal_validation', 'github_check', 'completion_signal',
      'gitreins_judgment', 'manual_qa', 'documentation_review', 'staging_result', 'deployment_proof', 'memory_closeout'
    ));
  END IF;
END $$;

-- manual-style provenance requirements apply to documentation reviews too
ALTER TABLE ssdlc_lifecycle_evidence
  DROP CONSTRAINT IF EXISTS ssdlc_evidence_manual_provenance_check;
ALTER TABLE ssdlc_lifecycle_evidence
  ADD CONSTRAINT ssdlc_evidence_manual_provenance_check CHECK (
    (source_type IN ('manual_qa', 'documentation_review')
      AND trust_level = 'authenticated_manual'
      AND actor IS NOT NULL AND btrim(actor) <> ''
      AND rationale IS NOT NULL AND btrim(rationale) <> ''
      AND source_ref IS NOT NULL AND btrim(source_ref) <> '')
    OR
    (source_type NOT IN ('manual_qa', 'documentation_review') AND actor IS NULL AND rationale IS NULL)
  );
