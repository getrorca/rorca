-- Application-owned transport generations allow safe pg-boss archive recovery.
-- pg-boss tables remain owned exclusively by pg-boss.

ALTER TABLE pipeline_run_closeout_reconciliations
  ADD COLUMN IF NOT EXISTS transport_generation INTEGER NOT NULL DEFAULT 1
    CHECK (transport_generation BETWEEN 1 AND 1000),
  ADD COLUMN IF NOT EXISTS transport_history JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(transport_history) = 'array' AND octet_length(transport_history::text) <= 262144);

CREATE OR REPLACE FUNCTION enforce_pipeline_run_closeout_reconciliation_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  transition_allowed BOOLEAN;
  transport_rotated BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'closeout reconciliation authority is append-only'
      USING ERRCODE = '23514';
  END IF;

  IF ROW(NEW.id, NEW.run_id, NEW.workspace_id, NEW.idempotency_key,
         NEW.request_hash, NEW.preview_hash, NEW.immutable_authority_hash,
         NEW.owner_receipt_id, NEW.requester_actor_id, NEW.rationale,
         NEW.required_fix_sha, NEW.build_sha, NEW.build_receipt_hash,
         NEW.preview_expires_at,
         NEW.before_projection, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.run_id, OLD.workspace_id, OLD.idempotency_key,
         OLD.request_hash, OLD.preview_hash, OLD.immutable_authority_hash,
         OLD.owner_receipt_id, OLD.requester_actor_id, OLD.rationale,
         OLD.required_fix_sha, OLD.build_sha, OLD.build_receipt_hash,
         OLD.preview_expires_at,
         OLD.before_projection, OLD.created_at) THEN
    RAISE EXCEPTION 'closeout reconciliation immutable authority changed'
      USING ERRCODE = '23514';
  END IF;

  transport_rotated := NEW.boss_job_id IS DISTINCT FROM OLD.boss_job_id
    OR NEW.transport_generation IS DISTINCT FROM OLD.transport_generation
    OR NEW.transport_history IS DISTINCT FROM OLD.transport_history;
  IF transport_rotated AND NOT (
    OLD.state IN ('prepared','queued')
    AND NEW.state IN ('prepared','queued')
    AND NEW.boss_job_id IS DISTINCT FROM OLD.boss_job_id
    AND NEW.transport_generation = OLD.transport_generation + 1
    AND NEW.job_payload_hash IS DISTINCT FROM OLD.job_payload_hash
    AND NEW.job_payload_hash ~ '^sha256:[0-9a-f]{64}$'
    AND jsonb_array_length(NEW.transport_history) = jsonb_array_length(OLD.transport_history) + 1
    AND NEW.transport_history->-1->>'bossJobId' = OLD.boss_job_id::text
  ) THEN
    RAISE EXCEPTION 'invalid closeout reconciliation transport generation rotation'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.job_payload_hash IS DISTINCT FROM OLD.job_payload_hash AND NOT transport_rotated THEN
    RAISE EXCEPTION 'closeout transport payload hash changed without generation rotation'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.state IN ('completed','blocked') THEN
    RAISE EXCEPTION 'terminal closeout reconciliation is immutable'
      USING ERRCODE = '23514';
  END IF;

  transition_allowed := CASE OLD.state
    WHEN 'prepared' THEN NEW.state IN ('prepared','queued','processing','blocked','completed')
    WHEN 'queued' THEN NEW.state IN ('queued','processing','blocked','completed')
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
