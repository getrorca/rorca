-- Restore only the non-owner application dependencies removed by the Wave 2
-- split-principal cutover. Provider authority remains read-only, and digest is
-- exposed only as the pure byte hash needed by invoker-rights integrity guards.

SELECT set_config('rorca.migration_mode','on',TRUE);

REVOKE ALL PRIVILEGES ON TABLE rorca.github_workspace_repository_authority FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION rorca.digest(BYTEA,TEXT) FROM PUBLIC;

DO $$
DECLARE
  runtime_user TEXT := current_setting('rorca.runtime_database_user',TRUE);
  writer_user TEXT := current_setting('rorca.canonical_writer_database_user',TRUE);
  principal_name TEXT;
  table_name TEXT;
BEGIN
  IF runtime_user IS NULL OR runtime_user=''
     OR NOT EXISTS(
       SELECT 1 FROM rorca.wave2_database_principals
        WHERE database_user=runtime_user AND principal_class='internal_runtime'
     ) THEN
    RAISE EXCEPTION 'registered Wave 2 runtime principal is required' USING ERRCODE='42501';
  END IF;

  EXECUTE format('GRANT SELECT ON TABLE rorca.github_workspace_repository_authority TO %I',runtime_user);
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.digest(BYTEA,TEXT) TO %I',runtime_user);

  -- Inherited request roles and the canonical writer are not application
  -- service identities. Keep both dependencies unavailable after SET ROLE.
  FOR principal_name IN
    SELECT rolname FROM pg_roles
     WHERE rolname IN ('authenticated','anon',writer_user)
       AND rolname<>runtime_user
  LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE rorca.github_workspace_repository_authority FROM %I',principal_name);
    EXECUTE format('REVOKE ALL PRIVILEGES ON FUNCTION rorca.digest(BYTEA,TEXT) FROM %I',principal_name);
  END LOOP;

  -- The original compatibility policy queried the protected principal ledger
  -- as its invoker. SET ROLE authenticated/anon therefore raised 42501 while
  -- evaluating otherwise unrelated legacy RLS policies. Bind the immutable
  -- registered runtime identity directly; never grant the ledger to request
  -- roles and never let an inherited role retain runtime-wide access.
  FOREACH table_name IN ARRAY ARRAY[
    'workspaces','direction_layers','wal_events','team_invites','api_key_vault'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS wave2_internal_runtime_legacy ON rorca.%I',table_name);
    EXECUTE format(
      'CREATE POLICY wave2_internal_runtime_legacy ON rorca.%I USING (current_user=%L) WITH CHECK (current_user=%L)',
      table_name,runtime_user,runtime_user
    );
  END LOOP;
END;
$$;

UPDATE rorca.wave2_schema_readiness
SET migration_version=20260731155000,installed_at=clock_timestamp()
WHERE singleton=TRUE AND state='ready' AND migration_version=20260731154000
  AND contract_source_digest='sha256:1111a20f8b6e8cfca7ddcf8861069989bdd7b7c4b52c5b12e26cb2ff8ad6bbfb';

DO $$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM rorca.wave2_schema_readiness
     WHERE singleton=TRUE AND state='ready' AND migration_version=20260731155000
       AND contract_source_digest='sha256:1111a20f8b6e8cfca7ddcf8861069989bdd7b7c4b52c5b12e26cb2ff8ad6bbfb'
  ) THEN
    RAISE EXCEPTION 'Wave 2 runtime dependency privilege transition failed closed' USING ERRCODE='55000';
  END IF;
END;
$$;
