-- Exact-run, owner-authorized, closeout-only reconciliation authority.
-- Application tables only; pg-boss remains transport and is never migrated here.

ALTER TABLE provider_human_authority_receipts
  DROP CONSTRAINT IF EXISTS provider_human_authority_receipts_purpose_check;
ALTER TABLE provider_human_authority_receipts
  ADD CONSTRAINT provider_human_authority_receipts_purpose_check CHECK (purpose IN (
    'authoring_plan_confirmation', 'spec_set_approval', 'retry_approval',
    'lifecycle_decision', 'task_manifest_dispatch', 'run_closeout_reconciliation'
  ));

ALTER TABLE provider_human_authority_receipts
  ADD COLUMN IF NOT EXISTS workspace_owner_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE provider_human_authority_receipts
  DROP CONSTRAINT IF EXISTS provider_human_authority_receipts_closeout_owner_ck;
ALTER TABLE provider_human_authority_receipts
  ADD CONSTRAINT provider_human_authority_receipts_closeout_owner_ck CHECK (
    purpose <> 'run_closeout_reconciliation' OR workspace_owner_verified
  );

CREATE TABLE IF NOT EXISTS pipeline_run_closeout_reconciliations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id BIGINT NOT NULL UNIQUE REFERENCES pipeline_runs(id) ON DELETE RESTRICT
    CHECK (run_id = 20260316000550 AND run_id <> 20260316000549),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK (
    char_length(idempotency_key) BETWEEN 8 AND 200
    AND idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'
  ),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^sha256:[0-9a-f]{64}$'),
  preview_hash TEXT NOT NULL CHECK (preview_hash ~ '^sha256:[0-9a-f]{64}$'),
  immutable_authority_hash TEXT NOT NULL CHECK (immutable_authority_hash ~ '^sha256:[0-9a-f]{64}$'),
  owner_receipt_id UUID NOT NULL UNIQUE
    REFERENCES provider_human_authority_receipts(id) ON DELETE RESTRICT,
  requester_actor_id TEXT NOT NULL CHECK (char_length(requester_actor_id) BETWEEN 1 AND 256),
  rationale TEXT NOT NULL CHECK (
    char_length(rationale) BETWEEN 12 AND 2000
    AND octet_length(rationale) <= 4000
  ),
  required_fix_sha CHAR(40) NOT NULL CHECK (required_fix_sha ~ '^[0-9a-f]{40}$'),
  build_sha CHAR(40) NOT NULL CHECK (build_sha ~ '^[0-9a-f]{40}$'),
  build_receipt_hash TEXT NOT NULL CHECK (build_receipt_hash ~ '^sha256:[0-9a-f]{64}$'),
  preview_expires_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL DEFAULT 'prepared'
    CHECK (state IN ('prepared','queued','processing','completed','blocked')),
  boss_job_id UUID NOT NULL UNIQUE,
  job_payload_hash TEXT NOT NULL CHECK (job_payload_hash ~ '^sha256:[0-9a-f]{64}$'),
  before_projection JSONB NOT NULL CHECK (
    jsonb_typeof(before_projection) = 'object'
    AND octet_length(before_projection::text) <= 2097152
  ),
  after_projection JSONB CHECK (
    after_projection IS NULL OR (
      jsonb_typeof(after_projection) = 'object'
      AND octet_length(after_projection::text) <= 262144
    )
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 1000),
  publish_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (publish_attempt_count BETWEEN 0 AND 1000),
  claim_token UUID,
  claim_expires_at TIMESTAMPTZ,
  claimed_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  last_error_code TEXT CHECK (last_error_code IS NULL OR char_length(last_error_code) <= 96),
  last_error_message TEXT CHECK (last_error_message IS NULL OR octet_length(last_error_message) <= 1024),
  reconciled_at TIMESTAMPTZ,
  result_receipt_hash TEXT UNIQUE CHECK (
    result_receipt_hash IS NULL OR result_receipt_hash ~ '^sha256:[0-9a-f]{64}$'
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, idempotency_key),
  CHECK ((claim_token IS NULL) = (claim_expires_at IS NULL)),
  CHECK (state = 'processing' OR (claim_token IS NULL AND claim_expires_at IS NULL)),
  CHECK (
    (state = 'completed') =
    (after_projection IS NOT NULL AND reconciled_at IS NOT NULL AND result_receipt_hash IS NOT NULL)
  ),
  CHECK (state <> 'blocked' OR last_error_code IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_run_closeout_reconciliation_recovery
  ON pipeline_run_closeout_reconciliations(state, updated_at, run_id)
  WHERE state IN ('prepared','queued','processing');

CREATE OR REPLACE FUNCTION enforce_pipeline_run_closeout_reconciliation_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  receipt provider_human_authority_receipts%ROWTYPE;
  run_workspace TEXT;
BEGIN
  -- Selector fence is deliberately first: protected or non-campaign identities
  -- cause zero reads of run/evidence/receipt authority and acquire no lock.
  IF NEW.run_id = 20260316000549 THEN
    RAISE EXCEPTION 'externally owned Genesis run is deny-listed'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.run_id <> 20260316000550 THEN
    RAISE EXCEPTION 'run is not the exact Wave 1 managed proof identity'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.preview_expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'closeout reconciliation preview is expired at database time'
      USING ERRCODE = '23514';
  END IF;
  SELECT * INTO receipt
    FROM provider_human_authority_receipts
   WHERE id = NEW.owner_receipt_id;
  SELECT workspace_id INTO run_workspace
    FROM pipeline_runs
   WHERE id = NEW.run_id;
  IF receipt.id IS NULL
     OR run_workspace IS NULL
     OR run_workspace <> NEW.workspace_id
     OR receipt.workspace_id <> NEW.workspace_id
     OR receipt.purpose <> 'run_closeout_reconciliation'
     OR receipt.target_hash <> NEW.preview_hash
     OR receipt.normalized_command_hash <> NEW.preview_hash
     OR receipt.workspace_owner_verified IS NOT TRUE
     OR NEW.build_receipt_hash IS NULL
     OR NEW.build_receipt_hash !~ '^sha256:[0-9a-f]{64}$'
     OR NOT (receipt.requester_actor_id IS NOT DISTINCT FROM NEW.requester_actor_id)
     OR receipt.actor_id = NEW.requester_actor_id THEN
    RAISE EXCEPTION 'closeout reconciliation owner receipt binding is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pipeline_run_closeout_reconciliation_binding
  ON pipeline_run_closeout_reconciliations;
CREATE TRIGGER trg_pipeline_run_closeout_reconciliation_binding
BEFORE INSERT ON pipeline_run_closeout_reconciliations
FOR EACH ROW EXECUTE FUNCTION enforce_pipeline_run_closeout_reconciliation_binding();

CREATE OR REPLACE FUNCTION enforce_pipeline_run_closeout_reconciliation_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  transition_allowed BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'closeout reconciliation authority is append-only'
      USING ERRCODE = '23514';
  END IF;

  IF ROW(NEW.id, NEW.run_id, NEW.workspace_id, NEW.idempotency_key,
         NEW.request_hash, NEW.preview_hash, NEW.immutable_authority_hash,
         NEW.owner_receipt_id, NEW.requester_actor_id, NEW.rationale,
         NEW.required_fix_sha, NEW.build_sha, NEW.build_receipt_hash, NEW.preview_expires_at,
         NEW.boss_job_id, NEW.job_payload_hash, NEW.before_projection,
         NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.run_id, OLD.workspace_id, OLD.idempotency_key,
         OLD.request_hash, OLD.preview_hash, OLD.immutable_authority_hash,
         OLD.owner_receipt_id, OLD.requester_actor_id, OLD.rationale,
         OLD.required_fix_sha, OLD.build_sha, OLD.build_receipt_hash, OLD.preview_expires_at,
         OLD.boss_job_id, OLD.job_payload_hash, OLD.before_projection,
         OLD.created_at) THEN
    RAISE EXCEPTION 'closeout reconciliation immutable authority changed'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.state IN ('completed','blocked') THEN
    RAISE EXCEPTION 'terminal closeout reconciliation is immutable'
      USING ERRCODE = '23514';
  END IF;

  transition_allowed := CASE OLD.state
    WHEN 'prepared' THEN NEW.state IN ('prepared','queued','processing','blocked')
    WHEN 'queued' THEN NEW.state IN ('queued','processing','blocked')
    WHEN 'processing' THEN NEW.state IN ('processing','queued','completed','blocked')
    ELSE FALSE
  END;
  IF NOT transition_allowed THEN
    RAISE EXCEPTION 'invalid closeout reconciliation state transition: % -> %', OLD.state, NEW.state
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pipeline_run_closeout_reconciliation_lifecycle
  ON pipeline_run_closeout_reconciliations;
CREATE TRIGGER trg_pipeline_run_closeout_reconciliation_lifecycle
BEFORE UPDATE OR DELETE ON pipeline_run_closeout_reconciliations
FOR EACH ROW EXECUTE FUNCTION enforce_pipeline_run_closeout_reconciliation_lifecycle();
