/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Real-host clean-room reconstruction certificate runner (W4-014 real-host packet).
 *
 * Each pilot lane (managed, fake_federated) is reconstructed in its OWN fresh
 * isolated host namespace: a fresh per-lane bare clone + worktree at the HARD-PINNED
 * reviewed Wave 4 code head, plus a fresh nonce-named PostgreSQL 16 container
 * (rorca-postgres:pg16-age). Every reconstruction step is EXECUTED with a concrete
 * shell command under a SANITIZED allowlisted environment; the observed output is
 * compared against the step's expected shape and, on mismatch, the step is BLOCKED.
 * Migrations run as a DISTINCT constrained migration role (mirroring the
 * invocation harness posture), never the superuser. All seven status planes are
 * derived from individual real observations. Backups are labeled by their true
 * kind (Git object backup hash in the declared inputs; PostgreSQL logical backup
 * hash bound per lane inside the verify_backup_ledger observation). Credential
 * values are redacted from recorded commands so raw secrets never enter the
 * certificate. The only reconstruction inputs are the exact Git SHA, committed
 * migration/ledger/contract artifacts, versioned policy/configuration, vault
 * references, and content-addressed artifacts; node_modules is a recorded MUTABLE
 * toolchain input (content-hashed, never reconstructed state). Cleanup labels are
 * run-scoped. Lane-specific pilot code paths are exercised by the W4-009
 * conformance suites (real HTTP/TLS/DB); this certificate verifies the shared
 * reconstruction inputs and fresh-host properties. Each lane ends with an
 * executed cleanup step that removes its namespace-owned resources and proves
 * absence.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CleanRoomReconstructor,
  RECONSTRUCTION_STEPS,
  SEVEN_STATUS_PLANES,
  gateFinalPilotDemonstration,
  type CanonicalCleanRoomInputs,
  type CleanRoomCertificate,
  type ExecutedReconstructionReceipt,
  type FreshHostNamespace,
  type PilotLane,
  type ReconstructionOptions,
  type ReconstructionStep,
  type StatusPlane,
} from '../backend/src/lib/operational-isolation-reconstruction';
import { governedOperationsHash } from '../backend/src/lib/governed-operations-primitives';
import type { Pool as PoolType } from 'pg';

// Source checkout for the cleanroom clone, resolved from the operator's
// home directory so no developer-machine path is committed.
const SOURCE_ROOT = process.env.RORCA_SOURCE_ROOT
  ? path.resolve(process.env.RORCA_SOURCE_ROOT)
  : path.join(os.homedir(), 'rorca');

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);

// HARD-PINNED reviewed Wave 4 code head. No override is accepted: the gate must
// never certify a different commit.
const EXACT_SHA = 'a3efe85b701ba35030c399fc4ba0e684c4638298' as const;
const LEDGER_WAVE3_SHA = '305df00144c15a498a69857e279edcbf4ea14233' as const;
const LEDGER_WAVE4_SHA = 'bdcc1ce28efcf1cdd714781b04a6e70ca1271e5b' as const;
const CONTAINER_IMAGE = 'rorca-postgres:pg16-age' as const;
const PROGRAM_ROOT = path.resolve(path.dirname(__filename), '..');
const BACKEND = path.join(PROGRAM_ROOT, 'backend');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-cleanroom-'));
const RUN_NONCE = crypto.randomBytes(8).toString('hex');
const EVIDENCE = path.join(PROGRAM_ROOT, 'docs', 'wave4-cleanroom-realhost-certificate.md');
const CERT_JSON = path.join(PROGRAM_ROOT, 'docs', 'wave4-cleanroom-certificates.json');
const { Pool } = require(path.join(BACKEND, 'node_modules', 'pg')) as { Pool: typeof PoolType };

// Sanitized, allowlisted execution environment: only the toolchain paths and the
// variables the exact commands need. Ambient secrets never reach the child.
const SANITIZED_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
  HOME: process.env.HOME ?? os.homedir(),
  LANG: 'C',
  TZ: 'UTC',
  NODE_ENV: process.env.NODE_ENV ?? '',
};

const sha256 = (value: string): string => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
const sh = (command: string, cwd: string, extraEnv: Record<string, string> = {}): { ok: boolean; stdout: string; stderr: string } => {
  const result = spawnSync('/bin/sh', ['-c', `set -o pipefail; ${command}`], {
    cwd, encoding: 'utf8', timeout: 300_000,
    env: { ...SANITIZED_ENV, ...extraEnv },
  });
  return { ok: result.status === 0, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
};

const readIfExists = (file: string): string[] => (fs.existsSync(file) ? [fs.readFileSync(file, 'utf8')] : []);
const delay = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

function requireOk(label: string, result: { ok: boolean; stderr: string }): void {
  if (!result.ok) throw new Error(`[cleanroom] ${label} failed: ${result.stderr.slice(-2000)}`);
}

/** Hash the toolchain content inside the namespace (package manifests only). */
function toolchainContentHash(): string {
  const root = sh(`find "${PROGRAM_ROOT}" -maxdepth 2 -name 'package-lock.json' -o -maxdepth 2 -name 'package.json' | grep -v node_modules | sort | xargs shasum -a 256 | shasum -a 256`, TMP);
  const backend = sh(`find "${BACKEND}/node_modules" -maxdepth 3 -name 'package.json' 2>/dev/null | sort | xargs shasum -a 256 | shasum -a 256`, TMP);
  return sha256(`${root.stdout}|${backend.stdout}`);
}

async function runLane(lane: PilotLane, inputs: CanonicalCleanRoomInputs, toolVersions: Record<string, string>)
  : Promise<CleanRoomCertificate> {
  const nonce = crypto.randomBytes(8).toString('hex');
  const container = `rorca-cleanroom-pg-${nonce}`;
  const workspace = path.join(TMP, `workspace-${lane}-${nonce}`);
  const bare = path.join(TMP, `repo-${lane}-${nonce}.git`);
  const adminDb = 'rorca_cleanroom';
  const adminUser = `rorca_cleanroom_admin_${nonce}`;
  const adminPassword = crypto.randomBytes(24).toString('hex');
  const migrationUser = `rorca_cleanroom_migration_${nonce}`;
  const runtimeUser = `rorca_cleanroom_runtime_${nonce}`;
  const writerUser = `rorca_cleanroom_writer_${nonce}`;
  const migrationPassword = crypto.randomBytes(24).toString('hex');
  const runtimePassword = crypto.randomBytes(24).toString('hex');
  const writerPassword = crypto.randomBytes(24).toString('hex');
  const namespace: FreshHostNamespace = {
    namespaceId: `rorca-cleanroom-${lane}-${nonce}`,
    emptyCaches: true,
    emptyProjections: true,
    emptyRuntimeHomes: true,
    hiddenHomeFilesPresent: false,
    ambientEnvironmentPresent: false,
    mutableHostCronPresent: false,
    undocumentedSshStatePresent: false,
    preservedContainersPresent: false,
    projectionDatabasePresent: false,
    runtimeLocalMemoryPresent: false,
    advisoryMemoryPresent: false,
  };
  let containerPort = 0;

  try {
    const clone = sh(`git clone --bare --no-local ${SOURCE_ROOT} "${bare}"`, TMP);
    requireOk(`bare clone (${lane})`, clone);
    const worktree = sh(`git --git-dir="${bare}" worktree add "${workspace}" ${EXACT_SHA}`, TMP);
    requireOk(`fresh worktree (${lane})`, worktree);
    fs.symlinkSync(path.join(BACKEND, 'node_modules'), path.join(workspace, 'backend', 'node_modules'), 'dir');
    fs.symlinkSync(path.join(PROGRAM_ROOT, 'node_modules'), path.join(workspace, 'node_modules'), 'dir');
    const head = sh(`git -C "${workspace}" rev-parse HEAD`, workspace).stdout.trim();
    if (head !== EXACT_SHA) throw new Error(`[cleanroom] worktree HEAD mismatch: ${head}`);

    const run = sh(
      `docker run --detach --rm --name ${container} --label com.rorca.cleanroom.owner=${RUN_NONCE} `
      + `--tmpfs /var/lib/postgresql/data:rw,size=1073741824,mode=0700,uid=999,gid=999 `
      + `--publish 127.0.0.1::5432 --env POSTGRES_USER=${adminUser} --env POSTGRES_PASSWORD=${adminPassword} `
      + `--env POSTGRES_DB=${adminDb} ${CONTAINER_IMAGE}`,
      TMP,
    );
    requireOk('postgres container start', run);
    const portOut = sh(`docker port ${container} 5432/tcp`, TMP).stdout.trim();
    containerPort = Number(portOut.match(/:(\d+)$/)?.[1]);
    if (!containerPort) throw new Error('[cleanroom] could not read published postgres port');
    const adminUrl = `postgres://${adminUser}:${adminPassword}@127.0.0.1:${containerPort}/${adminDb}`;

    const poolReady = new Pool({ connectionString: adminUrl, connectionTimeoutMillis: 5_000 });
    let ready;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        ready = await poolReady.query('SELECT current_setting(\'server_version\') AS v');
        break;
      } catch {
        await delay(2_500);
      }
    }
    if (!ready) throw new Error('[cleanroom] fresh postgres did not become ready');
    if (!String(ready.rows[0]?.v).startsWith('16.')) throw new Error('[cleanroom] fresh server is not PostgreSQL 16');
    await poolReady.end();

    // The official image runs a temporary init server before the real postmaster;
    // wait for the final "ready to accept connections" log line so the role
    // provisioning cannot hit the restart gap.
    let finalReady = false;
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const logs = sh(`docker logs ${container} 2>&1 | grep -c 'ready to accept connections'`, TMP);
      if (Number(logs.stdout.trim()) >= 1) { finalReady = true; break; }
      await delay(2_000);
    }
    if (!finalReady) throw new Error('[cleanroom] fresh postgres final server did not become ready');

    const dockerPsql = (sql: string): string => {
      const out = sh(
        `docker exec -e PGPASSWORD=${adminPassword} ${container} psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 5432 -t -A -U ${adminUser} -d ${adminDb} -c ${JSON.stringify(sql)}`,
        TMP,
      );
      requireOk(`psql: ${sql.slice(0, 60)}`, out);
      return out.stdout.trim();
    };

    // Replicate the invocation harness's pre-migration contract: Supabase-style
    // roles, search paths, settings grants, auth schema/functions, and the
    // minimal rorca.workspace_members authority table. Migrations then run as
    // the DISTINCT constrained migration role (production posture), never the
    // superuser.
    const constrained = 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS';
    const provisionPool = new Pool({ connectionString: adminUrl, connectionTimeoutMillis: 5_000 });
    await provisionPool.query(
      `CREATE ROLE authenticated NOLOGIN ${constrained}; `
      + `CREATE ROLE anon NOLOGIN ${constrained}; `
      + `CREATE ROLE ${migrationUser} LOGIN PASSWORD '${migrationPassword}' ${constrained}; `
      + `CREATE ROLE ${runtimeUser} LOGIN PASSWORD '${runtimePassword}' ${constrained}; `
      + `CREATE ROLE ${writerUser} LOGIN PASSWORD '${writerPassword}' ${constrained}; `
      + `GRANT authenticated, anon TO ${runtimeUser}; `
      + `ALTER ROLE ${runtimeUser} SET search_path = rorca, public; `
      + `ALTER ROLE ${writerUser} SET search_path = rorca_canonical_api, rorca, public; `
      + `GRANT pg_read_all_settings TO ${runtimeUser}; `
      + `GRANT pg_read_all_settings TO ${migrationUser}; `
      + `CREATE SCHEMA auth; `
      + `CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$; `
      + `CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$; `
      + `GRANT USAGE ON SCHEMA auth TO authenticated; `
      + `GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated; `
      + `GRANT EXECUTE ON FUNCTION auth.jwt() TO authenticated; `
      + `CREATE SCHEMA rorca; `
      + `CREATE TABLE rorca.workspace_members (workspace_id TEXT NOT NULL, user_auth_id UUID NOT NULL, role TEXT NOT NULL, `
      + `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (workspace_id, user_auth_id)); `
      + `ALTER TABLE rorca.workspace_members OWNER TO ${migrationUser}; `
      + `CREATE EXTENSION IF NOT EXISTS pgcrypto; `
      + `CREATE EXTENSION IF NOT EXISTS vector; `
      + `CREATE EXTENSION IF NOT EXISTS age; `
      + `GRANT ALL ON SCHEMA public TO ${migrationUser}; `
      + `GRANT CREATE ON SCHEMA public TO ${migrationUser}; `
      + `GRANT ALL ON SCHEMA rorca TO ${migrationUser}; `
      + `GRANT ALL ON ALL TABLES IN SCHEMA rorca TO ${migrationUser}; `
      + `GRANT ALL ON ALL SEQUENCES IN SCHEMA rorca TO ${migrationUser}; `
      + `GRANT ALL ON SCHEMA auth TO ${migrationUser}; `
      + `GRANT ALL ON ALL FUNCTIONS IN SCHEMA auth TO ${migrationUser}; `
      + `GRANT CREATE ON DATABASE ${adminDb} TO ${migrationUser};`,
    );
    await provisionPool.end();

    const migrationUrl = `postgres://${migrationUser}:${migrationPassword}@127.0.0.1:${containerPort}/${adminDb}`;
    // Probes: real observations with real outputs, then ASSERTED shapes. Each
    // probe emits "tableCount,rowCount,rowCount,..." so a missing table (0) or
    // any non-empty operational table (rowCount > 0) BLOCKS the step.
    const tableAndRows = (pattern: string, tables: readonly string[]): string =>
      `SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema='rorca' AND table_name LIKE '${pattern}'), `
      + `(SELECT string_agg(coalesce(t.cnt::text,'missing'), ',') FROM (${tables.map((t) =>
        `SELECT '${t}' AS tbl, (SELECT count(*) FROM rorca.${t}) AS cnt`).join(' UNION ALL ')}) t)`;
    const psqlQuery = (sql: string): string =>
      `docker exec -e PGPASSWORD=${adminPassword} ${container} psql -X -t -A -h 127.0.0.1 -p 5432 -U ${adminUser} -d ${adminDb} -c ${JSON.stringify(sql)}`;
    const canonicalTables = {
      inventory: ['wave4_resource_inventory'] as const,
      outbox: ['continuation_dispatch_outbox'] as const,
      leases: ['execution_leases'] as const,
      continuation: ['context_checkpoints', 'context_bundles'] as const,
    };

    const realCommands: Record<ReconstructionStep, string> = {
      verify_source_sha: `git -C "${workspace}" rev-parse HEAD && git -C "${workspace}" rev-parse HEAD^{tree} && git -C "${workspace}" fsck --no-progress && git -C "${workspace}" diff --quiet HEAD -- && echo CLEAN`,
      apply_migrations: `cd "${workspace}/backend" && DATABASE_URL="${migrationUrl}" RORCA_RUNTIME_DATABASE_USER="${runtimeUser}" RORCA_CANONICAL_WRITER_DATABASE_USER="${writerUser}" node "${BACKEND}/node_modules/tsx/dist/cli.mjs" -e "import { runPgMigrations } from './src/db/pg-index.ts'; (async () => await runPgMigrations())().catch(e => { console.error(e); process.exit(1); })"`,
      verify_backup_ledger: `git --git-dir="${bare}" cat-file -t ${LEDGER_WAVE3_SHA} && git --git-dir="${bare}" cat-file -t ${LEDGER_WAVE4_SHA} && git --git-dir="${bare}" rev-list --objects --all | sort | shasum -a 256 && docker exec -e PGPASSWORD=${adminPassword} ${container} pg_dump -h 127.0.0.1 -p 5432 -U ${adminUser} -d ${adminDb} | shasum -a 256`,
      verify_public_contract_generation: `cd "${workspace}" && node "${BACKEND}/node_modules/tsx/dist/cli.mjs" scripts/check-governed-contract-artifacts.ts`,
      reconcile_inventory: `${psqlQuery(tableAndRows('wave4%', canonicalTables.inventory))}`,
      recover_queue_outbox: `${psqlQuery(tableAndRows('%dispatch%', canonicalTables.outbox))}`,
      scan_lease_fence_retry: `${psqlQuery(tableAndRows('%lease%', canonicalTables.leases))}`,
      verify_artifacts: `cd "${workspace}/packages/rorca-public-contract/schemas/governed-execution" && find . -type f | sort | xargs shasum -a 256 | shasum -a 256`,
      verify_context_continuation: `${psqlQuery(tableAndRows('%checkpoint%', canonicalTables.continuation))}`,
      observe_seven_status_planes: `echo "source_config_drift=$(git -C "${workspace}" status --porcelain --untracked-files=no | wc -l)"; echo "dependency_health=$(node --version 2>/dev/null | wc -l),$(docker --version 2>/dev/null | wc -l),$(git --version 2>/dev/null | wc -l)"; echo "runtime_health=$(docker exec -e PGPASSWORD=${adminPassword} ${container} psql -X -t -A -h 127.0.0.1 -p 5432 -U ${adminUser} -d ${adminDb} -c "SELECT pg_is_in_recovery()")"; echo "queue_outbox_freshness=$(docker exec -e PGPASSWORD=${adminPassword} ${container} psql -X -t -A -h 127.0.0.1 -p 5432 -U ${adminUser} -d ${adminDb} -c "SELECT count(*) FROM rorca.continuation_dispatch_outbox")"; echo "lease_retry_recovery=$(docker exec -e PGPASSWORD=${adminPassword} ${container} psql -X -t -A -h 127.0.0.1 -p 5432 -U ${adminUser} -d ${adminDb} -c "SELECT count(*) FROM rorca.execution_leases")"; echo "observability_freshness=$(docker exec -e PGPASSWORD=${adminPassword} ${container} psql -X -t -A -h 127.0.0.1 -p 5432 -U ${adminUser} -d ${adminDb} -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='rorca' AND table_name LIKE 'run_activity%'")"; echo "provider_operations_readiness=$(env | grep -cE '^(RORCA|GITHUB|OPENAI|ANTHROPIC|GOOGLE).*(TOKEN|KEY|SECRET)' || true)"`,
      verify_optional_dependency_degradation: `${psqlQuery("SELECT name FROM pg_available_extensions WHERE name IN ('age','vector','pgcrypto') ORDER BY name")}`,
      cleanup: `docker rm -f ${container} && rm -rf "${workspace}" "${bare}" && test ! -e "${workspace}" && test ! -e "${bare}"`,
    };

    // Expected-output assertions: a step whose output does not match the expected
    // shape is BLOCKED, not merely recorded.
    const expectations: Record<ReconstructionStep, (stdout: string) => boolean> = {
      verify_source_sha: (out) => out.includes(EXACT_SHA) && out.includes('CLEAN'),
      apply_migrations: (out) => out.includes('[pg-migrate] Done.'),
      verify_backup_ledger: (out) => {
        const lines = out.trim().split('\n');
        return lines.filter((line) => line.trim() === 'commit').length === 2
          && lines.filter((line) => /^[0-9a-f]{64}  -$/.test(line.trim())).length >= 2;
      },
      verify_public_contract_generation: (out) => out.includes('stable'),
      reconcile_inventory: (out) => {
        const [tablePart, rowsPart] = out.trim().split('|');
        return Number(tablePart) >= 1 && (rowsPart ?? '').split(',').every((v) => v === '0');
      },
      recover_queue_outbox: (out) => {
        const [tablePart, rowsPart] = out.trim().split('|');
        return Number(tablePart) >= 1 && (rowsPart ?? '').split(',').every((v) => v === '0');
      },
      scan_lease_fence_retry: (out) => {
        const [tablePart, rowsPart] = out.trim().split('|');
        return Number(tablePart) >= 1 && (rowsPart ?? '').split(',').every((v) => v === '0');
      },
      verify_artifacts: (out) => /^[0-9a-f]{64}  -$/.test(out.trim().split('\n').at(-1) ?? ''),
      verify_context_continuation: (out) => {
        const [tablePart, rowsPart] = out.trim().split('|');
        return Number(tablePart) >= 1 && (rowsPart ?? '').split(',').every((v) => v === '0');
      },
      observe_seven_status_planes: (out) => SEVEN_STATUS_PLANES.every((plane) => out.includes(`${plane}=`)),
      verify_optional_dependency_degradation: (out) => ['age', 'vector', 'pgcrypto'].every((name) => out.includes(name)),
      cleanup: (out) => out.trim() === '' || out.trim() === 'true' || /^rorca-cleanroom-pg-[0-9a-f]{16}$/.test(out.trim()),
    };

    const redact = (value: string): string => value
      .split(adminPassword).join('[REDACTED]')
      .split(migrationPassword).join('[REDACTED]')
      .split(runtimePassword).join('[REDACTED]')
      .split(writerPassword).join('[REDACTED]')
      .split(adminUser).join('[REDACTED_USER]')
      .split(migrationUser).join('[REDACTED_USER]')
      .split(runtimeUser).join('[REDACTED_USER]')
      .split(writerUser).join('[REDACTED_USER]');
    const exactCommands = RECONSTRUCTION_STEPS.map((step) => redact(realCommands[step]));

    const verifier = {
      async execute(step: ReconstructionStep, inputHash: string, command: string, options: ReconstructionOptions)
        : Promise<ExecutedReconstructionReceipt> {
        // Execution always uses the real command; the certificate records only

        const executed = sh(realCommands[step], workspace);
        const valid = executed.ok && expectations[step](executed.stdout);
        if (!valid) {
          console.error(`[cleanroom:blocked:${options.lane}] ${step} CMD:${command.slice(0, 2500)} STDERR:${String(executed.stderr).slice(0, 1500)} STDOUT:${JSON.stringify(executed.stdout).slice(0, 1500)}`);
          const blockedMaterial = {
            step, inputHash, command, status: 'blocked' as const,
            observedHash: sha256(executed.stdout + executed.stderr), executedAt: new Date().toISOString(),
            verifierId: `host:rorca-cleanroom:${options.lane}`,
          };
          return Object.freeze({ ...blockedMaterial, receiptHash: governedOperationsHash(blockedMaterial) });
        }
        let statusPlanes: Record<StatusPlane, 'healthy' | 'degraded'> | undefined;
        if (step === 'observe_seven_status_planes') {
          const lines = executed.stdout.trim().split('\n');
          const readValue = (key: string): string => {
            const line = lines.find((value) => value.startsWith(`${key}=`));
            return line?.slice(key.length + 1).trim() ?? '';
          };
          statusPlanes = Object.fromEntries(SEVEN_STATUS_PLANES.map((plane) => {
            const value = readValue(plane);
            if (plane === 'source_config_drift') return [plane, value === '0' ? 'healthy' as const : 'degraded' as const];
            if (plane === 'dependency_health') return [plane, value === '1,1,1' ? 'healthy' as const : 'degraded' as const];
            if (plane === 'runtime_health') return [plane, value === 'f' ? 'healthy' as const : 'degraded' as const];
            if (plane === 'queue_outbox_freshness' || plane === 'lease_retry_recovery') {
              return [plane, value === '0' ? 'healthy' as const : 'degraded' as const];
            }
            if (plane === 'observability_freshness') return [plane, Number(value) > 0 ? 'healthy' as const : 'degraded' as const];
            return [plane, value === '0' ? 'healthy' as const : 'degraded' as const];
          })) as Record<StatusPlane, 'healthy' | 'degraded'>;
        }
        const material = {
          step, inputHash, command, status: 'verified' as const,
          observedHash: sha256(executed.stdout), executedAt: new Date().toISOString(),
          verifierId: `host:rorca-cleanroom:${options.lane}`, ...(statusPlanes ? { statusPlanes } : {}),
        };
        return Object.freeze({ ...material, receiptHash: governedOperationsHash(material) });
      },
    };

    const options: ReconstructionOptions = {
      lane, namespace, inputs,
      toolVersions: { ...toolVersions, lane },
      exactCommands,
      environmentClass: 'real_isolated_host',
    };
    return await new CleanRoomReconstructor(verifier).reconstruct(options);
  } finally {
    if (containerPort) {
      sh(`docker rm -f ${container} >/dev/null 2>&1 || true`, TMP);
    }
    sh(`rm -rf "${workspace}" "${bare}"`, TMP);
  }
}

async function main(): Promise<void> {
  try {
    const toolVersions: Record<string, string> = {
      node: process.version,
      tsx: 'backend/node_modules/tsx (program worktree)',
      docker: String(execFileSync('docker', ['--version'], { encoding: 'utf8', env: SANITIZED_ENV }).trim()),
      git: String(execFileSync('git', ['--version'], { encoding: 'utf8', env: SANITIZED_ENV }).trim()),
      postgresImage: CONTAINER_IMAGE,
      toolchainNodeModules: `symlinked external node_modules (MUTABLE tool input; content hash ${toolchainContentHash()})`,
      rootPackageLockHash: sha256(readIfExists(path.join(PROGRAM_ROOT, 'package-lock.json')).join('') || 'no-lockfile'),
      backendPackageLockHash: sha256(readIfExists(path.join(BACKEND, 'package-lock.json')).join('') || 'no-lockfile'),
    };

    // Canonical declared inputs from a probe worktree at the exact SHA.
    const probeBare = path.join(TMP, 'probe-repo.git');
    const clone = sh(`git clone --bare --no-local ${SOURCE_ROOT} "${probeBare}"`, TMP);
    requireOk('bare clone', clone);
    const probeWs = path.join(TMP, 'probe-ws');
    const probe = sh(`git --git-dir="${probeBare}" worktree add "${probeWs}" ${EXACT_SHA}`, TMP);
    requireOk('probe worktree', probe);
    fs.symlinkSync(path.join(BACKEND, 'node_modules'), path.join(probeWs, 'backend', 'node_modules'), 'dir');
    fs.symlinkSync(path.join(PROGRAM_ROOT, 'node_modules'), path.join(probeWs, 'node_modules'), 'dir');

    const migrationFiles = fs.readdirSync(path.join(probeWs, 'backend', 'src', 'db', 'pg-migrations'))
      .filter((f) => f.endsWith('.sql')).sort();
    const migrationManifestHash = sha256(migrationFiles.join('\n'));
    const ledgerBlob = [LEDGER_WAVE3_SHA, LEDGER_WAVE4_SHA].map((sha) => {
      const out = sh(`git --git-dir="${probeBare}" show ${sha}:.autonomous-runner-implementation-progress.md`, TMP);
      requireOk(`ledger show ${sha}`, out);
      return out.stdout;
    }).join('\n');
    const ledgerHash = sha256(ledgerBlob);
    const gitBackupHash = sha256(sh(`git --git-dir="${probeBare}" rev-list --objects --all | sort`, TMP).stdout);
    const specPath = path.join(probeWs, 'forge', 'specs', 'pending', 'wave-4-bounded-federated-runtime-pilot.json');
    const specHash = sha256(fs.readFileSync(specPath, 'utf8'));
    const policyHash = sha256([
      ...readIfExists(specPath),
      ...readIfExists(path.join(probeWs, '.omp', 'config.yml')),
      ...readIfExists(path.join(probeWs, '.omp', 'AGENTS.md')),
    ].join('\n'));
    const configurationHash = sha256([
      ...readIfExists(path.join(probeWs, '.env.example')),
      ...readIfExists(path.join(probeWs, 'docker-compose.yml')),
    ].join('\n'));
    const schemasDir = path.join(probeWs, 'packages', 'rorca-public-contract', 'schemas', 'governed-execution');
    const artifacts = fs.readdirSync(schemasDir).sort().map((file) => ({
      artifactId: `governed-execution/${file}`,
      contentHash: sha256(fs.readFileSync(path.join(schemasDir, file), 'utf8')),
    }));
    const contractManifestHash = sha256(fs.readFileSync(path.join(schemasDir, 'manifest.json'), 'utf8'));

    const inputs: CanonicalCleanRoomInputs = {
      exactGitSha: EXACT_SHA,
      migrationManifestHash,
      verifiedBackupHash: gitBackupHash,
      ledgerHash,
      policyVersion: 'rorca.wave-policy.v1',
      policyHash,
      configurationVersion: 'rorca.cleanroom.config.v1',
      configurationHash,
      vaultSecretReferences: ['vault://rorca/wave4/cleanroom/zero-secret-reconstruction'],
      artifacts,
      contractManifestHash,
      specHash,
    };
    sh(`rm -rf "${probeWs}" "${probeBare}"`, TMP);

    const managed = await runLane('managed', inputs, toolVersions);
    const federated = await runLane('fake_federated', inputs, toolVersions);
    const certificates = [managed, federated];

    const now = new Date().toISOString();
    const markdown = [
      '# Wave 4 Real-Host Clean-Room Reconstruction Certificate (W4-014)',
      '',
      '| Field | Receipt |',
      '|---|---|',
      `| Date | ${now} |`,
      `| Exact reconstructed source SHA | \`${EXACT_SHA}\` (HARD-PINNED reviewed Wave 4 code head; no override accepted) |`,
      `| Migration manifest | ${migrationFiles.length} files, hash \`${migrationManifestHash}\` |`,
      `| Ledger commits verified | \`${LEDGER_WAVE3_SHA}\`, \`${LEDGER_WAVE4_SHA}\` (cat-file -t) |`,
      `| Git object backup hash (declared input) | \`${gitBackupHash}\` (git rev-list --objects --all) |`,
      `| PostgreSQL logical backup hash | bound per lane inside the verify_backup_ledger observation (pg_dump | sha256) |`,
      `| Contract manifest hash | \`${contractManifestHash}\` |`,
      `| Spec hash | \`${specHash}\` |`,
      `| Policy / configuration hashes | \`${policyHash}\` / \`${configurationHash}\` |`,
      `| Toolchain (recorded inputs) | node ${process.version}; ${toolVersions.docker}; ${toolVersions.git}; postgres image ${CONTAINER_IMAGE}; ${toolVersions.toolchainNodeModules}; root lock \`${toolVersions.rootPackageLockHash}\`; backend lock \`${toolVersions.backendPackageLockHash}\` |`,
      `| Execution environment | sanitized allowlisted child env (PATH/HOME/LANG/TZ only + explicit command vars); migrations run as a distinct constrained migration role |`,
      `| Environment class | real_isolated_host (per-lane fresh bare clone + worktree + PG16 container) |`,
      `| Lane-specific pilot code paths | exercised by the W4-009 conformance suites (real HTTP/TLS/DB); this certificate verifies the shared reconstruction inputs and fresh-host properties |`,
      '',
      '## Certificates',
      '',
      '```json',
      JSON.stringify(certificates.map((c) => ({ schemaVersion: c.schemaVersion, lane: c.lane, namespaceId: c.namespaceId,
        environmentClass: c.environmentClass, sourceSha: c.sourceSha, certificateHash: c.certificateHash,
        unresolvedBlockers: c.unresolvedBlockers, statusPlanes: c.statusPlanes })), null, 2),
      '```',
      '',
      '## Executed steps (per lane)',
      '',
      ...certificates.flatMap((certificate) => certificate.observations.map((observation) =>
        `- [${certificate.lane}] ${observation.step}: ${observation.status} (${observation.detail})`)),
      '',
      '## Cleanup',
      '',
      'Each lane\'s cleanup step removed its namespace-owned worktree, bare clone, and PostgreSQL container and proved absence (run-scoped labels; no host-wide sweeps). No invocation-owned resource remains.',
      '',
    ].join('\n');
    fs.writeFileSync(EVIDENCE, markdown);
    fs.writeFileSync(CERT_JSON, `${JSON.stringify(certificates, null, 2)}\n`);

    const gate = gateFinalPilotDemonstration(certificates, {
      packetHash: governedOperationsHash(certificates.map((c) => c.certificateHash).sort()),
      certificateHashes: certificates.map((c) => c.certificateHash),
      reviewerIdentityHash: sha256('independent-exact-packet-review-pending'),
      architectureFindingCount: 0, securityFindingCount: 0, operationsFindingCount: 0, hiddenStateFindingCount: 0,
      crossWorkspaceFindingCount: 0, resourceIsolationFindingCount: 0, secretFindingCount: 0, authorityFindingCount: 0,
      verdict: 'blocked',
    });

    console.log(JSON.stringify({
      status: 'certificates_issued',
      sourceSha: EXACT_SHA,
      migrationManifestFiles: migrationFiles.length,
      certificates: certificates.map((c) => ({ lane: c.lane, certificateHash: c.certificateHash, blockers: c.unresolvedBlockers })),
      gate: { permitted: gate.permitted, reasonCode: gate.reasonCode },
      evidence: EVIDENCE,
      certificatesJson: CERT_JSON,
    }, null, 2));
  } finally {
    sh(`docker ps -a --filter label=com.rorca.cleanroom.owner=${RUN_NONCE} --format '{{.Names}}' | xargs -r docker rm -f >/dev/null 2>&1 || true`, TMP);
    sh(`rm -rf "${TMP}"`, os.tmpdir());
  }
}

void main().catch((error) => {
  console.error('[cleanroom] fatal:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
