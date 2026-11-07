-- One-time application-object ownership transfer for a pre-split Compose volume.
-- Run offline as the existing database superuser after bootstrap-roles.sh has
-- created the constrained migration role. Supply psql variables exactly:
--   -v previous_owner=rorca -v migration_user=rorca_migrator
-- Extension ownership is intentionally left with the offline bootstrap owner.
\set ON_ERROR_STOP on

SELECT (:'previous_owner'<>'' AND :'migration_user'<>'' AND :'previous_owner'<>:'migration_user')::int AS inputs_safe \gset
\if :inputs_safe
\else
  \echo 'previous_owner and migration_user must be distinct non-empty roles'
  \quit 3
\endif

SELECT (EXISTS(SELECT 1 FROM pg_roles WHERE rolname=:'previous_owner')
  AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname=:'migration_user' AND rolcanlogin
    AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls))::int AS roles_safe \gset
\if :roles_safe
\else
  \echo 'existing owner or constrained migration role validation failed'
  \quit 3
\endif

BEGIN;
SELECT format('ALTER DATABASE %I OWNER TO %I',current_database(),:'migration_user') \gexec
SELECT format('ALTER SCHEMA %I OWNER TO %I','rorca',:'migration_user')
WHERE EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='rorca') \gexec

-- Transfer only Rorca application relations. Do not transfer extension-owned
-- objects in public/ag_catalog; migrations use existing extensions but never
-- need their superuser ownership.
SELECT format('ALTER %s %I.%I OWNER TO %I',
  CASE relation.relkind WHEN 'r' THEN 'TABLE' WHEN 'p' THEN 'TABLE'
    WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
    WHEN 'f' THEN 'FOREIGN TABLE' END,
  namespace.nspname,relation.relname,:'migration_user')
FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
WHERE relation.relkind IN('r','p','S','v','m','f')
  AND (namespace.nspname='rorca' OR (namespace.nspname='public' AND relation.relname='schema_migrations'))
  AND pg_get_userbyid(relation.relowner)=:'previous_owner'
ORDER BY namespace.nspname,relation.relkind,relation.relname \gexec

SELECT format('ALTER FUNCTION %I.%I(%s) OWNER TO %I',namespace.nspname,procedure.proname,
  pg_get_function_identity_arguments(procedure.oid),:'migration_user')
FROM pg_proc procedure JOIN pg_namespace namespace ON namespace.oid=procedure.pronamespace
WHERE namespace.nspname='rorca' AND pg_get_userbyid(procedure.proowner)=:'previous_owner'
ORDER BY procedure.oid \gexec

-- User-defined enums, domains, ranges, and standalone composite types are
-- independently owned application objects. Table row types follow ALTER TABLE
-- and are excluded so an upgraded volume retains no legacy-owner type island.
SELECT format('ALTER TYPE %I.%I OWNER TO %I',namespace.nspname,object_type.typname,:'migration_user')
FROM pg_type object_type JOIN pg_namespace namespace ON namespace.oid=object_type.typnamespace
WHERE namespace.nspname='rorca'
  AND (object_type.typrelid=0 OR EXISTS(SELECT 1 FROM pg_class composite
    WHERE composite.oid=object_type.typrelid AND composite.relkind='c'))
  AND object_type.typtype IN('c','d','e','m','r')
  AND pg_get_userbyid(object_type.typowner)=:'previous_owner'
  AND NOT EXISTS(SELECT 1 FROM pg_depend dependency
    WHERE dependency.classid='pg_type'::regclass AND dependency.objid=object_type.oid
      AND dependency.deptype='e')
ORDER BY object_type.oid \gexec
COMMIT;
