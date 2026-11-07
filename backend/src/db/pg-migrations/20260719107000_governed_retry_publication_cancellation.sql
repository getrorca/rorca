-- Governed retry publication/cancellation linearization.
-- This migration owns only Rorca orchestration state. pg-boss continues to own
-- its schema and generate all job UUIDs.

ALTER TABLE pipeline_retry_previews
  ADD COLUMN IF NOT EXISTS preparation_state TEXT,
  ADD COLUMN IF NOT EXISTS preparation_owner TEXT,
  ADD COLUMN IF NOT EXISTS preparation_lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS preparation_generation BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS preparation_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS cancellation_evidence JSONB;

UPDATE pipeline_retry_previews preview
SET preparation_state = CASE
  WHEN preview.status = 'dispatched' THEN 'published'
  WHEN preview.status = 'cancelled' THEN 'cancelled'
  WHEN preview.status = 'refused' THEN 'refused'
  WHEN preview.status = 'approved' AND EXISTS (
    SELECT 1 FROM governed_retry_dispatches dispatch
    WHERE dispatch.preview_hash = preview.preview_hash
  ) THEN 'outbox_ready'
  WHEN preview.status = 'approved' THEN 'preparing'
  ELSE 'unowned'
END
WHERE preparation_state IS NULL;

ALTER TABLE pipeline_retry_previews
  ALTER COLUMN preparation_state SET DEFAULT 'unowned',
  ALTER COLUMN preparation_state SET NOT NULL;

ALTER TABLE pipeline_retry_previews
  DROP CONSTRAINT IF EXISTS pipeline_retry_previews_preparation_state_check;
ALTER TABLE pipeline_retry_previews
  ADD CONSTRAINT pipeline_retry_previews_preparation_state_check CHECK (preparation_state IN (
    'unowned', 'preparing', 'artifacts_ready', 'hooks_running', 'hooks_passed',
    'manifests_ready', 'outbox_ready', 'published', 'cancelled', 'refused'
  ));
ALTER TABLE pipeline_retry_previews
  DROP CONSTRAINT IF EXISTS pipeline_retry_previews_preparation_owner_check;
ALTER TABLE pipeline_retry_previews
  ADD CONSTRAINT pipeline_retry_previews_preparation_owner_check CHECK (
    (preparation_owner IS NULL) = (preparation_lease_expires_at IS NULL)
  );
ALTER TABLE pipeline_retry_previews
  DROP CONSTRAINT IF EXISTS pipeline_retry_previews_preparation_status_check;
ALTER TABLE pipeline_retry_previews
  ADD CONSTRAINT pipeline_retry_previews_preparation_status_check CHECK (
    (status = 'previewed' AND preparation_state = 'unowned') OR
    (status = 'approved' AND preparation_state IN (
      'preparing', 'artifacts_ready', 'hooks_running', 'hooks_passed',
      'manifests_ready', 'outbox_ready'
    )) OR
    (status = 'dispatched' AND preparation_state = 'published') OR
    (status = 'cancelled' AND preparation_state = 'cancelled') OR
    (status = 'refused' AND preparation_state = 'refused')
  );
UPDATE pipeline_retry_previews
SET cancellation_evidence = COALESCE(
  cancellation_evidence,
  jsonb_build_object(
    'schemaVersion', 'rorca.governed-retry-cancellation.v1',
    'reason', 'legacy_cancelled_preview',
    'previewHash', preview_hash
  )
), cancelled_at = COALESCE(cancelled_at, preparation_updated_at, NOW())
WHERE status = 'cancelled';

ALTER TABLE pipeline_retry_previews
  DROP CONSTRAINT IF EXISTS pipeline_retry_previews_cancellation_evidence_check;
ALTER TABLE pipeline_retry_previews
  ADD CONSTRAINT pipeline_retry_previews_cancellation_evidence_check CHECK (
    status <> 'cancelled' OR (
      cancelled_at IS NOT NULL
      AND cancellation_evidence IS NOT NULL
      AND cancellation_evidence->>'schemaVersion' = 'rorca.governed-retry-cancellation.v1'
      AND cancellation_evidence->>'previewHash' = preview_hash
    )
  );

ALTER TABLE governed_retry_dispatches
  ADD COLUMN IF NOT EXISTS cancellation_evidence JSONB,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS launch_token_hash TEXT,
  ADD COLUMN IF NOT EXISTS launch_pid INTEGER;
ALTER TABLE governed_retry_dispatches
  DROP CONSTRAINT IF EXISTS governed_retry_dispatches_launch_token_hash_check;
ALTER TABLE governed_retry_dispatches
  ADD CONSTRAINT governed_retry_dispatches_launch_token_hash_check CHECK (
    launch_token_hash IS NULL OR launch_token_hash ~ '^sha256:[0-9a-f]{64}$'
  );
ALTER TABLE governed_retry_dispatches
  DROP CONSTRAINT IF EXISTS governed_retry_dispatches_launch_pid_check;
ALTER TABLE governed_retry_dispatches
  ADD CONSTRAINT governed_retry_dispatches_launch_pid_check CHECK (
    launch_pid IS NULL OR launch_pid > 0
  );
ALTER TABLE governed_retry_dispatches
  DROP CONSTRAINT IF EXISTS governed_retry_dispatches_state_check;
ALTER TABLE governed_retry_dispatches
  ADD CONSTRAINT governed_retry_dispatches_state_check CHECK (state IN (
    'prepared', 'dispatched', 'claimed', 'executing', 'committed', 'integrating',
    'integrated_validated', 'finalized', 'failed', 'manual_review_required', 'cancelled'
  ));
ALTER TABLE governed_retry_dispatches
  DROP CONSTRAINT IF EXISTS governed_retry_dispatches_cancellation_evidence_check;
ALTER TABLE governed_retry_dispatches
  ADD CONSTRAINT governed_retry_dispatches_cancellation_evidence_check CHECK (
    state <> 'cancelled' OR (cancelled_at IS NOT NULL AND cancellation_evidence IS NOT NULL)
  );

ALTER TABLE governed_retry_story_attempts
  ADD COLUMN IF NOT EXISTS cancellation_evidence JSONB,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE governed_retry_story_attempts
  DROP CONSTRAINT IF EXISTS governed_retry_story_attempts_state_check;
ALTER TABLE governed_retry_story_attempts
  ADD CONSTRAINT governed_retry_story_attempts_state_check CHECK (state IN (
    'pending', 'executing', 'committed', 'integrating', 'finalized', 'failed',
    'manual_review_required', 'cancelled'
  ));
ALTER TABLE governed_retry_story_attempts
  DROP CONSTRAINT IF EXISTS governed_retry_story_attempts_cancellation_evidence_check;
ALTER TABLE governed_retry_story_attempts
  ADD CONSTRAINT governed_retry_story_attempts_cancellation_evidence_check CHECK (
    state <> 'cancelled' OR (cancelled_at IS NOT NULL AND cancellation_evidence IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION enforce_pipeline_retry_preview_transition()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  status_allowed BOOLEAN;
  preparation_allowed BOOLEAN;
BEGIN
  status_allowed := NEW.status = OLD.status OR CASE OLD.status
    WHEN 'previewed' THEN NEW.status IN ('approved', 'cancelled', 'refused')
    WHEN 'approved' THEN NEW.status IN ('dispatched', 'cancelled', 'refused')
    WHEN 'dispatched' THEN NEW.status IN ('cancelled', 'refused')
    ELSE FALSE
  END;
  IF NOT status_allowed THEN
    RAISE EXCEPTION 'illegal retry preview transition: % -> %', OLD.status, NEW.status;
  END IF;

  preparation_allowed := NEW.preparation_state = OLD.preparation_state OR CASE OLD.preparation_state
    WHEN 'unowned' THEN NEW.preparation_state IN ('preparing', 'cancelled', 'refused')
    WHEN 'preparing' THEN NEW.preparation_state IN ('artifacts_ready', 'cancelled', 'refused')
    WHEN 'artifacts_ready' THEN NEW.preparation_state IN ('hooks_running', 'cancelled', 'refused')
    WHEN 'hooks_running' THEN NEW.preparation_state IN ('hooks_passed', 'cancelled', 'refused')
    WHEN 'hooks_passed' THEN NEW.preparation_state IN ('manifests_ready', 'cancelled', 'refused')
    WHEN 'manifests_ready' THEN NEW.preparation_state IN ('outbox_ready', 'cancelled', 'refused')
    WHEN 'outbox_ready' THEN NEW.preparation_state IN ('published', 'cancelled', 'refused')
    WHEN 'published' THEN NEW.preparation_state IN ('cancelled', 'refused')
    ELSE FALSE
  END;
  IF NOT preparation_allowed THEN
    RAISE EXCEPTION 'illegal retry preparation transition: % -> %', OLD.preparation_state, NEW.preparation_state;
  END IF;

  IF OLD.status IN ('cancelled', 'refused') THEN
    IF ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
      RAISE EXCEPTION 'terminal retry preview evidence is immutable';
    END IF;
    RETURN OLD;
  END IF;
  NEW.preparation_updated_at := NOW();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pipeline_retry_preview_transition ON pipeline_retry_previews;
CREATE TRIGGER trg_pipeline_retry_preview_transition
BEFORE UPDATE ON pipeline_retry_previews
FOR EACH ROW EXECUTE FUNCTION enforce_pipeline_retry_preview_transition();

CREATE OR REPLACE FUNCTION enforce_governed_retry_dispatch_transition()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  transition_allowed BOOLEAN;
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
  IF NEW.fencing_token < OLD.fencing_token THEN
    RAISE EXCEPTION 'governed retry fencing token cannot decrease';
  END IF;
  transition_allowed := NEW.state = OLD.state OR CASE OLD.state
    WHEN 'prepared' THEN NEW.state IN ('dispatched', 'failed', 'cancelled')
    WHEN 'dispatched' THEN NEW.state IN ('claimed', 'failed', 'cancelled')
    WHEN 'claimed' THEN NEW.state IN ('executing', 'failed')
    WHEN 'executing' THEN NEW.state IN ('committed', 'failed')
    WHEN 'committed' THEN NEW.state IN ('integrating', 'failed')
    WHEN 'integrating' THEN NEW.state IN ('integrated_validated', 'manual_review_required', 'failed')
    WHEN 'integrated_validated' THEN NEW.state IN ('finalized', 'failed')
    ELSE FALSE
  END;
  IF NOT transition_allowed THEN RAISE EXCEPTION 'illegal governed retry dispatch transition: % -> %', OLD.state, NEW.state; END IF;
  IF NEW.state <> OLD.state THEN NEW.state_version := OLD.state_version + 1;
  ELSIF NEW.state_version <> OLD.state_version THEN RAISE EXCEPTION 'retry state version advances only with transition'; END IF;
  IF OLD.state IN ('finalized', 'failed', 'manual_review_required', 'cancelled') THEN
    IF ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
      RAISE EXCEPTION 'terminal governed retry evidence is immutable';
    END IF;
    RETURN OLD;
  END IF;
  NEW.updated_at := NOW();
  IF NEW.state = 'finalized' AND OLD.state <> 'finalized' THEN NEW.finalized_at := COALESCE(NEW.finalized_at, NOW()); END IF;
  IF NEW.state = 'cancelled' AND OLD.state <> 'cancelled' THEN NEW.cancelled_at := COALESCE(NEW.cancelled_at, NOW()); END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION enforce_governed_retry_attempt_transition()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  transition_allowed BOOLEAN;
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
    WHEN 'executing' THEN NEW.state IN ('committed', 'failed')
    WHEN 'committed' THEN NEW.state IN ('integrating', 'failed')
    WHEN 'integrating' THEN NEW.state IN ('finalized', 'manual_review_required', 'failed')
    ELSE FALSE
  END;
  IF NOT transition_allowed THEN RAISE EXCEPTION 'illegal governed retry attempt transition: % -> %', OLD.state, NEW.state; END IF;
  IF NEW.state <> OLD.state THEN NEW.state_version := OLD.state_version + 1;
  ELSIF NEW.state_version <> OLD.state_version THEN RAISE EXCEPTION 'attempt state version advances only with transition'; END IF;
  IF OLD.state IN ('finalized', 'failed', 'manual_review_required', 'cancelled') THEN
    IF ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
      RAISE EXCEPTION 'terminal governed retry attempt evidence is immutable';
    END IF;
    RETURN OLD;
  END IF;
  NEW.updated_at := NOW();
  IF NEW.state = 'finalized' AND OLD.state <> 'finalized' THEN NEW.finalized_at := COALESCE(NEW.finalized_at, NOW()); END IF;
  IF NEW.state = 'cancelled' AND OLD.state <> 'cancelled' THEN NEW.cancelled_at := COALESCE(NEW.cancelled_at, NOW()); END IF;
  RETURN NEW;
END $$;

-- Complete any legacy cancellation row using the same forward-only terminal
-- states. This is idempotent and records one append-only evidence event.
UPDATE governed_retry_story_attempts attempt
SET state = 'cancelled',
    cancellation_evidence = jsonb_build_object(
      'schemaVersion', 'rorca.governed-retry-cancellation.v1',
      'reason', 'legacy_cancelled_preview',
      'previewHash', preview.preview_hash
    ),
    cancelled_at = NOW()
FROM governed_retry_dispatches dispatch
JOIN pipeline_retry_previews preview ON preview.preview_hash = dispatch.preview_hash
WHERE attempt.dispatch_identity_hash = dispatch.identity_hash
  AND preview.status = 'cancelled'
  AND attempt.state = 'pending';

UPDATE governed_retry_dispatches dispatch
SET state = 'cancelled',
    cancellation_evidence = jsonb_build_object(
      'schemaVersion', 'rorca.governed-retry-cancellation.v1',
      'reason', 'legacy_cancelled_preview',
      'previewHash', preview.preview_hash
    ),
    cancelled_at = NOW(),
    lease_owner = NULL,
    lease_expires_at = NULL
FROM pipeline_retry_previews preview
WHERE dispatch.preview_hash = preview.preview_hash
  AND preview.status = 'cancelled'
  AND dispatch.state IN ('prepared', 'dispatched');

UPDATE pipeline_runs run
SET status = 'cancelled',
    finished_at = COALESCE(run.finished_at, NOW()),
    summary = COALESCE(run.summary, 'retry_preview_cancelled'),
    lifecycle_status = 'cancelled',
    lifecycle_updated_at = NOW(),
    lifecycle_diagnostics = run.lifecycle_diagnostics || jsonb_build_object(
      'owner', 'retry_publication_migration',
      'reason', 'legacy_cancelled_preview'
    )
FROM pipeline_retry_previews preview
WHERE preview.retry_run_id = run.id
  AND preview.status = 'cancelled'
  AND run.status = 'queued';

INSERT INTO wal_events (event_type, workspace_id, payload, ingest_key)
SELECT 'retry_preview_cancelled', preview.workspace_id,
       jsonb_build_object(
         'schemaVersion', 'rorca.governed-retry-cancellation.v1',
         'reason', 'legacy_cancelled_preview',
         'previewHash', preview.preview_hash,
         'originalRunId', preview.original_run_id,
         'retryRunId', preview.retry_run_id
       ),
       'governed-retry-cancel:' || preview.preview_hash
FROM pipeline_retry_previews preview
WHERE preview.status = 'cancelled'
ON CONFLICT (ingest_key) WHERE ingest_key IS NOT NULL DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_pipeline_retry_preparation_recovery
  ON pipeline_retry_previews (status, preparation_state, preparation_lease_expires_at);

-- Intentionally no CREATE/ALTER/UPDATE/DELETE against pgboss.*.
