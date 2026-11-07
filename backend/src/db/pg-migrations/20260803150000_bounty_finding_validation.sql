-- Independent finding validation, exact human admission, and atomic affected-target stop fences.
-- Validation policy contents live in versioned application code; durable rows pin that version and decision hash.

CREATE TABLE bounty_finding_approval_receipts (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  program_id UUID NOT NULL,
  mission_id UUID NOT NULL,
  action TEXT NOT NULL CHECK (action = 'finding.admit'),
  target_hash TEXT NOT NULL CHECK (target_hash ~ '^sha256:[0-9a-f]{64}$'),
  exact_target JSONB NOT NULL CHECK (jsonb_typeof(exact_target) = 'object'),
  provider_event JSONB NOT NULL CHECK (jsonb_typeof(provider_event) = 'object'),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, program_id) REFERENCES bounty_programs(workspace_id, id),
  FOREIGN KEY (workspace_id, mission_id) REFERENCES bounty_missions(workspace_id, id),
  CHECK (consumed_at IS NULL OR revoked_at IS NULL),
  CHECK (expires_at > created_at)
);

CREATE TABLE bounty_affected_target_stop_fences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  mission_id UUID NOT NULL,
  affected_target_id TEXT NOT NULL,
  finding_id UUID NOT NULL,
  decision_hash TEXT NOT NULL CHECK (decision_hash ~ '^sha256:[0-9a-f]{64}$'),
  stopped_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, mission_id, affected_target_id),
  UNIQUE (workspace_id, finding_id),
  UNIQUE (workspace_id, mission_id, affected_target_id, finding_id),
  FOREIGN KEY (workspace_id, mission_id) REFERENCES bounty_missions(workspace_id, id),
  FOREIGN KEY (workspace_id, finding_id) REFERENCES bounty_findings(workspace_id, id)
);

CREATE TABLE bounty_finding_admissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  mission_id UUID NOT NULL,
  candidate_identity TEXT NOT NULL,
  finding_id UUID NOT NULL,
  affected_target_id TEXT NOT NULL,
  policy_version TEXT NOT NULL CHECK (policy_version = 'bounty.validation.v1'),
  decision_hash TEXT NOT NULL CHECK (decision_hash ~ '^sha256:[0-9a-f]{64}$'),
  disposition TEXT NOT NULL CHECK (disposition IN ('admitted','human-required')),
  approval_receipt_id UUID,
  admitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, mission_id, candidate_identity),
  UNIQUE (workspace_id, finding_id),
  FOREIGN KEY (workspace_id, mission_id) REFERENCES bounty_missions(workspace_id, id),
  FOREIGN KEY (workspace_id, finding_id) REFERENCES bounty_findings(workspace_id, id),
  FOREIGN KEY (workspace_id, mission_id, affected_target_id, finding_id)
    REFERENCES bounty_affected_target_stop_fences(workspace_id, mission_id, affected_target_id, finding_id),
  FOREIGN KEY (workspace_id, approval_receipt_id) REFERENCES bounty_finding_approval_receipts(workspace_id, id),
  CHECK ((disposition = 'admitted' AND approval_receipt_id IS NULL)
    OR (disposition = 'human-required' AND approval_receipt_id IS NOT NULL))
);

-- A provider-human receipt may transition once to consumed or revoked; its exact signed target is immutable.
CREATE FUNCTION bounty_guard_finding_approval_receipt_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'finding approval receipt is immutable or already terminal' USING ERRCODE = '55000';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['consumed_at','revoked_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['consumed_at','revoked_at'])
    OR OLD.consumed_at IS NOT NULL OR OLD.revoked_at IS NOT NULL
    OR (NEW.consumed_at IS NOT NULL AND NEW.revoked_at IS NOT NULL)
    OR (NEW.consumed_at IS DISTINCT FROM OLD.consumed_at AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'finding approval receipt is immutable or already terminal' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bounty_finding_approval_receipt_guard BEFORE UPDATE OR DELETE ON bounty_finding_approval_receipts
FOR EACH ROW EXECUTE FUNCTION bounty_guard_finding_approval_receipt_update();

CREATE TRIGGER bounty_affected_target_stop_fence_immutable BEFORE UPDATE OR DELETE ON bounty_affected_target_stop_fences
FOR EACH ROW EXECUTE FUNCTION bounty_reject_append_only_mutation();
CREATE TRIGGER bounty_finding_admission_immutable BEFORE UPDATE OR DELETE ON bounty_finding_admissions
FOR EACH ROW EXECUTE FUNCTION bounty_reject_append_only_mutation();
