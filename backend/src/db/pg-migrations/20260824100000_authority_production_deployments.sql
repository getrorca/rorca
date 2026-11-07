-- Provider-neutral production authorization, reviewed external-gate evidence, and replay fencing.
-- Production credentials remain in SecretStore and are not members of these records.

ALTER TABLE rorca.authority_deployment_operations
  DROP CONSTRAINT IF EXISTS authority_deployment_operations_status_check;
ALTER TABLE rorca.authority_deployment_operations
  ADD CONSTRAINT authority_deployment_operations_status_check CHECK (status IN (
    'requested', 'waiting_for_authorization', 'waiting_for_change_window',
    'authorized', 'leased', 'dispatched', 'outcome_unknown', 'settled'
  ));

CREATE TABLE IF NOT EXISTS rorca.authority_external_gate_configurations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  binding_id UUID NOT NULL REFERENCES rorca.deployment_provider_bindings(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$'),
  gate_id TEXT NOT NULL CHECK (gate_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$'),
  environment TEXT NOT NULL CHECK (environment ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$'),
  configuration_digest TEXT NOT NULL CHECK (configuration_digest ~ '^sha256:[0-9a-f]{64}$'),
  review_receipt_digest TEXT NOT NULL CHECK (review_receipt_digest ~ '^sha256:[0-9a-f]{64}$'),
  reviewed_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reviewed', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_authority_external_gate_configuration_reviewed
  ON rorca.authority_external_gate_configurations (workspace_id, binding_id)
  WHERE status = 'reviewed';

CREATE OR REPLACE FUNCTION rorca.guard_authority_external_gate_configuration()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  binding_row rorca.deployment_provider_bindings%ROWTYPE;
BEGIN
  SELECT * INTO binding_row
    FROM rorca.deployment_provider_bindings
   WHERE id = NEW.binding_id;
  IF NOT FOUND
     OR binding_row.workspace_id IS DISTINCT FROM NEW.workspace_id
     OR binding_row.environment_kind IS DISTINCT FROM 'production'
     OR NOT (binding_row.capability_policy->'allowedActions' ? 'deploy.production')
     OR COALESCE(binding_row.capability_policy->>'productionApprovalMode', 'independent_external')
          IS DISTINCT FROM 'independent_external' THEN
    RAISE EXCEPTION 'external gate configuration is not bound to an independent-approval production target'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS authority_external_gate_configuration_guard
  ON rorca.authority_external_gate_configurations;
CREATE TRIGGER authority_external_gate_configuration_guard
BEFORE INSERT ON rorca.authority_external_gate_configurations
FOR EACH ROW EXECUTE FUNCTION rorca.guard_authority_external_gate_configuration();

CREATE TABLE IF NOT EXISTS rorca.authority_external_gate_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  configuration_id UUID NOT NULL REFERENCES rorca.authority_external_gate_configurations(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$'),
  provider_evidence_id TEXT NOT NULL CHECK (provider_evidence_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$'),
  gate_id TEXT NOT NULL CHECK (gate_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$'),
  environment TEXT NOT NULL CHECK (environment ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$'),
  configuration_digest TEXT NOT NULL CHECK (configuration_digest ~ '^sha256:[0-9a-f]{64}$'),
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'denied')),
  operation_intent_id UUID NOT NULL REFERENCES rorca.authority_operation_intents(id) ON DELETE RESTRICT,
  intent_digest TEXT NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  ci_evidence_digest TEXT NOT NULL CHECK (ci_evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  rollout_cohort JSONB NOT NULL CHECK (jsonb_typeof(rollout_cohort) = 'object'),
  provider_approval_id TEXT NOT NULL CHECK (provider_approval_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$'),
  evidence_digest TEXT NOT NULL CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  reviewer_subjects JSONB NOT NULL CHECK (
    jsonb_typeof(reviewer_subjects) = 'array' AND jsonb_array_length(reviewer_subjects) > 0
  ),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (configuration_id, provider_evidence_id),
  CHECK (expires_at > issued_at)
);

CREATE OR REPLACE FUNCTION rorca.guard_authority_external_gate_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  configuration_row rorca.authority_external_gate_configurations%ROWTYPE;
  intent_row rorca.authority_operation_intents%ROWTYPE;
BEGIN
  SELECT * INTO configuration_row
    FROM rorca.authority_external_gate_configurations
   WHERE id = NEW.configuration_id;
  SELECT * INTO intent_row
    FROM rorca.authority_operation_intents
   WHERE id = NEW.operation_intent_id;
  IF configuration_row.id IS NULL
     OR configuration_row.status IS DISTINCT FROM 'reviewed'
     OR configuration_row.workspace_id IS DISTINCT FROM NEW.workspace_id
     OR configuration_row.provider IS DISTINCT FROM NEW.provider
     OR configuration_row.gate_id IS DISTINCT FROM NEW.gate_id
     OR configuration_row.environment IS DISTINCT FROM NEW.environment
     OR configuration_row.configuration_digest IS DISTINCT FROM NEW.configuration_digest
     OR intent_row.id IS NULL
     OR intent_row.workspace_id IS DISTINCT FROM NEW.workspace_id
     OR intent_row.intent_digest IS DISTINCT FROM NEW.intent_digest
     OR intent_row.ci_evidence_digest IS DISTINCT FROM NEW.ci_evidence_digest
     OR intent_row.intent_payload->'rolloutCohort' IS DISTINCT FROM NEW.rollout_cohort
     OR intent_row.intent_payload#>>'{providerApprovalReference,provider}' IS DISTINCT FROM NEW.provider
     OR intent_row.intent_payload#>>'{providerApprovalReference,approvalId}' IS DISTINCT FROM NEW.provider_approval_id
     OR intent_row.intent_payload#>>'{providerApprovalReference,environment}' IS DISTINCT FROM NEW.environment
     OR intent_row.intent_payload#>>'{providerApprovalReference,evidenceDigest}' IS DISTINCT FROM NEW.evidence_digest
     OR NEW.verified_at < NEW.issued_at
     OR NEW.verified_at > NOW() THEN
    RAISE EXCEPTION 'external gate evidence does not bind reviewed configuration and exact release material'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS authority_external_gate_evidence_guard
  ON rorca.authority_external_gate_evidence;
CREATE TRIGGER authority_external_gate_evidence_guard
BEFORE INSERT ON rorca.authority_external_gate_evidence
FOR EACH ROW EXECUTE FUNCTION rorca.guard_authority_external_gate_evidence();

CREATE TABLE IF NOT EXISTS rorca.authority_production_authorizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id UUID NOT NULL UNIQUE REFERENCES rorca.authority_deployment_operations(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  binding_id UUID NOT NULL REFERENCES rorca.deployment_provider_bindings(id) ON DELETE RESTRICT,
  binding_generation BIGINT NOT NULL CHECK (binding_generation > 0),
  operation_intent_id UUID NOT NULL REFERENCES rorca.authority_operation_intents(id) ON DELETE RESTRICT,
  requested_intent_digest TEXT NOT NULL CHECK (requested_intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  requested_ci_evidence_digest TEXT NOT NULL CHECK (requested_ci_evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  requested_rollout_cohort JSONB NOT NULL CHECK (jsonb_typeof(requested_rollout_cohort) = 'object'),
  requested_grant_id UUID NOT NULL,
  approval_kind TEXT NOT NULL CHECK (approval_kind IN ('local_operator', 'external_gate')),
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK (status IN (
    'requested', 'waiting_for_authorization', 'waiting_for_change_window',
    'authorized', 'dispatch_claimed', 'dispatched'
  )),
  wait_reason TEXT,
  authorization_grant_id UUID REFERENCES rorca.authority_operation_intent_grants(id) ON DELETE RESTRICT,
  external_gate_configuration_id UUID REFERENCES rorca.authority_external_gate_configurations(id) ON DELETE RESTRICT,
  external_gate_evidence_id UUID REFERENCES rorca.authority_external_gate_evidence(id) ON DELETE RESTRICT,
  approval_mode TEXT CHECK (approval_mode IN ('local_operator', 'independent_external')),
  authorized_at TIMESTAMPTZ,
  claimed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (status IN ('requested', 'waiting_for_authorization', 'waiting_for_change_window')
      AND authorization_grant_id IS NULL AND approval_mode IS NULL AND authorized_at IS NULL)
    OR
    (status IN ('authorized', 'dispatch_claimed', 'dispatched')
      AND authorization_grant_id IS NOT NULL AND approval_mode IS NOT NULL AND authorized_at IS NOT NULL)
  ),
  CHECK (
    (approval_mode IS NULL)
    OR (approval_mode = 'local_operator'
      AND external_gate_configuration_id IS NULL AND external_gate_evidence_id IS NULL)
    OR (approval_mode = 'independent_external'
      AND external_gate_configuration_id IS NOT NULL AND external_gate_evidence_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_authority_production_grant_consumption
  ON rorca.authority_production_authorizations (authorization_grant_id)
  WHERE authorization_grant_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_authority_production_gate_evidence_consumption
  ON rorca.authority_production_authorizations (external_gate_evidence_id)
  WHERE external_gate_evidence_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_authority_production_waiting
  ON rorca.authority_production_authorizations (workspace_id, status, updated_at)
  WHERE status IN ('waiting_for_authorization', 'waiting_for_change_window');

CREATE OR REPLACE FUNCTION rorca.guard_authority_production_authorization()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  operation_row rorca.authority_deployment_operations%ROWTYPE;
  binding_row rorca.deployment_provider_bindings%ROWTYPE;
  intent_row rorca.authority_operation_intents%ROWTYPE;
  grant_row rorca.authority_operation_intent_grants%ROWTYPE;
  configuration_row rorca.authority_external_gate_configurations%ROWTYPE;
  evidence_row rorca.authority_external_gate_evidence%ROWTYPE;
BEGIN
  SELECT * INTO operation_row FROM rorca.authority_deployment_operations WHERE id = NEW.operation_id;
  SELECT * INTO binding_row FROM rorca.deployment_provider_bindings WHERE id = NEW.binding_id;
  SELECT * INTO intent_row FROM rorca.authority_operation_intents WHERE id = NEW.operation_intent_id;

  IF operation_row.id IS NULL
     OR operation_row.workspace_id IS DISTINCT FROM NEW.workspace_id
     OR operation_row.binding_id IS DISTINCT FROM NEW.binding_id
     OR operation_row.binding_generation IS DISTINCT FROM NEW.binding_generation
     OR operation_row.capability IS DISTINCT FROM 'deploy.production'
     OR binding_row.id IS NULL
     OR binding_row.workspace_id IS DISTINCT FROM NEW.workspace_id
     OR binding_row.environment_kind IS DISTINCT FROM 'production'
     OR intent_row.id IS NULL
     OR intent_row.workspace_id IS DISTINCT FROM NEW.workspace_id THEN
    RAISE EXCEPTION 'production authorization request crosses immutable authority material'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.status IN ('authorized', 'dispatch_claimed', 'dispatched') THEN
    IF intent_row.intent_digest IS DISTINCT FROM NEW.requested_intent_digest
       OR intent_row.ci_evidence_digest IS DISTINCT FROM NEW.requested_ci_evidence_digest
       OR intent_row.intent_payload->'rolloutCohort' IS DISTINCT FROM NEW.requested_rollout_cohort THEN
      RAISE EXCEPTION 'production authorization differs from exact release, CI, or cohort material'
        USING ERRCODE = '42501';
    END IF;
    SELECT * INTO grant_row
      FROM rorca.authority_operation_intent_grants
     WHERE id = NEW.authorization_grant_id;
    IF grant_row.id IS NULL
       OR grant_row.id IS DISTINCT FROM NEW.requested_grant_id
       OR grant_row.operation_intent_id IS DISTINCT FROM NEW.operation_intent_id
       OR grant_row.workspace_id IS DISTINCT FROM NEW.workspace_id
       OR grant_row.intent_digest IS DISTINCT FROM NEW.requested_intent_digest
       OR grant_row.ci_evidence_digest IS DISTINCT FROM NEW.requested_ci_evidence_digest
       OR grant_row.expires_at <= NEW.authorized_at THEN
      RAISE EXCEPTION 'production grant is expired or differs from exact release authority'
        USING ERRCODE = '42501';
    END IF;

    IF NEW.authorized_at < (intent_row.intent_payload#>>'{changeWindow,startsAt}')::TIMESTAMPTZ
       OR NEW.authorized_at >= (intent_row.intent_payload#>>'{changeWindow,endsAt}')::TIMESTAMPTZ THEN
      RAISE EXCEPTION 'production authorization is outside its exact change window'
        USING ERRCODE = '42501';
    END IF;

    IF NEW.approval_mode = 'independent_external' THEN
      SELECT * INTO configuration_row
        FROM rorca.authority_external_gate_configurations
       WHERE id = NEW.external_gate_configuration_id;
      SELECT * INTO evidence_row
        FROM rorca.authority_external_gate_evidence
       WHERE id = NEW.external_gate_evidence_id;
      IF NEW.approval_kind IS DISTINCT FROM 'external_gate'
         OR configuration_row.id IS NULL
         OR configuration_row.status IS DISTINCT FROM 'reviewed'
         OR configuration_row.binding_id IS DISTINCT FROM NEW.binding_id
         OR evidence_row.id IS NULL
         OR evidence_row.configuration_id IS DISTINCT FROM configuration_row.id
         OR evidence_row.decision IS DISTINCT FROM 'approved'
         OR evidence_row.operation_intent_id IS DISTINCT FROM NEW.operation_intent_id
         OR evidence_row.intent_digest IS DISTINCT FROM NEW.requested_intent_digest
         OR evidence_row.ci_evidence_digest IS DISTINCT FROM NEW.requested_ci_evidence_digest
         OR evidence_row.rollout_cohort IS DISTINCT FROM NEW.requested_rollout_cohort
         OR evidence_row.expires_at <= NEW.authorized_at THEN
        RAISE EXCEPTION 'independent production approval lacks exact reviewed external-gate evidence'
          USING ERRCODE = '42501';
      END IF;
    ELSIF NEW.approval_mode = 'local_operator' THEN
      IF NEW.approval_kind IS DISTINCT FROM 'local_operator'
         OR COALESCE(binding_row.capability_policy->>'productionApprovalMode', 'independent_external')
              IS DISTINCT FROM 'local_operator' THEN
        RAISE EXCEPTION 'local production approval is not enabled by binding policy'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS authority_production_authorization_guard
  ON rorca.authority_production_authorizations;
CREATE TRIGGER authority_production_authorization_guard
BEFORE INSERT OR UPDATE ON rorca.authority_production_authorizations
FOR EACH ROW EXECUTE FUNCTION rorca.guard_authority_production_authorization();

CREATE OR REPLACE FUNCTION rorca.protect_authority_production_authorization()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.operation_id IS DISTINCT FROM NEW.operation_id
     OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
     OR OLD.binding_id IS DISTINCT FROM NEW.binding_id
     OR OLD.binding_generation IS DISTINCT FROM NEW.binding_generation
     OR OLD.operation_intent_id IS DISTINCT FROM NEW.operation_intent_id
     OR OLD.requested_intent_digest IS DISTINCT FROM NEW.requested_intent_digest
     OR OLD.requested_ci_evidence_digest IS DISTINCT FROM NEW.requested_ci_evidence_digest
     OR OLD.requested_rollout_cohort IS DISTINCT FROM NEW.requested_rollout_cohort
     OR OLD.requested_grant_id IS DISTINCT FROM NEW.requested_grant_id
     OR OLD.approval_kind IS DISTINCT FROM NEW.approval_kind
     OR OLD.request_digest IS DISTINCT FROM NEW.request_digest
     OR (OLD.authorization_grant_id IS NOT NULL
       AND OLD.authorization_grant_id IS DISTINCT FROM NEW.authorization_grant_id)
     OR (OLD.external_gate_configuration_id IS NOT NULL
       AND OLD.external_gate_configuration_id IS DISTINCT FROM NEW.external_gate_configuration_id)
     OR (OLD.external_gate_evidence_id IS NOT NULL
       AND OLD.external_gate_evidence_id IS DISTINCT FROM NEW.external_gate_evidence_id)
     OR (OLD.approval_mode IS NOT NULL AND OLD.approval_mode IS DISTINCT FROM NEW.approval_mode)
     OR (OLD.authorized_at IS NOT NULL AND OLD.authorized_at IS DISTINCT FROM NEW.authorized_at)
     OR (OLD.claimed_at IS NOT NULL AND OLD.claimed_at IS DISTINCT FROM NEW.claimed_at) THEN
    RAISE EXCEPTION 'production authorization material and consumption are immutable'
      USING ERRCODE = '55000';
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS authority_production_authorization_immutable
  ON rorca.authority_production_authorizations;
CREATE TRIGGER authority_production_authorization_immutable
BEFORE UPDATE ON rorca.authority_production_authorizations
FOR EACH ROW EXECUTE FUNCTION rorca.protect_authority_production_authorization();

CREATE OR REPLACE FUNCTION rorca.protect_authority_external_gate_record()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'reviewed external gate records are immutable' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS authority_external_gate_configuration_immutable
  ON rorca.authority_external_gate_configurations;
CREATE TRIGGER authority_external_gate_configuration_immutable
BEFORE UPDATE OR DELETE ON rorca.authority_external_gate_configurations
FOR EACH ROW EXECUTE FUNCTION rorca.protect_authority_external_gate_record();

DROP TRIGGER IF EXISTS authority_external_gate_evidence_immutable
  ON rorca.authority_external_gate_evidence;
CREATE TRIGGER authority_external_gate_evidence_immutable
BEFORE UPDATE OR DELETE ON rorca.authority_external_gate_evidence
FOR EACH ROW EXECUTE FUNCTION rorca.protect_authority_external_gate_record();

REVOKE ALL PRIVILEGES ON TABLE rorca.authority_external_gate_configurations FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE rorca.authority_external_gate_evidence FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE rorca.authority_production_authorizations FROM PUBLIC;

DO $$
DECLARE
  runtime_user TEXT := current_setting('rorca.runtime_database_user', TRUE);
  writer_user TEXT := current_setting('rorca.canonical_writer_database_user', TRUE);
BEGIN
  IF runtime_user IS NOT NULL AND runtime_user <> '' AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_user) THEN
    EXECUTE format(
      'GRANT SELECT ON rorca.authority_external_gate_configurations, rorca.authority_external_gate_evidence, rorca.authority_production_authorizations TO %I',
      runtime_user
    );
  END IF;
  IF writer_user IS NOT NULL AND writer_user <> '' AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = writer_user) THEN
    EXECUTE format(
      'GRANT SELECT, INSERT ON rorca.authority_external_gate_configurations, rorca.authority_external_gate_evidence TO %I',
      writer_user
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE ON rorca.authority_production_authorizations TO %I',
      writer_user
    );
  END IF;
END;
$$;
