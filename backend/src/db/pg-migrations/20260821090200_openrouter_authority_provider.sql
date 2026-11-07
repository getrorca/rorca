-- OSR-001: provider-neutral authority bindings and redacted provider-key records.
-- Management credentials remain in the existing integration SecretStore; no
-- provider-specific credential column or child secret table is introduced.

ALTER TABLE rorca.integration_vault_secrets
  DROP CONSTRAINT IF EXISTS integration_vault_secrets_provider_check;
ALTER TABLE rorca.integration_vault_secrets
  ADD CONSTRAINT integration_vault_secrets_provider_check
  CHECK (provider IN ('github_app', 'openrouter'));

ALTER TABLE rorca.integration_vault_secrets
  DROP CONSTRAINT IF EXISTS integration_vault_secrets_secret_kind_check;
ALTER TABLE rorca.integration_vault_secrets
  ADD CONSTRAINT integration_vault_secrets_secret_kind_check
  CHECK (
    (provider = 'github_app' AND secret_kind IN ('private_key', 'webhook_secret'))
    OR (provider = 'openrouter' AND secret_kind IN ('management_key', 'runtime_key'))
  );

ALTER TABLE rorca.integration_vault_secrets
  ADD CONSTRAINT integration_vault_secrets_identity_key
  UNIQUE (id, provider, secret_kind);

CREATE TABLE IF NOT EXISTS rorca.provider_authority_bindings (
  id UUID PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider = 'openrouter'),
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  provider_account_id TEXT NOT NULL CHECK (btrim(provider_account_id) <> '' AND length(provider_account_id) <= 255),
  generation BIGINT NOT NULL DEFAULT 1 CHECK (generation > 0),
  status TEXT NOT NULL DEFAULT 'disabled' CHECK (status IN ('active', 'disabled', 'invalid')),
  management_secret_id UUID NOT NULL,
  management_secret_kind TEXT NOT NULL DEFAULT 'management_key' CHECK (management_secret_kind = 'management_key'),
  management_secret_fingerprint TEXT NOT NULL CHECK (management_secret_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  policy_limits JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(policy_limits) = 'object'),
  approved_operations TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[] CHECK (
    approved_operations <@ ARRAY['list_keys', 'create_limited_key', 'disable_key', 'delete_key', 'verify_binding']::TEXT[]
  ),
  provider_account_verified BOOLEAN NOT NULL DEFAULT FALSE,
  completion_probe_rejected BOOLEAN NOT NULL DEFAULT FALSE,
  verified_at TIMESTAMPTZ,
  validation_error_code TEXT,
  created_by TEXT NOT NULL CHECK (btrim(created_by) <> '' AND length(created_by) <= 255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disabled_at TIMESTAMPTZ,
  CONSTRAINT provider_authority_binding_secret_fk
    FOREIGN KEY (management_secret_id, provider, management_secret_kind)
    REFERENCES rorca.integration_vault_secrets(id, provider, secret_kind) ON DELETE RESTRICT,
  CONSTRAINT provider_authority_binding_health_check CHECK (
    (status = 'active' AND provider_account_verified AND completion_probe_rejected
      AND verified_at IS NOT NULL AND validation_error_code IS NULL AND disabled_at IS NULL)
    OR (status = 'disabled' AND disabled_at IS NOT NULL)
    OR status = 'invalid'
  ),
  CONSTRAINT provider_authority_binding_workspace_key UNIQUE (workspace_id, provider),
  CONSTRAINT provider_authority_binding_identity_key UNIQUE (id, workspace_id, generation, provider_account_id)
);

CREATE INDEX IF NOT EXISTS idx_provider_authority_bindings_workspace_status
  ON rorca.provider_authority_bindings (workspace_id, status);

CREATE TABLE IF NOT EXISTS rorca.provider_key_resources (
  id UUID PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'openrouter' CHECK (provider = 'openrouter'),
  provider_binding_id UUID NOT NULL,
  workspace_id TEXT NOT NULL,
  binding_generation BIGINT NOT NULL CHECK (binding_generation > 0),
  provider_account_id TEXT NOT NULL,
  provider_resource_id TEXT NOT NULL CHECK (btrim(provider_resource_id) <> '' AND length(provider_resource_id) <= 255),
  key_fingerprint TEXT NOT NULL CHECK (key_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  runtime_secret_id UUID,
  runtime_secret_kind TEXT NOT NULL DEFAULT 'runtime_key' CHECK (runtime_secret_kind = 'runtime_key'),
  display_name TEXT NOT NULL CHECK (btrim(display_name) <> '' AND length(display_name) <= 255),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'deleted')),
  policy_limits JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(policy_limits) = 'object'),
  provider_created_at TIMESTAMPTZ,
  provider_updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT provider_key_resource_binding_fk
    FOREIGN KEY (provider_binding_id, workspace_id, binding_generation, provider_account_id)
    REFERENCES rorca.provider_authority_bindings(id, workspace_id, generation, provider_account_id) ON DELETE RESTRICT,
  CONSTRAINT provider_key_resource_secret_fk
    FOREIGN KEY (runtime_secret_id, provider, runtime_secret_kind)
    REFERENCES rorca.integration_vault_secrets(id, provider, secret_kind) ON DELETE RESTRICT,
  CONSTRAINT provider_key_resource_identity_key UNIQUE (provider_binding_id, provider_resource_id)
);

CREATE INDEX IF NOT EXISTS idx_provider_key_resources_binding_status
  ON rorca.provider_key_resources (provider_binding_id, status, created_at DESC);

REVOKE ALL PRIVILEGES ON TABLE rorca.provider_authority_bindings FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE rorca.provider_key_resources FROM PUBLIC;
