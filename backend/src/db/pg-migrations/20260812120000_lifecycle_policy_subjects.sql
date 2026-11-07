-- Lifecycle policy approvals bind to the same four immutable release subjects as evidence.
ALTER TABLE ssdlc_decisions
  DROP CONSTRAINT IF EXISTS ssdlc_decisions_subject_type_check;

ALTER TABLE ssdlc_decisions
  ADD CONSTRAINT ssdlc_decisions_subject_type_check CHECK (
    subject_type IS NULL OR subject_type IN (
      'spec_hash', 'commit_sha', 'artifact_digest', 'deployment_id'
    )
  );

-- Internal policy decisions carry a structured exact compiled-plan identity.
-- Existing policy decisions remain historical but cannot satisfy the new
-- evaluator contract without this binding.
ALTER TABLE ssdlc_decisions
  ADD COLUMN IF NOT EXISTS compiled_plan_id BIGINT
    REFERENCES ssdlc_compiled_plans(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS plan_id TEXT;

ALTER TABLE ssdlc_decisions
  DROP CONSTRAINT IF EXISTS ssdlc_decisions_policy_plan_identity_check;

ALTER TABLE ssdlc_decisions
  ADD CONSTRAINT ssdlc_decisions_policy_plan_identity_check CHECK (
    decision_type <> 'policy_approval'
    OR (compiled_plan_id IS NOT NULL AND plan_id IS NOT NULL AND btrim(plan_id) <> '')
  ) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_ssdlc_decisions_policy_plan
  ON ssdlc_decisions (workspace_id, spec_slug, compiled_plan_id, plan_id)
  WHERE decision_type = 'policy_approval' AND revoked_at IS NULL;
