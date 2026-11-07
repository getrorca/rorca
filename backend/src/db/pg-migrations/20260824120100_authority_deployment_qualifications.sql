-- Immutable evidence for disposable staging and protected-production qualification.
-- Qualification carries only provider-neutral binding references and redacted receipts;
-- provider credentials remain exclusively in SecretStore.

CREATE TABLE IF NOT EXISTS rorca.authority_deployment_qualifications (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  provider_id TEXT NOT NULL CHECK (provider_id = 'coolify'),
  fixture_namespace TEXT NOT NULL UNIQUE CHECK (
    fixture_namespace ~ '^rorca-disposable-coolify/[a-z0-9][a-z0-9-]{2,80}$'
  ),
  fixture_owner TEXT NOT NULL CHECK (fixture_owner = 'rorca'),
  fixture_digest TEXT NOT NULL CHECK (fixture_digest ~ '^sha256:[0-9a-f]{64}$'),
  staging_binding_id UUID NOT NULL REFERENCES rorca.deployment_provider_bindings(id) ON DELETE RESTRICT,
  staging_binding_generation BIGINT NOT NULL CHECK (staging_binding_generation > 0),
  production_binding_id UUID NOT NULL REFERENCES rorca.deployment_provider_bindings(id) ON DELETE RESTRICT,
  production_binding_generation BIGINT NOT NULL CHECK (production_binding_generation > 0),
  staging_evidence JSONB CHECK (staging_evidence IS NULL OR jsonb_typeof(staging_evidence) = 'object'),
  external_gate_evidence JSONB CHECK (external_gate_evidence IS NULL OR jsonb_typeof(external_gate_evidence) = 'object'),
  status TEXT NOT NULL CHECK (status IN (
    'staging_pending', 'gate_pending', 'production_testing', 'passed', 'rollback_blocked'
  )),
  qualification_receipt JSONB CHECK (
    qualification_receipt IS NULL OR jsonb_typeof(qualification_receipt) = 'object'
  ),
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (staging_binding_id <> production_binding_id),
  CHECK ((status IN ('passed', 'rollback_blocked')) = (qualification_receipt IS NOT NULL)),
  CHECK ((qualification_receipt IS NULL) = (completed_at IS NULL))
);

CREATE TABLE IF NOT EXISTS rorca.authority_deployment_qualification_scenarios (
  qualification_id UUID NOT NULL REFERENCES rorca.authority_deployment_qualifications(id) ON DELETE RESTRICT,
  scenario TEXT NOT NULL CHECK (scenario IN (
    'intent_digest_changed', 'migration_set_changed', 'change_window_closed',
    'external_gate_denied', 'external_gate_invalid', 'grant_expired', 'grant_replayed',
    'cross_environment_binding', 'control_token_prompt_extraction', 'health_abort',
    'crash_deploy', 'crash_canary', 'crash_rollback', 'crash_revocation'
  )),
  outcome TEXT NOT NULL CHECK (outcome IN (
    'rejected', 'rolled_back', 'reconciled', 'rollback_blocked'
  )),
  lineage_id UUID,
  provider_mutation_count INTEGER NOT NULL CHECK (provider_mutation_count >= 0),
  evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  rollback_blocker JSONB CHECK (rollback_blocker IS NULL OR jsonb_typeof(rollback_blocker) = 'object'),
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (qualification_id, scenario),
  CHECK ((outcome = 'rollback_blocked') = (rollback_blocker IS NOT NULL)),
  CHECK ((provider_mutation_count = 0) = (lineage_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_authority_deployment_qualifications_pending
  ON rorca.authority_deployment_qualifications (workspace_id, status, updated_at)
  WHERE status IN ('staging_pending', 'gate_pending', 'production_testing', 'rollback_blocked');

CREATE OR REPLACE FUNCTION rorca.guard_authority_deployment_qualification_target()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  staging_row rorca.deployment_provider_bindings%ROWTYPE;
  production_row rorca.deployment_provider_bindings%ROWTYPE;
BEGIN
  SELECT * INTO staging_row
    FROM rorca.deployment_provider_bindings
   WHERE id = NEW.staging_binding_id;
  SELECT * INTO production_row
    FROM rorca.deployment_provider_bindings
   WHERE id = NEW.production_binding_id;

  IF staging_row.id IS NULL
     OR production_row.id IS NULL
     OR NEW.workspace_id !~ '^qualification:'
     OR staging_row.workspace_id IS DISTINCT FROM NEW.workspace_id
     OR production_row.workspace_id IS DISTINCT FROM NEW.workspace_id
     OR staging_row.provider_id IS DISTINCT FROM NEW.provider_id
     OR production_row.provider_id IS DISTINCT FROM NEW.provider_id
     OR staging_row.environment_kind IS DISTINCT FROM 'staging'
     OR production_row.environment_kind IS DISTINCT FROM 'production'
     OR staging_row.status IS DISTINCT FROM 'active'
     OR production_row.status IS DISTINCT FROM 'active'
     OR staging_row.binding_generation IS DISTINCT FROM NEW.staging_binding_generation
     OR production_row.binding_generation IS DISTINCT FROM NEW.production_binding_generation
     OR staging_row.base_url IS DISTINCT FROM production_row.base_url
     OR staging_row.project_uuid IS DISTINCT FROM production_row.project_uuid
     OR staging_row.application_uuid IS NOT DISTINCT FROM production_row.application_uuid
     OR staging_row.environment_uuid IS NOT DISTINCT FROM production_row.environment_uuid
     OR staging_row.secret_store_id IS NOT DISTINCT FROM production_row.secret_store_id
     OR staging_row.capability_policy->'allowedActions' IS DISTINCT FROM '["deploy.staging"]'::JSONB
     OR production_row.capability_policy->'allowedActions' IS DISTINCT FROM '["deploy.production"]'::JSONB
     OR staging_row.verified_profile#>>'{principal,subjectId}' IS DISTINCT FROM 'rorca-disposable-qualification'
     OR staging_row.verified_profile#>>'{principal,teamId}' IS DISTINCT FROM 'rorca-fixture-team'
     OR production_row.verified_profile#>>'{principal,subjectId}' IS DISTINCT FROM 'rorca-disposable-qualification'
     OR production_row.verified_profile#>>'{principal,teamId}' IS DISTINCT FROM 'rorca-fixture-team'
     OR production_row.capability_policy->>'productionApprovalMode' IS DISTINCT FROM 'independent_external' THEN
    RAISE EXCEPTION 'qualification bindings are not exact, isolated disposable targets'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS authority_deployment_qualification_target_guard
  ON rorca.authority_deployment_qualifications;
CREATE TRIGGER authority_deployment_qualification_target_guard
BEFORE INSERT ON rorca.authority_deployment_qualifications
FOR EACH ROW EXECUTE FUNCTION rorca.guard_authority_deployment_qualification_target();

CREATE OR REPLACE FUNCTION rorca.guard_authority_deployment_qualification_scenario()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  operation_count INTEGER;
  unique_operation_count INTEGER;
  idempotency_count INTEGER;
  unique_idempotency_count INTEGER;
  lease_count INTEGER;
  revoked_lease_count INTEGER;
  lease_ids JSONB;
  revoked_lease_ids JSONB;
  qualification_row rorca.authority_deployment_qualifications%ROWTYPE;
  production_row rorca.deployment_provider_bindings%ROWTYPE;
  rejection_scenario BOOLEAN := NEW.scenario IN (
    'intent_digest_changed', 'migration_set_changed', 'change_window_closed',
    'external_gate_denied', 'external_gate_invalid', 'grant_expired', 'grant_replayed',
    'cross_environment_binding', 'control_token_prompt_extraction'
  );
BEGIN
  SELECT * INTO qualification_row
    FROM rorca.authority_deployment_qualifications
   WHERE id = NEW.qualification_id;
  SELECT * INTO production_row
    FROM rorca.deployment_provider_bindings
   WHERE id = qualification_row.production_binding_id;
  SELECT COUNT(*), COUNT(DISTINCT value)
    INTO operation_count, unique_operation_count
    FROM jsonb_array_elements_text(NEW.evidence->'providerOperationIds');
  SELECT COUNT(*), COUNT(DISTINCT value)
    INTO idempotency_count, unique_idempotency_count
    FROM jsonb_array_elements_text(NEW.evidence->'providerIdempotencyKeys');
  SELECT COUNT(*), COALESCE(jsonb_agg(value ORDER BY value), '[]'::JSONB)
    INTO lease_count, lease_ids
    FROM jsonb_array_elements_text(NEW.evidence->'leaseIds');
  SELECT COUNT(*), COALESCE(jsonb_agg(value ORDER BY value), '[]'::JSONB)
    INTO revoked_lease_count, revoked_lease_ids
    FROM jsonb_array_elements_text(NEW.evidence->'revokedLeaseIds');

  IF qualification_row.id IS NULL
     OR production_row.id IS NULL
     OR jsonb_typeof(NEW.evidence->'providerOperationIds') IS DISTINCT FROM 'array'
     OR jsonb_typeof(NEW.evidence->'providerIdempotencyKeys') IS DISTINCT FROM 'array'
     OR jsonb_typeof(NEW.evidence->'leaseIds') IS DISTINCT FROM 'array'
     OR jsonb_typeof(NEW.evidence->'revokedLeaseIds') IS DISTINCT FROM 'array'
     OR jsonb_typeof(NEW.evidence->'receiptIds') IS DISTINCT FROM 'array'
     OR NEW.evidence#>>'{target,bindingId}' IS DISTINCT FROM production_row.id::TEXT
     OR (NEW.evidence#>>'{target,bindingGeneration}')::BIGINT
        IS DISTINCT FROM qualification_row.production_binding_generation
     OR NEW.evidence#>>'{target,projectUuid}' IS DISTINCT FROM production_row.project_uuid::TEXT
     OR NEW.evidence#>>'{target,applicationUuid}' IS DISTINCT FROM production_row.application_uuid::TEXT
     OR NEW.evidence#>>'{target,environmentUuid}' IS DISTINCT FROM production_row.environment_uuid::TEXT
     OR (NEW.evidence#>>'{terminalState,authorityBindingGeneration}')::BIGINT
        IS DISTINCT FROM qualification_row.production_binding_generation
     OR NEW.evidence->>'scenario' IS DISTINCT FROM NEW.scenario
     OR NEW.evidence->>'outcome' IS DISTINCT FROM NEW.outcome
     OR (NEW.evidence->>'providerMutationCount')::INTEGER IS DISTINCT FROM NEW.provider_mutation_count
     OR NEW.evidence->>'lineageId' IS DISTINCT FROM NEW.lineage_id::TEXT
     OR NEW.evidence->'unresolvedRollbackBlocker' IS DISTINCT FROM NEW.rollback_blocker
     OR NEW.evidence->>'secretMaterialObserved' IS DISTINCT FROM 'false'
     OR NEW.evidence#>>'{terminalState,productionCapabilityDisabled}' IS DISTINCT FROM 'true'
     OR operation_count IS DISTINCT FROM NEW.provider_mutation_count
     OR unique_operation_count IS DISTINCT FROM operation_count
     OR idempotency_count IS DISTINCT FROM NEW.provider_mutation_count
     OR unique_idempotency_count IS DISTINCT FROM idempotency_count
     OR jsonb_array_length(NEW.evidence->'receiptIds') IS NULL
     OR jsonb_array_length(NEW.evidence->'receiptIds') = 0
     OR (NEW.rollback_blocker IS NULL AND (
       NEW.evidence#>>'{terminalState,priorRevisionServing}' IS DISTINCT FROM 'true'
       OR NEW.evidence#>>'{terminalState,healthy}' IS DISTINCT FROM 'true'
       OR lease_count IS DISTINCT FROM revoked_lease_count
       OR lease_ids IS DISTINCT FROM revoked_lease_ids
     ))
     OR (rejection_scenario AND (
       NEW.outcome IS DISTINCT FROM 'rejected'
       OR NEW.provider_mutation_count IS DISTINCT FROM 0
       OR NEW.evidence->>'productionCredentialResolved' IS DISTINCT FROM 'false'
       OR NEW.evidence->>'rejectionBoundary' IS NULL
       OR NEW.evidence->>'rejectionBoundary' NOT IN (
         'before_credential_resolution', 'before_provider_mutation'
       )
     ))
     OR (NOT rejection_scenario AND (
       NEW.evidence->>'productionCredentialResolved' IS DISTINCT FROM 'true'
       OR NEW.provider_mutation_count = 0
       OR NEW.evidence->>'rejectionBoundary' IS NOT NULL
       OR (NEW.scenario = 'health_abort' AND NEW.outcome IS DISTINCT FROM 'rolled_back')
       OR (NEW.scenario LIKE 'crash_%' AND NEW.outcome NOT IN (
         'reconciled', 'rolled_back', 'rollback_blocked'
       ))
     )) THEN
    RAISE EXCEPTION 'qualification scenario lacks safe rejection, restoration, or unique reconciliation evidence'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS authority_deployment_qualification_scenario_guard
  ON rorca.authority_deployment_qualification_scenarios;
CREATE TRIGGER authority_deployment_qualification_scenario_guard
BEFORE INSERT ON rorca.authority_deployment_qualification_scenarios
FOR EACH ROW EXECUTE FUNCTION rorca.guard_authority_deployment_qualification_scenario();

CREATE OR REPLACE FUNCTION rorca.protect_authority_deployment_qualification_scenario()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'qualification scenario evidence is immutable'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS authority_deployment_qualification_scenario_immutable
  ON rorca.authority_deployment_qualification_scenarios;
CREATE TRIGGER authority_deployment_qualification_scenario_immutable
BEFORE UPDATE OR DELETE ON rorca.authority_deployment_qualification_scenarios
FOR EACH ROW EXECUTE FUNCTION rorca.protect_authority_deployment_qualification_scenario();

CREATE OR REPLACE FUNCTION rorca.protect_authority_deployment_qualification()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  staging_row rorca.deployment_provider_bindings%ROWTYPE;
  production_row rorca.deployment_provider_bindings%ROWTYPE;
  scenario_count INTEGER;
  receipt_scenario_match_count INTEGER;
  receipt_scenario_name_count INTEGER;
  blocker_count INTEGER;
BEGIN
  SELECT * INTO staging_row
    FROM rorca.deployment_provider_bindings
   WHERE id = NEW.staging_binding_id;
  SELECT * INTO production_row
    FROM rorca.deployment_provider_bindings
   WHERE id = NEW.production_binding_id;
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
     OR OLD.provider_id IS DISTINCT FROM NEW.provider_id
     OR OLD.fixture_namespace IS DISTINCT FROM NEW.fixture_namespace
     OR OLD.fixture_owner IS DISTINCT FROM NEW.fixture_owner
     OR OLD.fixture_digest IS DISTINCT FROM NEW.fixture_digest
     OR OLD.staging_binding_id IS DISTINCT FROM NEW.staging_binding_id
     OR OLD.staging_binding_generation IS DISTINCT FROM NEW.staging_binding_generation
     OR OLD.production_binding_id IS DISTINCT FROM NEW.production_binding_id
     OR OLD.production_binding_generation IS DISTINCT FROM NEW.production_binding_generation
     OR OLD.started_at IS DISTINCT FROM NEW.started_at
     OR (OLD.staging_evidence IS NOT NULL AND OLD.staging_evidence IS DISTINCT FROM NEW.staging_evidence)
     OR (OLD.external_gate_evidence IS NOT NULL AND OLD.external_gate_evidence IS DISTINCT FROM NEW.external_gate_evidence)
     OR (OLD.qualification_receipt IS NOT NULL AND OLD.qualification_receipt IS DISTINCT FROM NEW.qualification_receipt)
     OR (OLD.completed_at IS NOT NULL AND OLD.completed_at IS DISTINCT FROM NEW.completed_at) THEN
    RAISE EXCEPTION 'qualification identity and settled evidence are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status IN ('gate_pending', 'production_testing', 'passed', 'rollback_blocked')
     AND NEW.staging_evidence IS NULL THEN
    RAISE EXCEPTION 'production qualification cannot begin before staging evidence'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.staging_evidence IS NOT NULL
     AND (
       NEW.staging_evidence#>>'{target,bindingId}' IS DISTINCT FROM NEW.staging_binding_id::TEXT
       OR (NEW.staging_evidence#>>'{target,bindingGeneration}')::BIGINT
          IS DISTINCT FROM NEW.staging_binding_generation
       OR NEW.staging_evidence#>>'{target,projectUuid}' IS DISTINCT FROM staging_row.project_uuid::TEXT
       OR NEW.staging_evidence#>>'{target,applicationUuid}' IS DISTINCT FROM staging_row.application_uuid::TEXT
       OR NEW.staging_evidence#>>'{target,environmentUuid}' IS DISTINCT FROM staging_row.environment_uuid::TEXT
       OR NEW.staging_evidence->>'status' IS DISTINCT FROM 'healthy'
       OR jsonb_array_length(NEW.staging_evidence->'reachableTargets') IS DISTINCT FROM 1
       OR NEW.staging_evidence#>>'{reachableTargets,0,applicationUuid}' IS DISTINCT FROM staging_row.application_uuid::TEXT
       OR NEW.staging_evidence#>>'{reachableTargets,0,environmentUuid}' IS DISTINCT FROM staging_row.environment_uuid::TEXT
       OR NEW.staging_evidence#>>'{reachableTargets,0,applicationUuid}' IS NOT DISTINCT FROM production_row.application_uuid::TEXT
       OR NEW.staging_evidence#>>'{reachableTargets,0,environmentUuid}' IS NOT DISTINCT FROM production_row.environment_uuid::TEXT
       OR NEW.staging_evidence->>'leaseRevoked' IS DISTINCT FROM 'true'
       OR NEW.staging_evidence->>'secretMaterialObserved' IS DISTINCT FROM 'false'
     ) THEN
    RAISE EXCEPTION 'staging qualification evidence escaped its exact isolated target'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.status IN ('production_testing', 'passed', 'rollback_blocked')
     AND NEW.external_gate_evidence IS NULL THEN
    RAISE EXCEPTION 'production qualification cannot begin before external gate evidence'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.external_gate_evidence IS NOT NULL
     AND (
       NEW.external_gate_evidence->>'provider' IS DISTINCT FROM 'github-protected-environment-fixture'
       OR NEW.external_gate_evidence->>'decision' IS DISTINCT FROM 'approved'
       OR NEW.external_gate_evidence->>'reviewed' IS DISTINCT FROM 'true'
       OR (NEW.external_gate_evidence->>'expiresAt')::TIMESTAMPTZ <= NOW()
     ) THEN
    RAISE EXCEPTION 'production qualification external gate is invalid or expired'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status IN ('passed', 'rollback_blocked') THEN
    SELECT COUNT(*), COUNT(*) FILTER (WHERE rollback_blocker IS NOT NULL)
      INTO scenario_count, blocker_count
      FROM rorca.authority_deployment_qualification_scenarios
     WHERE qualification_id = NEW.id;
    SELECT COUNT(*), COUNT(DISTINCT receipt_scenario->>'scenario')
      INTO receipt_scenario_match_count, receipt_scenario_name_count
      FROM jsonb_array_elements(NEW.qualification_receipt->'scenarios') receipt_scenario
      JOIN rorca.authority_deployment_qualification_scenarios stored_scenario
        ON stored_scenario.qualification_id = NEW.id
       AND stored_scenario.scenario = receipt_scenario->>'scenario'
       AND stored_scenario.evidence = receipt_scenario;

    IF production_row.status IS DISTINCT FROM 'disabled'
       OR scenario_count IS DISTINCT FROM 14
       OR receipt_scenario_match_count IS DISTINCT FROM 14
       OR receipt_scenario_name_count IS DISTINCT FROM 14
       OR NEW.qualification_receipt->>'qualificationRunId' IS DISTINCT FROM NEW.id::TEXT
       OR NEW.qualification_receipt->>'fixtureNamespace' IS DISTINCT FROM NEW.fixture_namespace
       OR NEW.qualification_receipt->>'fixtureDigest' IS DISTINCT FROM NEW.fixture_digest
       OR NEW.qualification_receipt->>'workspaceId' IS DISTINCT FROM NEW.workspace_id
       OR NEW.qualification_receipt->>'providerId' IS DISTINCT FROM NEW.provider_id
       OR NEW.qualification_receipt->'staging' IS DISTINCT FROM NEW.staging_evidence
       OR NEW.qualification_receipt->'externalGate' IS DISTINCT FROM NEW.external_gate_evidence
       OR NEW.qualification_receipt->>'productionQualificationUnlocked' IS DISTINCT FROM 'true'
       OR NEW.qualification_receipt->>'productionCapabilityDisabled' IS DISTINCT FROM 'true'
       OR NEW.qualification_receipt->>'productionRolloutEnabled' IS DISTINCT FROM 'false'
       OR jsonb_array_length(NEW.qualification_receipt->'scenarios') IS DISTINCT FROM 14
       OR (NEW.status = 'passed') IS DISTINCT FROM (blocker_count = 0)
       OR NEW.qualification_receipt->>'status' IS DISTINCT FROM NEW.status
       OR (NEW.qualification_receipt->>'productionQualificationPassed')::BOOLEAN
          IS DISTINCT FROM (blocker_count = 0) THEN
      RAISE EXCEPTION 'qualification cannot settle without complete disabled-target evidence'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS authority_deployment_qualification_immutable
  ON rorca.authority_deployment_qualifications;
CREATE TRIGGER authority_deployment_qualification_immutable
BEFORE UPDATE ON rorca.authority_deployment_qualifications
FOR EACH ROW EXECUTE FUNCTION rorca.protect_authority_deployment_qualification();

REVOKE ALL PRIVILEGES ON TABLE rorca.authority_deployment_qualifications FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE rorca.authority_deployment_qualification_scenarios FROM PUBLIC;

DO $$
DECLARE
  runtime_user TEXT := current_setting('rorca.runtime_database_user', TRUE);
  writer_user TEXT := current_setting('rorca.canonical_writer_database_user', TRUE);
BEGIN
  IF runtime_user IS NOT NULL AND runtime_user <> ''
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_user) THEN
    EXECUTE format(
      'GRANT SELECT ON rorca.authority_deployment_qualifications, rorca.authority_deployment_qualification_scenarios TO %I',
      runtime_user
    );
  END IF;
  IF writer_user IS NOT NULL AND writer_user <> ''
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = writer_user) THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE ON rorca.authority_deployment_qualifications TO %I',
      writer_user
    );
    EXECUTE format(
      'GRANT SELECT, INSERT ON rorca.authority_deployment_qualification_scenarios TO %I',
      writer_user
    );
  END IF;
END;
$$;
