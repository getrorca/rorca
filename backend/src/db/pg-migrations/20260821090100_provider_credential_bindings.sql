-- SCR-001: Provider-neutral credential inventory. Credential material lives
-- only in an external SecretStore; this relation stores references and
-- non-reversible fingerprints so inventory and authority checks never require
-- secret access.

CREATE TABLE rorca.provider_credential_bindings (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider ~ '^[a-z][a-z0-9-]{0,63}$'),
  provider_account_id TEXT NOT NULL CHECK (btrim(provider_account_id) <> '' AND length(provider_account_id) <= 255),
  mode TEXT NOT NULL CHECK (mode IN ('test', 'live')),
  application_id TEXT NOT NULL CHECK (btrim(application_id) <> '' AND length(application_id) <= 255),
  resource_type TEXT NOT NULL CHECK (resource_type ~ '^[a-z][a-z0-9._-]{0,63}$'),
  resource_id TEXT NOT NULL CHECK (btrim(resource_id) <> '' AND length(resource_id) <= 255),
  credential_class TEXT NOT NULL CHECK (credential_class IN (
    'restricted_api_key', 'unrestricted_api_key', 'webhook_signing_secret'
  )),
  key_kind TEXT NOT NULL CHECK (key_kind IN ('restricted', 'unrestricted', 'signing_secret')),
  permission_manifest JSONB NOT NULL CHECK (jsonb_typeof(permission_manifest) = 'array'),
  owner TEXT NOT NULL CHECK (btrim(owner) <> '' AND length(owner) <= 255),
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  secret_store_reference TEXT NOT NULL CHECK (
    btrim(secret_store_reference) <> '' AND length(secret_store_reference) <= 2048
  ),
  target_binding_reference TEXT NOT NULL CHECK (
    btrim(target_binding_reference) <> '' AND length(target_binding_reference) <= 2048
  ),
  status TEXT NOT NULL CHECK (status IN ('active', 'staged', 'quarantined', 'revoked', 'invalid')),
  binding_generation BIGINT NOT NULL CHECK (binding_generation > 0),
  last_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT provider_credential_binding_kind_consistency CHECK (
    (credential_class = 'restricted_api_key' AND key_kind = 'restricted')
    OR (credential_class = 'unrestricted_api_key' AND key_kind = 'unrestricted')
    OR (credential_class = 'webhook_signing_secret' AND key_kind = 'signing_secret')
  ),
  CONSTRAINT provider_credential_binding_generation_key UNIQUE (
    workspace_id, provider, provider_account_id, mode, application_id,
    resource_type, resource_id, credential_class, binding_generation
  ),
  -- A SecretStore object, target slot, or credential fingerprint may never be
  -- rebound into another mode or workspace. This is deliberately stricter than
  -- including mode in these keys: cross-mode reuse must fail at persistence.
  CONSTRAINT provider_credential_binding_secret_reference_key UNIQUE (provider, secret_store_reference),
  CONSTRAINT provider_credential_binding_target_reference_key UNIQUE (provider, target_binding_reference),
  CONSTRAINT provider_credential_binding_fingerprint_key UNIQUE (provider, fingerprint)
);

CREATE UNIQUE INDEX provider_credential_binding_active_identity_key
  ON rorca.provider_credential_bindings (
    workspace_id, provider, provider_account_id, mode, application_id,
    resource_type, resource_id, credential_class
  )
  WHERE status = 'active';

CREATE INDEX provider_credential_bindings_inventory_idx
  ON rorca.provider_credential_bindings (
    workspace_id, provider, mode, application_id, resource_type, resource_id,
    binding_generation DESC
  );

CREATE OR REPLACE FUNCTION rorca.guard_provider_credential_binding()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'provider credential bindings are audit-retained; change status instead';
  END IF;

  IF (to_jsonb(NEW) - ARRAY['status', 'last_verified_at', 'status_changed_at']::TEXT[])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status', 'last_verified_at', 'status_changed_at']::TEXT[]) THEN
    RAISE EXCEPTION 'provider credential binding identity and generation are immutable';
  END IF;

  NEW.status_changed_at := CASE
    WHEN NEW.status IS DISTINCT FROM OLD.status THEN clock_timestamp()
    ELSE OLD.status_changed_at
  END;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION rorca.reject_provider_credential_value()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF to_jsonb(NEW)::TEXT ~ '(^|[^[:alnum:]])((sk|rk)_(test|live)_[[:alnum:]]{8,}|whsec_[[:alnum:]]{8,})' THEN
    RAISE EXCEPTION 'credential-shaped values are forbidden in provider credential bindings';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER provider_credential_binding_immutable
  BEFORE UPDATE OR DELETE ON rorca.provider_credential_bindings
  FOR EACH ROW EXECUTE FUNCTION rorca.guard_provider_credential_binding();

CREATE TRIGGER provider_credential_binding_no_values
  BEFORE INSERT OR UPDATE ON rorca.provider_credential_bindings
  FOR EACH ROW EXECUTE FUNCTION rorca.reject_provider_credential_value();

ALTER TABLE rorca.provider_credential_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.provider_credential_bindings FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE rorca.provider_credential_bindings FROM PUBLIC;
REVOKE ALL ON FUNCTION rorca.guard_provider_credential_binding() FROM PUBLIC;
REVOKE ALL ON FUNCTION rorca.reject_provider_credential_value() FROM PUBLIC;

DO $$
DECLARE
  runtime_user TEXT := current_setting('rorca.runtime_database_user', TRUE);
  writer_user TEXT := current_setting('rorca.canonical_writer_database_user', TRUE);
BEGIN
  IF runtime_user IS NULL OR runtime_user = ''
     OR NOT EXISTS (
       SELECT 1 FROM rorca.wave2_database_principals
       WHERE database_user = runtime_user AND principal_class = 'internal_runtime'
     ) THEN
    RAISE EXCEPTION 'registered provider-binding runtime principal is required' USING ERRCODE = '42501';
  END IF;
  IF writer_user IS NULL OR writer_user = '' OR writer_user = runtime_user
     OR NOT EXISTS (
       SELECT 1 FROM rorca.wave2_database_principals
       WHERE database_user = writer_user AND principal_class = 'canonical_writer'
     ) THEN
    RAISE EXCEPTION 'registered distinct provider-binding canonical writer is required' USING ERRCODE = '42501';
  END IF;

  EXECUTE format('GRANT SELECT ON TABLE rorca.provider_credential_bindings TO %I', runtime_user);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE rorca.provider_credential_bindings TO %I', writer_user);
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.guard_provider_credential_binding() TO %I', writer_user);
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.reject_provider_credential_value() TO %I', writer_user);

  EXECUTE format(
    'CREATE POLICY provider_credential_binding_runtime_read ON rorca.provider_credential_bindings FOR SELECT TO %I USING (current_user = %L)',
    runtime_user,
    runtime_user
  );
  EXECUTE format(
    'CREATE POLICY provider_credential_binding_writer_mutation ON rorca.provider_credential_bindings FOR ALL TO %I USING (current_user = %L) WITH CHECK (current_user = %L)',
    writer_user,
    writer_user,
    writer_user
  );
END;
$$;
