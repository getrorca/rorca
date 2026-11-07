#!/bin/sh
# Provision the production split-principal topology before API/worker startup.
# Runs as the offline PostgreSQL bootstrap administrator; that credential is
# never passed to either application process.
set -eu

: "${POSTGRES_HOST:?POSTGRES_HOST is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
POSTGRES_PORT=${POSTGRES_PORT:-5432}
case "$POSTGRES_PORT" in *[!0-9]*|'') echo "POSTGRES_PORT must be numeric" >&2; exit 64;; esac
: "${POSTGRES_BOOTSTRAP_USER:?POSTGRES_BOOTSTRAP_USER is required}"
: "${POSTGRES_BOOTSTRAP_PASSWORD:?POSTGRES_BOOTSTRAP_PASSWORD is required}"
: "${RORCA_MIGRATION_DATABASE_USER:?RORCA_MIGRATION_DATABASE_USER is required}"
: "${RORCA_MIGRATION_DATABASE_PASSWORD:?RORCA_MIGRATION_DATABASE_PASSWORD is required}"
: "${RORCA_RUNTIME_DATABASE_USER:?RORCA_RUNTIME_DATABASE_USER is required}"
: "${RORCA_RUNTIME_DATABASE_PASSWORD:?RORCA_RUNTIME_DATABASE_PASSWORD is required}"
: "${RORCA_CANONICAL_WRITER_DATABASE_USER:?RORCA_CANONICAL_WRITER_DATABASE_USER is required}"
: "${RORCA_CANONICAL_WRITER_DATABASE_PASSWORD:?RORCA_CANONICAL_WRITER_DATABASE_PASSWORD is required}"

for name in "$POSTGRES_BOOTSTRAP_USER" "$RORCA_MIGRATION_DATABASE_USER" "$RORCA_RUNTIME_DATABASE_USER" "$RORCA_CANONICAL_WRITER_DATABASE_USER"; do
  case "$name" in
    *[!A-Za-z0-9_]*|'') echo "database role names must be non-empty ASCII identifiers" >&2; exit 64 ;;
  esac
  case "$name" in authenticated|anon) echo "application principals must not collide with compatibility request roles" >&2; exit 64 ;; esac
done
if [ "$POSTGRES_BOOTSTRAP_USER" = "$RORCA_MIGRATION_DATABASE_USER" ] \
  || [ "$POSTGRES_BOOTSTRAP_USER" = "$RORCA_RUNTIME_DATABASE_USER" ] \
  || [ "$POSTGRES_BOOTSTRAP_USER" = "$RORCA_CANONICAL_WRITER_DATABASE_USER" ] \
  || [ "$RORCA_MIGRATION_DATABASE_USER" = "$RORCA_RUNTIME_DATABASE_USER" ] \
  || [ "$RORCA_MIGRATION_DATABASE_USER" = "$RORCA_CANONICAL_WRITER_DATABASE_USER" ] \
  || [ "$RORCA_RUNTIME_DATABASE_USER" = "$RORCA_CANONICAL_WRITER_DATABASE_USER" ]; then
  echo "bootstrap, migration, runtime, and canonical-writer roles must all be distinct" >&2
  exit 64
fi

export PGPASSWORD="$POSTGRES_BOOTSTRAP_PASSWORD"
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --host "$POSTGRES_HOST" --port "$POSTGRES_PORT" --username "$POSTGRES_BOOTSTRAP_USER" --dbname "$POSTGRES_DB" \
  --set migration_user="$RORCA_MIGRATION_DATABASE_USER" --set migration_password="$RORCA_MIGRATION_DATABASE_PASSWORD" \
  --set runtime_user="$RORCA_RUNTIME_DATABASE_USER" --set runtime_password="$RORCA_RUNTIME_DATABASE_PASSWORD" \
  --set writer_user="$RORCA_CANONICAL_WRITER_DATABASE_USER" --set writer_password="$RORCA_CANONICAL_WRITER_DATABASE_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
              :'migration_user', :'migration_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=:'migration_user') \gexec
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
              :'runtime_user', :'runtime_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=:'runtime_user') \gexec
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
              :'writer_user', :'writer_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=:'writer_user') \gexec
SELECT 'CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') \gexec
SELECT 'CREATE ROLE anon NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') \gexec
ALTER ROLE authenticated NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE anon NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

-- Reassert constraints and rotate only the three application credentials.
SELECT format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
              :'migration_user', :'migration_password') \gexec
SELECT format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
              :'runtime_user', :'runtime_password') \gexec
SELECT format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
              :'writer_user', :'writer_password') \gexec

-- Membership would collapse the split authority boundary or make a request
-- compatibility role inherit application authority. Revoke every cross-membership.
SELECT format('REVOKE %I FROM %I', granted.rolname, member.rolname)
FROM pg_auth_members memberships
JOIN pg_roles granted ON granted.oid=memberships.roleid
JOIN pg_roles member ON member.oid=memberships.member
WHERE granted.rolname IN (:'migration_user',:'runtime_user',:'writer_user','authenticated','anon')
  AND member.rolname IN (:'migration_user',:'runtime_user',:'writer_user','authenticated','anon') \gexec

-- The canonical migrations require pgvector, and the migration owner is
-- deliberately a non-superuser so it cannot install extensions itself. Create
-- the extensions here while the offline bootstrap principal is still available;
-- otherwise first-run migrations die with
-- 'permission denied to create extension "vector"'.
SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name='vector') AS vector_available \gset
\if :vector_available
CREATE EXTENSION IF NOT EXISTS vector;
SELECT format('GRANT USAGE ON SCHEMA %I TO %I', namespace.nspname, :'migration_user')
FROM pg_extension extension
JOIN pg_namespace namespace ON namespace.oid=extension.extnamespace
WHERE extension.extname='vector' \gexec
\endif
SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name='pgcrypto') AS pgcrypto_available \gset
\if :pgcrypto_available
CREATE EXTENSION IF NOT EXISTS pgcrypto;
SELECT format('GRANT USAGE ON SCHEMA %I TO %I', namespace.nspname, :'migration_user')
FROM pg_extension extension
JOIN pg_namespace namespace ON namespace.oid=extension.extnamespace
WHERE extension.extname='pgcrypto' \gexec
\endif

-- Existing volumes do not rerun docker-entrypoint initialization. Install AGE
-- here while the offline bootstrap principal is still available so attaching a
-- recovered volume to the AGE image cannot silently strand local Rorca in Lite.
-- Generic PostgreSQL services used by graph-lite CI do not advertise AGE; keep
-- split-principal provisioning valid there without masking failures on AGE images.
SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name='age') AS age_available \gset
\if :age_available
CREATE EXTENSION IF NOT EXISTS age;
SELECT format('GRANT USAGE ON SCHEMA ag_catalog TO %I, %I', :'migration_user', :'runtime_user') \gexec
SELECT format('GRANT SELECT ON ag_catalog.ag_graph, ag_catalog.ag_label TO %I, %I', :'migration_user', :'runtime_user') \gexec
\endif

-- Older volumes may have installed pgcrypto after AGE changed search_path,
-- placing it in ag_catalog. The offline bootstrap owner grants the trusted
-- migration owner access to the actual extension schema without granting any
-- additional extension-schema authority to runtime or writer.
SELECT format('GRANT USAGE ON SCHEMA %I TO %I', namespace.nspname, :'migration_user')
FROM pg_extension extension
JOIN pg_namespace namespace ON namespace.oid=extension.extnamespace
WHERE extension.extname='pgcrypto' \gexec

SELECT format('ALTER DATABASE %I OWNER TO %I', current_database(), :'migration_user') \gexec
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SELECT format('GRANT CONNECT ON DATABASE %I TO %I, %I, %I',current_database(),:'migration_user',:'runtime_user',:'writer_user') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I, %I, %I',:'migration_user',:'runtime_user',:'writer_user') \gexec

SELECT (count(*)=3 AND count(*) FILTER(WHERE rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR NOT rolcanlogin)=0)::int AS roles_safe
FROM pg_roles WHERE rolname IN (:'migration_user',:'runtime_user',:'writer_user') \gset
\if :roles_safe
\else
  \echo 'split-principal role attribute validation failed'
  \quit 3
\endif
SELECT (count(*)=2 AND count(*) FILTER(WHERE rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolcanlogin)=0)::int AS compatibility_roles_safe
FROM pg_roles WHERE rolname IN ('authenticated','anon') \gset
\if :compatibility_roles_safe
\else
  \echo 'compatibility request role attribute validation failed'
  \quit 3
\endif
SELECT (count(*)=0)::int AS memberships_safe
FROM pg_auth_members memberships
JOIN pg_roles granted ON granted.oid=memberships.roleid
JOIN pg_roles member ON member.oid=memberships.member
WHERE granted.rolname IN (:'migration_user',:'runtime_user',:'writer_user','authenticated','anon')
  AND member.rolname IN (:'migration_user',:'runtime_user',:'writer_user','authenticated','anon') \gset
\if :memberships_safe
\else
  \echo 'split-principal cross-membership remains'
  \quit 3
\endif
SQL
