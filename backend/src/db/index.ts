/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * db/index.ts — PostgreSQL connection pool + async query helpers for Rorca
 *
 * All database access is async via pg Pool:
 *
 *   await query<T>(sql, params)       — SELECT multiple rows
 *   await queryOne<T>(sql, params)    — SELECT single row or undefined
 *   await execute(sql, params)        — INSERT/UPDATE/DELETE
 *   await transaction(fn)             — Run function in a transaction
 *
 * All queries use $1, $2, ... numbered placeholders natively.
 *
 * PG-019: Managed service compatibility (Supabase, Neon, Railway)
 *   - SSL/TLS: auto-detect from DATABASE_URL ?sslmode=require or PGSSLMODE env
 *   - PGSSLROOTCERT: loads CA cert for strict verification
 *   - Pool auto-adjust: reads max_connections, caps pool to 80% of server limit
 *   - Cloud provider detection from hostname patterns
 */

import { AsyncLocalStorage } from 'async_hooks';
import * as fs from 'fs';
import { Pool, PoolClient, PoolConfig, type QueryConfig, type QueryResultRow } from 'pg';
import { logger } from '../lib/logger';
import { assertConnectedTestDatabase } from '../lib/test-db-safety';
import { assertTestDatabaseAccess } from './test-db-isolation';
import { createPoolForConnectionString, runPgMigrations } from './pg-index';

// ── Configuration ────────────────────────────────────────────────────────

const SLOW_QUERY_THRESHOLD_MS = parseInt(process.env.SLOW_QUERY_THRESHOLD_MS || '500', 10);
const DEFAULT_POOL_SIZE = 20;

// ── Cloud Provider Detection ─────────────────────────────────────────────

export type CloudProvider = 'supabase' | 'neon' | 'railway' | 'self-hosted';

/**
 * Infer the managed Postgres provider from the connection hostname.
 */
export function detectCloudProvider(connectionString?: string): CloudProvider {
  const url = connectionString || process.env.DATABASE_URL || '';
  const host = process.env.PGHOST || '';
  const combined = `${url} ${host}`.toLowerCase();

  if (combined.includes('supabase.co') || combined.includes('supabase.com')) return 'supabase';
  if (combined.includes('neon.tech')) return 'neon';
  if (combined.includes('railway.app') || combined.includes('railway.internal')) return 'railway';
  return 'self-hosted';
}

// ── SSL Configuration ────────────────────────────────────────────────────

/**
 * Build SSL/TLS config for pg Pool.
 *
 * Supports:
 * - DATABASE_URL with ?sslmode=require → ssl: { rejectUnauthorized: false }
 * - PGSSLMODE=require env var → ssl: { rejectUnauthorized: false }
 * - PGSSLROOTCERT=/path/to/ca.crt → loads CA cert for strict verification
 */
export function buildSslConfig(connectionString?: string): PoolConfig['ssl'] | undefined {
  const urlNeedsSsl = connectionString
    ? connectionString.includes('sslmode=require') || connectionString.includes('sslmode=verify-full')
    : false;
  const envNeedsSsl = process.env.PGSSLMODE === 'require' || process.env.PGSSLMODE === 'verify-full';

  if (!urlNeedsSsl && !envNeedsSsl) return undefined;

  const sslOptions: { rejectUnauthorized: boolean; ca?: string } = {
    rejectUnauthorized: false,
  };

  // If a CA root cert is provided, enable strict verification
  const rootCertPath = process.env.PGSSLROOTCERT;
  if (rootCertPath) {
    try {
      sslOptions.ca = fs.readFileSync(rootCertPath, 'utf8');
      sslOptions.rejectUnauthorized = true;
      logger.info({ path: rootCertPath }, '[db] Loaded SSL root CA for strict verification');
    } catch (err) {
      logger.warn({ err, path: rootCertPath }, '[db] Failed to load PGSSLROOTCERT — falling back to rejectUnauthorized: false');
    }
  }

  return sslOptions;
}

// ── Connection String Parsing ────────────────────────────────────────────

/**
 * Parse query parameters from a DATABASE_URL.
 * Supports both postgres:// and postgresql:// schemes.
 */
function parseConnectionParams(connectionString: string): {
  connectionTimeout?: number;
  statementTimeout?: number;
} {
  try {
    const url = new URL(connectionString);
    const params: { connectionTimeout?: number; statementTimeout?: number } = {};

    const connectTimeout = url.searchParams.get('connect_timeout');
    if (connectTimeout) params.connectionTimeout = parseInt(connectTimeout, 10) * 1000; // pg uses seconds

    const statementTimeout = url.searchParams.get('statement_timeout');
    if (statementTimeout) params.statementTimeout = parseInt(statementTimeout, 10);

    return params;
  } catch {
    return {};
  }
}

// ── Pool Config Builder ──────────────────────────────────────────────────

const assertTestDatabaseSafety = assertTestDatabaseAccess;

function configuredPoolSizes(): { application: number; operational: number; total: number } {
  const parsed = parseInt(process.env.PG_POOL_SIZE || String(DEFAULT_POOL_SIZE), 10);
  const total = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_POOL_SIZE;
  const operational = total >= 3 ? Math.min(2, total - 1) : 0;
  return { application: Math.max(1, total - operational), operational, total };
}

function buildPoolConfig(role: 'application' | 'operational' = 'application'): PoolConfig {
  const databaseUrl = process.env.DATABASE_URL;
  assertTestDatabaseSafety(databaseUrl);
  const sizes = configuredPoolSizes();
  const configuredPoolSize = role === 'operational' ? sizes.operational : sizes.application;
  const ssl = buildSslConfig(databaseUrl);

  // Explicitly pin search_path so all queries and migrations consistently hit the
  // rorca schema (where pg-boss and app tables live) before falling back to public.
  // Without this, $user resolution is implicit and migrations may land in the wrong schema.
  const testWorkspaceScope = process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE;
  if (testWorkspaceScope && !databaseUrl) throw new Error('RORCA_TEST_DATABASE_WORKSPACE_SCOPE requires an explicit _test DATABASE_URL');
  // Split-principal GUCs must reach every connection the same way pg-index's
  // poolOptions does: the wave-2 RLS migrations read rorca.runtime_database_user
  // from the session, so an owner-connected local backend would otherwise fail
  // them with 'requires a distinct existing non-privileged RORCA_RUNTIME_DATABASE_USER'.
  const runtimeDatabaseUser = process.env.RORCA_RUNTIME_DATABASE_USER;
  const canonicalWriterDatabaseUser = process.env.RORCA_CANONICAL_WRITER_DATABASE_USER;
  const rorcaOptions = `${runtimeDatabaseUser ? ` -c rorca.runtime_database_user=${runtimeDatabaseUser}` : ''}${canonicalWriterDatabaseUser ? ` -c rorca.canonical_writer_database_user=${canonicalWriterDatabaseUser}` : ''} -c rorca.pgboss_schema=${String(process.env.RORCA_PGBOSS_SCHEMA ?? 'pgboss').trim()}`;
  const searchPathOption = `--search_path=rorca,public${testWorkspaceScope ? ` -c rorca.workspace_id=${testWorkspaceScope}` : ''}${rorcaOptions}`;

  if (databaseUrl) {
    const urlParams = parseConnectionParams(databaseUrl);
    return {
      connectionString: databaseUrl,
      max: configuredPoolSize,
      idleTimeoutMillis: process.env.NODE_ENV === 'test' ? 250 : 30_000,
      connectionTimeoutMillis: urlParams.connectionTimeout || 5_000,
      statement_timeout: urlParams.statementTimeout || 30_000,
      options: searchPathOption,
      ...(ssl ? { ssl } : {}),
    };
  }

  return {
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    user: process.env.PGUSER || 'rorca',
    password: process.env.PGPASSWORD || 'rorca',
    database: process.env.PGDATABASE || 'rorca',
    max: configuredPoolSize,
    idleTimeoutMillis: process.env.NODE_ENV === 'test' ? 250 : 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
    options: searchPathOption,
    ...(ssl ? { ssl } : {}),
  };
}

// ── Lazy Pool ────────────────────────────────────────────────────────────

let _pool: Pool | null = null;
interface AdvisoryLockContext {
  client: PoolClient;
  active: boolean;
  key: string;
  transactionOwner?: symbol;
}
interface TransactionContext {
  client: PoolClient;
  active: boolean;
}
const advisoryLockClient = new AsyncLocalStorage<AdvisoryLockContext>();
const advisoryTransactionOwner = new AsyncLocalStorage<symbol>();
const transactionClient = new AsyncLocalStorage<TransactionContext>();

function currentAdvisoryClient(): PoolClient | undefined {
  const context = advisoryLockClient.getStore();
  if (!context?.active) return undefined;
  if (context.transactionOwner && advisoryTransactionOwner.getStore() !== context.transactionOwner) {
    throw new Error('Concurrent query attempted outside the active fenced transaction');
  }
  return context.client;
}

function currentTransactionClient(): PoolClient | undefined {
  const context = transactionClient.getStore();
  if (!context) return undefined;
  if (!context.active) {
    throw new Error('Query attempted after its managed transaction completed');
  }
  return context.client;
}

function currentManagedClient(): PoolClient | undefined {
  return currentAdvisoryClient() ?? currentTransactionClient();
}
let _operationalPool: Pool | null = null;
let _canonicalWriterPool: Pool | null = null;
let _runtimePool: Pool | null = null;
let _migrationsDone = false;
let _migrationsRunning: Promise<void> | null = null;

function configurePoolEvents(target: Pool, label: string): void {
  // PoolConfig.options pins search_path before a connection is exposed. Do not
  // issue fire-and-forget client.query() calls from the `connect` event: pg does
  // not await that listener, so the first borrower can overlap RESET/SET queries
  // on one client (pg@9 rejects this and pg@8 warns about it).
  target.on('error', (err) => logger.error({ err }, `[db] Unexpected ${label} pool error`));
}

function getPool(): Pool {
  assertTestDatabaseAccess(_pool?.options.connectionString ?? process.env.DATABASE_URL);
  if (!_pool) {
    _pool = new Pool(buildPoolConfig('application'));
    configurePoolEvents(_pool, 'application');
  }
  return _pool;
}

/**
 * Cross-process/container cooperative authority fence. All provider actuators and
 * authority replacement paths must use the same stable workspace-scoped key.
 */
export async function withPgAdvisoryLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  await ensureMigrations();
  if (transactionClient.getStore()) {
    throw new Error('PostgreSQL advisory authority fences inside managed transactions are forbidden');
  }
  if (advisoryLockClient.getStore()?.active) {
    throw new Error('Nested PostgreSQL advisory authority fences are forbidden');
  }
  const client = await getPool().connect();
  let lockAcquired = false;
  let cleanupError: Error | undefined;
  try {
    await resetSessionState(client);
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key]);
    lockAcquired = true;
    // Route application-table reads performed by the fenced operation through
    // the lock-owning session. This preserves the session-level fence and also
    // works when the configured application pool has only one connection.
    const context: AdvisoryLockContext = { client, active: true, key };
    try {
      return await advisoryLockClient.run(context, operation);
    } finally {
      // Async descendants created by an operation may outlive it. They retain
      // the ALS object, so invalidate it before unlocking/releasing the client.
      context.active = false;
    }
  } finally {
    // ROLLBACK is harmless when idle and clears any transaction abandoned by a
    // raw callback before reset. Never return poisoned role/claim/path state to
    // the pool. A cleanup failure destroys, rather than reuses, the client.
    try {
      await client.query('ROLLBACK');
      await resetSessionState(client);
    } catch (error) {
      cleanupError = error instanceof Error ? error : new Error(String(error));
    }
    if (lockAcquired) {
      try {
        const unlocked = await client.query<{ unlocked: boolean }>(
          'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked', [key],
        );
        if (unlocked.rows[0]?.unlocked !== true) {
          cleanupError ??= new Error('PostgreSQL advisory authority fence was not held at cleanup');
        }
      } catch (error) {
        cleanupError ??= error instanceof Error ? error : new Error(String(error));
      }
    }
    client.release(cleanupError);
    if (cleanupError) throw cleanupError;
  }
}

/** Reserved for WAL ingestion and readiness so application pool pressure cannot starve them. */
function getOperationalPool(): Pool {
  assertTestDatabaseAccess(_operationalPool?.options.connectionString ?? process.env.DATABASE_URL);
  if (configuredPoolSizes().operational === 0) return getPool();
  if (!_operationalPool) {
    _operationalPool = new Pool({
      ...buildPoolConfig('operational'),
      connectionTimeoutMillis: 500,
      statement_timeout: 650,
    });
    configurePoolEvents(_operationalPool, 'operational');
  }
  return _operationalPool;
}

function getCanonicalWriterPool(): Pool {
  const connectionString = process.env.RORCA_CANONICAL_WRITER_DATABASE_URL;
  if (!connectionString) throw new Error('RORCA_CANONICAL_WRITER_DATABASE_URL is required for governed canonical mutations');
  assertTestDatabaseSafety(connectionString);
  const writerUser=decodeURIComponent(new URL(connectionString).username);
  const runtimeUser=process.env.DATABASE_URL?decodeURIComponent(new URL(process.env.DATABASE_URL).username):process.env.PGUSER;
  const migrationUser=process.env.RORCA_MIGRATION_DATABASE_URL
    ?decodeURIComponent(new URL(process.env.RORCA_MIGRATION_DATABASE_URL).username):undefined;
  if (!writerUser || writerUser===runtimeUser || writerUser===migrationUser
    || writerUser!==process.env.RORCA_CANONICAL_WRITER_DATABASE_USER) {
    throw new Error('Canonical writer must be explicitly named and distinct from runtime and migration principals');
  }
  if (!_canonicalWriterPool) {
    const ssl = buildSslConfig(connectionString);
    _canonicalWriterPool = new Pool({
      connectionString,
      max: Math.max(1, Math.min(4, configuredPoolSizes().application)),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 30_000,
      options: '--search_path=rorca,public',
      ...(ssl ? { ssl } : {}),
    });
    configurePoolEvents(_canonicalWriterPool, 'canonical-writer');
  }
  return _canonicalWriterPool;
}

/** Narrow runtime-principal pool for capabilities that require session_user to
 * be the sanctioned RLS runtime principal (e.g. strict memory synthesis). */
function getRuntimePrincipalPool(): Pool {
  const connectionString = process.env.RORCA_RUNTIME_DATABASE_URL;
  if (!connectionString) {
    throw new Error('RORCA_RUNTIME_DATABASE_URL is required for runtime-principal capabilities');
  }
  assertTestDatabaseSafety(connectionString);
  const runtimeUser = decodeURIComponent(new URL(connectionString).username);
  const expectedRuntimeUser = process.env.RORCA_RUNTIME_DATABASE_USER?.trim();
  if (!expectedRuntimeUser
      || !/^[a-z_][a-z0-9_]{0,62}$/.test(expectedRuntimeUser)
      || runtimeUser !== expectedRuntimeUser) {
    throw new Error('RORCA_RUNTIME_DATABASE_URL user must match the required RORCA_RUNTIME_DATABASE_USER');
  }
  if (!_runtimePool) {
    const ssl = buildSslConfig(connectionString);
    _runtimePool = new Pool({
      connectionString,
      max: Math.max(1, Math.min(4, configuredPoolSizes().application)),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 30_000,
      options: `--search_path=rorca,public -c rorca.runtime_database_user=${expectedRuntimeUser}`,
      ...(ssl ? { ssl } : {}),
    });
    configurePoolEvents(_runtimePool, 'runtime');
  }
  return _runtimePool;
}

/** Ensure migrations have run exactly once. Awaited before first query. */
async function ensureMigrations(): Promise<void> {
  assertTestDatabaseAccess(process.env.DATABASE_URL);
  if (process.env.JEST_SKIP_RUNTIME_MIGRATIONS === 'true') {
    _migrationsDone = true;
    return;
  }
  if (_migrationsDone) return;
  if (_migrationsRunning) {
    await _migrationsRunning;
    return;
  }
  _migrationsRunning = (async () => {
    const pool = getPool();
    const migrationUrl = process.env.RORCA_MIGRATION_DATABASE_URL;
    if (process.env.RORCA_MIGRATIONS_PREAPPLIED === 'true') {
      if (migrationUrl) throw new Error('Pre-applied migration topology must not inject migration-owner credentials into runtime processes');
      const readiness = await pool.query<{ registered: boolean; ready: boolean }>(`SELECT
        EXISTS(SELECT 1 FROM rorca.wave2_database_principals p
          WHERE p.database_user=current_user AND p.principal_class='internal_runtime') registered,
        EXISTS(SELECT 1 FROM rorca.wave2_schema_readiness
          WHERE singleton=TRUE AND state='ready' AND migration_version=20260731157000
            AND contract_source_digest='sha256:1111a20f8b6e8cfca7ddcf8861069989bdd7b7c4b52c5b12e26cb2ff8ad6bbfb')
        AND EXISTS(SELECT 1 FROM rorca.completion_schema_readiness
          WHERE singleton=TRUE AND state='ready' AND protocol_version=1
            AND migration_version=20260804170000
            AND contract_source_digest='sha256:6efbecef9d1a2d6252dbf34fb870e48f95a793a1547bf505bce34e21277be2b5') ready`);
      if (!readiness.rows[0]?.registered || !readiness.rows[0]?.ready) {
        throw new Error('Pre-applied Wave 2 schema is absent, stale, or not readable by the runtime principal');
      }
      _migrationsDone = true;
      logger.info('[db] Verified pre-applied PostgreSQL migrations under the runtime principal');
      await autoAdjustPoolSize(pool);
      return;
    }
    logger.info('[db] Running PostgreSQL migrations...');
    if (migrationUrl) {
      if (migrationUrl === process.env.DATABASE_URL) throw new Error('RORCA_MIGRATION_DATABASE_URL must use a distinct migration principal');
      const migrationPool = createPoolForConnectionString(migrationUrl);
      try { await runPgMigrations(migrationPool); } finally { await migrationPool.end(); }
    } else await runPgMigrations(pool);
    const runtimePrincipal = await pool.query(`SELECT current_user database_user,EXISTS(
      SELECT 1 FROM rorca.wave2_database_principals p WHERE p.database_user=current_user AND p.principal_class='internal_runtime'
    ) registered`);
    if (!runtimePrincipal.rows[0]?.registered) throw new Error('DATABASE_URL must connect as the registered Wave 2 internal_runtime principal');
    _migrationsDone = true;
    logger.info('[db] Migrations complete');

    // PG-019: Auto-adjust pool size based on server's max_connections
    await autoAdjustPoolSize(pool);
  })();
  await _migrationsRunning;
}

/**
 * PG-019: Read max_connections from the server and cap pool size to 80%.
 * Managed services often have low limits (Supabase free: 50, Neon free: 100).
 */
async function autoAdjustPoolSize(p: Pool): Promise<void> {
  try {
    const result = await p.query<{ max_connections: string }>('SHOW max_connections');
    const serverMax = parseInt(result.rows[0]?.max_connections ?? '100', 10);
    const safeMax = Math.floor(serverMax * 0.8);
    const cfg = buildPoolConfig();
    const configuredMax = cfg.max ?? DEFAULT_POOL_SIZE;

    if (configuredMax > safeMax) {
      logger.warn(
        { configuredMax, serverMax, adjustedTo: safeMax },
        '[db] Pool size exceeds 80% of server max_connections — auto-adjusting',
      );
      // pg Pool doesn't support dynamic resize, but we log the warning.
      // The pool was already created with configuredMax; new connections beyond
      // safeMax will queue, which is preferable to hitting server limits.
      // For next startup, user should set PG_POOL_SIZE <= safeMax.
    } else {
      logger.info({ configuredMax, serverMax, safeMax }, '[db] Pool size within server limits');
    }

    _serverMaxConnections = serverMax;
  } catch (err) {
    logger.debug({ err }, '[db] Could not read max_connections (restricted user?) — using default pool size');
  }
}

/** Cached server max_connections for health reporting */
let _serverMaxConnections: number | null = null;

// ── Exported Pool ────────────────────────────────────────────────────────

/** The pg Pool instance. Prefer using query/queryOne/execute/transaction helpers. */
export const pool: Pool = new Proxy({} as Pool, {
  get(_target, prop, receiver) {
    const real = getPool();
    const val = Reflect.get(real, prop, receiver);
    return typeof val === 'function' ? val.bind(real) : val;
  },
});

export const operationalPool: Pool = new Proxy({} as Pool, {
  get(_target, prop, receiver) {
    const real = getOperationalPool();
    const val = Reflect.get(real, prop, receiver);
    return typeof val === 'function' ? val.bind(real) : val;
  },
});

export function combinedPoolStats(): { total: number; idle: number; waiting: number } {
  const application = getPool();
  if (configuredPoolSizes().operational === 0) {
    return { total: application.totalCount, idle: application.idleCount, waiting: application.waitingCount };
  }
  const operational = getOperationalPool();
  return {
    total: application.totalCount + operational.totalCount,
    idle: application.idleCount + operational.idleCount,
    waiting: application.waitingCount + operational.waitingCount,
  };
}

// ── Placeholder Rewriter ─────────────────────────────────────────────────

/**
 * Converts ? placeholders to $1, $2, ... numbered placeholders.
 * Utility for SQL string conversion. Prefer writing $N placeholders directly.
 */
export function rewritePlaceholders(sql: string): string {
  let idx = 0;
  return sql.replace(/\?/g, () => `$${++idx}`);
}

// ── Slow Query Logger ────────────────────────────────────────────────────

function logSlowQuery(sql: string, params: unknown[] | undefined, durationMs: number): void {
  if (durationMs >= SLOW_QUERY_THRESHOLD_MS) {
    // Sanitize params: mask anything that looks like a secret
    const sanitized = params?.map((p) => {
      if (typeof p === 'string' && p.length > 20) {
        const lower = p.toLowerCase();
        if (lower.includes('password') || lower.includes('secret') || lower.includes('key') || lower.includes('token')) {
          return '[REDACTED]';
        }
      }
      return p;
    });
    logger.warn({ sql: sql.slice(0, 200), params: sanitized, durationMs }, '[db] Slow query');
  }
}

const verifiedTestClients = new WeakSet<PoolClient>();

async function assertLiveTestConnection(client: PoolClient,expectedUrl=process.env.DATABASE_URL!): Promise<void> {
  if (process.env.NODE_ENV !== 'test' || verifiedTestClients.has(client)) return;
  await assertConnectedTestDatabase(client, expectedUrl);
  verifiedTestClients.add(client);
}

async function resetSessionState(client: PoolClient,expectedUrl?:string,searchPath='rorca, public'): Promise<void> {
  await assertLiveTestConnection(client,expectedUrl);
  await client.query('RESET ROLE');
  await client.query('RESET request.jwt.claim.sub');
  await client.query('RESET request.jwt.claims');
  if(!/^[a-z_][a-z0-9_]*(?:, [a-z_][a-z0-9_]*)*$/.test(searchPath))throw new Error('Unsafe database search path');
  await client.query(`SET search_path TO ${searchPath}`);
}

// ── Query Helpers ────────────────────────────────────────────────────────

/**
 * Execute a query and return all matching rows.
 */
export async function query<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  await ensureMigrations();
  const managedClient = currentManagedClient();
  const start = Date.now();
  if (managedClient) {
    const result = await managedClient.query(sql, params);
    logSlowQuery(sql, params, Date.now() - start);
    return result.rows as T[];
  }
  const client = await getPool().connect();
  try {
    await resetSessionState(client);
    const result = await client.query(sql, params);
    logSlowQuery(sql, params, Date.now() - start);
    return result.rows as T[];
  } finally {
    client.release();
  }
}

/**
 * Execute a query and return the first row, or undefined.
 */
export async function queryOne<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<T | undefined> {
  await ensureMigrations();
  const managedClient = currentManagedClient();
  const start = Date.now();
  if (managedClient) {
    const result = await managedClient.query(sql, params);
    logSlowQuery(sql, params, Date.now() - start);
    return (result.rows[0] as T) ?? undefined;
  }
  const client = await getPool().connect();
  try {
    await resetSessionState(client);
    const result = await client.query(sql, params);
    logSlowQuery(sql, params, Date.now() - start);
    return (result.rows[0] as T) ?? undefined;
  } finally {
    client.release();
  }
}

/**
 * Run a short operational query on the reserved pool. Callers must provide a
 * query_timeout no greater than the operational statement timeout.
 */
export async function operationalQuery<T extends QueryResultRow = QueryResultRow>(
  config: QueryConfig,
): Promise<T[]> {
  await ensureMigrations();
  const result = await getOperationalPool().query<T>(config);
  return result.rows;
}

export async function operationalQueryOne<T extends QueryResultRow = QueryResultRow>(
  config: QueryConfig,
): Promise<T | undefined> {
  return (await operationalQuery<T>(config))[0];
}

/** Execute a statement (INSERT/UPDATE/DELETE) and return affected row count. */
export async function execute(
  sql: string,
  params?: unknown[],
): Promise<{ rowCount: number }> {
  await ensureMigrations();
  const managedClient = currentManagedClient();
  const start = Date.now();
  if (managedClient) {
    const result = await managedClient.query(sql, params);
    logSlowQuery(sql, params, Date.now() - start);
    return { rowCount: result.rowCount ?? 0 };
  }
  const client = await getPool().connect();
  try {
    await resetSessionState(client);
    const result = await client.query(sql, params);
    logSlowQuery(sql, params, Date.now() - start);
    return { rowCount: result.rowCount ?? 0 };
  } finally {
    client.release();
  }
}

/**
 * Runtime-principal transaction for capabilities whose SQL enforces
 * session_user identity (e.g. strict memory synthesis receipts). The ordinary
 * owner-connected DATABASE_URL principal cannot satisfy those checks, so the
 * caller must configure RORCA_RUNTIME_DATABASE_URL for the sanctioned runtime
 * user (rorca_runtime in the split-principal deployment).
 */
export async function runtimeTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensureMigrations();
  // Split-principal deployments name a distinct runtime user. Single-principal
  // test harnesses already connect the application pool as the runtime
  // principal, so the default pool satisfies the same session_user checks.
  const configuredUrl = process.env.RORCA_RUNTIME_DATABASE_URL;
  const client = configuredUrl
    ? await getRuntimePrincipalPool().connect()
    : await getPool().connect();
  try {
    await resetSessionState(client, configuredUrl ?? undefined, 'rorca, public');
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}
/**
 * Canonical Wave 2 writer transaction. The ordinary DATABASE_URL principal is
 * intentionally unable to mint mutation authority or write canonical stores.
 */
export async function canonicalTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensureMigrations();
  const client = await getCanonicalWriterPool().connect();
  try {
    await resetSessionState(client,process.env.RORCA_CANONICAL_WRITER_DATABASE_URL,'rorca_canonical_api, rorca, public');
    const authority = await client.query<{ registered: boolean }>(`SELECT EXISTS(
      SELECT 1 FROM wave2_canonical_writer_identities WHERE database_user=current_user
    ) registered`);
    if (!authority.rows[0]?.registered) throw new Error('Canonical writer database principal is not registered');
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}

export async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  await ensureMigrations();
  const fencedContext = advisoryLockClient.getStore();
  if (fencedContext?.active) {
    if (fencedContext.transactionOwner) {
      throw new Error('Nested or concurrent transactions inside an advisory authority fence are forbidden');
    }
    const owner = Symbol('advisory-transaction');
    fencedContext.transactionOwner = owner;
    try {
      return await advisoryTransactionOwner.run(owner, async () => {
        try {
          await fencedContext.client.query('BEGIN');
          const result = await fn(fencedContext.client);
          await fencedContext.client.query('COMMIT');
          return result;
        } catch (err) {
          await fencedContext.client.query('ROLLBACK');
          throw err;
        }
      });
    } finally {
      if (fencedContext.transactionOwner === owner) fencedContext.transactionOwner = undefined;
    }
  }

  if (transactionClient.getStore()) {
    throw new Error('Nested managed transactions are forbidden');
  }

  const client = await getPool().connect();
  const context: TransactionContext = { client, active: true };
  try {
    await resetSessionState(client);
    await client.query('BEGIN');
    try {
      const result = await transactionClient.run(context, () => fn(client));
      context.active = false;
      await client.query('COMMIT');
      return result;
    } catch (err) {
      context.active = false;
      await client.query('ROLLBACK');
      throw err;
    }
  } finally {
    context.active = false;
    client.release();
  }
}

// ── Health Check ─────────────────────────────────────────────────────────

export interface DbHealthResult {
  ok: boolean;
  latencyMs: number;
  poolStats: { total: number; idle: number; waiting: number; maxSize: number };
  pgVersion?: string;
  extensions?: string[];
  /** PG-019: Cloud compatibility info */
  cloud: boolean;
  provider: CloudProvider;
  extensionStatus?: { vector: boolean; age: boolean; pgcrypto: boolean };
  connectionLimit?: number;
}

/**
 * Runs SELECT 1 and returns pool diagnostics + PostgreSQL metadata.
 * Used by GET /api/health. PG-019: includes cloud compatibility reporting.
 */
export async function dbHealthCheck(): Promise<DbHealthResult> {
  const p = getPool();
  const cfg = buildPoolConfig();
  const maxSize = cfg.max ?? DEFAULT_POOL_SIZE;
  const provider = detectCloudProvider();
  const isCloud = provider !== 'self-hosted';
  const start = Date.now();

  try {
    await p.query('SELECT 1');
    const latencyMs = Date.now() - start;

    // Fetch PG version + installed extensions
    let pgVersion: string | undefined;
    let extensions: string[] = [];
    let vectorAvailable = false;
    let ageAvailable = false;
    let pgcryptoAvailable = false;
    try {
      const versionRow = await p.query<{ version: string }>('SELECT version()');
      pgVersion = versionRow.rows[0]?.version;
      const extRows = await p.query<{ extname: string }>(
        "SELECT extname FROM pg_extension WHERE extname IN ('vector', 'age', 'pgcrypto') ORDER BY extname"
      );
      extensions = extRows.rows.map(r => r.extname);
      vectorAvailable = extensions.includes('vector');
      ageAvailable = extensions.includes('age');
      pgcryptoAvailable = extensions.includes('pgcrypto');
    } catch {
      // Non-critical — version/extension queries may fail on restricted users
    }

    return {
      ok: true,
      latencyMs,
      poolStats: {
        total: p.totalCount,
        idle: p.idleCount,
        waiting: p.waitingCount,
        maxSize,
      },
      pgVersion,
      extensions,
      cloud: isCloud,
      provider,
      extensionStatus: { vector: vectorAvailable, age: ageAvailable, pgcrypto: pgcryptoAvailable },
      connectionLimit: _serverMaxConnections ?? undefined,
    };
  } catch {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      poolStats: {
        total: p.totalCount,
        idle: p.idleCount,
        waiting: p.waitingCount,
        maxSize,
      },
      cloud: isCloud,
      provider,
    };
  }
}

// ── Initialization ───────────────────────────────────────────────────────

/**
 * Explicitly initialize the pool and run migrations.
 * Call from server startup to ensure DB is ready before accepting requests.
 */
export async function initDb(): Promise<void> {
  await ensureMigrations();
  await seedDefaultAdmin();
  await seedWorkerSettings();
}

// ── Seed Worker Settings ─────────────────────────────────────────────────

async function seedWorkerSettings(): Promise<void> {
  await execute(
    `INSERT INTO worker_settings (key, value)
     VALUES ('max_concurrent_runs', '3')
     ON CONFLICT (key) DO NOTHING`,
  );
}

// ── Seed Default Admin ───────────────────────────────────────────────────

async function seedDefaultAdmin(): Promise<void> {
  const existing = await queryOne<{ id: string }>(
    "SELECT id FROM users WHERE email = 'admin@rorca.local'",
  );
  if (!existing) {
    const hasPasswordHash = await queryOne<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'users'
           AND column_name = 'password_hash'
       ) AS exists`,
    );

    if (hasPasswordHash?.exists) {
      // bcrypt hash of 'rorca123' (cost 10) for legacy/local-auth schemas.
      const defaultHash = '$2b$10$BMXqmRMejhhifW5gs6Ju.eI.cxoG/k7iW5sGJ86Nb4WloLowY.qxy';
      await execute(
        `INSERT INTO users (id, email, display_name, password_hash, role, plan, email_verified_at)
         VALUES ('local-admin', 'admin@rorca.local', 'Admin', $1, 'admin', 'pro', NOW())`,
        [defaultHash],
      );
    } else {
      await execute(
        `INSERT INTO users (id, email, display_name, role, plan, email_verified_at)
         VALUES ('local-admin', 'admin@rorca.local', 'Admin', 'admin', 'pro', NOW())`,
      );
    }
    logger.info('[db] Seeded default admin user (admin@rorca.local)');
  } else {
    await execute(
      "UPDATE users SET plan = 'pro' WHERE email = 'admin@rorca.local' AND plan = 'free'",
    );
  }
}

// ── Graceful Shutdown ────────────────────────────────────────────────────

async function shutdown(): Promise<void> {
  const targets = new Set<Pool>();
  if (_pool) {
    logger.info('[db] Closing application pool...');
    targets.add(_pool);
    _pool = null;
  }
  if (_operationalPool) {
    logger.info('[db] Closing operational pool...');
    targets.add(_operationalPool);
    _operationalPool = null;
  }
  if (_canonicalWriterPool) {
    logger.info('[db] Closing canonical writer pool...');
    targets.add(_canonicalWriterPool);
    _canonicalWriterPool = null;
  }
  await Promise.allSettled([...targets].map(target => target.end()));
  if (targets.size > 0) logger.info('[db] Pools closed');
}

// Exported for tests that need to close the pool to release connections
export const closePool = shutdown;

// Register service-process shutdown handlers outside Jest only. A library import
// must not intercept Jest's worker SIGTERM and force the test runner to SIGKILL it;
// per-suite cleanup owns pools in test mode. Check RORCA_PROCESS_ROLE at signal
// time because ES module hoisting precedes worker.ts process-role assignment.
// Worker and engine processes manage their own pool lifecycle.
if (process.env.NODE_ENV !== 'test') {
  process.on('SIGTERM', () => {
    if (process.env.RORCA_PROCESS_ROLE !== 'engine' && process.env.RORCA_PROCESS_ROLE !== 'worker') {
      shutdown().catch(() => {});
    }
  });
  process.on('SIGINT', () => {
    if (process.env.RORCA_PROCESS_ROLE !== 'engine' && process.env.RORCA_PROCESS_ROLE !== 'worker') {
      shutdown().catch(() => {});
    }
  });
}
