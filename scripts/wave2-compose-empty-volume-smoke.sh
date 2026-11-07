#!/bin/sh
# Destructive only to its unique, invocation-owned Compose project/volume.
# Never points at an existing project or database.
set -eu

if [ "${RORCA_WAVE2_COMPOSE_SMOKE:-}" != "I_ACKNOWLEDGE_INVOCATION_OWNED_EMPTY_VOLUME" ]; then
  echo "set RORCA_WAVE2_COMPOSE_SMOKE=I_ACKNOWLEDGE_INVOCATION_OWNED_EMPTY_VOLUME" >&2
  exit 64
fi
command -v docker >/dev/null
command -v curl >/dev/null

root=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
project=${RORCA_WAVE2_COMPOSE_PROJECT:-"rorca-wave2-smoke-$$"}
port=${RORCA_WAVE2_COMPOSE_PORT:-$((38000 + ($$ % 1000)))}
if ! printf '%s' "$project" | grep -Eq '^rorca-wave2-[a-z0-9][a-z0-9_-]{5,80}$'; then
  echo "RORCA_WAVE2_COMPOSE_PROJECT must be a unique rorca-wave2-* identity" >&2
  exit 64
fi
case "$port" in *[!0-9]*|'') echo "RORCA_WAVE2_COMPOSE_PORT must be numeric" >&2; exit 64;; esac
if [ "$port" -lt 1024 ] || [ "$port" -gt 65535 ]; then
  echo "RORCA_WAVE2_COMPOSE_PORT must be between 1024 and 65535" >&2
  exit 64
fi
secret() { openssl rand -hex 24; }
export RORCA_POSTGRES_DATABASE=rorca_smoke
export RORCA_POSTGRES_BOOTSTRAP_USER=rorca_smoke_bootstrap
RORCA_POSTGRES_BOOTSTRAP_PASSWORD=$(secret)
export RORCA_POSTGRES_BOOTSTRAP_PASSWORD
export RORCA_MIGRATION_DATABASE_USER=rorca_smoke_migrator
RORCA_MIGRATION_DATABASE_PASSWORD=$(secret)
export RORCA_MIGRATION_DATABASE_PASSWORD
export RORCA_RUNTIME_DATABASE_USER=rorca_smoke_runtime
RORCA_RUNTIME_DATABASE_PASSWORD=$(secret)
export RORCA_RUNTIME_DATABASE_PASSWORD
export RORCA_CANONICAL_WRITER_DATABASE_USER=rorca_smoke_writer
RORCA_CANONICAL_WRITER_DATABASE_PASSWORD=$(secret)
export RORCA_CANONICAL_WRITER_DATABASE_PASSWORD
export RORCA_MIGRATION_DATABASE_URL="postgres://$RORCA_MIGRATION_DATABASE_USER:$RORCA_MIGRATION_DATABASE_PASSWORD@db:5432/$RORCA_POSTGRES_DATABASE"
export RORCA_RUNTIME_DATABASE_URL="postgres://$RORCA_RUNTIME_DATABASE_USER:$RORCA_RUNTIME_DATABASE_PASSWORD@db:5432/$RORCA_POSTGRES_DATABASE"
export RORCA_CANONICAL_WRITER_DATABASE_URL="postgres://$RORCA_CANONICAL_WRITER_DATABASE_USER:$RORCA_CANONICAL_WRITER_DATABASE_PASSWORD@db:5432/$RORCA_POSTGRES_DATABASE"
JWT_SECRET=$(secret)
export JWT_SECRET
RORCA_INTERNAL_SERVICE_TOKEN=$(secret)
export RORCA_INTERNAL_SERVICE_TOKEN
RORCA_DISPATCH_RECEIVER_TOKEN=$(secret)
export RORCA_DISPATCH_RECEIVER_TOKEN
export RORCA_PORT="$port"

compose="docker compose --project-directory $root --project-name $project -f $root/docker-compose.yml"
cleanup() { $compose down --volumes --remove-orphans --rmi local >/dev/null 2>&1 || true; }
trap cleanup EXIT HUP INT TERM

build_flag=--build
case "${RORCA_WAVE2_COMPOSE_PREBUILT:-}" in
  '') ;;
  I_ACKNOWLEDGE_EXACT_PROJECT_IMAGES_ALREADY_BUILT)
    for service in db db-role-bootstrap db-migrate rorca worker; do
      docker image inspect "$project-$service" >/dev/null
    done
    build_flag=--no-build
    ;;
  *) echo "invalid RORCA_WAVE2_COMPOSE_PREBUILT acknowledgement" >&2; exit 64 ;;
esac

echo "Wave 2 Compose smoke project: $project"
$compose config --quiet
if ! $compose up "$build_flag" --detach rorca worker; then
  $compose logs --no-color db db-role-bootstrap db-migrate rorca worker >&2 || true
  exit 1
fi
attempt=0
until curl --fail --silent --show-error "http://127.0.0.1:$port/api/health" >/dev/null; do
  attempt=$((attempt+1))
  if [ "$attempt" -ge 60 ]; then
    $compose logs --no-color db db-role-bootstrap db-migrate rorca worker >&2 || true
    exit 1
  fi
  sleep 2
done

export PGPASSWORD="$RORCA_POSTGRES_BOOTSTRAP_PASSWORD"
catalog=$($compose exec -T db psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --username "$RORCA_POSTGRES_BOOTSTRAP_USER" --dbname "$RORCA_POSTGRES_DATABASE" --tuples-only --no-align \
  --set migration_user="$RORCA_MIGRATION_DATABASE_USER" --set runtime_user="$RORCA_RUNTIME_DATABASE_USER" \
  --set writer_user="$RORCA_CANONICAL_WRITER_DATABASE_USER" <<'SQL'
SELECT count(*) FROM pg_roles WHERE rolname IN (:'migration_user',:'runtime_user',:'writer_user')
 AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls;
SELECT count(*) FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.roleid JOIN pg_roles u ON u.oid=m.member
 WHERE g.rolname IN (:'migration_user',:'runtime_user',:'writer_user') AND u.rolname IN (:'migration_user',:'runtime_user',:'writer_user');
SELECT count(*) FROM public.schema_migrations WHERE version=20260731154000;
SELECT count(*) FROM information_schema.role_table_grants
 WHERE grantee=:'runtime_user' AND table_schema='rorca'
 AND privilege_type IN ('INSERT','UPDATE','DELETE')
 AND table_name IN ('governed_missions','execution_leases','context_policy_activations','continuation_dispatch_outbox');
SELECT (pg_get_userbyid(database.datdba)=:'migration_user')::int
 FROM pg_database database WHERE database.datname=current_database();
SELECT (pg_get_userbyid(namespace.nspowner)=:'migration_user')::int
 FROM pg_namespace namespace WHERE namespace.nspname='rorca';
SELECT count(*) FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
 WHERE ((namespace.nspname='public' AND relation.relname='schema_migrations')
    OR (namespace.nspname='rorca' AND relation.relname='governed_missions'))
   AND pg_get_userbyid(relation.relowner)=:'migration_user';
SELECT count(*) FROM pg_proc procedure JOIN pg_namespace namespace ON namespace.oid=procedure.pronamespace
 WHERE namespace.nspname='rorca' AND procedure.proname='authorize_wave2_canonical_writer_mutation_v3'
   AND pg_get_userbyid(procedure.proowner)=:'migration_user';
SELECT count(*) FROM pg_namespace namespace
 WHERE namespace.nspname='pgboss' AND pg_get_userbyid(namespace.nspowner)=:'migration_user';
SELECT has_database_privilege(:'runtime_user',current_database(),'CREATE')::int;
SELECT has_schema_privilege(:'runtime_user','rorca','CREATE')::int;
SELECT has_schema_privilege(:'writer_user','rorca_canonical_api','USAGE')::int;
SELECT has_table_privilege(:'writer_user','rorca.governed_missions','INSERT')::int;
SELECT has_table_privilege(:'writer_user','rorca_canonical_api.governed_missions','INSERT')::int;
SELECT count(*) FROM pg_extension extension JOIN pg_roles owner ON owner.oid=extension.extowner
 WHERE extension.extname IN('age','vector','pgcrypto') AND owner.rolname=:'migration_user';
SQL
)
expected='3
0
1
0
1
1
2
1
1
0
0
1
0
1
0'
if [ "$catalog" != "$expected" ]; then
  echo "unexpected split-principal catalog smoke result:" >&2
  printf '%s\n' "$catalog" >&2
  exit 1
fi

$compose exec -T db psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --username "$RORCA_RUNTIME_DATABASE_USER" --dbname "$RORCA_POSTGRES_DATABASE" \
  --command "INSERT INTO rorca.governed_missions(workspace_id,mission_id,created_by) VALUES('workspace:denied','mission:denied','smoke')" \
  >/dev/null 2>&1 && { echo 'runtime direct canonical DML unexpectedly succeeded' >&2; exit 1; }
$compose exec -T db psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --username "$RORCA_CANONICAL_WRITER_DATABASE_USER" --dbname "$RORCA_POSTGRES_DATABASE" \
  --command "INSERT INTO rorca.governed_missions(workspace_id,mission_id,created_by) VALUES('workspace:denied','mission:denied','smoke')" \
  >/dev/null 2>&1 && { echo 'writer direct base-table DML unexpectedly succeeded' >&2; exit 1; }

# The API gets only the exact runtime/writer topology and pre-applied markers.
# Do not print the generated credentials while verifying their identities.
$compose exec -T rorca node <<'NODE'
const runtime = new URL(process.env.DATABASE_URL || '').username;
const writer = new URL(process.env.RORCA_CANONICAL_WRITER_DATABASE_URL || '').username;
if (runtime !== process.env.RORCA_RUNTIME_DATABASE_USER
    || writer !== process.env.RORCA_CANONICAL_WRITER_DATABASE_USER
    || process.env.RORCA_MIGRATIONS_PREAPPLIED !== 'true'
    || process.env.RORCA_PGBOSS_PREAPPLIED !== 'true') process.exit(2);
for (const forbidden of ['RORCA_MIGRATION_DATABASE_URL','RORCA_POSTGRES_BOOTSTRAP_PASSWORD',
  'RORCA_MIGRATION_DATABASE_PASSWORD','RORCA_CANONICAL_WRITER_DATABASE_PASSWORD']) {
  if (process.env[forbidden]) process.exit(3);
}
NODE

# The worker has only its runtime/transport credential set. In particular, the
# dispatch sender cannot self-assert receiver acceptance and cannot write
# canonical stores directly.
$compose exec -T worker node <<'NODE'
const runtime = new URL(process.env.DATABASE_URL || '').username;
if (runtime !== process.env.RORCA_RUNTIME_DATABASE_USER
    || process.env.RORCA_MIGRATIONS_PREAPPLIED !== 'true'
    || process.env.RORCA_PGBOSS_PREAPPLIED !== 'true') process.exit(2);
for (const forbidden of ['RORCA_MIGRATION_DATABASE_URL','RORCA_POSTGRES_BOOTSTRAP_PASSWORD',
  'RORCA_MIGRATION_DATABASE_PASSWORD','RORCA_CANONICAL_WRITER_DATABASE_URL',
  'RORCA_CANONICAL_WRITER_DATABASE_USER','RORCA_CANONICAL_WRITER_DATABASE_PASSWORD',
  'RORCA_DISPATCH_RECEIVER_TOKEN']) {
  if (process.env[forbidden]) process.exit(3);
}
NODE

# Deliberately inject the owned migrator URL into an isolated one-shot API
# container and prove pre-applied runtime startup refuses the confused deputy.
$compose run --rm --no-deps \
  -e RORCA_MIGRATION_DATABASE_URL="$RORCA_MIGRATION_DATABASE_URL" rorca \
  node -e "require('./backend/dist/db/index.js').initDb().then(() => process.exit(10)).catch(error => process.exit(String(error.message).includes('must not inject migration-owner credentials') ? 0 : 11))"

# Exercise the documented pre-split ownership transfer on independently owned
# relation, routine, and enum objects, then verify/drop them as the migrator.
$compose exec -T db psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --username "$RORCA_POSTGRES_BOOTSTRAP_USER" --dbname "$RORCA_POSTGRES_DATABASE" \
  --command 'CREATE TYPE rorca.wave2_upgrade_owner_state AS ENUM ('"'"'ready'"'"'); CREATE TABLE rorca.wave2_upgrade_owner_smoke(id INTEGER PRIMARY KEY, state rorca.wave2_upgrade_owner_state); CREATE FUNCTION rorca.wave2_upgrade_owner_function(value INTEGER) RETURNS INTEGER LANGUAGE SQL IMMUTABLE AS $$ SELECT value + 1 $$' >/dev/null
$compose exec -T db psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --username "$RORCA_POSTGRES_BOOTSTRAP_USER" --dbname "$RORCA_POSTGRES_DATABASE" \
  --set previous_owner="$RORCA_POSTGRES_BOOTSTRAP_USER" --set migration_user="$RORCA_MIGRATION_DATABASE_USER" \
  < "$root/docker/postgres/upgrade-split-owner.sql" >/dev/null
upgrade_owners=$($compose exec -T db psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --username "$RORCA_POSTGRES_BOOTSTRAP_USER" --dbname "$RORCA_POSTGRES_DATABASE" --tuples-only --no-align \
  --command "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='rorca.wave2_upgrade_owner_smoke'::regclass; \
    SELECT pg_get_userbyid(typowner) FROM pg_type WHERE oid='rorca.wave2_upgrade_owner_state'::regtype; \
    SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='rorca.wave2_upgrade_owner_function(integer)'::regprocedure")
expected_upgrade_owners=$(printf '%s\n%s\n%s' "$RORCA_MIGRATION_DATABASE_USER" "$RORCA_MIGRATION_DATABASE_USER" "$RORCA_MIGRATION_DATABASE_USER")
[ "$upgrade_owners" = "$expected_upgrade_owners" ] || { echo 'upgrade ownership transfer failed' >&2; exit 1; }
$compose exec -T -e PGPASSWORD="$RORCA_MIGRATION_DATABASE_PASSWORD" db \
  psql --no-psqlrc --set ON_ERROR_STOP=1 --username "$RORCA_MIGRATION_DATABASE_USER" \
  --dbname "$RORCA_POSTGRES_DATABASE" --command 'DROP FUNCTION rorca.wave2_upgrade_owner_function(integer); DROP TABLE rorca.wave2_upgrade_owner_smoke; DROP TYPE rorca.wave2_upgrade_owner_state' >/dev/null

echo "Wave 2 empty-volume Compose split-principal smoke: PASS"
