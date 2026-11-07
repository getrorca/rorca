-- Bind hydration status helpers to the invocation's exact runtime workspace.
-- Fixture setup remains migration-owner authority; request roles and the
-- canonical writer receive no direct access to hydration state.

SELECT set_config('rorca.migration_mode','on',TRUE);

ALTER TABLE rorca.workspace_hydration ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.workspace_hydration FORCE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE rorca.workspace_hydration FROM PUBLIC;
REVOKE ALL PRIVILEGES ON SEQUENCE rorca.workspace_hydration_id_seq FROM PUBLIC;

DROP POLICY IF EXISTS workspace_hydration_runtime_scope ON rorca.workspace_hydration;
CREATE POLICY workspace_hydration_runtime_scope ON rorca.workspace_hydration
FOR ALL
USING (
  workspace_id=current_setting('rorca.workspace_id',TRUE)
  AND EXISTS (
    SELECT 1 FROM rorca.wave2_database_principals principal
     WHERE principal.database_user=current_user
       AND principal.principal_class='internal_runtime'
  )
)
WITH CHECK (
  workspace_id=current_setting('rorca.workspace_id',TRUE)
  AND EXISTS (
    SELECT 1 FROM rorca.wave2_database_principals principal
     WHERE principal.database_user=current_user
       AND principal.principal_class='internal_runtime'
  )
);

DROP POLICY IF EXISTS workspace_hydration_migration_fixture ON rorca.workspace_hydration;
CREATE POLICY workspace_hydration_migration_fixture ON rorca.workspace_hydration
FOR ALL
USING (
  current_setting('rorca.migration_mode',TRUE)='on'
  AND EXISTS (
    SELECT 1 FROM rorca.wave2_database_principals principal
     WHERE principal.database_user=current_user
       AND principal.principal_class='migration_owner'
  )
)
WITH CHECK (
  current_setting('rorca.migration_mode',TRUE)='on'
  AND EXISTS (
    SELECT 1 FROM rorca.wave2_database_principals principal
     WHERE principal.database_user=current_user
       AND principal.principal_class='migration_owner'
  )
);

DO $$
DECLARE
  runtime_user TEXT := current_setting('rorca.runtime_database_user',TRUE);
  writer_user TEXT := current_setting('rorca.canonical_writer_database_user',TRUE);
  principal_name TEXT;
BEGIN
  IF runtime_user IS NULL OR runtime_user=''
     OR NOT EXISTS (
       SELECT 1 FROM rorca.wave2_database_principals
        WHERE database_user=runtime_user AND principal_class='internal_runtime'
     ) THEN
    RAISE EXCEPTION 'registered Wave 2 runtime principal is required' USING ERRCODE='42501';
  END IF;

  EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE rorca.workspace_hydration FROM %I',runtime_user);
  EXECUTE format('REVOKE ALL PRIVILEGES ON SEQUENCE rorca.workspace_hydration_id_seq FROM %I',runtime_user);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE rorca.workspace_hydration TO %I',runtime_user);
  EXECUTE format('GRANT USAGE ON SEQUENCE rorca.workspace_hydration_id_seq TO %I',runtime_user);

  FOR principal_name IN
    SELECT rolname FROM pg_roles
     WHERE rolname IN ('authenticated','anon',writer_user)
       AND rolname<>runtime_user
  LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE rorca.workspace_hydration FROM %I',principal_name);
    EXECUTE format('REVOKE ALL PRIVILEGES ON SEQUENCE rorca.workspace_hydration_id_seq FROM %I',principal_name);
  END LOOP;
END;
$$;

-- These compatibility roles are part of the Release-1 authority topology.
-- Keep the denial explicit after the runtime grant so inherited request
-- identities never retain legacy default sequence or table privileges.
REVOKE ALL PRIVILEGES ON TABLE rorca.workspace_hydration FROM authenticated, anon;
REVOKE ALL PRIVILEGES ON SEQUENCE rorca.workspace_hydration_id_seq FROM authenticated, anon;

UPDATE rorca.wave2_schema_readiness
SET migration_version=20260731157000,installed_at=clock_timestamp()
WHERE singleton=TRUE AND state='ready' AND migration_version=20260731156000
  AND contract_source_digest='sha256:1111a20f8b6e8cfca7ddcf8861069989bdd7b7c4b52c5b12e26cb2ff8ad6bbfb';

DO $$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM rorca.wave2_schema_readiness
     WHERE singleton=TRUE AND state='ready' AND migration_version=20260731157000
       AND contract_source_digest='sha256:1111a20f8b6e8cfca7ddcf8861069989bdd7b7c4b52c5b12e26cb2ff8ad6bbfb'
  ) THEN
    RAISE EXCEPTION 'Workspace hydration runtime policy transition failed closed' USING ERRCODE='55000';
  END IF;
END;
$$;
