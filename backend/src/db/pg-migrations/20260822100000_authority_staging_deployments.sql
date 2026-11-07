-- Provider-neutral immutable deployment operations and execution receipts.
-- Provider credentials remain in SecretStore and are never copied into these records.

CREATE TABLE IF NOT EXISTS rorca.authority_deployment_operations (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE CASCADE,
  binding_id UUID NOT NULL REFERENCES rorca.deployment_provider_bindings(id) ON DELETE RESTRICT,
  binding_generation BIGINT NOT NULL CHECK (binding_generation > 0),
  capability TEXT NOT NULL CHECK (capability IN ('deploy.staging', 'deploy.production')),
  source_revision TEXT CHECK (source_revision IS NULL OR source_revision ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  image_digest TEXT CHECK (image_digest IS NULL OR image_digest ~ '^sha256:[0-9a-f]{64}$'),
  configuration_binding_generation BIGINT NOT NULL CHECK (configuration_binding_generation > 0),
  health_signals JSONB NOT NULL CHECK (jsonb_typeof(health_signals) = 'array'),
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  requested_lease_seconds INTEGER CHECK (requested_lease_seconds IS NULL OR requested_lease_seconds BETWEEN 30 AND 3600),
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN (
    'requested', 'waiting_for_authorization', 'leased', 'dispatched',
    'outcome_unknown', 'settled'
  )),
  lease_id UUID UNIQUE REFERENCES rorca.deployment_capability_leases(id) ON DELETE RESTRICT,
  provider_deployment_id TEXT,
  provider_accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (source_revision IS NOT NULL OR image_digest IS NOT NULL),
  CHECK ((provider_deployment_id IS NULL) = (provider_accepted_at IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_authority_deployment_provider_lineage
  ON rorca.authority_deployment_operations (binding_id, provider_deployment_id)
  WHERE provider_deployment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_authority_deployment_reconciliation
  ON rorca.authority_deployment_operations (workspace_id, status, updated_at)
  WHERE status IN ('dispatched', 'outcome_unknown');

CREATE TABLE IF NOT EXISTS rorca.authority_execution_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id UUID NOT NULL UNIQUE REFERENCES rorca.authority_deployment_operations(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE CASCADE,
  receipt_payload JSONB NOT NULL CHECK (jsonb_typeof(receipt_payload) = 'object'),
  settled_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION rorca.guard_authority_deployment_operation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  binding_row rorca.deployment_provider_bindings%ROWTYPE;
BEGIN
  SELECT * INTO binding_row
    FROM rorca.deployment_provider_bindings
   WHERE id = NEW.binding_id;
  IF NOT FOUND OR binding_row.workspace_id <> NEW.workspace_id THEN
    RAISE EXCEPTION 'deployment operation binding is not in the requested workspace' USING ERRCODE = '42501';
  END IF;
  IF binding_row.binding_generation <> NEW.binding_generation THEN
    RAISE EXCEPTION 'deployment operation binding generation is stale' USING ERRCODE = '55000';
  END IF;
  IF (binding_row.environment_kind = 'staging' AND NEW.capability <> 'deploy.staging')
     OR (binding_row.environment_kind = 'production' AND NEW.capability <> 'deploy.production') THEN
    RAISE EXCEPTION 'deployment operation crosses the bound environment' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS authority_deployment_operation_guard ON rorca.authority_deployment_operations;
CREATE TRIGGER authority_deployment_operation_guard
BEFORE INSERT ON rorca.authority_deployment_operations
FOR EACH ROW EXECUTE FUNCTION rorca.guard_authority_deployment_operation();

CREATE OR REPLACE FUNCTION rorca.protect_authority_deployment_request()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
     OR OLD.binding_id IS DISTINCT FROM NEW.binding_id
     OR OLD.binding_generation IS DISTINCT FROM NEW.binding_generation
     OR OLD.capability IS DISTINCT FROM NEW.capability
     OR OLD.source_revision IS DISTINCT FROM NEW.source_revision
     OR OLD.image_digest IS DISTINCT FROM NEW.image_digest
     OR OLD.configuration_binding_generation IS DISTINCT FROM NEW.configuration_binding_generation
     OR OLD.health_signals IS DISTINCT FROM NEW.health_signals
     OR OLD.requested_lease_seconds IS DISTINCT FROM NEW.requested_lease_seconds
     OR OLD.request_digest IS DISTINCT FROM NEW.request_digest
     OR OLD.lease_id IS NOT NULL AND OLD.lease_id IS DISTINCT FROM NEW.lease_id
     OR (OLD.provider_deployment_id IS NOT NULL AND OLD.provider_deployment_id IS DISTINCT FROM NEW.provider_deployment_id)
     OR (OLD.provider_accepted_at IS NOT NULL AND OLD.provider_accepted_at IS DISTINCT FROM NEW.provider_accepted_at) THEN
    RAISE EXCEPTION 'deployment operation request and accepted lineage are immutable' USING ERRCODE = '55000';
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS authority_deployment_request_immutable ON rorca.authority_deployment_operations;
CREATE TRIGGER authority_deployment_request_immutable
BEFORE UPDATE ON rorca.authority_deployment_operations
FOR EACH ROW EXECUTE FUNCTION rorca.protect_authority_deployment_request();

CREATE OR REPLACE FUNCTION rorca.guard_authority_execution_receipt()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  operation_row rorca.authority_deployment_operations%ROWTYPE;
  binding_row rorca.deployment_provider_bindings%ROWTYPE;
  lease_row rorca.deployment_capability_leases%ROWTYPE;
BEGIN
  SELECT * INTO operation_row
    FROM rorca.authority_deployment_operations
   WHERE id = NEW.operation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'authority execution receipt operation is not resolvable' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO lease_row
    FROM rorca.deployment_capability_leases
   WHERE id = operation_row.lease_id
     AND operation_id = operation_row.id;
  SELECT * INTO binding_row
    FROM rorca.deployment_provider_bindings
   WHERE id = operation_row.binding_id;
  IF operation_row.workspace_id IS DISTINCT FROM NEW.workspace_id
     OR lease_row.id IS NULL
     OR lease_row.status IS DISTINCT FROM 'revoked'
     OR lease_row.provider_deployment_id IS DISTINCT FROM operation_row.provider_deployment_id
     OR lease_row.binding_id IS DISTINCT FROM operation_row.binding_id
     OR lease_row.binding_generation IS DISTINCT FROM operation_row.binding_generation
     OR lease_row.capability IS DISTINCT FROM operation_row.capability
     OR (NEW.receipt_payload->>'receiptId')::UUID IS DISTINCT FROM NEW.id
     OR NEW.receipt_payload->>'operationId' IS DISTINCT FROM NEW.operation_id::TEXT
     OR NEW.receipt_payload->>'workspaceId' IS DISTINCT FROM NEW.workspace_id
     OR NEW.receipt_payload->>'capability' IS DISTINCT FROM operation_row.capability
     OR NEW.receipt_payload->>'providerDeploymentId' IS DISTINCT FROM operation_row.provider_deployment_id
     OR NEW.receipt_payload#>>'{target,providerId}' IS DISTINCT FROM binding_row.provider_id
     OR NEW.receipt_payload#>>'{target,bindingId}' IS DISTINCT FROM operation_row.binding_id::TEXT
     OR NEW.receipt_payload#>>'{target,projectUuid}' IS DISTINCT FROM binding_row.project_uuid::TEXT
     OR NEW.receipt_payload#>>'{target,applicationUuid}' IS DISTINCT FROM binding_row.application_uuid::TEXT
     OR NEW.receipt_payload#>>'{target,environmentUuid}' IS DISTINCT FROM binding_row.environment_uuid::TEXT
     OR NEW.receipt_payload#>>'{revision,sourceRevision}' IS DISTINCT FROM operation_row.source_revision
     OR NEW.receipt_payload#>>'{revision,imageDigest}' IS DISTINCT FROM operation_row.image_digest
     OR (NEW.receipt_payload->>'configurationBindingGeneration')::BIGINT
          IS DISTINCT FROM operation_row.configuration_binding_generation
     OR (NEW.receipt_payload->>'bindingGeneration')::BIGINT
          IS DISTINCT FROM operation_row.binding_generation
     OR NEW.receipt_payload#>>'{lease,leaseId}' IS DISTINCT FROM operation_row.lease_id::TEXT
     OR NEW.receipt_payload#>>'{lease,revoked}' IS DISTINCT FROM 'true'
     OR (NEW.receipt_payload->>'settledAt')::TIMESTAMPTZ IS DISTINCT FROM NEW.settled_at
     OR NEW.receipt_payload#>>'{health,outcome}' IS NULL
     OR NEW.receipt_payload#>>'{health,outcome}' NOT IN ('healthy', 'unhealthy')
     OR NEW.receipt_payload::TEXT ~* '"[^"]*(control.?token|secret|credential|password|private.?key|access.?token|api.?key)[^"]*"[[:space:]]*:' THEN
    RAISE EXCEPTION 'authority execution receipt does not match its redacted immutable operation' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS authority_execution_receipt_guard ON rorca.authority_execution_receipts;
CREATE TRIGGER authority_execution_receipt_guard
BEFORE INSERT ON rorca.authority_execution_receipts
FOR EACH ROW EXECUTE FUNCTION rorca.guard_authority_execution_receipt();

CREATE OR REPLACE FUNCTION rorca.protect_authority_execution_receipt()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'authority execution receipts are immutable' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS authority_execution_receipt_immutable ON rorca.authority_execution_receipts;
CREATE TRIGGER authority_execution_receipt_immutable
BEFORE UPDATE OR DELETE ON rorca.authority_execution_receipts
FOR EACH ROW EXECUTE FUNCTION rorca.protect_authority_execution_receipt();

REVOKE ALL PRIVILEGES ON TABLE rorca.authority_deployment_operations FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE rorca.authority_execution_receipts FROM PUBLIC;

DO $$
DECLARE
  runtime_user TEXT := current_setting('rorca.runtime_database_user', TRUE);
  writer_user TEXT := current_setting('rorca.canonical_writer_database_user', TRUE);
BEGIN
  IF runtime_user IS NOT NULL AND runtime_user <> '' AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_user) THEN
    EXECUTE format('GRANT SELECT ON rorca.authority_deployment_operations, rorca.authority_execution_receipts TO %I', runtime_user);
  END IF;
  IF writer_user IS NOT NULL AND writer_user <> '' AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = writer_user) THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON rorca.authority_deployment_operations TO %I', writer_user);
    EXECUTE format('GRANT SELECT, INSERT ON rorca.authority_execution_receipts TO %I', writer_user);
  END IF;
END;
$$;
