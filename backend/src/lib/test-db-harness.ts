/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Provision and exactly clean one nonce-owned PostgreSQL 16 Jest target. */

import * as crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from 'pg';
import { requireCurrentProcessStartIdentity } from './process-instance-identity';
import {
  JEST_INVOCATION_PREFIX,
  OWNER_HEARTBEAT_FILENAME,
  TEST_DB_STATE_SCHEMA_VERSION,
  readIsolatedTestDatabaseState,
  readStaleIsolatedTestDatabaseState,
  type IsolatedTestDatabaseState,
} from './test-db-safety';

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function writeState(state: IsolatedTestDatabaseState): void {
  const temporary = `${state.stateFile}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, state.stateFile);
  fs.chmodSync(state.stateFile, 0o600);
}

function executable(filePath: string): boolean {
  try { fs.accessSync(filePath, fs.constants.X_OK); return true; } catch { return false; }
}

function findPg16Bin(env: NodeJS.ProcessEnv): string | null {
  const configured = [env.RORCA_TEST_PG_BIN, env.PG16_BIN].filter((value): value is string => Boolean(value));
  const candidates = [
    ...configured,
    '/usr/local/opt/postgresql@16/bin',
    '/opt/homebrew/opt/postgresql@16/bin',
    '/usr/lib/postgresql/16/bin',
  ];
  try {
    const pgConfig = execFileSync('sh', ['-c', 'command -v pg_config'], { encoding: 'utf8' }).trim();
    if (pgConfig) candidates.push(path.dirname(pgConfig));
  } catch { /* no host client */ }
  for (const candidate of [...new Set(candidates.map(value => path.resolve(value)))]) {
    if (!['initdb', 'pg_ctl', 'postgres'].every(tool => executable(path.join(candidate, tool)))) continue;
    const version = execFileSync(path.join(candidate, 'postgres'), ['--version'], { encoding: 'utf8' });
    if (!/\b16\.\d+\b/.test(version)) continue;
    try {
      const shared = execFileSync(path.join(candidate, 'pg_config'), ['--sharedir'], { encoding: 'utf8' }).trim();
      if (!fs.existsSync(path.join(shared, 'extension', 'vector.control'))) continue;
    } catch { continue; }
    return candidate;
  }
  return null;
}

function connectionUrl(input: {
  user: string;
  password?: string;
  database: string;
  applicationName: string;
  host?: string;
  port?: number;
  socketDirectory?: string;
}): string {
  const auth = input.password
    ? `${encodeURIComponent(input.user)}:${encodeURIComponent(input.password)}`
    : encodeURIComponent(input.user);
  const url = new URL(`postgresql://${auth}@${input.host ?? 'localhost'}:${input.port ?? 5432}/${encodeURIComponent(input.database)}`);
  url.searchParams.set('application_name', input.applicationName);
  if (input.socketDirectory) url.searchParams.set('host', input.socketDirectory);
  url.searchParams.set('connect_timeout', '5');
  return url.toString();
}

async function connectWithRetry(connectionString: string, attempts = 60): Promise<Client> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const client = new Client({ connectionString });
    try {
      await client.connect();
      return client;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Invocation-owned PostgreSQL did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function invocationSocketDirectory(state: IsolatedTestDatabaseState): string {
  // Darwin's per-user temp root plus the invocation directory exceeds the
  // sockaddr_un path limit. Keep the exact nonce identity while using /tmp's
  // short canonical path; cleanup validates this path before removal.
  return process.platform === 'darwin'
    ? path.join(fs.realpathSync('/tmp'), `rorca-js-${state.invocationId}`)
    : path.join(state.root, 'socket');
}


async function startLocalCluster(
  state: IsolatedTestDatabaseState,
  env: NodeJS.ProcessEnv,
): Promise<IsolatedTestDatabaseState> {
  const pgBin = findPg16Bin(env);
  if (!pgBin) throw new Error('No local PostgreSQL 16 installation with pgvector is available');
  const dataDirectory = path.join(state.root, 'pgdata');
  const socketDirectory = invocationSocketDirectory(state);
  fs.mkdirSync(socketDirectory, { mode: 0o700 });
  const admin = `rorca_jest_admin_${state.invocationId}`;
  const init = spawnSync(path.join(pgBin, 'initdb'), [
    '-D', dataDirectory,
    '--username', admin,
    '--auth-local=trust',
    '--auth-host=reject',
    '--set', 'shared_memory_type=mmap',
    '--set', 'dynamic_shared_memory_type=posix',
    '--no-instructions',
    '--encoding=UTF8',
  ], { encoding: 'utf8', timeout: 60_000, env: { ...env, LC_ALL: 'C' } });
  if (init.status !== 0) throw new Error(`initdb failed: ${String(init.stderr).slice(-2000)}`);
  fs.appendFileSync(path.join(dataDirectory, 'postgresql.conf'), [
    "listen_addresses = ''",
    `unix_socket_directories = ${quoteLiteral(socketDirectory)}`,
    'unix_socket_permissions = 0700',
    'max_connections = 40',
    'fsync = off',
    'synchronous_commit = off',
    'full_page_writes = off',
    '',
  ].join('\n'));
  const logPath = path.join(state.root, 'postgres.log');
  state = { ...state, status: 'starting', mode: 'local-cluster', pgBin, dataDirectory, socketDirectory };
  writeState(state);
  const start = spawnSync(path.join(pgBin, 'pg_ctl'), [
    '-D', dataDirectory, '-l', logPath, '-w', '-t', '30', 'start',
  ], { encoding: 'utf8', timeout: 40_000, env: { ...env } });
  if (start.status !== 0) throw new Error(`pg_ctl start failed: ${String(start.stderr).slice(-2000)} ${fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').slice(-2000) : ''}`);
  return {
    ...state,
    adminDatabaseUrl: connectionUrl({
      user: admin,
      database: 'postgres',
      applicationName: `rorca-jest-admin:${state.invocationId}`,
      socketDirectory,
    }),
  };
}

async function startDockerCluster(
  state: IsolatedTestDatabaseState,
  env: NodeJS.ProcessEnv,
): Promise<IsolatedTestDatabaseState> {
  const docker = env.RORCA_TEST_DOCKER_BIN || 'docker';
  const probe = spawnSync(docker, ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8', timeout: 15_000, env: { ...env },
  });
  if (probe.status !== 0) throw new Error('Neither a local PG16+pgvector installation nor Docker is available');
  const containerName = `rorca-jest-pg16-${state.invocationId}`;
  const admin = `rorca_jest_admin_${state.invocationId}`;
  const password = crypto.randomBytes(24).toString('hex');
  const image = env.RORCA_TEST_POSTGRES_IMAGE || 'rorca-postgres:pg16-age';
  const imageProbe = spawnSync(docker, ['image', 'inspect', image], {
    encoding: 'utf8', timeout: 15_000, env: { ...env },
  });
  // Test isolation may create and remove only this invocation's labeled
  // container. Building/tagging an image here would mutate shared Docker image
  // state, so image availability is an explicit external prerequisite.
  if (imageProbe.status !== 0) {
    throw new Error(`Invocation PostgreSQL requires a prebuilt local image: ${image}`);
  }
  // Persist the intended exact name/label before `docker run`; a wrapper crash
  // after daemon-side creation but before stdout capture remains recoverable.
  state = { ...state, status: 'starting', mode: 'docker-container', containerName };
  writeState(state);
  const run = spawnSync(docker, [
    'run', '--detach', '--rm',
    '--name', containerName,
    '--label', `com.rorca.jest-invocation=${state.invocationId}`,
    // Keep the entire invocation cluster off shared Docker storage. The
    // bounded tmpfs disappears with this exact labeled container.
    '--tmpfs', '/var/lib/postgresql/data:rw,size=1073741824,mode=0700,uid=999,gid=999',
    // PostgreSQL initdb and parallel workers allocate their shared segment in
    // /dev/shm; Docker's 64MiB default is too small on macOS/CI hosts.
    '--shm-size', '1073741824',
    '--publish', '127.0.0.1::5432',
    '--env', `POSTGRES_USER=${admin}`,
    '--env', `POSTGRES_PASSWORD=${password}`,
    '--env', 'POSTGRES_DB=postgres',
    image,
  ], { encoding: 'utf8', timeout: 120_000, env: { ...env } });
  if (run.status !== 0) throw new Error(`Docker PostgreSQL start failed: ${String(run.stderr).slice(-2000)}`);
  const containerId = run.stdout.trim();
  if (!/^[a-f0-9]{64}$/.test(containerId)) throw new Error('Docker did not return the exact invocation container identity');
  state = { ...state, containerId };
  writeState(state);
  const portOutput = execFileSync(docker, ['port', containerName, '5432/tcp'], {
    encoding: 'utf8', env: { ...env },
  }).trim();
  const port = Number(portOutput.match(/:(\d+)$/)?.[1]);
  if (!Number.isSafeInteger(port) || port <= 0) throw new Error('Docker did not publish the invocation-owned PostgreSQL port');
  return {
    ...state,
    adminDatabaseUrl: connectionUrl({
      user: admin,
      password,
      database: 'postgres',
      applicationName: `rorca-jest-admin:${state.invocationId}`,
      host: '127.0.0.1',
      port,
    }),
  };
}

async function provisionDatabase(
  state: IsolatedTestDatabaseState,
  env: NodeJS.ProcessEnv,
): Promise<IsolatedTestDatabaseState> {
  const runtimeRole = `rorca_jest_${state.invocationId}_runner`;
  const migrationRole = `rorca_jest_${state.invocationId}_migration`;
  const writerRole = `rorca_jest_${state.invocationId}_writer`;
  const runtimePassword = crypto.randomBytes(24).toString('hex');
  const migrationPassword = crypto.randomBytes(24).toString('hex');
  const writerPassword = crypto.randomBytes(24).toString('hex');
  const database = `rorca_jest_${state.invocationId}_test`;
  const marker = `rorca-jest-owned:${state.invocationId}:${state.leaseTokenHash}`;
  const applicationName = `rorca-jest:${state.invocationId}`;
  const constrainedRoleAttributes = 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 32';
  const admin = await connectWithRetry(state.adminDatabaseUrl!);
  try {
    await admin.query(`CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await admin.query(`CREATE ROLE anon NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await admin.query(`CREATE ROLE ${quoteIdent(runtimeRole)} LOGIN PASSWORD ${quoteLiteral(runtimePassword)} ${constrainedRoleAttributes}`);
    await admin.query(`CREATE ROLE ${quoteIdent(migrationRole)} LOGIN PASSWORD ${quoteLiteral(migrationPassword)} ${constrainedRoleAttributes}`);
    await admin.query(`CREATE ROLE ${quoteIdent(writerRole)} LOGIN PASSWORD ${quoteLiteral(writerPassword)} ${constrainedRoleAttributes}`);
    await admin.query(`GRANT authenticated, anon TO ${quoteIdent(runtimeRole)}`);
    await admin.query(`ALTER ROLE ${quoteIdent(runtimeRole)} SET search_path = rorca, public`);
    await admin.query(`ALTER ROLE ${quoteIdent(migrationRole)} SET search_path = rorca, public`);
    await admin.query(`ALTER ROLE ${quoteIdent(writerRole)} SET search_path = rorca_canonical_api, rorca, public`);
    // Runtime and migration guards read server identity. The canonical writer
    // must have no role memberships, including predefined read roles.
    await admin.query(`GRANT pg_read_all_settings TO ${quoteIdent(runtimeRole)}`);
    await admin.query(`GRANT pg_read_all_settings TO ${quoteIdent(migrationRole)}`);
    if (state.mode === 'docker-container' && state.containerName) {
      const docker = env.RORCA_TEST_DOCKER_BIN || 'docker';
      const plugin = spawnSync(docker, ['exec', state.containerName, 'sh', '-c',
        'd="$(pg_config --pkglibdir)"; mkdir -p "$d/plugins"; ln -sf "$d/age.so" "$d/plugins/age.so"'],
      { encoding: 'utf8', timeout: 15_000, env: { ...env } });
      if (plugin.status !== 0) throw new Error(`Could not prepare invocation-only AGE plugin path: ${String(plugin.stderr).slice(-1000)}`);
      await admin.query(`ALTER ROLE ${quoteIdent(runtimeRole)} SET dynamic_library_path = ${quoteLiteral('$libdir/plugins')}`);
      await admin.query(`ALTER ROLE ${quoteIdent(migrationRole)} SET dynamic_library_path = ${quoteLiteral('$libdir/plugins')}`);
      await admin.query(`ALTER ROLE ${quoteIdent(writerRole)} SET dynamic_library_path = ${quoteLiteral('$libdir/plugins')}`);
    }
    await admin.query(`CREATE DATABASE rorca`);
    await admin.query(`REVOKE CONNECT ON DATABASE rorca FROM PUBLIC`);
    await admin.query(`REVOKE CONNECT ON DATABASE rorca FROM ${quoteIdent(runtimeRole)}`);
    await admin.query(`REVOKE CONNECT ON DATABASE rorca FROM ${quoteIdent(migrationRole)}`);
    await admin.query(`REVOKE CONNECT ON DATABASE rorca FROM ${quoteIdent(writerRole)}`);
    await admin.query(`CREATE DATABASE ${quoteIdent(database)} OWNER ${quoteIdent(migrationRole)} TEMPLATE template0`);
    await admin.query(`COMMENT ON DATABASE ${quoteIdent(database)} IS ${quoteLiteral(marker)}`);
    const identity = await admin.query<{ system_identifier: string; data_directory: string; server_version: string }>(`
      SELECT control.system_identifier::text AS system_identifier,
             current_setting('data_directory') AS data_directory,
             current_setting('server_version') AS server_version
        FROM pg_control_system() control
    `);
    const row = identity.rows[0];
    if (!row || !row.server_version.startsWith('16.')) throw new Error('Invocation server is not PostgreSQL 16');
    state = {
      ...state,
      database,
      user: runtimeRole,
      marker,
      applicationName,
      systemIdentifier: row.system_identifier,
      dataDirectory: state.mode === 'local-cluster' ? fs.realpathSync(row.data_directory) : row.data_directory,
      serverVersion: row.server_version,
    };
  } finally {
    await admin.end();
  }

  const adminTestUrl = new URL(state.adminDatabaseUrl!);
  adminTestUrl.pathname = `/${database}`;
  const adminTest = await connectWithRetry(adminTestUrl.toString());
  let extensions: string[] = [];
  try {
    const available = await adminTest.query<{ name: string }>(
      `SELECT name FROM pg_available_extensions WHERE name IN ('age','vector','pgcrypto') ORDER BY name`,
    );
    extensions = available.rows.map(row => row.name);
    for (const required of ['pgcrypto', 'vector']) {
      if (!extensions.includes(required)) throw new Error(`Invocation server lacks required extension ${required}`);
    }
    for (const extension of extensions) await adminTest.query(`CREATE EXTENSION IF NOT EXISTS ${quoteIdent(extension)}`);
  } finally {
    await adminTest.end();
  }

  const adminUrl = new URL(state.adminDatabaseUrl!);
  const connectionTarget = {
    database,
    host: state.mode === 'docker-container' ? adminUrl.hostname : undefined,
    port: state.mode === 'docker-container' ? Number(adminUrl.port) : undefined,
    socketDirectory: state.mode === 'local-cluster' ? state.socketDirectory : undefined,
  };
  const databaseUrl = connectionUrl({
    ...connectionTarget,
    user: runtimeRole,
    password: runtimePassword,
    applicationName,
  });
  const migrationDatabaseUrl = connectionUrl({
    ...connectionTarget,
    user: migrationRole,
    password: migrationPassword,
    applicationName: `rorca-jest-migration:${state.invocationId}`,
  });
  const canonicalWriterDatabaseUrl = connectionUrl({
    ...connectionTarget,
    user: writerRole,
    password: writerPassword,
    applicationName: `rorca-jest-writer:${state.invocationId}`,
  });
  const migrator = await connectWithRetry(migrationDatabaseUrl);
  try {
    // Supabase supplies this authority table in hosted environments. The fresh
    // standalone harness creates the same minimal contract before repository
    // migrations install policies that reference it.
    await migrator.query('CREATE SCHEMA rorca');
    await migrator.query(`CREATE TABLE rorca.workspace_members (
      workspace_id TEXT NOT NULL,
      user_auth_id UUID NOT NULL,
      role TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (workspace_id, user_auth_id)
    )`);
    await migrator.query('CREATE SCHEMA auth');
    await migrator.query(`CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$`);
    await migrator.query(`CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
      SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
    $$`);
    await migrator.query('GRANT USAGE ON SCHEMA auth TO authenticated');
    await migrator.query('GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated');
    await migrator.query('GRANT EXECUTE ON FUNCTION auth.jwt() TO authenticated');
  } finally {
    await migrator.end();
  }
  return {
    ...state,
    databaseUrl,
    migrationDatabaseUrl,
    canonicalWriterDatabaseUrl,
    extensions,
    status: 'ready',
  };
}

/**
 * Allocate a fresh invocation-owned lease (state file + owner lease) and
 * provision the isolated PostgreSQL cluster against it. The calling process
 * becomes the lease owner: its exact process-start identity is recorded and
 * every consumer (including sandboxed Jest) must observe it alive and exact
 * before using the database.
 */
export async function allocateIsolatedTestDatabase(
  env: NodeJS.ProcessEnv = process.env,
): Promise<IsolatedTestDatabaseState> {
  const invocationId = crypto.randomBytes(12).toString('hex');
  const root = path.join(fs.realpathSync(os.tmpdir()), `${JEST_INVOCATION_PREFIX}${invocationId}`);
  fs.mkdirSync(root, { mode: 0o700 });
  const ownerPid = process.pid;
  const ownerProcessStartIdentity = requireCurrentProcessStartIdentity();
  const ownerInstanceNonce = crypto.randomBytes(32).toString('hex');
  const token = crypto.randomBytes(32).toString('hex');
  const stateFile = path.join(root, 'database-state.json');
  const leaseFile = path.join(root, 'owner.lease');
  const state: IsolatedTestDatabaseState = {
    schemaVersion: TEST_DB_STATE_SCHEMA_VERSION,
    invocationId,
    ownerPid,
    ownerProcessStartIdentity,
    ownerInstanceNonce,
    root,
    leaseFile,
    leaseTokenHash: `sha256:${crypto.createHash('sha256').update(token).digest('hex')}`,
    stateFile,
    status: 'allocated',
  };
  writeState(state);
  fs.writeFileSync(leaseFile, `${JSON.stringify({
    invocationId,
    ownerPid,
    ownerProcessStartIdentity,
    ownerInstanceNonce,
    token,
  })}\n`, { mode: 0o600, flag: 'wx' });
  return provisionIsolatedTestDatabase({
    ...env,
    RORCA_JEST_INVOCATION_ID: invocationId,
    RORCA_JEST_STATE_FILE: stateFile,
    RORCA_JEST_OWNER_PID: String(ownerPid),
  });
}
/**
 * Rewrite the lease owner's signed heartbeat. Called periodically by the
 * lease-owning process (the engine) so sandboxed consumers can prove the
 * owner is alive without process observation (ps is setuid on Darwin and
 * cannot exec inside the seatbelt).
 */
export function touchIsolatedTestDatabaseHeartbeat(env: NodeJS.ProcessEnv = process.env): void {
  const state = readIsolatedTestDatabaseState(env);
  if (state.status !== 'ready') throw new Error(`Cannot heartbeat invocation database from state ${state.status}`);
  const lease = JSON.parse(fs.readFileSync(state.leaseFile, 'utf8')) as { token?: unknown };
  if (typeof lease.token !== 'string') throw new Error('Invocation lease token is unavailable');
  const ts = Date.now();
  fs.writeFileSync(
    path.join(state.root, OWNER_HEARTBEAT_FILENAME),
    `${JSON.stringify({ ts, hash: `sha256:${crypto.createHash('sha256').update(`${lease.token}:${ts}`).digest('hex')}` })}\n`,
    { mode: 0o600 },
  );
}


export async function provisionIsolatedTestDatabase(env: NodeJS.ProcessEnv = process.env): Promise<IsolatedTestDatabaseState> {
  let state = readIsolatedTestDatabaseState(env);
  if (state.status === 'ready') return state;
  if (state.status !== 'allocated') throw new Error(`Cannot provision invocation database from state ${state.status}`);
  try {
    const localPg = findPg16Bin(env);
    if (localPg && env.RORCA_TEST_DATABASE_MODE !== 'docker') {
      try {
        state = await startLocalCluster(state, env);
      } catch (localError) {
        // Some constrained Darwin hosts exhaust the system-wide SysV segment
        // table even for initdb. Remove only this invocation's partial data and
        // fall back to one nonce-labeled container, never a shared server.
        const partial = readIsolatedTestDatabaseState(env);
        if (partial.mode === 'local-cluster' && partial.pgBin && partial.dataDirectory) {
          stopExactLocalCluster(partial, env);
          fs.rmSync(partial.dataDirectory, { recursive: true, force: true });
          if (partial.socketDirectory) removeExactLocalSocketDirectory(partial);
          for (const file of ['postgres.log']) fs.rmSync(path.join(partial.root, file), { force: true });
        }
        state = {
          schemaVersion: partial.schemaVersion,
          invocationId: partial.invocationId,
          ownerPid: partial.ownerPid,
          ownerProcessStartIdentity: partial.ownerProcessStartIdentity,
          ownerInstanceNonce: partial.ownerInstanceNonce,
          root: partial.root,
          leaseFile: partial.leaseFile,
          leaseTokenHash: partial.leaseTokenHash,
          stateFile: partial.stateFile,
          status: 'allocated',
        };
        writeState(state);
        console.warn(`[jest-setup] local PG16 unavailable for this invocation; using exact Docker fallback: ${localError instanceof Error ? localError.message.split('\n')[0] : String(localError)}`);
        state = await startDockerCluster(state, env);
      }
    } else {
      state = await startDockerCluster(state, env);
    }
    state = await provisionDatabase(state, env);
    writeState(state);
    return state;
  } catch (error) {
    // startLocalCluster/startDockerCluster persist resource identity before the
    // side effect whose result may be ambiguous. An awaited assignment does
    // not update this function's local `state` when that call rejects, so read
    // the durable current identity before marking failure. Never overwrite it
    // with the stale pre-start `allocated` snapshot.
    let statePersistenceError: unknown;
    try {
      const durableState = readIsolatedTestDatabaseState(env);
      writeState({ ...durableState, status: 'failed' });
    } catch (caughtStatePersistenceError) {
      statePersistenceError = caughtStatePersistenceError;
    }
    try {
      await cleanupIsolatedTestDatabase(env);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, ...(statePersistenceError ? [statePersistenceError] : []), cleanupError],
        'Invocation PostgreSQL provisioning and exact cleanup both failed',
      );
    }
    if (statePersistenceError) {
      throw new AggregateError(
        [error, statePersistenceError],
        'Invocation PostgreSQL provisioning failed and durable failure state could not be recorded',
      );
    }
    throw error;
  }
}

function assertCleanupRoot(state: IsolatedTestDatabaseState): void {
  const expected = path.join(fs.realpathSync(os.tmpdir()), `${JEST_INVOCATION_PREFIX}${state.invocationId}`);
  if (state.root !== expected || path.resolve(state.root) !== expected) throw new Error('Refusing cleanup outside exact Jest invocation root');
}

function cleanupCommandTimeout(env: NodeJS.ProcessEnv, fallback: number): number {
  const configured = Number(env.RORCA_TEST_CLEANUP_COMMAND_TIMEOUT_MS);
  if (Number.isSafeInteger(configured) && configured >= 25 && configured <= fallback) return configured;
  return fallback;
}

function commandFailure(label: string, result: ReturnType<typeof spawnSync>): Error {
  const detail = [result.error?.message, result.signal, result.stderr, result.stdout]
    .filter(Boolean).join(' ').trim().slice(-2_000);
  return new Error(`${label} failed (${result.status ?? result.signal ?? (result.error as NodeJS.ErrnoException | undefined)?.code ?? 'unknown'})${detail ? `: ${detail}` : ''}`);
}

function exactLocalDataDirectory(state: IsolatedTestDatabaseState): string {
  if (!state.pgBin || !path.isAbsolute(state.pgBin) || !state.dataDirectory) {
    throw new Error('Local PostgreSQL cleanup lacks exact binary/data identity');
  }
  const expected = path.join(state.root, 'pgdata');
  if (path.resolve(state.dataDirectory) !== expected) throw new Error('Local PostgreSQL data directory escaped the exact invocation root');
  if (!fs.existsSync(expected)) return expected;
  const stat = fs.lstatSync(expected);
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(expected) !== expected) {
    throw new Error('Local PostgreSQL data directory changed identity');
  }
  fs.accessSync(path.join(state.pgBin, 'pg_ctl'), fs.constants.X_OK);
  return expected;
}

function exactLocalSocketDirectory(state: IsolatedTestDatabaseState): string {
  if (!state.socketDirectory) throw new Error('Local PostgreSQL cleanup lacks exact socket identity');
  const expected = invocationSocketDirectory(state);
  if (path.resolve(state.socketDirectory) !== expected) {
    throw new Error('Local PostgreSQL socket directory escaped the exact invocation identity');
  }
  if (!fs.existsSync(expected)) return expected;
  const stat = fs.lstatSync(expected);
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(expected) !== expected) {
    throw new Error('Local PostgreSQL socket directory changed identity');
  }
  return expected;
}

function removeExactLocalSocketDirectory(state: IsolatedTestDatabaseState): void {
  const socketDirectory = exactLocalSocketDirectory(state);
  if (fs.existsSync(socketDirectory)) fs.rmSync(socketDirectory, { recursive: true, force: false });
}


function localClusterStatus(state: IsolatedTestDatabaseState, env: NodeJS.ProcessEnv): 'running' | 'stopped' {
  const dataDirectory = exactLocalDataDirectory(state);
  if (!fs.existsSync(dataDirectory)) return 'stopped';
  const result = spawnSync(path.join(state.pgBin!, 'pg_ctl'), ['-D', dataDirectory, 'status'], {
    encoding: 'utf8',
    timeout: cleanupCommandTimeout(env, 10_000),
    env: { ...env },
  });
  if (result.error || result.signal) throw commandFailure('pg_ctl status', result);
  if (result.status === 0) return 'running';
  if (result.status === 3) return 'stopped';
  throw commandFailure('pg_ctl status', result);
}

function stopExactLocalCluster(state: IsolatedTestDatabaseState, env: NodeJS.ProcessEnv): void {
  if (localClusterStatus(state, env) === 'stopped') return;
  const result = spawnSync(path.join(state.pgBin!, 'pg_ctl'), [
    '-D', state.dataDirectory!, '-m', 'immediate', '-w', '-t', '30', 'stop',
  ], {
    encoding: 'utf8',
    timeout: cleanupCommandTimeout(env, 40_000),
    env: { ...env },
  });
  if (result.error || result.signal || result.status !== 0) throw commandFailure('pg_ctl stop', result);
  if (localClusterStatus(state, env) !== 'stopped') {
    throw new Error('pg_ctl stop returned success but the exact invocation postmaster remains active');
  }
}

interface DockerIdentity {
  id: string;
  label: string;
  name: string;
}

function parseDockerIdentity(output: string): DockerIdentity | null {
  const line = output.trim();
  if (!line) return null;
  const [id, label, rawName] = line.split('|');
  if (!id || !label || !rawName) throw new Error('Docker returned an incomplete invocation identity');
  return { id, label, name: rawName.replace(/^\//, '') };
}

function inspectExactDockerContainer(
  state: IsolatedTestDatabaseState,
  env: NodeJS.ProcessEnv,
): DockerIdentity | null {
  if (!state.containerName || !/^rorca-jest-pg16-[a-f0-9]{24}$/.test(state.containerName)) {
    throw new Error('Docker cleanup lacks an exact invocation container name');
  }
  const docker = env.RORCA_TEST_DOCKER_BIN || 'docker';
  const timeout = cleanupCommandTimeout(env, 15_000);
  const format = '{{.Id}}|{{ index .Config.Labels "com.rorca.jest-invocation" }}|{{.Name}}';
  const inspected = spawnSync(docker, ['inspect', '--format', format, state.containerName], {
    encoding: 'utf8', timeout, env: { ...env },
  });
  if (!inspected.error && !inspected.signal && inspected.status === 0) {
    return parseDockerIdentity(inspected.stdout);
  }
  if (inspected.error || inspected.signal || (inspected.status !== 1 && inspected.status !== 125)) {
    throw commandFailure('Docker inspect', inspected);
  }
  // `docker inspect` exit 1 conflates absence and daemon failure. A successful
  // exact-name inventory with no row is the required absence proof.
  const listed = spawnSync(docker, [
    'container', 'ls', '--all', '--filter', `name=^/${state.containerName}$`,
    '--format', '{{.ID}}|{{.Label "com.rorca.jest-invocation"}}|{{.Names}}',
  ], { encoding: 'utf8', timeout, env: { ...env } });
  if (listed.error || listed.signal || listed.status !== 0) throw commandFailure('Docker exact-name absence proof', listed);
  const listedIdentity = parseDockerIdentity(listed.stdout);
  if (listedIdentity) {
    throw new Error('Docker inspect failed while exact-name inventory still found the invocation container');
  }
  return null;
}

function assertDockerIdentity(state: IsolatedTestDatabaseState, identity: DockerIdentity): void {
  if (identity.label !== state.invocationId || identity.name !== state.containerName) {
    throw new Error('Refusing cleanup of Docker container with mismatched invocation identity');
  }
  if (state.containerId && identity.id !== state.containerId && !state.containerId.startsWith(identity.id)) {
    throw new Error('Refusing cleanup of Docker container with changed container id');
  }
}

function removeExactDockerContainer(state: IsolatedTestDatabaseState, env: NodeJS.ProcessEnv): void {
  const identity = inspectExactDockerContainer(state, env);
  if (!identity) return;
  assertDockerIdentity(state, identity);
  const docker = env.RORCA_TEST_DOCKER_BIN || 'docker';
  const removed = spawnSync(docker, ['rm', '--force', state.containerName!], {
    encoding: 'utf8',
    timeout: cleanupCommandTimeout(env, 30_000),
    env: { ...env },
  });
  if (removed.error || removed.signal || removed.status !== 0) throw commandFailure('Docker remove', removed);
  const after = inspectExactDockerContainer(state, env);
  if (after) throw new Error('Docker remove returned success but the exact invocation container remains present');
}

async function cleanupVerifiedState(state: IsolatedTestDatabaseState, env: NodeJS.ProcessEnv): Promise<void> {
  assertCleanupRoot(state);
  if (state.status !== 'cleaned') {
    writeState({ ...state, status: 'cleaning' });
    if (state.mode === 'local-cluster') {
      stopExactLocalCluster(state, env);
      removeExactLocalSocketDirectory(state);
    }
    else if (state.mode === 'docker-container') removeExactDockerContainer(state, env);
    else {
      const hasResourceIdentity = state.containerName !== undefined
        || state.containerId !== undefined
        || state.dataDirectory !== undefined
        || state.socketDirectory !== undefined;
      const resumableUnprovisionedCleanup = state.status === 'cleaning' && !hasResourceIdentity;
      if (state.status !== 'allocated' && !resumableUnprovisionedCleanup) {
        throw new Error(`Invocation cleanup cannot prove resource absence from state ${state.status}`);
      }
    }
    writeState({ ...state, status: 'cleaned' });
  }
  // Root is direct-child, nonce-shaped, private, lease-verified, and now has a
  // successful stop/remove plus exact post-removal absence proof.
  fs.rmSync(state.root, { recursive: true, force: false });
}

export async function cleanupIsolatedTestDatabase(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const statePath = env.RORCA_JEST_STATE_FILE;
  if (!statePath || !fs.existsSync(statePath)) return;
  let state: IsolatedTestDatabaseState;
  try { state = readIsolatedTestDatabaseState(env); } catch (error) {
    throw new Error(`Refusing unverified Jest database cleanup: ${error instanceof Error ? error.message : String(error)}`);
  }
  await cleanupVerifiedState(state, env);
}

/** Recover only exact private roots whose PID+start+nonce owner is proved gone. */
export async function recoverStaleIsolatedTestDatabases(
  env: NodeJS.ProcessEnv = process.env,
  candidates?: readonly string[],
): Promise<number> {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const roots = candidates ?? fs.readdirSync(temporaryRoot)
    .filter(name => name.startsWith(JEST_INVOCATION_PREFIX))
    .map(name => path.join(temporaryRoot, name));
  let recovered = 0;
  for (const candidate of roots) {
    const resolved = path.resolve(candidate);
    if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith(JEST_INVOCATION_PREFIX)) continue;
    let stale: IsolatedTestDatabaseState | null;
    try { stale = readStaleIsolatedTestDatabaseState(resolved); } catch (error) {
      throw new Error(`Refusing unverified stale Jest cleanup for ${resolved}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!stale) continue;
    await cleanupVerifiedState(stale, env);
    recovered += 1;
  }
  return recovered;
}
