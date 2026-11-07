-- Reconcile the provider vault's workspace schema and split-principal grants.
-- The runtime service may read provider configuration, while every mutation is
-- performed only by the registered canonical-writer principal.

ALTER TABLE rorca.api_key_vault
  ADD COLUMN IF NOT EXISTS workspace_id TEXT;

DO $$
DECLARE
  vault_workspace_attnum SMALLINT;
  workspace_id_attnum SMALLINT;
BEGIN
  SELECT attnum INTO STRICT vault_workspace_attnum
    FROM pg_attribute
   WHERE attrelid = 'rorca.api_key_vault'::regclass
     AND attname = 'workspace_id'
     AND NOT attisdropped;
  SELECT attnum INTO STRICT workspace_id_attnum
    FROM pg_attribute
   WHERE attrelid = 'rorca.workspaces'::regclass
     AND attname = 'id'
     AND NOT attisdropped;

  IF EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'rorca.api_key_vault'::regclass
       AND conname = 'api_key_vault_workspace_id_fkey'
       AND (
         contype IS DISTINCT FROM 'f'
         OR confrelid IS DISTINCT FROM 'rorca.workspaces'::regclass
         OR conkey IS DISTINCT FROM ARRAY[vault_workspace_attnum]::SMALLINT[]
         OR confkey IS DISTINCT FROM ARRAY[workspace_id_attnum]::SMALLINT[]
         OR confdeltype IS DISTINCT FROM 'c'
       )
  ) THEN
    ALTER TABLE rorca.api_key_vault
      DROP CONSTRAINT api_key_vault_workspace_id_fkey;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'rorca.api_key_vault'::regclass
       AND conname = 'api_key_vault_workspace_id_fkey'
  ) THEN
    ALTER TABLE rorca.api_key_vault
      ADD CONSTRAINT api_key_vault_workspace_id_fkey
      FOREIGN KEY (workspace_id) REFERENCES rorca.workspaces(id) ON DELETE CASCADE;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_api_key_vault_user_workspace_created
  ON rorca.api_key_vault (user_id, workspace_id, created_at DESC);

ALTER TABLE rorca.api_key_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.provider_defaults ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wave2_internal_runtime_legacy ON rorca.api_key_vault;
DROP POLICY IF EXISTS provider_vault_runtime_read ON rorca.api_key_vault;
DROP POLICY IF EXISTS provider_vault_writer_mutation ON rorca.api_key_vault;
DROP POLICY IF EXISTS provider_defaults_runtime_read ON rorca.provider_defaults;
DROP POLICY IF EXISTS provider_defaults_writer_mutation ON rorca.provider_defaults;

REVOKE ALL PRIVILEGES ON TABLE rorca.api_key_vault FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE rorca.provider_defaults FROM PUBLIC;

DO $$
DECLARE
  runtime_user TEXT := current_setting('rorca.runtime_database_user', TRUE);
  writer_user TEXT := current_setting('rorca.canonical_writer_database_user', TRUE);
  request_role TEXT;
BEGIN
  IF runtime_user IS NULL OR runtime_user = ''
     OR NOT EXISTS (
       SELECT 1
         FROM rorca.wave2_database_principals
        WHERE database_user = runtime_user
          AND principal_class = 'internal_runtime'
     ) THEN
    RAISE EXCEPTION 'registered provider-vault runtime principal is required' USING ERRCODE = '42501';
  END IF;

  IF writer_user IS NULL OR writer_user = '' OR writer_user = runtime_user
     OR NOT EXISTS (
       SELECT 1
         FROM rorca.wave2_database_principals
        WHERE database_user = writer_user
          AND principal_class = 'canonical_writer'
     ) THEN
    RAISE EXCEPTION 'registered distinct provider-vault canonical writer is required' USING ERRCODE = '42501';
  END IF;

  EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE rorca.api_key_vault FROM %I', runtime_user);
  EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE rorca.provider_defaults FROM %I', runtime_user);
  EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE rorca.api_key_vault FROM %I', writer_user);
  EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE rorca.provider_defaults FROM %I', writer_user);

  FOR request_role IN
    SELECT rolname FROM pg_roles WHERE rolname IN ('authenticated', 'anon')
  LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE rorca.api_key_vault FROM %I', request_role);
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE rorca.provider_defaults FROM %I', request_role);
  END LOOP;

  -- Retain the existing owner-scoped direct read contract for authenticated
  -- request roles, but remove their historical vault mutation privileges.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'GRANT SELECT ON TABLE rorca.api_key_vault TO authenticated';
  END IF;

  EXECUTE format('GRANT SELECT ON TABLE rorca.api_key_vault, rorca.provider_defaults TO %I', runtime_user);

  -- Column grants intentionally match the canonical routes. In particular,
  -- runtime cannot update last_used_at and writer cannot update secret fields.
  EXECUTE format('GRANT SELECT, DELETE ON TABLE rorca.api_key_vault TO %I', writer_user);
  EXECUTE format(
    'GRANT INSERT (id, user_id, workspace_id, provider, encrypted_key, label, base_url) ON TABLE rorca.api_key_vault TO %I',
    writer_user
  );
  EXECUTE format('GRANT UPDATE (last_used_at) ON TABLE rorca.api_key_vault TO %I', writer_user);

  EXECUTE format('GRANT SELECT ON TABLE rorca.provider_defaults TO %I', writer_user);
  EXECUTE format(
    'GRANT INSERT (id, user_id, workspace_id, provider) ON TABLE rorca.provider_defaults TO %I',
    writer_user
  );
  EXECUTE format('GRANT UPDATE (provider, updated_at) ON TABLE rorca.provider_defaults TO %I', writer_user);

  EXECUTE format(
    'CREATE POLICY provider_vault_runtime_read ON rorca.api_key_vault FOR SELECT TO %I USING (current_user = %L)',
    runtime_user,
    runtime_user
  );
  EXECUTE format(
    'CREATE POLICY provider_vault_writer_mutation ON rorca.api_key_vault FOR ALL TO %I USING (current_user = %L) WITH CHECK (current_user = %L)',
    writer_user,
    writer_user,
    writer_user
  );
  EXECUTE format(
    'CREATE POLICY provider_defaults_runtime_read ON rorca.provider_defaults FOR SELECT TO %I USING (current_user = %L)',
    runtime_user,
    runtime_user
  );
  EXECUTE format(
    'CREATE POLICY provider_defaults_writer_mutation ON rorca.provider_defaults FOR ALL TO %I USING (current_user = %L) WITH CHECK (current_user = %L)',
    writer_user,
    writer_user,
    writer_user
  );
END;
$$;
