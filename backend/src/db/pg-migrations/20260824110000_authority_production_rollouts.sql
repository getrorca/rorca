-- Provider-neutral protected-production rollout, health evaluation, rollback, and receipt lineage.
-- Provider credentials remain exclusively in SecretStore and are never members of these records.

ALTER TABLE rorca.authority_deployment_operations
  ADD COLUMN IF NOT EXISTS production_prior_state JSONB;
ALTER TABLE rorca.authority_deployment_operations
  ADD COLUMN IF NOT EXISTS production_rollout_cohort JSONB;
ALTER TABLE rorca.authority_deployment_operations
  DROP CONSTRAINT IF EXISTS authority_deployment_operations_production_checkpoint_check;
ALTER TABLE rorca.authority_deployment_operations
  ADD CONSTRAINT authority_deployment_operations_production_checkpoint_check CHECK (
    (production_prior_state IS NULL) = (production_rollout_cohort IS NULL)
    AND (production_prior_state IS NULL OR capability = 'deploy.production')
    AND (production_prior_state IS NULL OR jsonb_typeof(production_prior_state) = 'object')
    AND (production_rollout_cohort IS NULL OR jsonb_typeof(production_rollout_cohort) = 'object')
  );

CREATE OR REPLACE FUNCTION rorca.protect_authority_production_dispatch_checkpoint()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (OLD.production_prior_state IS NOT NULL
       AND OLD.production_prior_state IS DISTINCT FROM NEW.production_prior_state)
     OR (OLD.production_rollout_cohort IS NOT NULL
       AND OLD.production_rollout_cohort IS DISTINCT FROM NEW.production_rollout_cohort) THEN
    RAISE EXCEPTION 'production prior state and approved cohort are immutable once captured'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS authority_production_dispatch_checkpoint_immutable
  ON rorca.authority_deployment_operations;
CREATE TRIGGER authority_production_dispatch_checkpoint_immutable
BEFORE UPDATE ON rorca.authority_deployment_operations
FOR EACH ROW EXECUTE FUNCTION rorca.protect_authority_production_dispatch_checkpoint();


CREATE TABLE IF NOT EXISTS rorca.authority_production_rollouts (
  operation_id UUID PRIMARY KEY REFERENCES rorca.authority_deployment_operations(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  authorization_id UUID NOT NULL UNIQUE REFERENCES rorca.authority_production_authorizations(id) ON DELETE RESTRICT,
  binding_id UUID NOT NULL REFERENCES rorca.deployment_provider_bindings(id) ON DELETE RESTRICT,
  binding_generation BIGINT NOT NULL CHECK (binding_generation > 0),
  operation_intent_id UUID NOT NULL REFERENCES rorca.authority_operation_intents(id) ON DELETE RESTRICT,
  intent_digest TEXT NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  ci_evidence_digest TEXT NOT NULL CHECK (ci_evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  grant_id UUID NOT NULL REFERENCES rorca.authority_operation_intent_grants(id) ON DELETE RESTRICT,
  external_gate_evidence_id UUID REFERENCES rorca.authority_external_gate_evidence(id) ON DELETE RESTRICT,
  authorized_at TIMESTAMPTZ NOT NULL,
  provider_id TEXT NOT NULL CHECK (provider_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$'),
  project_uuid UUID NOT NULL,
  application_uuid UUID NOT NULL,
  environment_uuid UUID NOT NULL,
  approved_cohort JSONB NOT NULL CHECK (jsonb_typeof(approved_cohort) = 'object'),
  prior_state JSONB NOT NULL CHECK (jsonb_typeof(prior_state) = 'object'),
  status TEXT NOT NULL CHECK (status IN (
    'canary_dispatched', 'expansion_pending', 'expansion_dispatched',
    'rollback_pending', 'rollback_dispatched', 'reconciliation_required', 'settled'
  )),
  health_evaluation JSONB CHECK (health_evaluation IS NULL OR jsonb_typeof(health_evaluation) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rorca.authority_production_rollout_actions (
  id UUID PRIMARY KEY,
  rollout_operation_id UUID NOT NULL REFERENCES rorca.authority_production_rollouts(operation_id) ON DELETE RESTRICT,
  phase TEXT NOT NULL CHECK (phase IN ('canary', 'expansion', 'rollback')),
  status TEXT NOT NULL CHECK (status IN ('prepared', 'dispatched', 'outcome_unknown', 'observed', 'revoked')),
  target_revision JSONB NOT NULL CHECK (jsonb_typeof(target_revision) = 'object'),
  cohort JSONB NOT NULL CHECK (jsonb_typeof(cohort) = 'object'),
  lease_id UUID UNIQUE REFERENCES rorca.deployment_capability_leases(id) ON DELETE RESTRICT,
  provider_deployment_id TEXT,
  provider_accepted_at TIMESTAMPTZ,
  observation JSONB CHECK (observation IS NULL OR jsonb_typeof(observation) = 'object'),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (rollout_operation_id, phase),
  CHECK (provider_deployment_id IS NULL OR lease_id IS NOT NULL),
  CHECK ((provider_deployment_id IS NULL) = (provider_accepted_at IS NULL)),
  CHECK ((status = 'prepared') = (lease_id IS NULL)),
  CHECK ((status IN ('observed', 'revoked')) = (observation IS NOT NULL)),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_authority_production_rollout_reconciliation
  ON rorca.authority_production_rollouts (workspace_id, status, updated_at)
  WHERE status IN (
    'canary_dispatched', 'expansion_dispatched', 'rollback_dispatched', 'reconciliation_required'
  );
CREATE INDEX IF NOT EXISTS idx_authority_production_action_reconciliation
  ON rorca.authority_production_rollout_actions (rollout_operation_id, status, updated_at)
  WHERE status IN ('dispatched', 'outcome_unknown');

CREATE OR REPLACE FUNCTION rorca.guard_authority_production_rollout()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  authorization_row rorca.authority_production_authorizations%ROWTYPE;
  operation_row rorca.authority_deployment_operations%ROWTYPE;
  intent_row rorca.authority_operation_intents%ROWTYPE;
  binding_row rorca.deployment_provider_bindings%ROWTYPE;
BEGIN
  SELECT * INTO authorization_row
    FROM rorca.authority_production_authorizations
   WHERE id = NEW.authorization_id;
  SELECT * INTO operation_row
    FROM rorca.authority_deployment_operations
   WHERE id = NEW.operation_id;
  SELECT * INTO intent_row
    FROM rorca.authority_operation_intents
   WHERE id = NEW.operation_intent_id;
  SELECT * INTO binding_row
    FROM rorca.deployment_provider_bindings
   WHERE id = NEW.binding_id;

  IF authorization_row.id IS NULL
     OR authorization_row.operation_id IS DISTINCT FROM NEW.operation_id
     OR authorization_row.workspace_id IS DISTINCT FROM NEW.workspace_id
     OR authorization_row.binding_id IS DISTINCT FROM NEW.binding_id
     OR authorization_row.binding_generation IS DISTINCT FROM NEW.binding_generation
     OR authorization_row.operation_intent_id IS DISTINCT FROM NEW.operation_intent_id
     OR authorization_row.requested_intent_digest IS DISTINCT FROM NEW.intent_digest
     OR authorization_row.requested_ci_evidence_digest IS DISTINCT FROM NEW.ci_evidence_digest
     OR authorization_row.requested_rollout_cohort IS DISTINCT FROM NEW.approved_cohort
     OR authorization_row.authorization_grant_id IS DISTINCT FROM NEW.grant_id
     OR authorization_row.external_gate_evidence_id IS DISTINCT FROM NEW.external_gate_evidence_id
     OR authorization_row.authorized_at IS DISTINCT FROM NEW.authorized_at
     OR authorization_row.status NOT IN ('dispatch_claimed', 'dispatched')
     OR operation_row.id IS NULL
     OR operation_row.capability IS DISTINCT FROM 'deploy.production'
     OR operation_row.provider_deployment_id IS NULL
     OR operation_row.binding_id IS DISTINCT FROM NEW.binding_id
     OR operation_row.binding_generation IS DISTINCT FROM NEW.binding_generation
     OR operation_row.production_prior_state IS DISTINCT FROM NEW.prior_state
     OR operation_row.production_rollout_cohort IS DISTINCT FROM NEW.approved_cohort
     OR intent_row.id IS NULL
     OR intent_row.intent_digest IS DISTINCT FROM NEW.intent_digest
     OR intent_row.ci_evidence_digest IS DISTINCT FROM NEW.ci_evidence_digest
     OR intent_row.intent_payload->'rolloutCohort' IS DISTINCT FROM NEW.approved_cohort
     OR binding_row.id IS NULL
     OR binding_row.provider_id IS DISTINCT FROM NEW.provider_id
     OR binding_row.project_uuid IS DISTINCT FROM NEW.project_uuid
     OR binding_row.application_uuid IS DISTINCT FROM NEW.application_uuid
     OR binding_row.environment_uuid IS DISTINCT FROM NEW.environment_uuid
     OR binding_row.environment_kind IS DISTINCT FROM 'production'
     OR binding_row.binding_generation IS DISTINCT FROM NEW.binding_generation
     OR (NEW.prior_state->>'authorityBindingGeneration')::BIGINT IS DISTINCT FROM NEW.binding_generation
     OR (NEW.prior_state#>>'{revision,configurationBindingGeneration}')::BIGINT <= 0
     OR (NEW.prior_state#>>'{revision,sourceRevision}' IS NULL
       AND NEW.prior_state#>>'{revision,imageDigest}' IS NULL) THEN
    RAISE EXCEPTION 'production rollout differs from authorized release, target, cohort, or prior state'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS authority_production_rollout_guard
  ON rorca.authority_production_rollouts;
CREATE TRIGGER authority_production_rollout_guard
BEFORE INSERT ON rorca.authority_production_rollouts
FOR EACH ROW EXECUTE FUNCTION rorca.guard_authority_production_rollout();

CREATE OR REPLACE FUNCTION rorca.guard_authority_production_rollout_action()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  rollout_row rorca.authority_production_rollouts%ROWTYPE;
  intent_row rorca.authority_operation_intents%ROWTYPE;
  lease_row rorca.deployment_capability_leases%ROWTYPE;
  expected_revision JSONB;
BEGIN
  SELECT * INTO rollout_row
    FROM rorca.authority_production_rollouts
   WHERE operation_id = NEW.rollout_operation_id;
  SELECT * INTO intent_row
    FROM rorca.authority_operation_intents
   WHERE id = rollout_row.operation_intent_id;

  IF NEW.phase IN ('canary', 'expansion') THEN
    expected_revision := jsonb_build_object(
      'sourceRevision', intent_row.intent_payload->'sourceRevision',
      'imageDigest', intent_row.intent_payload#>'{artifacts,imageDigests,0}',
      'configurationBindingGeneration', intent_row.intent_payload->'configurationBindingGeneration'
    );
  ELSE
    expected_revision := rollout_row.prior_state->'revision';
  END IF;

  IF rollout_row.operation_id IS NULL
     OR intent_row.id IS NULL
     OR NEW.cohort IS DISTINCT FROM rollout_row.approved_cohort
     OR NEW.target_revision IS DISTINCT FROM expected_revision
     OR (NEW.phase = 'canary' AND NEW.id IS DISTINCT FROM NEW.rollout_operation_id)
     OR (NEW.phase = 'expansion'
       AND rollout_row.health_evaluation->>'decision' IS DISTINCT FROM 'expand')
     OR (NEW.phase = 'rollback'
       AND rollout_row.health_evaluation->>'decision' IS DISTINCT FROM 'abort'
       AND NOT EXISTS (
         SELECT 1
           FROM rorca.authority_production_rollout_actions expansion
          WHERE expansion.rollout_operation_id = NEW.rollout_operation_id
            AND expansion.phase = 'expansion'
            AND expansion.observation#>>'{evidence,providerOutcome}' = 'unhealthy'
       )) THEN
    RAISE EXCEPTION 'production action differs from exact cohort, revision, or health decision'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.lease_id IS NOT NULL THEN
    SELECT * INTO lease_row
      FROM rorca.deployment_capability_leases
     WHERE id = NEW.lease_id;
    IF lease_row.id IS NULL
       OR lease_row.binding_id IS DISTINCT FROM rollout_row.binding_id
       OR lease_row.binding_generation IS DISTINCT FROM rollout_row.binding_generation
       OR lease_row.capability IS DISTINCT FROM 'deploy.production'
       OR lease_row.operation_id IS DISTINCT FROM NEW.id
       OR lease_row.provider_deployment_id IS DISTINCT FROM NEW.provider_deployment_id THEN
      RAISE EXCEPTION 'production action lease is not fenced to its exact provider operation'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF NEW.observation IS NOT NULL
     AND (NEW.observation->>'actionId' IS DISTINCT FROM NEW.id::TEXT
       OR NEW.observation->>'phase' IS DISTINCT FROM NEW.phase
       OR NEW.observation#>>'{evidence,providerDeploymentId}' IS DISTINCT FROM NEW.provider_deployment_id
       OR NEW.observation#>'{evidence,rolloutCohort}' IS DISTINCT FROM NEW.cohort
       OR NEW.observation#>'{evidence,revision}' IS DISTINCT FROM NEW.target_revision) THEN
    RAISE EXCEPTION 'production observation differs from exact provider action'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS authority_production_rollout_action_guard
  ON rorca.authority_production_rollout_actions;
CREATE TRIGGER authority_production_rollout_action_guard
BEFORE INSERT OR UPDATE ON rorca.authority_production_rollout_actions
FOR EACH ROW EXECUTE FUNCTION rorca.guard_authority_production_rollout_action();

CREATE OR REPLACE FUNCTION rorca.protect_authority_production_rollout()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.operation_id IS DISTINCT FROM NEW.operation_id
     OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
     OR OLD.authorization_id IS DISTINCT FROM NEW.authorization_id
     OR OLD.binding_id IS DISTINCT FROM NEW.binding_id
     OR OLD.binding_generation IS DISTINCT FROM NEW.binding_generation
     OR OLD.operation_intent_id IS DISTINCT FROM NEW.operation_intent_id
     OR OLD.intent_digest IS DISTINCT FROM NEW.intent_digest
     OR OLD.ci_evidence_digest IS DISTINCT FROM NEW.ci_evidence_digest
     OR OLD.grant_id IS DISTINCT FROM NEW.grant_id
     OR OLD.external_gate_evidence_id IS DISTINCT FROM NEW.external_gate_evidence_id
     OR OLD.authorized_at IS DISTINCT FROM NEW.authorized_at
     OR OLD.provider_id IS DISTINCT FROM NEW.provider_id
     OR OLD.project_uuid IS DISTINCT FROM NEW.project_uuid
     OR OLD.application_uuid IS DISTINCT FROM NEW.application_uuid
     OR OLD.environment_uuid IS DISTINCT FROM NEW.environment_uuid
     OR OLD.approved_cohort IS DISTINCT FROM NEW.approved_cohort
     OR OLD.prior_state IS DISTINCT FROM NEW.prior_state
     OR (OLD.health_evaluation IS NOT NULL
       AND OLD.health_evaluation IS DISTINCT FROM NEW.health_evaluation)
     OR OLD.status = 'settled' AND NEW.status IS DISTINCT FROM 'settled' THEN
    RAISE EXCEPTION 'production rollout authority, prior state, evidence, and terminal state are immutable'
      USING ERRCODE = '55000';
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS authority_production_rollout_immutable
  ON rorca.authority_production_rollouts;
CREATE TRIGGER authority_production_rollout_immutable
BEFORE UPDATE ON rorca.authority_production_rollouts
FOR EACH ROW EXECUTE FUNCTION rorca.protect_authority_production_rollout();

CREATE OR REPLACE FUNCTION rorca.protect_authority_production_rollout_action()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.rollout_operation_id IS DISTINCT FROM NEW.rollout_operation_id
     OR OLD.phase IS DISTINCT FROM NEW.phase
     OR OLD.target_revision IS DISTINCT FROM NEW.target_revision
     OR OLD.cohort IS DISTINCT FROM NEW.cohort
     OR (OLD.lease_id IS NOT NULL AND OLD.lease_id IS DISTINCT FROM NEW.lease_id)
     OR (OLD.provider_deployment_id IS NOT NULL
       AND OLD.provider_deployment_id IS DISTINCT FROM NEW.provider_deployment_id)
     OR (OLD.provider_accepted_at IS NOT NULL
       AND OLD.provider_accepted_at IS DISTINCT FROM NEW.provider_accepted_at)
     OR (OLD.observation IS NOT NULL AND OLD.observation IS DISTINCT FROM NEW.observation)
     OR (OLD.revoked_at IS NOT NULL AND OLD.revoked_at IS DISTINCT FROM NEW.revoked_at)
     OR OLD.status = 'revoked' AND NEW.status IS DISTINCT FROM 'revoked' THEN
    RAISE EXCEPTION 'production rollout action lineage is immutable once recorded'
      USING ERRCODE = '55000';
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS authority_production_rollout_action_immutable
  ON rorca.authority_production_rollout_actions;
CREATE TRIGGER authority_production_rollout_action_immutable
BEFORE UPDATE ON rorca.authority_production_rollout_actions
FOR EACH ROW EXECUTE FUNCTION rorca.protect_authority_production_rollout_action();

CREATE OR REPLACE FUNCTION rorca.guard_authority_production_rollout_receipt()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  operation_row rorca.authority_deployment_operations%ROWTYPE;
  rollout_row rorca.authority_production_rollouts%ROWTYPE;
  intent_row rorca.authority_operation_intents%ROWTYPE;
  action_row rorca.authority_production_rollout_actions%ROWTYPE;
  action_count INTEGER;
BEGIN
  SELECT * INTO operation_row
    FROM rorca.authority_deployment_operations
   WHERE id = NEW.operation_id;
  IF operation_row.capability IS DISTINCT FROM 'deploy.production' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO rollout_row
    FROM rorca.authority_production_rollouts
   WHERE operation_id = NEW.operation_id;
  SELECT * INTO intent_row
    FROM rorca.authority_operation_intents
   WHERE id = rollout_row.operation_intent_id;
  SELECT COUNT(*) INTO action_count
    FROM rorca.authority_production_rollout_actions
   WHERE rollout_operation_id = NEW.operation_id;

  IF rollout_row.operation_id IS NULL
     OR NEW.receipt_payload->>'operationIntentId' IS DISTINCT FROM rollout_row.operation_intent_id::TEXT
     OR NEW.receipt_payload->>'releaseIntentDigest' IS DISTINCT FROM rollout_row.intent_digest
     OR NEW.receipt_payload->>'ciEvidenceDigest' IS DISTINCT FROM rollout_row.ci_evidence_digest
     OR NEW.receipt_payload->>'authorizationId' IS DISTINCT FROM rollout_row.authorization_id::TEXT
     OR (NEW.receipt_payload->>'externalGateEvidenceId')::UUID
          IS DISTINCT FROM rollout_row.external_gate_evidence_id
     OR NEW.receipt_payload->'rolloutCohort' IS DISTINCT FROM rollout_row.approved_cohort
     OR NEW.receipt_payload->'priorState' IS DISTINCT FROM rollout_row.prior_state
     OR NEW.receipt_payload#>'{health,evaluation}' IS DISTINCT FROM rollout_row.health_evaluation
     OR jsonb_array_length(NEW.receipt_payload->'actions') IS DISTINCT FROM action_count
     OR jsonb_array_length(NEW.receipt_payload->'revokedLeases') IS DISTINCT FROM action_count THEN
    RAISE EXCEPTION 'production receipt differs from release, gate, cohort, prior state, or health authority'
      USING ERRCODE = '55000';
  END IF;

  FOR action_row IN
    SELECT * FROM rorca.authority_production_rollout_actions
     WHERE rollout_operation_id = NEW.operation_id
  LOOP
    IF action_row.status IS DISTINCT FROM 'revoked'
       OR action_row.observation IS NULL
       OR NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(NEW.receipt_payload->'actions') receipt_action
          WHERE receipt_action->>'actionId' = action_row.id::TEXT
            AND receipt_action->>'phase' = action_row.phase
            AND receipt_action->>'leaseId' = action_row.lease_id::TEXT
            AND receipt_action->>'providerDeploymentId' = action_row.provider_deployment_id
            AND (receipt_action->>'acceptedAt')::TIMESTAMPTZ = action_row.provider_accepted_at
            AND receipt_action->'cohort' = action_row.cohort
            AND receipt_action->'targetRevision' = action_row.target_revision
            AND (receipt_action->>'observedAt')::TIMESTAMPTZ
                 = (action_row.observation#>>'{evidence,observedAt}')::TIMESTAMPTZ
            AND receipt_action->>'providerStatus'
                 = action_row.observation#>>'{evidence,providerStatus}'
            AND receipt_action->>'providerOutcome'
                 = action_row.observation#>>'{evidence,providerOutcome}'
       )
       OR NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(NEW.receipt_payload->'revokedLeases') receipt_revocation
          WHERE receipt_revocation->>'actionId' = action_row.id::TEXT
            AND receipt_revocation->>'phase' = action_row.phase
            AND receipt_revocation->>'leaseId' = action_row.lease_id::TEXT
            AND receipt_revocation->>'providerDeploymentId' = action_row.provider_deployment_id
            AND (receipt_revocation->>'revokedAt')::TIMESTAMPTZ = action_row.revoked_at
       ) THEN
      RAISE EXCEPTION 'production receipt omits exact action, deployment, observation, or revocation lineage'
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  IF rollout_row.health_evaluation->>'decision' = 'abort'
     OR EXISTS (
       SELECT 1
         FROM rorca.authority_production_rollout_actions expansion
        WHERE expansion.rollout_operation_id = NEW.operation_id
          AND expansion.phase = 'expansion'
          AND expansion.observation#>>'{evidence,providerOutcome}' = 'unhealthy'
     ) THEN
    SELECT * INTO action_row
      FROM rorca.authority_production_rollout_actions
     WHERE rollout_operation_id = NEW.operation_id AND phase = 'rollback';
    IF action_row.id IS NULL
       OR NEW.receipt_payload->'rollback' IS NULL
       OR NEW.receipt_payload#>>'{rollback,owner}'
            IS DISTINCT FROM intent_row.intent_payload#>>'{rollback,owner}'
       OR NEW.receipt_payload#>'{rollback,procedure}'
            IS DISTINCT FROM intent_row.intent_payload#>'{rollback,procedure}'
       OR NEW.receipt_payload#>>'{rollback,providerDeploymentId}'
            IS DISTINCT FROM action_row.provider_deployment_id
       OR NEW.receipt_payload#>'{rollback,restoredRevision}'
            IS DISTINCT FROM rollout_row.prior_state->'revision'
       OR NEW.receipt_payload#>>'{rollback,healthVerified}' IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'rollback receipt omits the declared exact procedure and verified restoration'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.receipt_payload->'rollback' <> 'null'::JSONB THEN
    RAISE EXCEPTION 'non-abort production receipt cannot claim rollback'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS authority_production_rollout_receipt_guard
  ON rorca.authority_execution_receipts;
CREATE TRIGGER authority_production_rollout_receipt_guard
BEFORE INSERT ON rorca.authority_execution_receipts
FOR EACH ROW EXECUTE FUNCTION rorca.guard_authority_production_rollout_receipt();

REVOKE ALL PRIVILEGES ON TABLE rorca.authority_production_rollouts FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE rorca.authority_production_rollout_actions FROM PUBLIC;

DO $$
DECLARE
  runtime_user TEXT := current_setting('rorca.runtime_database_user', TRUE);
  writer_user TEXT := current_setting('rorca.canonical_writer_database_user', TRUE);
BEGIN
  IF runtime_user IS NOT NULL AND runtime_user <> '' AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_user) THEN
    EXECUTE format(
      'GRANT SELECT ON rorca.authority_production_rollouts, rorca.authority_production_rollout_actions TO %I',
      runtime_user
    );
  END IF;
  IF writer_user IS NOT NULL AND writer_user <> '' AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = writer_user) THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE ON rorca.authority_production_rollouts, rorca.authority_production_rollout_actions TO %I',
      writer_user
    );
  END IF;
END;
$$;
