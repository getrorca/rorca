-- Durable running cancellation request for governed retries.
-- pg-boss remains dispatch-only and is not modified here.

ALTER TABLE governed_retry_dispatches
  ADD COLUMN IF NOT EXISTS cancellation_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancellation_request JSONB;

ALTER TABLE governed_retry_dispatches
  DROP CONSTRAINT IF EXISTS governed_retry_cancellation_request_pair_ck,
  ADD CONSTRAINT governed_retry_cancellation_request_pair_ck CHECK (
    (cancellation_requested_at IS NULL) = (cancellation_request IS NULL)
  );

CREATE OR REPLACE FUNCTION enforce_governed_retry_dispatch_transition()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE transition_allowed BOOLEAN;
BEGIN
  IF ROW(NEW.identity_hash, NEW.workspace_id, NEW.spec_id, NEW.spec_revision,
         NEW.original_run_id, NEW.retry_run_id, NEW.original_run_lineage,
         NEW.base_revision, NEW.integrated_revision, NEW.prior_integration_ancestry,
         NEW.recovery_ref, NEW.recovery_ref_revision, NEW.preview_hash,
         NEW.scope_hash, NEW.evidence_hash, NEW.execution_manifest_hash,
         NEW.queue_payload_hash, NEW.job_payload, NEW.queue_name, NEW.idempotency_key, NEW.lease_identity)
     IS DISTINCT FROM
     ROW(OLD.identity_hash, OLD.workspace_id, OLD.spec_id, OLD.spec_revision,
         OLD.original_run_id, OLD.retry_run_id, OLD.original_run_lineage,
         OLD.base_revision, OLD.integrated_revision, OLD.prior_integration_ancestry,
         OLD.recovery_ref, OLD.recovery_ref_revision, OLD.preview_hash,
         OLD.scope_hash, OLD.evidence_hash, OLD.execution_manifest_hash,
         OLD.queue_payload_hash, OLD.job_payload, OLD.queue_name, OLD.idempotency_key, OLD.lease_identity) THEN
    RAISE EXCEPTION 'governed retry dispatch identity is immutable';
  END IF;
  IF NEW.fencing_token < OLD.fencing_token THEN RAISE EXCEPTION 'governed retry fencing token cannot decrease'; END IF;
  IF OLD.cancellation_requested_at IS NOT NULL AND (
    NEW.cancellation_requested_at IS DISTINCT FROM OLD.cancellation_requested_at
    OR NEW.cancellation_request IS DISTINCT FROM OLD.cancellation_request
  ) THEN RAISE EXCEPTION 'governed retry cancellation request is immutable'; END IF;
  transition_allowed := NEW.state = OLD.state OR CASE OLD.state
    WHEN 'prepared' THEN NEW.state IN ('dispatched', 'failed', 'cancelled')
    WHEN 'dispatched' THEN NEW.state IN ('claimed', 'failed', 'cancelled')
    WHEN 'claimed' THEN NEW.state IN ('executing', 'failed', 'cancelled')
    WHEN 'executing' THEN NEW.state IN ('committed', 'failed', 'cancelled')
    WHEN 'committed' THEN NEW.state IN ('integrating', 'failed')
    WHEN 'integrating' THEN NEW.state IN ('integrated_validated', 'manual_review_required', 'failed')
    WHEN 'integrated_validated' THEN NEW.state IN ('finalized', 'failed')
    ELSE FALSE
  END;
  IF NOT transition_allowed THEN RAISE EXCEPTION 'illegal governed retry dispatch transition: % -> %', OLD.state, NEW.state; END IF;
  IF NEW.state <> OLD.state THEN NEW.state_version := OLD.state_version + 1;
  ELSIF NEW.state_version <> OLD.state_version THEN RAISE EXCEPTION 'retry state version advances only with transition'; END IF;
  IF OLD.state IN ('finalized', 'failed', 'manual_review_required', 'cancelled') THEN
    IF ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN RAISE EXCEPTION 'terminal governed retry evidence is immutable'; END IF;
    RETURN OLD;
  END IF;
  NEW.updated_at := NOW();
  IF NEW.state = 'finalized' AND OLD.state <> 'finalized' THEN NEW.finalized_at := COALESCE(NEW.finalized_at, NOW()); END IF;
  IF NEW.state = 'cancelled' AND OLD.state <> 'cancelled' THEN NEW.cancelled_at := COALESCE(NEW.cancelled_at, NOW()); END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION enforce_governed_retry_attempt_transition()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE transition_allowed BOOLEAN;
BEGIN
  IF ROW(NEW.attempt_identity, NEW.dispatch_identity_hash, NEW.workspace_id, NEW.spec_id,
         NEW.original_root_run_id, NEW.source_run_id, NEW.retry_run_id, NEW.story_id,
         NEW.attempt, NEW.previous_attempt, NEW.idempotency_key, NEW.manifest_hash, NEW.recovery_ref)
     IS DISTINCT FROM
     ROW(OLD.attempt_identity, OLD.dispatch_identity_hash, OLD.workspace_id, OLD.spec_id,
         OLD.original_root_run_id, OLD.source_run_id, OLD.retry_run_id, OLD.story_id,
         OLD.attempt, OLD.previous_attempt, OLD.idempotency_key, OLD.manifest_hash, OLD.recovery_ref) THEN
    RAISE EXCEPTION 'governed retry story-attempt identity is immutable';
  END IF;
  transition_allowed := NEW.state = OLD.state OR CASE OLD.state
    WHEN 'pending' THEN NEW.state IN ('executing', 'failed', 'cancelled')
    WHEN 'executing' THEN NEW.state IN ('committed', 'failed', 'cancelled')
    WHEN 'committed' THEN NEW.state IN ('integrating', 'failed')
    WHEN 'integrating' THEN NEW.state IN ('finalized', 'manual_review_required', 'failed')
    ELSE FALSE
  END;
  IF NOT transition_allowed THEN RAISE EXCEPTION 'illegal governed retry attempt transition: % -> %', OLD.state, NEW.state; END IF;
  IF NEW.state <> OLD.state THEN NEW.state_version := OLD.state_version + 1;
  ELSIF NEW.state_version <> OLD.state_version THEN RAISE EXCEPTION 'attempt state version advances only with transition'; END IF;
  IF OLD.state IN ('finalized', 'failed', 'manual_review_required', 'cancelled') THEN
    IF ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN RAISE EXCEPTION 'terminal governed retry attempt evidence is immutable'; END IF;
    RETURN OLD;
  END IF;
  NEW.updated_at := NOW();
  IF NEW.state = 'finalized' AND OLD.state <> 'finalized' THEN NEW.finalized_at := COALESCE(NEW.finalized_at, NOW()); END IF;
  IF NEW.state = 'cancelled' AND OLD.state <> 'cancelled' THEN NEW.cancelled_at := COALESCE(NEW.cancelled_at, NOW()); END IF;
  RETURN NEW;
END $$;
