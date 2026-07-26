-- Canonical, one-time, expiring human authority for destructive governed retry.
-- Rorca application tables are authoritative; this migration never touches pgboss.*.

CREATE TABLE IF NOT EXISTS governed_retry_human_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_hash TEXT NOT NULL UNIQUE CHECK (receipt_hash ~ '^sha256:[0-9a-f]{64}$'),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  original_run_id BIGINT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  preview_hash TEXT NOT NULL UNIQUE CHECK (preview_hash ~ '^sha256:[0-9a-f]{64}$'),
  packet_hash TEXT NOT NULL CHECK (packet_hash ~ '^sha256:[0-9a-f]{64}$'),
  preview_identity_hash TEXT NOT NULL CHECK (preview_identity_hash ~ '^sha256:[0-9a-f]{64}$'),
  scope_hash TEXT NOT NULL CHECK (scope_hash ~ '^sha256:[0-9a-f]{64}$'),
  rationale TEXT NOT NULL CHECK (char_length(btrim(rationale)) BETWEEN 10 AND 2000),
  rationale_hash TEXT NOT NULL CHECK (rationale_hash ~ '^sha256:[0-9a-f]{64}$'),
  principal_type TEXT NOT NULL CHECK (principal_type = 'authenticated_user'),
  principal_id TEXT NOT NULL,
  principal_auth_id TEXT NOT NULL,
  principal_display_label TEXT NOT NULL,
  source_channel TEXT NOT NULL CHECK (source_channel = 'api'),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^sha256:[0-9a-f]{64}$'),
  claims JSONB NOT NULL CHECK (jsonb_typeof(claims) = 'object'),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  consumed_retry_run_id BIGINT UNIQUE REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  consumed_idempotency_key TEXT,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, idempotency_key),
  CHECK (expires_at > issued_at),
  CHECK (
    (consumed_at IS NULL AND consumed_retry_run_id IS NULL AND consumed_idempotency_key IS NULL)
    OR
    (consumed_at IS NOT NULL AND consumed_retry_run_id IS NOT NULL AND consumed_idempotency_key IS NOT NULL)
  ),
  CHECK (NOT (revoked_at IS NOT NULL AND consumed_at IS NOT NULL))
);

CREATE OR REPLACE FUNCTION enforce_governed_retry_human_approval_immutability()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'governed retry human approvals are append-only';
  END IF;
  IF OLD.consumed_at IS NULL
     AND NEW.consumed_at IS NOT NULL
     AND NEW.consumed_retry_run_id IS NOT NULL
     AND NEW.consumed_idempotency_key IS NOT NULL
     AND ROW(NEW.id, NEW.receipt_hash, NEW.workspace_id, NEW.original_run_id,
             NEW.preview_hash, NEW.packet_hash, NEW.preview_identity_hash, NEW.scope_hash,
             NEW.rationale, NEW.rationale_hash, NEW.principal_type, NEW.principal_id,
             NEW.principal_auth_id, NEW.principal_display_label, NEW.source_channel,
             NEW.idempotency_key, NEW.request_hash, NEW.claims, NEW.issued_at,
             NEW.expires_at, NEW.revoked_at, NEW.created_at)
         IS NOT DISTINCT FROM
         ROW(OLD.id, OLD.receipt_hash, OLD.workspace_id, OLD.original_run_id,
             OLD.preview_hash, OLD.packet_hash, OLD.preview_identity_hash, OLD.scope_hash,
             OLD.rationale, OLD.rationale_hash, OLD.principal_type, OLD.principal_id,
             OLD.principal_auth_id, OLD.principal_display_label, OLD.source_channel,
             OLD.idempotency_key, OLD.request_hash, OLD.claims, OLD.issued_at,
             OLD.expires_at, OLD.revoked_at, OLD.created_at)
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'governed retry human approvals are immutable except for one exact consumption';
END;
$$;

DROP TRIGGER IF EXISTS trg_governed_retry_human_approval_immutable ON governed_retry_human_approvals;
CREATE TRIGGER trg_governed_retry_human_approval_immutable
BEFORE UPDATE OR DELETE ON governed_retry_human_approvals
FOR EACH ROW EXECUTE FUNCTION enforce_governed_retry_human_approval_immutability();

ALTER TABLE pipeline_retry_previews
  ADD COLUMN IF NOT EXISTS human_approval_id UUID
    REFERENCES governed_retry_human_approvals(id) ON DELETE RESTRICT;

-- Fail closed any nonterminal destructive preview admitted by the historical
-- opaque-token rule. Deployment must quiesce old workers before this migration.
UPDATE governed_retry_story_attempts attempt
SET state = 'failed',
    failure_evidence = jsonb_build_object(
      'schemaVersion', 'rorca.retry-human-approval-migration.v1',
      'reason', 'legacy_unverified_retry_approval'
    )
FROM governed_retry_dispatches dispatch
JOIN pipeline_retry_previews preview ON preview.preview_hash = dispatch.preview_hash
WHERE attempt.dispatch_identity_hash = dispatch.identity_hash
  AND COALESCE((preview.packet->>'requiresApproval')::boolean, FALSE)
  AND preview.human_approval_id IS NULL
  AND attempt.state IN ('pending', 'executing', 'committed', 'integrating');

UPDATE governed_retry_dispatches dispatch
SET state = 'failed',
    failure_evidence = jsonb_build_object(
      'schemaVersion', 'rorca.retry-human-approval-migration.v1',
      'reason', 'legacy_unverified_retry_approval'
    ),
    lease_owner = NULL,
    lease_expires_at = NULL
FROM pipeline_retry_previews preview
WHERE dispatch.preview_hash = preview.preview_hash
  AND COALESCE((preview.packet->>'requiresApproval')::boolean, FALSE)
  AND preview.human_approval_id IS NULL
  AND dispatch.state IN ('prepared', 'dispatched', 'claimed', 'executing', 'committed', 'integrating', 'integrated_validated');

UPDATE pipeline_runs run
SET status = 'failed',
    finished_at = COALESCE(run.finished_at, NOW()),
    summary = 'legacy_unverified_retry_approval',
    lifecycle_status = 'failed',
    lifecycle_updated_at = NOW(),
    lifecycle_diagnostics = COALESCE(run.lifecycle_diagnostics, '{}'::jsonb)
      || jsonb_build_object('reason', 'legacy_unverified_retry_approval')
FROM pipeline_retry_previews preview
WHERE preview.retry_run_id = run.id
  AND COALESCE((preview.packet->>'requiresApproval')::boolean, FALSE)
  AND preview.human_approval_id IS NULL
  AND run.status IN ('queued', 'running', 'paused');

UPDATE pipeline_retry_previews
SET status = 'refused',
    preparation_state = 'refused',
    refusal_reason = 'legacy_unverified_retry_approval',
    preparation_owner = NULL,
    preparation_lease_expires_at = NULL
WHERE COALESCE((packet->>'requiresApproval')::boolean, FALSE)
  AND human_approval_id IS NULL
  AND status IN ('approved', 'dispatched');

-- Historical approval_token remains audit-only. New code never reads or writes it.
