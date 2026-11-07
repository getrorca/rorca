-- Generic database-provider authority storage. Provider credentials remain in a
-- SecretStore; these relations persist only immutable scope, verified authority
-- metadata, opaque references, fingerprints, and redacted operation evidence.
CREATE FUNCTION rorca.authority_metadata_is_reference_only_v1(p_value JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, rorca
AS $$
  SELECT p_value::text !~* 'postgres(?:ql)?://'
     AND p_value::text !~* '"(password|connection_?string|credential_?bytes|secret_?bytes|api_?key|service_?role_?key|token|private_?key)"[[:space:]]*:'
$$;


CREATE TABLE rorca.authority_provider_bindings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  provider_id TEXT NOT NULL CHECK (provider_id ~ '^[a-z][a-z0-9-]{1,63}$'),
  provider_subject_ref TEXT NOT NULL CHECK (
    btrim(provider_subject_ref) <> ''
    AND length(provider_subject_ref) <= 255
    AND provider_subject_ref !~ '[[:space:]]'
    AND provider_subject_ref !~ '://'
  ),
  environment TEXT NOT NULL CHECK (environment IN ('staging', 'production')),
  resource_identity JSONB NOT NULL CHECK (
    jsonb_typeof(resource_identity) = 'object'
    AND rorca.authority_metadata_is_reference_only_v1(resource_identity)
  ),
  resource_identity_hash TEXT NOT NULL CHECK (resource_identity_hash ~ '^sha256:[0-9a-f]{64}$'),
  binding_generation BIGINT NOT NULL CHECK (binding_generation > 0),
  binding_status TEXT NOT NULL CHECK (binding_status IN ('active', 'disabled', 'invalid')),
  role_profile JSONB NOT NULL CHECK (
    jsonb_typeof(role_profile) = 'object'
    AND jsonb_typeof(role_profile -> 'verified') = 'boolean'
    AND jsonb_typeof(role_profile -> 'capabilities') = 'array'
    AND role_profile ->> 'authenticationClass' = 'database-role'
    AND rorca.authority_metadata_is_reference_only_v1(role_profile)
  ),
  binding_hash TEXT NOT NULL CHECK (binding_hash ~ '^sha256:[0-9a-f]{64}$'),
  supersedes_binding_id UUID REFERENCES rorca.authority_provider_bindings(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  disabled_at TIMESTAMPTZ,
  CHECK ((binding_status = 'disabled') = (disabled_at IS NOT NULL)),
  UNIQUE (workspace_id, provider_id, provider_subject_ref, environment, binding_generation),
  UNIQUE (id, workspace_id),
  CHECK (supersedes_binding_id IS NULL OR supersedes_binding_id <> id)
);

CREATE UNIQUE INDEX authority_provider_bindings_one_active_scope_idx
  ON rorca.authority_provider_bindings (workspace_id, provider_id, provider_subject_ref, environment)
  WHERE binding_status = 'active';

CREATE TABLE rorca.authority_secret_references (
  binding_id UUID NOT NULL,
  workspace_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose ~ '^[a-z][a-z0-9.-]{1,63}$'),
  reference_id TEXT NOT NULL CHECK (
    btrim(reference_id) <> ''
    AND length(reference_id) <= 1024
    AND reference_id ~ '^[a-z][a-z0-9+.-]{1,31}://[^[:space:]]+$'
    AND reference_id !~* '^postgres(?:ql)?://'
  ),
  reference_fingerprint TEXT NOT NULL CHECK (reference_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  credential_class TEXT NOT NULL CHECK (credential_class IN (
    'database-role',
    'application-anon',
    'application-publishable',
    'application-secret',
    'application-service-role'
  )),
  CHECK (purpose <> 'database-connection' OR credential_class = 'database-role'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (binding_id, purpose),
  FOREIGN KEY (binding_id, workspace_id)
    REFERENCES rorca.authority_provider_bindings(id, workspace_id) ON DELETE RESTRICT
);

CREATE TABLE rorca.authority_operation_receipts (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  binding_id UUID NOT NULL,
  provider_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  binding_generation BIGINT NOT NULL CHECK (binding_generation > 0),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^sha256:[0-9a-f]{64}$'),
  target_identity_hash TEXT NOT NULL CHECK (target_identity_hash ~ '^sha256:[0-9a-f]{64}$'),
  result_hash TEXT NOT NULL CHECK (result_hash ~ '^sha256:[0-9a-f]{64}$'),
  secret_reference_id TEXT NOT NULL CHECK (
    btrim(secret_reference_id) <> ''
    AND secret_reference_id ~ '^[a-z][a-z0-9+.-]{1,31}://[^[:space:]]+$'
    AND secret_reference_id !~* '^postgres(?:ql)?://'
  ),
  secret_reference_fingerprint TEXT NOT NULL CHECK (secret_reference_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  redacted_evidence JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(redacted_evidence) = 'object'
    AND rorca.authority_metadata_is_reference_only_v1(redacted_evidence)
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (binding_id, workspace_id)
    REFERENCES rorca.authority_provider_bindings(id, workspace_id) ON DELETE RESTRICT
);

CREATE FUNCTION rorca.guard_authority_provider_binding_immutability_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, rorca
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Database authority bindings are append-only'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
     OR OLD.provider_id IS DISTINCT FROM NEW.provider_id
     OR OLD.provider_subject_ref IS DISTINCT FROM NEW.provider_subject_ref
     OR OLD.environment IS DISTINCT FROM NEW.environment
     OR OLD.resource_identity IS DISTINCT FROM NEW.resource_identity
     OR OLD.resource_identity_hash IS DISTINCT FROM NEW.resource_identity_hash
     OR OLD.binding_generation IS DISTINCT FROM NEW.binding_generation
     OR OLD.role_profile IS DISTINCT FROM NEW.role_profile
     OR OLD.binding_hash IS DISTINCT FROM NEW.binding_hash
     OR OLD.supersedes_binding_id IS DISTINCT FROM NEW.supersedes_binding_id
     OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'Database authority binding identity and verified profile are immutable'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.binding_status <> 'active'
     OR NEW.binding_status <> 'disabled'
     OR OLD.disabled_at IS NOT NULL
     OR NEW.disabled_at IS NULL
  THEN
    RAISE EXCEPTION 'Database authority binding permits only active-to-disabled transition'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER authority_provider_binding_immutability
BEFORE UPDATE OR DELETE ON rorca.authority_provider_bindings
FOR EACH ROW EXECUTE FUNCTION rorca.guard_authority_provider_binding_immutability_v1();

CREATE FUNCTION rorca.deny_authority_secret_reference_mutation_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, rorca
AS $$
BEGIN
  IF TG_TABLE_NAME = 'authority_operation_receipts' THEN
    RAISE EXCEPTION 'Authority operation receipts are immutable' USING ERRCODE = '42501';
  END IF;
  RAISE EXCEPTION 'Authority secret references are immutable; create a new binding generation'
    USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER authority_secret_reference_immutability
BEFORE UPDATE OR DELETE ON rorca.authority_secret_references
FOR EACH ROW EXECUTE FUNCTION rorca.deny_authority_secret_reference_mutation_v1();

CREATE TRIGGER authority_operation_receipt_immutability
BEFORE UPDATE OR DELETE ON rorca.authority_operation_receipts
FOR EACH ROW EXECUTE FUNCTION rorca.deny_authority_secret_reference_mutation_v1();

ALTER TABLE rorca.authority_provider_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.authority_secret_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.authority_operation_receipts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON FUNCTION rorca.authority_metadata_is_reference_only_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON TABLE rorca.authority_provider_bindings FROM PUBLIC;
REVOKE ALL ON TABLE rorca.authority_secret_references FROM PUBLIC;
REVOKE ALL ON TABLE rorca.authority_operation_receipts FROM PUBLIC;
REVOKE ALL ON FUNCTION rorca.guard_authority_provider_binding_immutability_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION rorca.deny_authority_secret_reference_mutation_v1() FROM PUBLIC;

DO $$
DECLARE
  runtime_user TEXT := current_setting('rorca.runtime_database_user', TRUE);
  writer_user TEXT := current_setting('rorca.canonical_writer_database_user', TRUE);
  request_role TEXT;
BEGIN
  IF runtime_user IS NULL OR runtime_user = ''
     OR NOT EXISTS (
       SELECT 1 FROM rorca.wave2_database_principals
       WHERE database_user = runtime_user AND principal_class = 'internal_runtime'
     )
  THEN
    RAISE EXCEPTION 'registered database-authority runtime principal is required' USING ERRCODE = '42501';
  END IF;
  IF writer_user IS NULL OR writer_user = '' OR writer_user = runtime_user
     OR NOT EXISTS (
       SELECT 1 FROM rorca.wave2_database_principals
       WHERE database_user = writer_user AND principal_class = 'canonical_writer'
     )
  THEN
    RAISE EXCEPTION 'registered distinct database-authority canonical writer is required' USING ERRCODE = '42501';
  END IF;
  FOR request_role IN
    SELECT rolname FROM pg_roles WHERE rolname IN ('authenticated', 'anon')
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE rorca.authority_provider_bindings FROM %I', request_role);
    EXECUTE format('REVOKE ALL ON TABLE rorca.authority_secret_references FROM %I', request_role);
    EXECUTE format('REVOKE ALL ON TABLE rorca.authority_operation_receipts FROM %I', request_role);
    EXECUTE format('REVOKE ALL ON FUNCTION rorca.authority_metadata_is_reference_only_v1(JSONB) FROM %I', request_role);
    EXECUTE format('REVOKE ALL ON FUNCTION rorca.guard_authority_provider_binding_immutability_v1() FROM %I', request_role);
    EXECUTE format('REVOKE ALL ON FUNCTION rorca.deny_authority_secret_reference_mutation_v1() FROM %I', request_role);
  END LOOP;


  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.authority_metadata_is_reference_only_v1(JSONB) TO %I', runtime_user);
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.authority_metadata_is_reference_only_v1(JSONB) TO %I', writer_user);
  EXECUTE format('GRANT SELECT ON rorca.authority_provider_bindings, rorca.authority_secret_references TO %I', runtime_user);
  EXECUTE format('GRANT SELECT, INSERT ON rorca.authority_operation_receipts TO %I', runtime_user);
  EXECUTE format('GRANT SELECT, INSERT ON rorca.authority_provider_bindings TO %I', writer_user);
  EXECUTE format('GRANT UPDATE (binding_status, disabled_at) ON rorca.authority_provider_bindings TO %I', writer_user);
  EXECUTE format('GRANT SELECT, INSERT ON rorca.authority_secret_references TO %I', writer_user);
  EXECUTE format('GRANT SELECT ON rorca.authority_operation_receipts TO %I', writer_user);

  EXECUTE format(
    'CREATE POLICY authority_provider_bindings_runtime_read ON rorca.authority_provider_bindings FOR SELECT TO %I USING (current_user = %L)',
    runtime_user, runtime_user
  );
  EXECUTE format(
    'CREATE POLICY authority_secret_references_runtime_read ON rorca.authority_secret_references FOR SELECT TO %I USING (current_user = %L)',
    runtime_user, runtime_user
  );
  EXECUTE format(
    'CREATE POLICY authority_operation_receipts_runtime_write ON rorca.authority_operation_receipts FOR ALL TO %I USING (current_user = %L) WITH CHECK (current_user = %L)',
    runtime_user, runtime_user, runtime_user
  );
  EXECUTE format(
    'CREATE POLICY authority_provider_bindings_writer_mutation ON rorca.authority_provider_bindings FOR ALL TO %I USING (current_user = %L) WITH CHECK (current_user = %L)',
    writer_user, writer_user, writer_user
  );
  EXECUTE format(
    'CREATE POLICY authority_secret_references_writer_insert ON rorca.authority_secret_references FOR ALL TO %I USING (current_user = %L) WITH CHECK (current_user = %L)',
    writer_user, writer_user, writer_user
  );
  EXECUTE format(
    'CREATE POLICY authority_operation_receipts_writer_read ON rorca.authority_operation_receipts FOR SELECT TO %I USING (current_user = %L)',
    writer_user, writer_user
  );
END;
$$;
