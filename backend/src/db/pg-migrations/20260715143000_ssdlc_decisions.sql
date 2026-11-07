-- 20260715143000_ssdlc_decisions.sql
-- LFC-007: governed, expiring, revocable SSDLC decisions with immutable actor provenance.
-- Evidence remains append-only in ssdlc_lifecycle_evidence and is never updated by this ledger.

CREATE TABLE IF NOT EXISTS ssdlc_decisions (
  id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  spec_slug TEXT NOT NULL CHECK (btrim(spec_slug) <> ''),
  spec_version TEXT,
  run_id INTEGER REFERENCES pipeline_runs(id) ON DELETE SET NULL,
  story_id TEXT,
  phase_id TEXT NOT NULL CHECK (btrim(phase_id) <> ''),
  gate_id TEXT,
  decision_type TEXT NOT NULL CHECK (decision_type IN (
    'defer',
    'not_applicable_confirmation',
    'gate_override',
    'qa_approval',
    'merge_approval',
    'production_approval'
  )),
  rationale TEXT NOT NULL CHECK (length(btrim(rationale)) >= 10),
  evidence_gap TEXT,
  subject_type TEXT CHECK (subject_type IN ('commit_sha', 'artifact_digest')),
  subject_value TEXT,
  policy_version TEXT NOT NULL CHECK (btrim(policy_version) <> ''),
  policy_reference TEXT NOT NULL CHECK (btrim(policy_reference) <> ''),
  policy_authorized BOOLEAN NOT NULL CHECK (policy_authorized),
  principal_type TEXT NOT NULL CHECK (principal_type IN (
    'local_admin', 'authenticated_user', 'hermes', 'internal_service'
  )),
  principal_id TEXT NOT NULL CHECK (btrim(principal_id) <> ''),
  principal_display_label TEXT NOT NULL CHECK (btrim(principal_display_label) <> ''),
  actor TEXT NOT NULL CHECK (btrim(actor) <> ''),
  delegated_principal_id TEXT,
  delegated_display_label TEXT,
  source_request_id TEXT NOT NULL CHECK (btrim(source_request_id) <> ''),
  source_channel TEXT NOT NULL CHECK (source_channel IN ('local', 'api', 'hermes', 'internal')),
  scope_key TEXT NOT NULL CHECK (btrim(scope_key) <> ''),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^sha256:[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by_principal_type TEXT CHECK (revoked_by_principal_type IN (
    'local_admin', 'authenticated_user', 'hermes', 'internal_service'
  )),
  revoked_by_principal_id TEXT,
  revoked_by_display_label TEXT,
  revocation_rationale TEXT,
  revocation_source_request_id TEXT,
  CONSTRAINT ssdlc_decisions_expiry_check CHECK (
    expires_at IS NULL OR expires_at > created_at
  ),
  CONSTRAINT ssdlc_decisions_required_expiry_check CHECK (
    decision_type NOT IN ('defer', 'gate_override') OR expires_at IS NOT NULL
  ),
  CONSTRAINT ssdlc_decisions_override_scope_check CHECK (
    decision_type <> 'gate_override'
    OR (gate_id IS NOT NULL AND btrim(gate_id) <> ''
      AND evidence_gap IS NOT NULL AND length(btrim(evidence_gap)) >= 10)
  ),
  CONSTRAINT ssdlc_decisions_subject_binding_check CHECK (
    (decision_type IN ('qa_approval', 'merge_approval', 'production_approval')
      AND subject_type IS NOT NULL AND subject_value IS NOT NULL AND btrim(subject_value) <> '')
    OR
    (decision_type NOT IN ('qa_approval', 'merge_approval', 'production_approval')
      AND subject_type IS NULL AND subject_value IS NULL)
  ),
  CONSTRAINT ssdlc_decisions_delegation_check CHECK (
    (delegated_principal_id IS NULL AND delegated_display_label IS NULL)
    OR
    (principal_type = 'hermes'
      AND delegated_principal_id IS NOT NULL AND btrim(delegated_principal_id) <> ''
      AND delegated_display_label IS NOT NULL AND btrim(delegated_display_label) <> '')
  ),
  CONSTRAINT ssdlc_decisions_revocation_check CHECK (
    (revoked_at IS NULL
      AND revoked_by_principal_type IS NULL
      AND revoked_by_principal_id IS NULL
      AND revoked_by_display_label IS NULL
      AND revocation_rationale IS NULL
      AND revocation_source_request_id IS NULL)
    OR
    (revoked_at IS NOT NULL AND revoked_at >= created_at
      AND revoked_by_principal_type IS NOT NULL
      AND revoked_by_principal_id IS NOT NULL AND btrim(revoked_by_principal_id) <> ''
      AND revoked_by_display_label IS NOT NULL AND btrim(revoked_by_display_label) <> ''
      AND revocation_rationale IS NOT NULL AND length(btrim(revocation_rationale)) >= 10
      AND revocation_source_request_id IS NOT NULL AND btrim(revocation_source_request_id) <> '')
  ),
  CONSTRAINT ssdlc_decisions_source_request_unique UNIQUE (workspace_id, source_request_id)
);

CREATE INDEX IF NOT EXISTS idx_ssdlc_decisions_scope_active
  ON ssdlc_decisions (workspace_id, spec_slug, phase_id, gate_id, story_id, run_id, created_at DESC)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ssdlc_decisions_history
  ON ssdlc_decisions (workspace_id, spec_slug, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ssdlc_decisions_subject
  ON ssdlc_decisions (workspace_id, spec_slug, subject_type, subject_value)
  WHERE revoked_at IS NULL AND subject_type IS NOT NULL;

-- Rows are immutable except for one complete, one-way revocation. This keeps actor,
-- scope, policy, identity binding, and rationale snapshots audit-stable.
CREATE OR REPLACE FUNCTION guard_ssdlc_decision_ledger_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SSDLc decisions are audit-retained and cannot be deleted';
  END IF;

  IF OLD.revoked_at IS NOT NULL
     OR NEW.revoked_at IS NULL
     OR NEW.revoked_by_principal_type IS NULL
     OR NEW.revoked_by_principal_id IS NULL
     OR NEW.revoked_by_display_label IS NULL
     OR NEW.revocation_rationale IS NULL
     OR NEW.revocation_source_request_id IS NULL
     OR (to_jsonb(OLD) - ARRAY[
          'revoked_at', 'revoked_by_principal_type', 'revoked_by_principal_id',
          'revoked_by_display_label', 'revocation_rationale', 'revocation_source_request_id'
        ]::text[])
        IS DISTINCT FROM
        (to_jsonb(NEW) - ARRAY[
          'revoked_at', 'revoked_by_principal_type', 'revoked_by_principal_id',
          'revoked_by_display_label', 'revocation_rationale', 'revocation_source_request_id'
        ]::text[]) THEN
    RAISE EXCEPTION 'SSDLc decisions are immutable; only one-way revocation is allowed';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ssdlc_decisions_immutable ON ssdlc_decisions;
CREATE TRIGGER ssdlc_decisions_immutable
  BEFORE UPDATE OR DELETE ON ssdlc_decisions
  FOR EACH ROW EXECUTE FUNCTION guard_ssdlc_decision_ledger_mutation();
