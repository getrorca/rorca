-- Fail-closed remediation for exact closeout reconciliation authority.
-- Fresh installs receive the same invariants in the originating migration;
-- this migration upgrades already-provisioned candidate/test databases.

-- Do not fabricate a receipt for any pre-remediation authority row. Such a row
-- remains NULL and the worker blocks it; the insert trigger requires every new
-- request to carry the exact startup receipt hash.
ALTER TABLE pipeline_run_closeout_reconciliations
  ADD COLUMN IF NOT EXISTS build_receipt_hash TEXT
  CHECK (build_receipt_hash IS NULL OR build_receipt_hash ~ '^sha256:[0-9a-f]{64}$');

ALTER TABLE pipeline_run_closeout_reconciliations
  DROP CONSTRAINT IF EXISTS pipeline_run_closeout_reconciliations_wave1_run_ck,
  ADD CONSTRAINT pipeline_run_closeout_reconciliations_wave1_run_ck CHECK (
    run_id = 20260316000550 AND run_id <> 20260316000549
  ) NOT VALID;

CREATE OR REPLACE FUNCTION enforce_pipeline_run_closeout_reconciliation_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  receipt provider_human_authority_receipts%ROWTYPE;
  run_workspace TEXT;
BEGIN
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
         NEW.required_fix_sha, NEW.build_sha, NEW.build_receipt_hash,
         NEW.preview_expires_at, NEW.boss_job_id, NEW.job_payload_hash,
         NEW.before_projection, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.run_id, OLD.workspace_id, OLD.idempotency_key,
         OLD.request_hash, OLD.preview_hash, OLD.immutable_authority_hash,
         OLD.owner_receipt_id, OLD.requester_actor_id, OLD.rationale,
         OLD.required_fix_sha, OLD.build_sha, OLD.build_receipt_hash,
         OLD.preview_expires_at, OLD.boss_job_id, OLD.job_payload_hash,
         OLD.before_projection, OLD.created_at) THEN
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
