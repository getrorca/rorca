-- 20260818230000_ssdlc_evidence_testing_classification.sql
-- The 11→7 phase collapse (20260817150000) renamed the validation/security/qa
-- phases to 'testing' and updated every evidence writer to classify those rows
-- as 'testing', but never updated ssdlc_evidence_classification_check. Every
-- governed story closeout then failed persisting its evidence with a CHECK
-- violation, and the story was marked fail/closeout_exception despite an
-- accepted closeout decision.
--
-- Admit the canonical 'testing' classification alongside the pre-collapse
-- values (legacy rows keep 'qa' valid).

ALTER TABLE ssdlc_lifecycle_evidence
  DROP CONSTRAINT IF EXISTS ssdlc_evidence_classification_check;

ALTER TABLE ssdlc_lifecycle_evidence
  ADD CONSTRAINT ssdlc_evidence_classification_check CHECK (classification IN (
    'validation', 'revision', 'completion', 'risk_judgment', 'qa', 'testing',
    'documentation', 'staging', 'deployment', 'memory_closeout', 'approval'
  ));
