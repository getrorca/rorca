#!/usr/bin/env bash
# Wave 3 Always-On PostgreSQL 16 release certification.
# Creates, mutates, backs up, restores, and drops only unique disposable DBs.
set -Eeuo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# An operator must pin the exact checkout and branch being certified. This keeps
# the destructive-to-disposable harness reusable without silently certifying a
# different worktree after an integration handoff.
EXPECTED_ROOT="${RORCA_CERT_EXPECTED_ROOT:-}"
EXPECTED_BRANCH="${RORCA_CERT_EXPECTED_BRANCH:-}"
PG16_BIN="${PG16_BIN:-/usr/local/opt/postgresql@16/bin}"
PGHOST_CERT="${PGHOST_CERT:-127.0.0.1}"
PGPORT_CERT="${PGPORT_CERT:-5433}"
PGADMIN_DB="postgres"
PGROLE_CERT="$(id -un)"
EVIDENCE_PATH="${1:-$ROOT/.wave3-postgres-cert-evidence.log}"
TMP_ROOT="$(mktemp -d /tmp/rorca-wave3-postgres-cert.XXXXXX)"
SUFFIX="$(openssl rand -hex 8)"
FRESH_DB="rorca_wave3_cert_fresh_${SUFFIX}"
BROWN_DB="rorca_wave3_cert_brownfield_${SUFFIX}"
RESTORE_DB="rorca_wave3_cert_restore_${SUFFIX}"
FOCUSED_TEST_DB="rorca_wave3_cert_focus_${SUFFIX}_test"
ARCHIVE="$TMP_ROOT/rorca-wave3-cert.dump"
EMPTY_PGPASS="$TMP_ROOT/empty.pgpass"
MIGRATION_VERSION="20260714150000"
DBS=("$FRESH_DB" "$BROWN_DB" "$RESTORE_DB" "$FOCUSED_TEST_DB")

touch "$EMPTY_PGPASS"
chmod 600 "$EMPTY_PGPASS"
mkdir -p "$(dirname "$EVIDENCE_PATH")"
: > "$EVIDENCE_PATH"
exec > >(tee -a "$EVIDENCE_PATH") 2>&1

psql_cert() {
  PGPASSFILE="$EMPTY_PGPASS" "$PG16_BIN/psql" -X -w -h "$PGHOST_CERT" -p "$PGPORT_CERT" -U "$PGROLE_CERT" "$@"
}

assert_disposable_name() {
  local name="$1"
  [[ "$name" == *rorca_wave3_cert_* ]] || {
    echo "REFUSE: mutable database name lacks rorca_wave3_cert_: $name" >&2
    exit 20
  }
  [[ "$name" != "rorca" && "$name" != "postgres" ]] || {
    echo "REFUSE: mutable database resolves to protected database: $name" >&2
    exit 21
  }
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  echo "[cleanup] begin"
  for db in "${DBS[@]}"; do
    if assert_disposable_name "$db"; then
      PGPASSFILE="$EMPTY_PGPASS" "$PG16_BIN/dropdb" -w -h "$PGHOST_CERT" -p "$PGPORT_CERT" -U "$PGROLE_CERT" --if-exists "$db" >/dev/null 2>&1 || true
    fi
  done
  rm -rf "$TMP_ROOT"
  local leftovers
  leftovers="$(psql_cert -d "$PGADMIN_DB" -Atqc "SELECT count(*) FROM pg_database WHERE datname = ANY (ARRAY['$FRESH_DB','$BROWN_DB','$RESTORE_DB','$FOCUSED_TEST_DB'])" 2>/dev/null || echo unknown)"
  echo "[cleanup] disposable_databases_remaining=$leftovers archive_removed=$([[ ! -e "$ARCHIVE" ]] && echo true || echo false)"
  echo "[cleanup] result=$rc"
  exit "$rc"
}
trap cleanup EXIT INT TERM

for db in "${DBS[@]}"; do assert_disposable_name "$db"; done

[[ -n "$EXPECTED_ROOT" && "$EXPECTED_ROOT" == /* ]] || {
  echo "REFUSE: set RORCA_CERT_EXPECTED_ROOT to the absolute certification checkout" >&2
  exit 22
}
[[ -n "$EXPECTED_BRANCH" ]] || {
  echo "REFUSE: set RORCA_CERT_EXPECTED_BRANCH to the certification branch" >&2
  exit 23
}
[[ "$ROOT" == "$EXPECTED_ROOT" ]] || { echo "REFUSE: wrong checkout: $ROOT" >&2; exit 24; }
[[ "$(git -C "$ROOT" branch --show-current)" == "$EXPECTED_BRANCH" ]] || { echo "REFUSE: wrong branch" >&2; exit 25; }
[[ -z "$(git -C "$ROOT" status --porcelain --untracked-files=no -- . ':!backend/src/db/pg-migrations/050_knowledge_graph.sql')" ]] || {
  echo "REFUSE: unexpected tracked changes in certification checkout" >&2
  exit 26
}

for tool in psql createdb dropdb pg_dump pg_restore; do
  [[ -x "$PG16_BIN/$tool" ]] || { echo "REFUSE: missing PostgreSQL 16 tool: $PG16_BIN/$tool" >&2; exit 25; }
  "$PG16_BIN/$tool" --version | grep -Eq 'PostgreSQL\) 16\.' || { echo "REFUSE: $tool is not major 16" >&2; exit 26; }
done

# Capture server and protected DB identity using only the maintenance database.
IFS='|' read -r SERVER_VERSION SERVER_PORT DATA_DIRECTORY SYSTEM_IDENTIFIER CURRENT_DB CURRENT_USER PRODUCTION_OID < <(
  psql_cert -d "$PGADMIN_DB" -AtF '|' -v ON_ERROR_STOP=1 -c \
    "SELECT current_setting('server_version'), current_setting('port'), current_setting('data_directory'),
            (SELECT system_identifier::text FROM pg_control_system()), current_database(), current_user,
            COALESCE((SELECT oid::text FROM pg_database WHERE datname='rorca'),'missing')"
)
[[ "$SERVER_VERSION" == 16.* ]] || { echo "REFUSE: target server is not PostgreSQL 16" >&2; exit 27; }
[[ "$SERVER_PORT" == "$PGPORT_CERT" && "$CURRENT_DB" == "$PGADMIN_DB" ]] || { echo "REFUSE: server/database identity is ambiguous" >&2; exit 28; }
[[ "$DATA_DIRECTORY" == /* && "$SYSTEM_IDENTIFIER" =~ ^[0-9]+$ && "$PRODUCTION_OID" =~ ^[0-9]+$ ]] || {
  echo "REFUSE: data-directory/system/production database identity is ambiguous" >&2
  exit 29
}
DATA_DIR_HASH="$(printf '%s' "$DATA_DIRECTORY" | shasum -a 256 | awk '{print $1}')"
SYSTEM_ID_HASH="$(printf '%s' "$SYSTEM_IDENTIFIER" | shasum -a 256 | awk '{print $1}')"
echo "[identity] server_version=$SERVER_VERSION port=$SERVER_PORT maintenance_db=$CURRENT_DB role=<local-peer>"
echo "[identity] data_directory=<redacted> sha256=$DATA_DIR_HASH system_identifier=<redacted> sha256=$SYSTEM_ID_HASH"
echo "[identity] protected_database=rorca oid=$PRODUCTION_OID (never used as mutable/test target)"
echo "[identity] disposable_databases=$FRESH_DB,$BROWN_DB,$RESTORE_DB,$FOCUSED_TEST_DB"

AVAILABLE="$(psql_cert -d "$PGADMIN_DB" -AtF '|' -v ON_ERROR_STOP=1 -c \
  "SELECT name,default_version FROM pg_available_extensions WHERE name IN ('age','vector','pgcrypto') ORDER BY name")"
for extension in age vector pgcrypto; do
  grep -q "^${extension}|" <<<"$AVAILABLE" || { echo "REFUSE: required extension unavailable: $extension" >&2; exit 30; }
done
echo "[compatibility] clients=16 server=16 extensions=$(tr '\n' ',' <<<"$AVAILABLE" | sed 's/,$//')"

create_db() {
  local db="$1"
  assert_disposable_name "$db"
  PGPASSFILE="$EMPTY_PGPASS" "$PG16_BIN/createdb" -w -h "$PGHOST_CERT" -p "$PGPORT_CERT" -U "$PGROLE_CERT" -T template0 "$db"
  local actual
  actual="$(psql_cert -d "$db" -Atqc 'SELECT current_database()')"
  [[ "$actual" == "$db" ]] || { echo "REFUSE: created database identity mismatch" >&2; exit 31; }
}

run_migrations() {
  local db="$1" log="$2"
  assert_disposable_name "$db"
  (
    cd "$ROOT/backend"
    DATABASE_URL="postgresql://$PGHOST_CERT:$PGPORT_CERT/$db" \
      npx tsx -e "import { runPgMigrations } from './src/db/pg-index.ts'; (async()=>await runPgMigrations())().catch(e=>{console.error(e);process.exit(1)})"
  ) >"$log" 2>&1
  grep -E '^\[pg-migrate\] (Applied: 050_knowledge_graph.sql|Applied: 20260714150000_|Done\.)' "$log"
}

EXPECTED_MIGRATIONS="$(find "$ROOT/backend/src/db/pg-migrations" -type f -name '*.sql' | wc -l | tr -d ' ')"

echo "[fresh] creating $FRESH_DB"
create_db "$FRESH_DB"
run_migrations "$FRESH_DB" "$TMP_ROOT/fresh-migrations.log"
psql_cert -d "$FRESH_DB" -v ON_ERROR_STOP=1 -At <<SQL
DO \$\$
DECLARE migration_count integer; skipped_count integer; graph_labels integer;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE skipped_in_lite_mode) INTO migration_count, skipped_count FROM public.schema_migrations;
  IF migration_count <> $EXPECTED_MIGRATIONS OR skipped_count <> 0 THEN RAISE EXCEPTION 'migration count/skip invariant failed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version=$MIGRATION_VERSION) THEN RAISE EXCEPTION 'reconciliation migration missing'; END IF;
  IF to_regnamespace('pgboss') IS NOT NULL THEN RAISE EXCEPTION 'canonical migrations hand-created pgboss schema'; END IF;
  IF NOT EXISTS (SELECT 1 FROM ag_catalog.ag_graph WHERE name='rorca' AND namespace='rorca'::regnamespace) THEN RAISE EXCEPTION 'AGE graph invariant failed'; END IF;
  SELECT count(*) INTO graph_labels FROM ag_catalog.ag_label WHERE graph=(SELECT graphid FROM ag_catalog.ag_graph WHERE name='rorca');
  IF graph_labels < 16 THEN RAISE EXCEPTION 'AGE labels incomplete'; END IF;
  IF (SELECT count(*) FROM pg_extension WHERE extname IN ('age','vector','pgcrypto')) <> 3 THEN RAISE EXCEPTION 'extension install invariant failed'; END IF;
  IF to_regclass('rorca.context_events') IS NULL OR to_regclass('rorca.memory_candidates') IS NULL THEN RAISE EXCEPTION 'Always-On tables missing'; END IF;
  IF to_regclass('rorca.memory_distillation_settings') IS NULL OR to_regclass('rorca.context_capture_settings') IS NULL THEN RAISE EXCEPTION 'reconciliation tables missing'; END IF;
  IF to_regclass('rorca.idx_context_events_distillation_pending') IS NULL OR to_regclass('rorca.idx_memory_candidates_always_on_dedupe') IS NULL THEN RAISE EXCEPTION 'reconciliation indexes missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='context_events_distillation_status_mainline_check') THEN RAISE EXCEPTION 'distillation constraint missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='memory_candidates_default_retrieval_mainline_check') THEN RAISE EXCEPTION 'retrieval constraint missing'; END IF;
  IF length(encode(digest('wave3','sha256'),'hex')) <> 64 OR gen_random_uuid() IS NULL THEN RAISE EXCEPTION 'pgcrypto behavior failed'; END IF;
  IF vector_dims(array_fill(0::real, ARRAY[1536])::vector) <> 1536 THEN RAISE EXCEPTION 'pgvector behavior failed'; END IF;
END \$\$;
SELECT '[fresh] migrations='||count(*)||' skipped='||count(*) FILTER (WHERE skipped_in_lite_mode) FROM public.schema_migrations;
SELECT '[fresh] extension='||extname||':'||extversion||' schema='||extnamespace::regnamespace::text FROM pg_extension WHERE extname IN ('age','vector','pgcrypto') ORDER BY extname;
SELECT '[fresh] graph_labels='||count(*) FROM ag_catalog.ag_label WHERE graph=(SELECT graphid FROM ag_catalog.ag_graph WHERE name='rorca');
SQL

# Clone before pg-boss exists, then construct a divergent canonical CCS/UCC brownfield state.
assert_disposable_name "$BROWN_DB"
PGPASSFILE="$EMPTY_PGPASS" "$PG16_BIN/createdb" -w -h "$PGHOST_CERT" -p "$PGPORT_CERT" -U "$PGROLE_CERT" -T "$FRESH_DB" "$BROWN_DB"
psql_cert -d "$BROWN_DB" -v ON_ERROR_STOP=1 <<SQL
SET search_path=rorca,public;
DELETE FROM public.schema_migrations WHERE version=$MIGRATION_VERSION;
ALTER TABLE context_events DROP CONSTRAINT IF EXISTS context_events_distillation_status_mainline_check;
ALTER TABLE memory_candidates DROP CONSTRAINT IF EXISTS memory_candidates_default_retrieval_mainline_check;
DROP INDEX IF EXISTS idx_context_events_distillation_pending;
DROP INDEX IF EXISTS idx_memory_candidates_source_session;
DROP INDEX IF EXISTS idx_memory_candidates_always_on_dedupe;
DROP INDEX IF EXISTS idx_memory_candidates_external_import_vendor;
DROP INDEX IF EXISTS idx_memory_candidates_external_import_idempotency;
DROP INDEX IF EXISTS idx_context_capture_audit_workspace_time;
DROP INDEX IF EXISTS idx_context_capture_settings_paused_policy;
DROP TABLE IF EXISTS context_capture_audit_log;
DROP TABLE IF EXISTS context_capture_settings;
DROP TABLE IF EXISTS memory_distillation_settings;
INSERT INTO workspaces(id,label,path) VALUES ('wave3-brownfield','Wave 3 brownfield','/tmp/wave3-brownfield');
INSERT INTO context_events(
  workspace_id,event_type,source_system,source_ref,occurred_at,summary,payload,provenance,
  related_files,metadata,trust_tier,idempotency_key,distillation_status,
  distillation_attempted_at,distillation_error
) VALUES (
  'wave3-brownfield','manual_note','rorca-capture','historical-event',NOW()-interval '2 days',
  'Historical immutable evidence','{"fixture":"accepted-error","value":1}'::jsonb,
  '{"source":"pre-reconciliation"}'::jsonb,'[]'::jsonb,'{}'::jsonb,'working_note',
  'wave3-brownfield-event','error',NOW()-interval '1 day',
  'column "payload" of relation "memory_candidates" does not exist'
);
INSERT INTO memory_candidates(
  workspace_id,event_type,source_system,source_ref,occurred_at,suggested_category,title,rule,context,
  related_files,confidence,trust_tier,review_status,reviewer,reviewed_at,idempotency_key,
  provenance,metadata,security_sensitive,regulated_domain,requires_review,default_retrieval_eligible
) VALUES
  ('wave3-brownfield','manual_note','manual','approved-candidate',NOW()-interval '3 days','Decision',
   'Approved historical candidate','Preserve approved review state.','brownfield','[]','high','verified_fact',
   'approved','wave3-cert',NOW()-interval '2 days','wave3-brownfield-approved','{}','{}',FALSE,FALSE,FALSE,FALSE),
  ('wave3-brownfield','manual_note','manual','conflict-candidate',NOW()-interval '3 days','Gotcha',
   'Conflict historical candidate','Preserve conflict review evidence.','brownfield','[]','medium','working_note',
   'conflict','wave3-cert',NOW()-interval '2 days','wave3-brownfield-conflict','{}','{}',FALSE,FALSE,TRUE,FALSE);
SQL

psql_cert -d "$BROWN_DB" -Atqc "SET search_path=rorca,public; SELECT encode(digest(string_agg(to_jsonb(t)::text,'' ORDER BY id),'sha256'),'hex') FROM (SELECT id,payload,distillation_status,distillation_attempted_at,distillation_error FROM context_events WHERE workspace_id='wave3-brownfield') t" > "$TMP_ROOT/brown-event-before"
psql_cert -d "$BROWN_DB" -Atqc "SET search_path=rorca,public; SELECT encode(digest(string_agg(to_jsonb(t)::text,'' ORDER BY id),'sha256'),'hex') FROM (SELECT id,review_status,title,rule,provenance,metadata FROM memory_candidates WHERE workspace_id='wave3-brownfield') t" > "$TMP_ROOT/brown-candidates-before"
[[ "$(psql_cert -d "$BROWN_DB" -Atqc "SELECT to_regnamespace('pgboss') IS NULL")" == t ]] || { echo 'brownfield unexpectedly has pgboss'; exit 32; }
run_migrations "$BROWN_DB" "$TMP_ROOT/brown-migrations.log"
psql_cert -d "$BROWN_DB" -Atqc "SET search_path=rorca,public; SELECT encode(digest(string_agg(to_jsonb(t)::text,'' ORDER BY id),'sha256'),'hex') FROM (SELECT id,payload,distillation_status,distillation_attempted_at,distillation_error FROM context_events WHERE workspace_id='wave3-brownfield') t" > "$TMP_ROOT/brown-event-after"
psql_cert -d "$BROWN_DB" -Atqc "SET search_path=rorca,public; SELECT encode(digest(string_agg(to_jsonb(t)::text,'' ORDER BY id),'sha256'),'hex') FROM (SELECT id,review_status,title,rule,provenance,metadata FROM memory_candidates WHERE workspace_id='wave3-brownfield') t" > "$TMP_ROOT/brown-candidates-after"
cmp -s "$TMP_ROOT/brown-event-before" "$TMP_ROOT/brown-event-after" || { echo 'brownfield event evidence changed'; exit 33; }
cmp -s "$TMP_ROOT/brown-candidates-before" "$TMP_ROOT/brown-candidates-after" || { echo 'brownfield candidate evidence changed'; exit 34; }
psql_cert -d "$BROWN_DB" -v ON_ERROR_STOP=1 -At <<SQL
SET search_path=rorca,public;
DO \$\$
BEGIN
  IF to_regnamespace('pgboss') IS NOT NULL THEN RAISE EXCEPTION 'reconciliation hand-created pgboss'; END IF;
  IF (SELECT count(*) FROM memory_candidates WHERE workspace_id='wave3-brownfield') <> 2 THEN RAISE EXCEPTION 'candidate data loss'; END IF;
  IF (SELECT count(*) FROM memory_candidates WHERE workspace_id='wave3-brownfield' AND review_status IN ('approved','conflict')) <> 2 THEN RAISE EXCEPTION 'review status changed'; END IF;
  IF (SELECT count(*) FROM context_events ce CROSS JOIN (SELECT applied_at FROM public.schema_migrations WHERE version=$MIGRATION_VERSION) baseline WHERE ce.workspace_id='wave3-brownfield' AND ce.distillation_status='error' AND ce.distillation_error='column "payload" of relation "memory_candidates" does not exist' AND ce.distillation_attempted_at <= baseline.applied_at) <> 1 THEN RAISE EXCEPTION 'accepted historical error baseline failed'; END IF;
END \$\$;
SELECT '[brownfield] candidates='||count(*)||' statuses='||string_agg(review_status,',' ORDER BY review_status) FROM memory_candidates WHERE workspace_id='wave3-brownfield';
SELECT '[brownfield] accepted_historical_errors='||count(*) FROM context_events ce CROSS JOIN (SELECT applied_at FROM public.schema_migrations WHERE version=$MIGRATION_VERSION) baseline WHERE ce.workspace_id='wave3-brownfield' AND ce.distillation_status='error' AND ce.distillation_attempted_at <= baseline.applied_at;
SELECT '[brownfield] event_checksum='||left(trim(pg_read_file('$TMP_ROOT/brown-event-after')),16)||'… candidate_checksum='||left(trim(pg_read_file('$TMP_ROOT/brown-candidates-after')),16)||'…';
SQL

# Real in-process queue exercise: pg-boss owns all queue DDL; no server/worker is started.
echo "[capture] running synchronous capture -> distill harness"
(
  cd "$ROOT/backend"
  DATABASE_URL="postgresql://$PGHOST_CERT:$PGPORT_CERT/$FRESH_DB" \
  JEST_SKIP_RUNTIME_MIGRATIONS=true \
    npx tsx scripts/wave3-postgres16-capture-harness.ts
)

snapshot() {
  local db="$1" out="$2"
  psql_cert -d "$db" -AtF '|' -v ON_ERROR_STOP=1 <<'SQL' > "$out"
SET search_path=rorca,public;
SELECT 'migrations',count(*)::text,max(version)::text FROM public.schema_migrations;
SELECT 'extensions',string_agg(extname||':'||extversion,',' ORDER BY extname) FROM pg_extension WHERE extname IN ('age','vector','pgcrypto');
SELECT 'graph',g.name,count(l.*)::text FROM ag_catalog.ag_graph g LEFT JOIN ag_catalog.ag_label l ON l.graph=g.graphid WHERE g.name='rorca' GROUP BY g.name;
SELECT 'critical_schema',encode(digest(string_agg(table_name||':'||ordinal_position||':'||column_name||':'||data_type||':'||is_nullable||':'||coalesce(column_default,''),E'\n' ORDER BY table_name,ordinal_position),'sha256'),'hex') FROM information_schema.columns WHERE table_schema='rorca' AND table_name IN ('context_events','memory_candidates','context_capture_settings','memory_distillation_settings');
SELECT 'critical_constraints',encode(digest(string_agg(c.conname||':'||pg_get_constraintdef(c.oid),E'\n' ORDER BY c.conname),'sha256'),'hex') FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='rorca' AND t.relname IN ('context_events','memory_candidates');
SELECT 'context_events',count(*)::text,encode(digest(coalesce(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id),''),'sha256'),'hex') FROM context_events t;
SELECT 'memory_candidates',count(*)::text,encode(digest(coalesce(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id),''),'sha256'),'hex') FROM memory_candidates t;
SELECT 'capture_settings',count(*)::text,encode(digest(coalesce(string_agg(to_jsonb(t)::text,E'\n' ORDER BY workspace_id),''),'sha256'),'hex') FROM context_capture_settings t;
SELECT 'queues',count(*)::text,string_agg(name,',' ORDER BY name) FROM pgboss.queue WHERE name IN ('context:capture','context:distill');
SQL
}

snapshot "$FRESH_DB" "$TMP_ROOT/fresh.snapshot"
echo "[backup] custom-format dump"
PGPASSFILE="$EMPTY_PGPASS" "$PG16_BIN/pg_dump" -w -h "$PGHOST_CERT" -p "$PGPORT_CERT" -U "$PGROLE_CERT" -Fc -f "$ARCHIVE" "$FRESH_DB"
PGPASSFILE="$EMPTY_PGPASS" "$PG16_BIN/pg_restore" --list "$ARCHIVE" > "$TMP_ROOT/restore.list"
grep -q 'context_events' "$TMP_ROOT/restore.list"
grep -q 'memory_candidates' "$TMP_ROOT/restore.list"
grep -q 'pgboss' "$TMP_ROOT/restore.list"
echo "[backup] bytes=$(wc -c < "$ARCHIVE" | tr -d ' ') sha256=$(shasum -a 256 "$ARCHIVE" | awk '{print $1}') restore_list_entries=$(wc -l < "$TMP_ROOT/restore.list" | tr -d ' ')"
create_db "$RESTORE_DB"
PGPASSFILE="$EMPTY_PGPASS" "$PG16_BIN/pg_restore" -w -h "$PGHOST_CERT" -p "$PGPORT_CERT" -U "$PGROLE_CERT" -d "$RESTORE_DB" --no-owner --no-privileges --exit-on-error "$ARCHIVE"
snapshot "$RESTORE_DB" "$TMP_ROOT/restore.snapshot"
diff -u "$TMP_ROOT/fresh.snapshot" "$TMP_ROOT/restore.snapshot"
echo "[restore] critical schema/row/queue checksums identical"

# Controlled migration-shaped failure: publication and tracking insert must roll back together.
cat > "$TMP_ROOT/atomic-failure.sql" <<'SQL'
BEGIN;
CREATE TABLE rorca.wave3_atomic_probe(id integer PRIMARY KEY, evidence text NOT NULL);
INSERT INTO rorca.wave3_atomic_probe VALUES (1,'must roll back');
INSERT INTO public.schema_migrations(version,filename) VALUES (29991231235959,'controlled_wave3_atomic_failure.sql');
DO $$ BEGIN RAISE EXCEPTION 'controlled_wave3_atomic_failure'; END $$;
COMMIT;
SQL
set +e
psql_cert -d "$RESTORE_DB" -v ON_ERROR_STOP=1 -f "$TMP_ROOT/atomic-failure.sql" > "$TMP_ROOT/atomic-failure.log" 2>&1
ATOMIC_RC=$?
set -e
[[ "$ATOMIC_RC" -ne 0 ]] || { echo 'controlled failure unexpectedly succeeded'; exit 35; }
[[ "$(psql_cert -d "$RESTORE_DB" -Atqc "SELECT to_regclass('rorca.wave3_atomic_probe') IS NULL AND NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version=29991231235959)")" == t ]] || {
  echo 'controlled failure published partial state'; exit 36
}
echo "[atomicity] expected_failure_rc=$ATOMIC_RC table_absent=true migration_record_absent=true"

# Focused backend checks are pointed only at the disposable restore database.
echo "[tests] backend typecheck"
(cd "$ROOT/backend" && DATABASE_URL="postgresql://$PGHOST_CERT:$PGPORT_CERT/$RESTORE_DB" npx tsc --noEmit)
echo "[tests] focused Always-On reconciliation tests"
(cd "$ROOT/backend" && \
  DATABASE_URL="postgresql://$PGHOST_CERT:$PGPORT_CERT/$FOCUSED_TEST_DB" \
  DATABASE_URL_TEST="postgresql://$PGHOST_CERT:$PGPORT_CERT/$FOCUSED_TEST_DB" \
  JEST_SKIP_RUNTIME_MIGRATIONS=true \
  npx jest src/lib/__tests__/always-on-mainline-reconciliation.test.ts src/db/__tests__/knowledge-graph-fresh-install-migration.test.ts --runInBand)

echo "[result] PASS fresh_install=true brownfield=true capture_distill=true backup_restore=true atomic_failure=true"
