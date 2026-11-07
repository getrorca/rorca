-- WPE-008: production retry dispatch, immutable attempts, leases/fences, and
-- explicit accepted-sibling carry-forward. pg-boss owns its schema; job UUIDs
-- remain auto-generated and are recorded only after send succeeds.

CREATE TABLE IF NOT EXISTS governed_retry_dispatches (
  identity_hash TEXT PRIMARY KEY CHECK (identity_hash ~ '^sha256:[0-9a-f]{64}$'),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  spec_id TEXT NOT NULL,
  spec_revision TEXT NOT NULL,
  original_run_id BIGINT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  retry_run_id BIGINT NOT NULL UNIQUE REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  original_run_lineage JSONB NOT NULL CHECK (jsonb_typeof(original_run_lineage) = 'array'),
  base_revision CHAR(40) NOT NULL CHECK (base_revision ~ '^[0-9a-f]{40}$'),
  integrated_revision CHAR(40) NOT NULL CHECK (integrated_revision ~ '^[0-9a-f]{40}$'),
  prior_integration_ancestry JSONB NOT NULL CHECK (jsonb_typeof(prior_integration_ancestry) = 'array'),
  recovery_ref TEXT NOT NULL,
  recovery_ref_revision CHAR(40) NOT NULL CHECK (recovery_ref_revision ~ '^[0-9a-f]{40}$'),
  preview_hash TEXT NOT NULL REFERENCES pipeline_retry_previews(preview_hash) ON DELETE RESTRICT,
  scope_hash TEXT NOT NULL CHECK (scope_hash ~ '^sha256:[0-9a-f]{64}$'),
  evidence_hash TEXT NOT NULL CHECK (evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  execution_manifest_hash TEXT NOT NULL CHECK (execution_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  queue_payload_hash TEXT NOT NULL CHECK (queue_payload_hash ~ '^sha256:[0-9a-f]{64}$'),
  job_payload JSONB NOT NULL CHECK (jsonb_typeof(job_payload) = 'object'),
  queue_name TEXT NOT NULL CHECK (queue_name = 'pipeline:retry'),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (char_length(idempotency_key) BETWEEN 8 AND 512),
  lease_identity TEXT NOT NULL UNIQUE CHECK (lease_identity ~ '^sha256:[0-9a-f]{64}$'),
  fencing_token BIGINT NOT NULL DEFAULT 1 CHECK (fencing_token > 0),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  state TEXT NOT NULL CHECK (state IN (
    'prepared', 'dispatched', 'claimed', 'executing', 'committed', 'integrating',
    'integrated_validated', 'finalized', 'failed', 'manual_review_required'
  )),
  boss_job_id UUID,
  failure_evidence JSONB,
  finalization_identity TEXT UNIQUE,
  state_version BIGINT NOT NULL DEFAULT 1 CHECK (state_version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finalized_at TIMESTAMPTZ,
  CHECK (base_revision = integrated_revision),
  CHECK (recovery_ref_revision = integrated_revision),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CHECK (state <> 'dispatched' OR boss_job_id IS NOT NULL),
  CHECK (state <> 'finalized' OR (finalization_identity IS NOT NULL AND finalized_at IS NOT NULL)),
  CHECK (state NOT IN ('failed', 'manual_review_required') OR failure_evidence IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS governed_retry_story_attempts (
  attempt_identity TEXT PRIMARY KEY CHECK (attempt_identity ~ '^sha256:[0-9a-f]{64}$'),
  dispatch_identity_hash TEXT NOT NULL REFERENCES governed_retry_dispatches(identity_hash) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  spec_id TEXT NOT NULL,
  original_root_run_id BIGINT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  source_run_id BIGINT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  retry_run_id BIGINT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  story_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  previous_attempt INTEGER NOT NULL CHECK (previous_attempt >= 0 AND attempt = previous_attempt + 1),
  idempotency_key TEXT NOT NULL UNIQUE,
  manifest_hash TEXT NOT NULL REFERENCES story_execution_manifests(manifest_hash) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'executing', 'committed', 'integrating', 'finalized', 'failed', 'manual_review_required')),
  source_commit CHAR(40),
  recovery_ref TEXT NOT NULL,
  failure_evidence JSONB,
  finalization_identity TEXT UNIQUE,
  state_version BIGINT NOT NULL DEFAULT 1 CHECK (state_version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finalized_at TIMESTAMPTZ,
  UNIQUE (original_root_run_id, story_id, attempt),
  UNIQUE (retry_run_id, story_id),
  CHECK (source_commit IS NULL OR source_commit ~ '^[0-9a-f]{40}$'),
  CHECK (state <> 'finalized' OR (source_commit IS NOT NULL AND finalization_identity IS NOT NULL AND finalized_at IS NOT NULL)),
  CHECK (state NOT IN ('failed', 'manual_review_required') OR failure_evidence IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS governed_retry_carry_forward (
  dispatch_identity_hash TEXT NOT NULL REFERENCES governed_retry_dispatches(identity_hash) ON DELETE RESTRICT,
  story_id TEXT NOT NULL,
  source_run_id BIGINT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  source_attempt INTEGER NOT NULL CHECK (source_attempt > 0),
  result_identity TEXT NOT NULL,
  source_commit CHAR(40) NOT NULL CHECK (source_commit ~ '^[0-9a-f]{40}$'),
  resulting_head CHAR(40) NOT NULL CHECK (resulting_head ~ '^[0-9a-f]{40}$'),
  integration_order INTEGER NOT NULL CHECK (integration_order >= 0),
  reason_code TEXT NOT NULL CHECK (reason_code = 'ACCEPTED_INTEGRATED_SIBLING'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (dispatch_identity_hash, story_id),
  UNIQUE (dispatch_identity_hash, integration_order)
);

CREATE TABLE IF NOT EXISTS governed_retry_attempt_events (
  event_identity TEXT PRIMARY KEY CHECK (event_identity ~ '^sha256:[0-9a-f]{64}$'),
  attempt_identity TEXT NOT NULL REFERENCES governed_retry_story_attempts(attempt_identity) ON DELETE RESTRICT,
  fencing_token BIGINT NOT NULL CHECK (fencing_token > 0),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'claimed', 'agent_started', 'source_committed', 'integration_prepared',
    'integration_reconciled', 'integrated_validated', 'finalized', 'failed'
  )),
  evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (attempt_identity, event_type, fencing_token)
);

CREATE INDEX IF NOT EXISTS idx_governed_retry_restart
  ON governed_retry_dispatches (state, lease_expires_at, fencing_token);
CREATE INDEX IF NOT EXISTS idx_governed_retry_attempt_finalization
  ON governed_retry_story_attempts (retry_run_id, state, state_version);

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
    WHEN 'prepared' THEN NEW.state IN ('dispatched', 'failed')
    WHEN 'dispatched' THEN NEW.state IN ('claimed', 'failed')
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
  IF OLD.state IN ('finalized', 'failed', 'manual_review_required') AND ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
    RAISE EXCEPTION 'terminal governed retry evidence is immutable';
  END IF;
  NEW.updated_at := NOW();
  IF NEW.state = 'finalized' AND OLD.state <> 'finalized' THEN NEW.finalized_at := COALESCE(NEW.finalized_at, NOW()); END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_governed_retry_dispatch_transition ON governed_retry_dispatches;
CREATE TRIGGER trg_governed_retry_dispatch_transition BEFORE UPDATE ON governed_retry_dispatches
FOR EACH ROW EXECUTE FUNCTION enforce_governed_retry_dispatch_transition();

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
    WHEN 'pending' THEN NEW.state IN ('executing', 'failed')
    WHEN 'executing' THEN NEW.state IN ('committed', 'failed')
    WHEN 'committed' THEN NEW.state IN ('integrating', 'failed')
    WHEN 'integrating' THEN NEW.state IN ('finalized', 'manual_review_required', 'failed')
    ELSE FALSE
  END;
  IF NOT transition_allowed THEN RAISE EXCEPTION 'illegal governed retry attempt transition: % -> %', OLD.state, NEW.state; END IF;
  IF NEW.state <> OLD.state THEN NEW.state_version := OLD.state_version + 1;
  ELSIF NEW.state_version <> OLD.state_version THEN RAISE EXCEPTION 'attempt state version advances only with transition'; END IF;
  IF OLD.state IN ('finalized', 'failed', 'manual_review_required') AND ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
    RAISE EXCEPTION 'terminal governed retry attempt evidence is immutable';
  END IF;
  NEW.updated_at := NOW();
  IF NEW.state = 'finalized' AND OLD.state <> 'finalized' THEN NEW.finalized_at := COALESCE(NEW.finalized_at, NOW()); END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_governed_retry_attempt_transition ON governed_retry_story_attempts;
CREATE TRIGGER trg_governed_retry_attempt_transition BEFORE UPDATE ON governed_retry_story_attempts
FOR EACH ROW EXECUTE FUNCTION enforce_governed_retry_attempt_transition();

-- Carries, events, prior results, WAL, commits, and recovery refs are append-only.
CREATE OR REPLACE FUNCTION refuse_governed_retry_evidence_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'governed retry evidence is append-only';
END $$;

DROP TRIGGER IF EXISTS trg_governed_retry_carry_immutable ON governed_retry_carry_forward;
CREATE TRIGGER trg_governed_retry_carry_immutable BEFORE UPDATE OR DELETE ON governed_retry_carry_forward
FOR EACH ROW EXECUTE FUNCTION refuse_governed_retry_evidence_mutation();
DROP TRIGGER IF EXISTS trg_governed_retry_events_immutable ON governed_retry_attempt_events;
CREATE TRIGGER trg_governed_retry_events_immutable BEFORE UPDATE OR DELETE ON governed_retry_attempt_events
FOR EACH ROW EXECUTE FUNCTION refuse_governed_retry_evidence_mutation();
