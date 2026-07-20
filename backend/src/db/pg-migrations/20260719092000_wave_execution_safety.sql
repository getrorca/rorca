-- Qualification-scoped leases, durable crash boundaries, and idempotent cleanup.
-- pg-boss owns its own schema; this migration intentionally touches only Rorca tables.

CREATE TABLE IF NOT EXISTS qualification_story_attempts (
  qualification_namespace TEXT NOT NULL CHECK (qualification_namespace ~ '^qrun_[a-f0-9]{24}$'),
  isolation_marker TEXT NOT NULL,
  story_id TEXT NOT NULL CHECK (story_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  worker_id TEXT NOT NULL CHECK (worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  fencing_token BIGINT NOT NULL CHECK (fencing_token > 0),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  terminal_status TEXT NOT NULL DEFAULT 'active'
    CHECK (terminal_status IN ('active', 'cancelled', 'timed_out', 'failed', 'succeeded')),
  terminal_reason TEXT,
  terminal_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (qualification_namespace, story_id, attempt),
  CHECK (isolation_marker = 'rorca-qualification-owned:' || qualification_namespace),
  CHECK ((terminal_status = 'active') = (terminal_at IS NULL)),
  CHECK ((terminal_status = 'active') = (terminal_reason IS NULL)),
  CHECK (terminal_reason IS NULL OR length(terminal_reason) BETWEEN 1 AND 512)
);

CREATE INDEX IF NOT EXISTS idx_qualification_attempts_startup_reconcile
  ON qualification_story_attempts (qualification_namespace, terminal_status, lease_expires_at, fencing_token);

CREATE TABLE IF NOT EXISTS qualification_durable_boundaries (
  qualification_namespace TEXT NOT NULL,
  story_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  boundary TEXT NOT NULL CHECK (boundary IN (
    'queue_claim', 'agent_start', 'agent_commit', 'host_validation',
    'integration_preparation', 'integration_apply', 'integrated_validation',
    'evidence_persistence', 'run_closeout'
  )),
  fencing_token BIGINT NOT NULL CHECK (fencing_token > 0),
  evidence_hash CHAR(64) NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (qualification_namespace, story_id, attempt, boundary),
  FOREIGN KEY (qualification_namespace, story_id, attempt)
    REFERENCES qualification_story_attempts (qualification_namespace, story_id, attempt) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS qualification_cleanup_actions (
  qualification_namespace TEXT NOT NULL,
  story_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN (
    'worktree', 'recovery_ref', 'integration', 'process', 'job', 'database_row', 'artifact'
  )),
  immutable_resource_id TEXT NOT NULL,
  fencing_token BIGINT NOT NULL CHECK (fencing_token > 0),
  classification TEXT NOT NULL CHECK (classification IN (
    'integrated', 'recoverable', 'safe-to-clean', 'manual-review-required'
  )),
  cleanup_state TEXT NOT NULL DEFAULT 'classified'
    CHECK (cleanup_state IN ('classified', 'started', 'completed', 'manual-review-required')),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (qualification_namespace, immutable_resource_id, fencing_token),
  FOREIGN KEY (qualification_namespace, story_id, attempt)
    REFERENCES qualification_story_attempts (qualification_namespace, story_id, attempt) ON DELETE CASCADE,
  CHECK ((cleanup_state = 'completed') = (completed_at IS NOT NULL)),
  CHECK (immutable_resource_id LIKE qualification_namespace || ':%')
);

CREATE OR REPLACE FUNCTION enforce_qualification_attempt_fence()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(NEW.qualification_namespace, NEW.isolation_marker, NEW.story_id, NEW.attempt)
     IS DISTINCT FROM
     ROW(OLD.qualification_namespace, OLD.isolation_marker, OLD.story_id, OLD.attempt) THEN
    RAISE EXCEPTION 'qualification story attempt identity is immutable';
  END IF;
  IF NEW.fencing_token < OLD.fencing_token THEN
    RAISE EXCEPTION 'qualification fencing token cannot decrease';
  END IF;
  IF OLD.terminal_status <> 'active' AND NEW.terminal_status IS DISTINCT FROM OLD.terminal_status THEN
    RAISE EXCEPTION 'qualification terminal status is immutable';
  END IF;
  IF OLD.terminal_status <> 'active' AND (
    NEW.worker_id IS DISTINCT FROM OLD.worker_id
    OR NEW.fencing_token IS DISTINCT FROM OLD.fencing_token
    OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at
  ) THEN
    RAISE EXCEPTION 'terminal qualification lease cannot be reclaimed';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_qualification_attempt_fence ON qualification_story_attempts;
CREATE TRIGGER trg_qualification_attempt_fence
BEFORE UPDATE ON qualification_story_attempts
FOR EACH ROW EXECUTE FUNCTION enforce_qualification_attempt_fence();

CREATE OR REPLACE FUNCTION enforce_qualification_boundary_fence()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  current_attempt qualification_story_attempts%ROWTYPE;
BEGIN
  SELECT * INTO current_attempt
    FROM qualification_story_attempts
   WHERE qualification_namespace = NEW.qualification_namespace
     AND story_id = NEW.story_id
     AND attempt = NEW.attempt;
  IF NOT FOUND
     OR current_attempt.terminal_status <> 'active'
     OR current_attempt.lease_expires_at <= NOW()
     OR current_attempt.fencing_token <> NEW.fencing_token THEN
    RAISE EXCEPTION 'stale or terminal qualification fence cannot write a durable boundary';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_qualification_boundary_fence ON qualification_durable_boundaries;
CREATE TRIGGER trg_qualification_boundary_fence
BEFORE INSERT OR UPDATE ON qualification_durable_boundaries
FOR EACH ROW EXECUTE FUNCTION enforce_qualification_boundary_fence();

CREATE OR REPLACE FUNCTION enforce_qualification_cleanup_fence()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  current_attempt qualification_story_attempts%ROWTYPE;
  transition_allowed BOOLEAN;
BEGIN
  SELECT * INTO current_attempt
    FROM qualification_story_attempts
   WHERE qualification_namespace = NEW.qualification_namespace
     AND story_id = NEW.story_id
     AND attempt = NEW.attempt;
  IF NOT FOUND OR current_attempt.fencing_token <> NEW.fencing_token THEN
    RAISE EXCEPTION 'stale qualification fence cannot classify or clean a resource';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.qualification_namespace, NEW.story_id, NEW.attempt, NEW.resource_kind,
           NEW.immutable_resource_id, NEW.fencing_token, NEW.classification)
       IS DISTINCT FROM
       ROW(OLD.qualification_namespace, OLD.story_id, OLD.attempt, OLD.resource_kind,
           OLD.immutable_resource_id, OLD.fencing_token, OLD.classification) THEN
      RAISE EXCEPTION 'qualification cleanup identity and classification are immutable';
    END IF;
    transition_allowed := NEW.cleanup_state = OLD.cleanup_state OR CASE OLD.cleanup_state
      WHEN 'classified' THEN NEW.cleanup_state IN ('started', 'manual-review-required')
      WHEN 'started' THEN NEW.cleanup_state IN ('completed', 'manual-review-required')
      WHEN 'completed' THEN FALSE
      WHEN 'manual-review-required' THEN FALSE
      ELSE FALSE
    END;
    IF NOT transition_allowed THEN
      RAISE EXCEPTION 'illegal qualification cleanup transition: % -> %', OLD.cleanup_state, NEW.cleanup_state;
    END IF;
  END IF;
  IF NEW.classification = 'manual-review-required' AND NEW.cleanup_state NOT IN ('classified', 'manual-review-required') THEN
    RAISE EXCEPTION 'manual-review-required resource cannot be cleaned automatically';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_qualification_cleanup_fence ON qualification_cleanup_actions;
CREATE TRIGGER trg_qualification_cleanup_fence
BEFORE INSERT OR UPDATE ON qualification_cleanup_actions
FOR EACH ROW EXECUTE FUNCTION enforce_qualification_cleanup_fence();
