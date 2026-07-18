-- 20260715230000_github_app_credentials.sql
-- Repository-scoped GitHub App credentials. Secrets remain encrypted in the
-- integration vault; installation tokens/JWTs are intentionally never stored.
-- pg-boss is application-managed and is not touched by this migration.

CREATE TABLE IF NOT EXISTS integration_vault_secrets (
  id UUID PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('github_app')),
  secret_kind TEXT NOT NULL CHECK (secret_kind IN ('private_key', 'webhook_secret')),
  encrypted_value TEXT NOT NULL,
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  created_by TEXT NOT NULL CHECK (btrim(created_by) <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rotated_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_integration_vault_secrets_active
  ON integration_vault_secrets (provider, secret_kind) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS github_app_registrations (
  id UUID PRIMARY KEY,
  app_id BIGINT NOT NULL UNIQUE CHECK (app_id > 0),
  app_slug TEXT NOT NULL CHECK (app_slug ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,99}$'),
  client_id TEXT CHECK (client_id IS NULL OR client_id ~ '^Iv1\.[A-Za-z0-9]+$'),
  private_key_secret_id UUID NOT NULL REFERENCES integration_vault_secrets(id) ON DELETE RESTRICT,
  webhook_secret_id UUID NOT NULL REFERENCES integration_vault_secrets(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by TEXT NOT NULL CHECK (btrim(created_by) <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disabled_at TIMESTAMPTZ,
  CONSTRAINT github_app_registration_status_check CHECK (
    (status = 'active' AND disabled_at IS NULL) OR (status = 'disabled' AND disabled_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_github_app_single_active_registration
  ON github_app_registrations ((true)) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS github_app_installations (
  id UUID PRIMARY KEY,
  registration_id UUID NOT NULL,
  installation_id BIGINT NOT NULL CHECK (installation_id > 0),
  account_id BIGINT NOT NULL CHECK (account_id > 0),
  account_login TEXT NOT NULL CHECK (account_login ~ '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$'),
  account_type TEXT NOT NULL CHECK (account_type IN ('Organization', 'User')),
  repository_selection TEXT NOT NULL CHECK (repository_selection = 'selected'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'removed')),
  created_by TEXT NOT NULL CHECK (btrim(created_by) <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_validated_at TIMESTAMPTZ,
  status_changed_at TIMESTAMPTZ,
  CONSTRAINT ga_install_registration_fk
    FOREIGN KEY (registration_id) REFERENCES github_app_registrations(id) ON DELETE RESTRICT,
  CONSTRAINT ga_install_installation_id_key UNIQUE (installation_id),
  CONSTRAINT ga_install_id_registration_key UNIQUE (id, registration_id)
);
CREATE INDEX IF NOT EXISTS idx_github_app_installations_registration
  ON github_app_installations (registration_id, status);

CREATE TABLE IF NOT EXISTS github_app_workspace_bindings (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  registration_id UUID NOT NULL REFERENCES github_app_registrations(id) ON DELETE RESTRICT,
  installation_record_id UUID NOT NULL,
  installation_id BIGINT NOT NULL CHECK (installation_id > 0),
  repository_id BIGINT NOT NULL CHECK (repository_id > 0),
  repo_owner TEXT NOT NULL CHECK (repo_owner ~ '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$'),
  repo_name TEXT NOT NULL CHECK (repo_name ~ '^[A-Za-z0-9._-]{1,100}$'),
  permissions JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(permissions) = 'object'),
  events JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(events) = 'array'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'invalid')),
  created_by TEXT NOT NULL CHECK (btrim(created_by) <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_validated_at TIMESTAMPTZ,
  last_webhook_at TIMESTAMPTZ,
  validation_error_code TEXT,
  status_changed_at TIMESTAMPTZ,
  CONSTRAINT ga_binding_installation_registration_fk
    FOREIGN KEY (installation_record_id, registration_id)
    REFERENCES github_app_installations(id, registration_id) ON DELETE RESTRICT,
  CONSTRAINT ga_binding_workspace_key UNIQUE (workspace_id),
  CONSTRAINT ga_binding_registration_repository_key UNIQUE (registration_id, repository_id),
  CONSTRAINT ga_binding_registration_install_repo_key UNIQUE (registration_id, installation_id, repository_id),
  CONSTRAINT github_app_binding_status_check CHECK (
    (status = 'active' AND validation_error_code IS NULL)
    OR status IN ('disabled', 'invalid')
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_github_app_binding_repo_name_ci
  ON github_app_workspace_bindings (registration_id, lower(repo_owner), lower(repo_name));
CREATE INDEX IF NOT EXISTS idx_github_app_binding_webhook_identity
  ON github_app_workspace_bindings (installation_id, repository_id, status);

CREATE TABLE IF NOT EXISTS github_app_setup_states (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  state_digest TEXT NOT NULL UNIQUE CHECK (state_digest ~ '^sha256:[0-9a-f]{64}$'),
  csrf_digest TEXT NOT NULL CHECK (csrf_digest ~ '^sha256:[0-9a-f]{64}$'),
  requested_by TEXT NOT NULL CHECK (btrim(requested_by) <> ''),
  callback_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CONSTRAINT github_app_setup_state_expiry_check CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS idx_github_app_setup_states_expiry
  ON github_app_setup_states (expires_at) WHERE consumed_at IS NULL;

CREATE OR REPLACE FUNCTION guard_github_app_binding_identity()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'GitHub App bindings are audit-retained; disable instead of deleting';
  END IF;
  IF (to_jsonb(OLD) - ARRAY['permissions','events','status','last_validated_at','last_webhook_at','validation_error_code','status_changed_at']::text[])
     IS DISTINCT FROM
     (to_jsonb(NEW) - ARRAY['permissions','events','status','last_validated_at','last_webhook_at','validation_error_code','status_changed_at']::text[]) THEN
    RAISE EXCEPTION 'GitHub App workspace/repository/installation binding identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_github_app_binding_identity ON github_app_workspace_bindings;
CREATE TRIGGER trg_github_app_binding_identity
  BEFORE UPDATE OR DELETE ON github_app_workspace_bindings
  FOR EACH ROW EXECUTE FUNCTION guard_github_app_binding_identity();
