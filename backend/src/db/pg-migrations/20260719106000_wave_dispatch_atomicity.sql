-- Forward-only ownership, fencing and capacity reservations for governed wave dispatch.
ALTER TABLE wave_parallel_rollout_controls
  ADD COLUMN IF NOT EXISTS policy_epoch BIGINT NOT NULL DEFAULT 1;

ALTER TABLE pipeline_runs
  ADD COLUMN IF NOT EXISTS summary TEXT,
  ADD COLUMN IF NOT EXISTS wave_policy_epoch BIGINT,
  ADD COLUMN IF NOT EXISTS dispatch_owner TEXT,
  ADD COLUMN IF NOT EXISTS dispatch_fence TEXT,
  ADD COLUMN IF NOT EXISTS dispatch_lease_expires_at TIMESTAMPTZ;

-- Copy the immutable queued envelope identity into indexed claim columns even for
-- callers predating these columns.
CREATE OR REPLACE FUNCTION stamp_wave_dispatch_policy_identity()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.wave_policy IS NOT NULL THEN
    NEW.wave_policy_fence := COALESCE(NEW.wave_policy_fence, NEW.wave_policy->>'fence');
    NEW.wave_policy_epoch := COALESCE(NEW.wave_policy_epoch, NULLIF(NEW.wave_policy#>>'{rollout,policyEpoch}', '')::BIGINT, 0);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_stamp_wave_dispatch_policy_identity ON pipeline_runs;
CREATE TRIGGER trg_stamp_wave_dispatch_policy_identity
BEFORE INSERT OR UPDATE OF wave_policy ON pipeline_runs
FOR EACH ROW EXECUTE FUNCTION stamp_wave_dispatch_policy_identity();

-- The audit insert is a database trigger, so every control mutation and its
-- append-only evidence share the same commit (including rollback/health paths).
CREATE OR REPLACE FUNCTION audit_wave_rollout_control_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO wave_parallel_governance_audit (
    workspace_id, event_type, actor, rationale, requested_policy,
    effective_policy, rollout_cohort, fencing_policy, outcome
  ) VALUES (
    NEW.workspace_id, 'cohort_change', NEW.updated_by, NEW.rationale,
    jsonb_build_object('enabled', NEW.enabled, 'draining', NEW.draining),
    jsonb_build_object('policyEpoch', NEW.policy_epoch, 'halted', NEW.halted,
                       'maxActiveWaveRuns', NEW.max_active_wave_runs,
                       'maxActiveWaveRunsPerWorkspace', NEW.max_active_wave_runs_per_workspace),
    NEW.cohort, 'dispatch-boundary-v1', CASE WHEN NEW.halted THEN 'halted' WHEN NEW.draining THEN 'draining' ELSE 'recorded' END
  );
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_wave_rollout_control_audit ON wave_parallel_rollout_controls;
CREATE TRIGGER trg_wave_rollout_control_audit
AFTER INSERT OR UPDATE ON wave_parallel_rollout_controls
FOR EACH ROW EXECUTE FUNCTION audit_wave_rollout_control_mutation();

CREATE TABLE IF NOT EXISTS wave_parallel_capacity_reservations (
  run_id BIGINT PRIMARY KEY REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  policy_epoch BIGINT NOT NULL,
  owner TEXT NOT NULL CHECK (octet_length(owner) BETWEEN 1 AND 256),
  fence TEXT NOT NULL CHECK (fence ~ '^sha256:[0-9a-f]{64}$'),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wave_capacity_reservations_active
  ON wave_parallel_capacity_reservations (workspace_id, lease_expires_at)
  WHERE released_at IS NULL;

-- Release ephemeral capacity on every terminal/non-active run transition,
-- regardless of which worker/error path owns closeout. Active pipeline state,
-- not lease age, remains the authoritative capacity signal.
CREATE OR REPLACE FUNCTION release_wave_capacity_reservation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status NOT IN ('starting', 'running') THEN
    UPDATE wave_parallel_capacity_reservations
       SET released_at = COALESCE(released_at, NOW())
     WHERE run_id = NEW.id AND released_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_release_wave_capacity_reservation ON pipeline_runs;
CREATE TRIGGER trg_release_wave_capacity_reservation
AFTER UPDATE OF status ON pipeline_runs
FOR EACH ROW EXECUTE FUNCTION release_wave_capacity_reservation();

-- Epoch changes fence all queued dispatches after any control mutation.
CREATE OR REPLACE FUNCTION bump_wave_rollout_policy_epoch()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.policy_epoch := OLD.policy_epoch + 1;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_wave_rollout_policy_epoch ON wave_parallel_rollout_controls;
CREATE TRIGGER trg_wave_rollout_policy_epoch
BEFORE UPDATE ON wave_parallel_rollout_controls
FOR EACH ROW EXECUTE FUNCTION bump_wave_rollout_policy_epoch();
