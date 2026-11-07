-- Provider-neutral authority bindings and bounded capability leases.
-- Coolify control tokens remain encrypted in api_key_vault; these tables hold only
-- immutable provider identity, policy/profile projections, and SecretStore ids.

CREATE TABLE IF NOT EXISTS rorca.deployment_provider_bindings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL CHECK (provider_id ~ '^[a-z][a-z0-9-]{1,79}$'),
  environment_kind TEXT NOT NULL CHECK (environment_kind IN ('staging', 'production')),
  base_url TEXT NOT NULL CHECK (base_url ~ '^https?://[^[:space:]]+$'),
  project_uuid UUID NOT NULL,
  application_uuid UUID NOT NULL,
  environment_uuid UUID NOT NULL,
  secret_store_id TEXT NOT NULL REFERENCES rorca.api_key_vault(id) ON DELETE RESTRICT,
  capability_policy JSONB NOT NULL CHECK (jsonb_typeof(capability_policy) = 'object'),
  verified_profile JSONB,
  binding_generation BIGINT NOT NULL DEFAULT 1 CHECK (binding_generation > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'invalid')),
  validation_error_code TEXT CHECK (validation_error_code IS NULL OR validation_error_code IN (
    'unreachable', 'stale', 'ambiguous', 'wrong_environment',
    'permission_deficient', 'not_resolvable'
  )),
  profile_verified_at TIMESTAMPTZ,
  profile_expires_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  disabled_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, provider_id, environment_kind),
  UNIQUE (provider_id, base_url, application_uuid),
  CHECK ((verified_profile IS NULL) = (profile_verified_at IS NULL)),
  CHECK ((verified_profile IS NULL) = (profile_expires_at IS NULL)),
  CHECK (profile_expires_at IS NULL OR profile_expires_at > profile_verified_at),
  CHECK (
    capability_policy ? 'allowedActions'
    AND jsonb_typeof(capability_policy->'allowedActions') = 'array'
    AND CASE environment_kind
      WHEN 'staging' THEN capability_policy->'allowedActions' = '["deploy.staging"]'::jsonb
      WHEN 'production' THEN capability_policy->'allowedActions' = '["deploy.production"]'::jsonb
    END
  ),
  CHECK (
    verified_profile IS NULL OR (
      jsonb_typeof(verified_profile) = 'object'
      AND (verified_profile #>> '{target,project,uuid}') IS NOT DISTINCT FROM project_uuid::TEXT
      AND (verified_profile #>> '{target,application,uuid}') IS NOT DISTINCT FROM application_uuid::TEXT
      AND (verified_profile #>> '{target,environment,uuid}') IS NOT DISTINCT FROM environment_uuid::TEXT
      AND (verified_profile->'allowedActions') IS NOT DISTINCT FROM (capability_policy->'allowedActions')
      AND (verified_profile->>'verifiedAt')::TIMESTAMPTZ IS NOT DISTINCT FROM profile_verified_at
      AND (verified_profile->>'expiresAt')::TIMESTAMPTZ IS NOT DISTINCT FROM profile_expires_at
    )
  ),
  CHECK (
    (status = 'active' AND verified_profile IS NOT NULL AND validation_error_code IS NULL)
    OR (status = 'invalid' AND verified_profile IS NULL AND validation_error_code IS NOT NULL)
    OR status = 'disabled'
  )
);

CREATE OR REPLACE FUNCTION rorca.guard_authority_binding_secret_reference()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  secret_workspace_id TEXT;
  secret_provider_id TEXT;
BEGIN
  SELECT workspace_id, provider
    INTO secret_workspace_id, secret_provider_id
    FROM rorca.api_key_vault
   WHERE id = NEW.secret_store_id;

  IF NOT FOUND
     OR secret_workspace_id IS DISTINCT FROM NEW.workspace_id
     OR secret_provider_id IS DISTINCT FROM NEW.provider_id THEN
    RAISE EXCEPTION 'provider binding secret reference is outside its workspace or provider'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS authority_binding_secret_reference_guard ON rorca.deployment_provider_bindings;
CREATE TRIGGER authority_binding_secret_reference_guard
BEFORE INSERT ON rorca.deployment_provider_bindings
FOR EACH ROW EXECUTE FUNCTION rorca.guard_authority_binding_secret_reference();

CREATE INDEX IF NOT EXISTS idx_authority_provider_bindings_workspace
  ON rorca.deployment_provider_bindings (workspace_id, provider_id, status);

CREATE TABLE IF NOT EXISTS rorca.deployment_capability_leases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  binding_id UUID NOT NULL REFERENCES rorca.deployment_provider_bindings(id) ON DELETE RESTRICT,
  binding_generation BIGINT NOT NULL CHECK (binding_generation > 0),
  capability TEXT NOT NULL CHECK (capability IN ('deploy.staging', 'deploy.production')),
  operation_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'leased' CHECK (status IN (
    'leased', 'dispatched', 'outcome_unknown', 'settled', 'revoked',
    'revocation_required', 'reconciliation_required'
  )),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (binding_id, operation_id),
  CHECK (expires_at > issued_at)
);

ALTER TABLE rorca.deployment_capability_leases ADD COLUMN IF NOT EXISTS provider_deployment_id TEXT;

CREATE INDEX IF NOT EXISTS idx_authority_capability_leases_binding_active
  ON rorca.deployment_capability_leases (binding_id, status, expires_at);

CREATE OR REPLACE FUNCTION rorca.guard_authority_capability_lease()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  binding_row rorca.deployment_provider_bindings%ROWTYPE;
BEGIN
  SELECT * INTO binding_row
    FROM rorca.deployment_provider_bindings
   WHERE id = NEW.binding_id
   FOR UPDATE;

  IF NOT FOUND OR binding_row.status <> 'active' THEN
    RAISE EXCEPTION 'provider binding is not active' USING ERRCODE = '55000';
  END IF;
  IF binding_row.binding_generation <> NEW.binding_generation THEN
    RAISE EXCEPTION 'provider binding generation is stale' USING ERRCODE = '55000';
  END IF;
  IF binding_row.profile_expires_at IS NULL OR binding_row.profile_expires_at <= NOW() THEN
    RAISE EXCEPTION 'provider binding profile is stale' USING ERRCODE = '55000';
  END IF;
  IF NEW.expires_at > binding_row.profile_expires_at THEN
    RAISE EXCEPTION 'capability lease exceeds verified profile lifetime' USING ERRCODE = '55000';
  END IF;
  IF NOT (binding_row.capability_policy->'allowedActions' ? NEW.capability) THEN
    RAISE EXCEPTION 'capability is not allowed by provider binding' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS authority_capability_lease_guard ON rorca.deployment_capability_leases;
CREATE TRIGGER authority_capability_lease_guard
BEFORE INSERT ON rorca.deployment_capability_leases
FOR EACH ROW EXECUTE FUNCTION rorca.guard_authority_capability_lease();

CREATE OR REPLACE FUNCTION rorca.reconcile_disabled_authority_binding()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'active' AND NEW.status <> 'active' THEN
    NEW.disabled_at := COALESCE(NEW.disabled_at, NOW());
    UPDATE rorca.deployment_capability_leases
       SET status = CASE status
         WHEN 'leased' THEN 'revoked'
         WHEN 'dispatched' THEN 'revocation_required'
         WHEN 'outcome_unknown' THEN 'reconciliation_required'
         ELSE status
       END,
       updated_at = NOW()
     WHERE binding_id = NEW.id
       AND status IN ('leased', 'dispatched', 'outcome_unknown');
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS authority_binding_disable_reconciliation ON rorca.deployment_provider_bindings;
CREATE TRIGGER authority_binding_disable_reconciliation
BEFORE UPDATE ON rorca.deployment_provider_bindings
FOR EACH ROW EXECUTE FUNCTION rorca.reconcile_disabled_authority_binding();

CREATE OR REPLACE FUNCTION rorca.protect_authority_binding_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
     OR OLD.provider_id IS DISTINCT FROM NEW.provider_id
     OR OLD.environment_kind IS DISTINCT FROM NEW.environment_kind
     OR OLD.base_url IS DISTINCT FROM NEW.base_url
     OR OLD.project_uuid IS DISTINCT FROM NEW.project_uuid
     OR OLD.application_uuid IS DISTINCT FROM NEW.application_uuid
     OR OLD.environment_uuid IS DISTINCT FROM NEW.environment_uuid
     OR OLD.secret_store_id IS DISTINCT FROM NEW.secret_store_id THEN
    RAISE EXCEPTION 'provider binding identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS authority_binding_identity_immutable ON rorca.deployment_provider_bindings;
CREATE TRIGGER authority_binding_identity_immutable
BEFORE UPDATE ON rorca.deployment_provider_bindings
FOR EACH ROW EXECUTE FUNCTION rorca.protect_authority_binding_identity();

REVOKE ALL PRIVILEGES ON TABLE rorca.deployment_provider_bindings FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE rorca.deployment_capability_leases FROM PUBLIC;

DO $$
DECLARE
  runtime_user TEXT := current_setting('rorca.runtime_database_user', TRUE);
  writer_user TEXT := current_setting('rorca.canonical_writer_database_user', TRUE);
BEGIN
  IF runtime_user IS NOT NULL AND runtime_user <> '' AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_user) THEN
    EXECUTE format('GRANT SELECT ON rorca.deployment_provider_bindings, rorca.deployment_capability_leases TO %I', runtime_user);
  END IF;
  IF writer_user IS NOT NULL AND writer_user <> '' AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = writer_user) THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON rorca.deployment_provider_bindings, rorca.deployment_capability_leases TO %I', writer_user);
  END IF;
END;
$$;
