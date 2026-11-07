-- Exact local bounty report drafts and provider-human submission-readiness facts.
-- There is deliberately no submission outbox, destination, platform, transport, or delivery state.

CREATE TABLE bounty_report_drafts (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  program_id UUID NOT NULL,
  mission_id UUID NOT NULL,
  finding_id UUID NOT NULL,
  admission_decision_hash TEXT NOT NULL CHECK (admission_decision_hash ~ '^sha256:[0-9a-f]{64}$'),
  revision BIGINT NOT NULL CHECK (revision > 0),
  policy_version TEXT NOT NULL CHECK (policy_version = 'bounty.report.v1'),
  markdown_bytes BYTEA NOT NULL CHECK (octet_length(markdown_bytes) BETWEEN 1 AND 1000000),
  json_bytes BYTEA NOT NULL CHECK (octet_length(json_bytes) BETWEEN 1 AND 1000000),
  markdown_hash TEXT NOT NULL CHECK (markdown_hash ~ '^sha256:[0-9a-f]{64}$'),
  json_hash TEXT NOT NULL CHECK (json_hash ~ '^sha256:[0-9a-f]{64}$'),
  citation_manifest JSONB NOT NULL CHECK (jsonb_typeof(citation_manifest) = 'array' AND jsonb_array_length(citation_manifest) > 0),
  citation_manifest_hash TEXT NOT NULL CHECK (citation_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  redaction_manifest JSONB NOT NULL CHECK (jsonb_typeof(redaction_manifest) = 'array'),
  redaction_manifest_hash TEXT NOT NULL CHECK (redaction_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  bundle_hash TEXT NOT NULL CHECK (bundle_hash ~ '^sha256:[0-9a-f]{64}$'),
  release_status TEXT NOT NULL DEFAULT 'draft-unreleased' CHECK (release_status = 'draft-unreleased'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, finding_id, revision),
  UNIQUE (workspace_id, bundle_hash),
  FOREIGN KEY (workspace_id, program_id) REFERENCES bounty_programs(workspace_id, id),
  FOREIGN KEY (workspace_id, mission_id) REFERENCES bounty_missions(workspace_id, id),
  FOREIGN KEY (workspace_id, finding_id) REFERENCES bounty_findings(workspace_id, id),
  FOREIGN KEY (workspace_id, finding_id) REFERENCES bounty_finding_admissions(workspace_id, finding_id)
);

CREATE TRIGGER bounty_report_draft_revision_sequence BEFORE INSERT ON bounty_report_drafts
FOR EACH ROW EXECUTE FUNCTION bounty_require_next_number('finding_id','revision');

-- This receipt stores a provider-verified event. Only its one-use consumed/revoked terminal state can change.
CREATE TABLE bounty_draft_release_approval_receipts (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  program_id UUID NOT NULL,
  mission_id UUID NOT NULL,
  action TEXT NOT NULL DEFAULT 'draft.release' CHECK (action = 'draft.release'),
  target_hash TEXT NOT NULL CHECK (target_hash ~ '^sha256:[0-9a-f]{64}$'),
  exact_target JSONB NOT NULL CHECK (jsonb_typeof(exact_target) = 'object' AND exact_target->>'action' = 'draft.release'),
  provider_event JSONB NOT NULL CHECK (jsonb_typeof(provider_event) = 'object' AND provider_event#>>'{actor,kind}' = 'provider_human'),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, program_id) REFERENCES bounty_programs(workspace_id, id),
  FOREIGN KEY (workspace_id, mission_id) REFERENCES bounty_missions(workspace_id, id),
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR revoked_at IS NULL)
);

CREATE TABLE bounty_report_releases (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  draft_id UUID NOT NULL,
  approval_receipt_id UUID NOT NULL,
  readiness_status TEXT NOT NULL DEFAULT 'submission-ready' CHECK (readiness_status = 'submission-ready'),
  bundle_hash TEXT NOT NULL CHECK (bundle_hash ~ '^sha256:[0-9a-f]{64}$'),
  markdown_hash TEXT NOT NULL CHECK (markdown_hash ~ '^sha256:[0-9a-f]{64}$'),
  json_hash TEXT NOT NULL CHECK (json_hash ~ '^sha256:[0-9a-f]{64}$'),
  citation_manifest_hash TEXT NOT NULL CHECK (citation_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  redaction_manifest_hash TEXT NOT NULL CHECK (redaction_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  released_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, draft_id),
  UNIQUE (workspace_id, approval_receipt_id),
  FOREIGN KEY (workspace_id, draft_id) REFERENCES bounty_report_drafts(workspace_id, id),
  FOREIGN KEY (workspace_id, approval_receipt_id) REFERENCES bounty_draft_release_approval_receipts(workspace_id, id)
);

CREATE FUNCTION bounty_guard_draft_release_approval_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'draft release approval is immutable or terminal' USING ERRCODE = '55000';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['consumed_at','revoked_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['consumed_at','revoked_at'])
    OR OLD.consumed_at IS NOT NULL OR OLD.revoked_at IS NOT NULL
    OR (NEW.consumed_at IS NOT NULL AND NEW.revoked_at IS NOT NULL)
    OR (NEW.consumed_at IS DISTINCT FROM OLD.consumed_at AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'draft release approval is immutable or terminal' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bounty_draft_release_approval_guard BEFORE UPDATE OR DELETE ON bounty_draft_release_approval_receipts
FOR EACH ROW EXECUTE FUNCTION bounty_guard_draft_release_approval_update();

-- Exact drafts/releases cannot be edited in place. A changed report is a fresh unreleased revision.
CREATE TRIGGER bounty_report_drafts_immutable BEFORE UPDATE OR DELETE ON bounty_report_drafts
FOR EACH ROW EXECUTE FUNCTION bounty_reject_append_only_mutation();
CREATE TRIGGER bounty_report_releases_immutable BEFORE UPDATE OR DELETE ON bounty_report_releases
FOR EACH ROW EXECUTE FUNCTION bounty_reject_append_only_mutation();
