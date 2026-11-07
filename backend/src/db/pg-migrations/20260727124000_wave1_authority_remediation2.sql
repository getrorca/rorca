-- Wave 1 rereview remediation: conflict poisoning, member worktrees, and
-- generation-bound closeout transport. This migration deliberately touches no
-- pg-boss-owned table and is safe on databases which already applied 27123000.

CREATE OR REPLACE FUNCTION enforce_host_story_attempt_envelope_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  run_row pipeline_runs%ROWTYPE;
  manifest_row story_execution_manifests%ROWTYPE;
BEGIN
  SELECT * INTO run_row FROM pipeline_runs WHERE id = NEW.run_id FOR SHARE;
  IF run_row.id IS NULL
     OR run_row.workspace_id <> NEW.workspace_id
     OR run_row.dispatch_fence IS DISTINCT FROM NEW.cancellation_fence
     OR run_row.spec_path IS DISTINCT FROM NEW.canonical_spec_path
     OR run_row.execution_workspace_path IS DISTINCT FROM NEW.repository_realpath
     OR EXISTS (SELECT 1 FROM pipeline_run_cancellation_requests cancellation WHERE cancellation.run_id = NEW.run_id)
     OR EXISTS (
       SELECT 1 FROM governed_retry_dispatches retry
        WHERE retry.retry_run_id = NEW.run_id AND retry.cancellation_requested_at IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'host attempt envelope differs from active run generation authority'
      USING ERRCODE = '23514';
  END IF;
  SELECT * INTO manifest_row FROM story_execution_manifests WHERE manifest_hash = NEW.manifest_hash FOR SHARE;
  IF manifest_row.manifest_hash IS NULL
     OR manifest_row.workspace_id <> NEW.workspace_id
     OR manifest_row.run_id <> NEW.run_id
     OR manifest_row.story_id <> NEW.story_id
     OR manifest_row.attempt <> NEW.attempt
     OR manifest_row.spec_id <> NEW.spec_id
     OR manifest_row.spec_revision <> NEW.spec_revision
     OR manifest_row.story_revision <> NEW.story_revision THEN
    RAISE EXCEPTION 'host attempt envelope differs from immutable execution manifest'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_successful_host_attempt_for_story_closeout()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'accepted' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('pipeline-run-authority:' || NEW.run_id::text, 0));
  END IF;
  IF NEW.status = 'accepted' AND NOT EXISTS (
    SELECT 1
      FROM host_story_attempt_envelopes envelope
      JOIN pipeline_runs run ON run.id = envelope.run_id
     WHERE envelope.workspace_id = NEW.workspace_id
       AND envelope.run_id = NEW.run_id
       AND envelope.story_id = NEW.story_id
       AND envelope.attempt = NEW.attempt
       AND envelope.manifest_hash = NEW.manifest_hash
       AND envelope.authority_state = 'valid'
       AND envelope.outcome = 'success'
       AND envelope.exit_code = 0
       AND envelope.exit_signal IS NULL
       AND run.dispatch_fence = envelope.cancellation_fence
       AND NOT EXISTS (
         SELECT 1 FROM host_story_attempt_conflicts conflict
          WHERE conflict.workspace_id = envelope.workspace_id
            AND conflict.run_id = envelope.run_id
            AND conflict.story_id = envelope.story_id
            AND conflict.attempt = envelope.attempt
       )
       AND NOT EXISTS (SELECT 1 FROM pipeline_run_cancellation_requests cancellation WHERE cancellation.run_id = run.id)
       AND NOT EXISTS (
         SELECT 1 FROM governed_retry_dispatches retry
          WHERE retry.retry_run_id = run.id AND retry.cancellation_requested_at IS NOT NULL
       )
  ) THEN
    RAISE EXCEPTION 'accepted story closeout lacks current successful host attempt authority'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_pipeline_run_closeout_reconciliation_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  transition_allowed BOOLEAN;
  transport_rotated BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'closeout reconciliation authority is append-only' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.id, NEW.run_id, NEW.workspace_id, NEW.idempotency_key,
         NEW.request_hash, NEW.preview_hash, NEW.immutable_authority_hash,
         NEW.owner_receipt_id, NEW.requester_actor_id, NEW.rationale,
         NEW.required_fix_sha, NEW.build_sha, NEW.build_receipt_hash,
         NEW.preview_expires_at, NEW.before_projection, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.run_id, OLD.workspace_id, OLD.idempotency_key,
         OLD.request_hash, OLD.preview_hash, OLD.immutable_authority_hash,
         OLD.owner_receipt_id, OLD.requester_actor_id, OLD.rationale,
         OLD.required_fix_sha, OLD.build_sha, OLD.build_receipt_hash,
         OLD.preview_expires_at, OLD.before_projection, OLD.created_at) THEN
    RAISE EXCEPTION 'closeout reconciliation immutable authority changed' USING ERRCODE = '23514';
  END IF;
  transport_rotated := NEW.boss_job_id IS DISTINCT FROM OLD.boss_job_id
    OR NEW.transport_generation IS DISTINCT FROM OLD.transport_generation
    OR NEW.transport_history IS DISTINCT FROM OLD.transport_history;
  IF transport_rotated AND NOT (
    OLD.state IN ('prepared','queued') AND NEW.state IN ('prepared','queued')
    AND NEW.boss_job_id IS DISTINCT FROM OLD.boss_job_id
    AND NEW.transport_generation = OLD.transport_generation + 1
    AND NEW.job_payload_hash IS DISTINCT FROM OLD.job_payload_hash
    AND NEW.job_payload_hash ~ '^sha256:[0-9a-f]{64}$'
    AND jsonb_array_length(NEW.transport_history) = jsonb_array_length(OLD.transport_history) + 1
    AND NEW.transport_history->-1->>'bossJobId' = OLD.boss_job_id::text
  ) THEN
    RAISE EXCEPTION 'invalid closeout reconciliation transport generation rotation' USING ERRCODE = '23514';
  END IF;
  IF NEW.job_payload_hash IS DISTINCT FROM OLD.job_payload_hash AND NOT transport_rotated THEN
    RAISE EXCEPTION 'closeout transport payload hash changed without generation rotation' USING ERRCODE = '23514';
  END IF;
  IF OLD.state IN ('completed','blocked') THEN
    RAISE EXCEPTION 'terminal closeout reconciliation is immutable' USING ERRCODE = '23514';
  END IF;
  transition_allowed := CASE OLD.state
    WHEN 'prepared' THEN NEW.state IN ('prepared','queued','processing','blocked','completed')
    WHEN 'queued' THEN NEW.state IN ('queued','processing','blocked','completed')
    WHEN 'processing' THEN NEW.state IN ('processing','queued','completed','blocked')
    ELSE FALSE
  END;
  IF NOT transition_allowed THEN
    RAISE EXCEPTION 'invalid closeout reconciliation state transition: % -> %', OLD.state, NEW.state USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
