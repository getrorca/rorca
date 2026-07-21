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
import { Pool } from 'pg';
import { logger } from '../lib/logger';
import { assertConnectedTestDatabase, assertTestDatabaseName } from '../lib/test-db-safety';
import { runPgMigrations } from './pg-index';
// ── Configuration ────────────────────────────────────────────────────────
const SLOW_QUERY_THRESHOLD_MS = parseInt(process.env.SLOW_QUERY_THRESHOLD_MS || '500', 10);
const DEFAULT_POOL_SIZE = 20;
/**
 * Infer the managed Postgres provider from the connection hostname.
 */
export function detectCloudProvider(connectionString) {
    const url = connectionString || process.env.DATABASE_URL || '';
    const host = process.env.PGHOST || '';
    const combined = `${url} ${host}`.toLowerCase();
    if (combined.includes('supabase.co') || combined.includes('supabase.com'))
        return 'supabase';
    if (combined.includes('neon.tech'))
        return 'neon';
    if (combined.includes('railway.app') || combined.includes('railway.internal'))
        return 'railway';
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
export function buildSslConfig(connectionString) {
    const urlNeedsSsl = connectionString
        ? connectionString.includes('sslmode=require') || connectionString.includes('sslmode=verify-full')
        : false;
    const envNeedsSsl = process.env.PGSSLMODE === 'require' || process.env.PGSSLMODE === 'verify-full';
    if (!urlNeedsSsl && !envNeedsSsl)
        return undefined;
    const sslOptions = {
        rejectUnauthorized: false,
    };
    // If a CA root cert is provided, enable strict verification
    const rootCertPath = process.env.PGSSLROOTCERT;
    if (rootCertPath) {
        try {
            sslOptions.ca = fs.readFileSync(rootCertPath, 'utf8');
            sslOptions.rejectUnauthorized = true;
            logger.info({ path: rootCertPath }, '[db] Loaded SSL root CA for strict verification');
        }
        catch (err) {
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
function parseConnectionParams(connectionString) {
    try {
        const url = new URL(connectionString);
        const params = {};
        const connectTimeout = url.searchParams.get('connect_timeout');
        if (connectTimeout)
            params.connectionTimeout = parseInt(connectTimeout, 10) * 1000; // pg uses seconds
        const statementTimeout = url.searchParams.get('statement_timeout');
        if (statementTimeout)
            params.statementTimeout = parseInt(statementTimeout, 10);
        return params;
    }
    catch {
        return {};
    }
}
// ── Pool Config Builder ──────────────────────────────────────────────────
function assertTestDatabaseSafety(databaseUrl) {
    if (process.env.NODE_ENV !== 'test')
        return;
    let dbName = process.env.PGDATABASE || '';
    if (databaseUrl) {
        try {
            dbName = new URL(databaseUrl).pathname.slice(1);
        }
        catch {
            dbName = '';
        }
    }
    assertTestDatabaseName(dbName, 'configured test database');
}
function configuredPoolSizes() {
    const parsed = parseInt(process.env.PG_POOL_SIZE || String(DEFAULT_POOL_SIZE), 10);
    const total = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_POOL_SIZE;
    const operational = total >= 3 ? Math.min(2, total - 1) : 0;
    return { application: Math.max(1, total - operational), operational, total };
}
function buildPoolConfig(role = 'application') {
    const databaseUrl = process.env.DATABASE_URL;
    assertTestDatabaseSafety(databaseUrl);
    const sizes = configuredPoolSizes();
    const configuredPoolSize = role === 'operational' ? sizes.operational : sizes.application;
    const ssl = buildSslConfig(databaseUrl);
    // Explicitly pin search_path so all queries and migrations consistently hit the
    // rorca schema (where pg-boss and app tables live) before falling back to public.
    // Without this, $user resolution is implicit and migrations may land in the wrong schema.
    const searchPathOption = '--search_path=rorca,public';
    if (databaseUrl) {
        const urlParams = parseConnectionParams(databaseUrl);
        return {
            connectionString: databaseUrl,
            max: configuredPoolSize,
            idleTimeoutMillis: 30_000,
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
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
        statement_timeout: 30_000,
        options: searchPathOption,
        ...(ssl ? { ssl } : {}),
    };
}
// ── Lazy Pool ────────────────────────────────────────────────────────────
let _pool = null;
const advisoryLockClient = new AsyncLocalStorage();
const advisoryTransactionOwner = new AsyncLocalStorage();
function currentAdvisoryClient() {
    const context = advisoryLockClient.getStore();
    if (!context?.active)
        return undefined;
    if (context.transactionOwner && advisoryTransactionOwner.getStore() !== context.transactionOwner) {
        throw new Error('Concurrent query attempted outside the active fenced transaction');
    }
    return context.client;
}
let _operationalPool = null;
let _migrationsDone = false;
let _migrationsRunning = null;
function configurePoolEvents(target, label) {
    // PoolConfig.options pins search_path before a connection is exposed. Do not
    // issue fire-and-forget client.query() calls from the `connect` event: pg does
    // not await that listener, so the first borrower can overlap RESET/SET queries
    // on one client (pg@9 rejects this and pg@8 warns about it).
    target.on('error', (err) => logger.error({ err }, `[db] Unexpected ${label} pool error`));
}
function getPool() {
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
export async function withPgAdvisoryLock(key, operation) {
    await ensureMigrations();
    if (advisoryLockClient.getStore()?.active) {
        throw new Error('Nested PostgreSQL advisory authority fences are forbidden');
    }
    const client = await getPool().connect();
    let lockAcquired = false;
    let cleanupError;
    try {
        await resetSessionState(client);
        await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key]);
        lockAcquired = true;
        // Route application-table reads performed by the fenced operation through
        // the lock-owning session. This preserves the session-level fence and also
        // works when the configured application pool has only one connection.
        const context = { client, active: true, key };
        try {
            return await advisoryLockClient.run(context, operation);
        }
        finally {
            // Async descendants created by an operation may outlive it. They retain
            // the ALS object, so invalidate it before unlocking/releasing the client.
            context.active = false;
        }
    }
    finally {
        // ROLLBACK is harmless when idle and clears any transaction abandoned by a
        // raw callback before reset. Never return poisoned role/claim/path state to
        // the pool. A cleanup failure destroys, rather than reuses, the client.
        try {
            await client.query('ROLLBACK');
            await resetSessionState(client);
        }
        catch (error) {
            cleanupError = error instanceof Error ? error : new Error(String(error));
        }
        if (lockAcquired) {
            try {
                const unlocked = await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked', [key]);
                if (unlocked.rows[0]?.unlocked !== true) {
                    cleanupError ??= new Error('PostgreSQL advisory authority fence was not held at cleanup');
                }
            }
            catch (error) {
                cleanupError ??= error instanceof Error ? error : new Error(String(error));
            }
        }
        client.release(cleanupError);
        if (cleanupError)
            throw cleanupError;
    }
}
/** Reserved for WAL ingestion and readiness so application pool pressure cannot starve them. */
function getOperationalPool() {
    if (configuredPoolSizes().operational === 0)
        return getPool();
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
/** Ensure migrations have run exactly once. Awaited before first query. */
async function ensureMigrations() {
    if (process.env.JEST_SKIP_RUNTIME_MIGRATIONS === 'true') {
        _migrationsDone = true;
        return;
    }
    if (_migrationsDone)
        return;
    if (_migrationsRunning) {
        await _migrationsRunning;
        return;
    }
    _migrationsRunning = (async () => {
        const pool = getPool();
        logger.info('[db] Running PostgreSQL migrations...');
        await runPgMigrations(pool);
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
async function autoAdjustPoolSize(p) {
    try {
        const result = await p.query('SHOW max_connections');
        const serverMax = parseInt(result.rows[0]?.max_connections ?? '100', 10);
        const safeMax = Math.floor(serverMax * 0.8);
        const cfg = buildPoolConfig();
        const configuredMax = cfg.max ?? DEFAULT_POOL_SIZE;
        if (configuredMax > safeMax) {
            logger.warn({ configuredMax, serverMax, adjustedTo: safeMax }, '[db] Pool size exceeds 80% of server max_connections — auto-adjusting');
            // pg Pool doesn't support dynamic resize, but we log the warning.
            // The pool was already created with configuredMax; new connections beyond
            // safeMax will queue, which is preferable to hitting server limits.
            // For next startup, user should set PG_POOL_SIZE <= safeMax.
        }
        else {
            logger.info({ configuredMax, serverMax, safeMax }, '[db] Pool size within server limits');
        }
        _serverMaxConnections = serverMax;
    }
    catch (err) {
        logger.debug({ err }, '[db] Could not read max_connections (restricted user?) — using default pool size');
    }
}
/** Cached server max_connections for health reporting */
let _serverMaxConnections = null;
// ── Exported Pool ────────────────────────────────────────────────────────
/** The pg Pool instance. Prefer using query/queryOne/execute/transaction helpers. */
export const pool = new Proxy({}, {
    get(_target, prop, receiver) {
        const real = getPool();
        const val = Reflect.get(real, prop, receiver);
        return typeof val === 'function' ? val.bind(real) : val;
    },
});
export const operationalPool = new Proxy({}, {
    get(_target, prop, receiver) {
        const real = getOperationalPool();
        const val = Reflect.get(real, prop, receiver);
        return typeof val === 'function' ? val.bind(real) : val;
    },
});
export function combinedPoolStats() {
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
export function rewritePlaceholders(sql) {
    let idx = 0;
    return sql.replace(/\?/g, () => `$${++idx}`);
}
// ── Slow Query Logger ────────────────────────────────────────────────────
function logSlowQuery(sql, params, durationMs) {
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
const verifiedTestClients = new WeakSet();
async function assertLiveTestConnection(client) {
    if (process.env.NODE_ENV !== 'test' || verifiedTestClients.has(client))
        return;
    await assertConnectedTestDatabase(client, process.env.DATABASE_URL);
    verifiedTestClients.add(client);
}
async function resetSessionState(client) {
    await assertLiveTestConnection(client);
    await client.query('RESET ROLE');
    await client.query('RESET request.jwt.claim.sub');
    await client.query('RESET request.jwt.claims');
    await client.query('SET search_path TO rorca, public');
}
// ── Query Helpers ────────────────────────────────────────────────────────
/**
 * Execute a query and return all matching rows.
 */
export async function query(sql, params) {
    await ensureMigrations();
    const fencedClient = currentAdvisoryClient();
    const start = Date.now();
    if (fencedClient) {
        const result = await fencedClient.query(sql, params);
        logSlowQuery(sql, params, Date.now() - start);
        return result.rows;
    }
    const client = await getPool().connect();
    try {
        await resetSessionState(client);
        const result = await client.query(sql, params);
        logSlowQuery(sql, params, Date.now() - start);
        return result.rows;
    }
    finally {
        client.release();
    }
}
/**
 * Execute a query and return the first row, or undefined.
 */
export async function queryOne(sql, params) {
    await ensureMigrations();
    const fencedClient = currentAdvisoryClient();
    const start = Date.now();
    if (fencedClient) {
        const result = await fencedClient.query(sql, params);
        logSlowQuery(sql, params, Date.now() - start);
        return result.rows[0] ?? undefined;
    }
    const client = await getPool().connect();
    try {
        await resetSessionState(client);
        const result = await client.query(sql, params);
        logSlowQuery(sql, params, Date.now() - start);
        return result.rows[0] ?? undefined;
    }
    finally {
        client.release();
    }
}
/**
 * Run a short operational query on the reserved pool. Callers must provide a
 * query_timeout no greater than the operational statement timeout.
 */
export async function operationalQuery(config) {
    await ensureMigrations();
    const result = await getOperationalPool().query(config);
    return result.rows;
}
export async function operationalQueryOne(config) {
    return (await operationalQuery(config))[0];
}
/** Execute a statement (INSERT/UPDATE/DELETE) and return affected row count. */
export async function execute(sql, params) {
    await ensureMigrations();
    const fencedClient = currentAdvisoryClient();
    const start = Date.now();
    if (fencedClient) {
        const result = await fencedClient.query(sql, params);
        logSlowQuery(sql, params, Date.now() - start);
        return { rowCount: result.rowCount ?? 0 };
    }
    const client = await getPool().connect();
    try {
        await resetSessionState(client);
        const result = await client.query(sql, params);
        logSlowQuery(sql, params, Date.now() - start);
        return { rowCount: result.rowCount ?? 0 };
    }
    finally {
        client.release();
    }
}
/**
 * Run a function inside a transaction.
 * Acquires a client, BEGINs, runs fn, COMMITs on success, ROLLBACKs on error.
 */
export async function transaction(fn) {
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
                }
                catch (err) {
                    await fencedContext.client.query('ROLLBACK');
                    throw err;
                }
            });
        }
        finally {
            if (fencedContext.transactionOwner === owner)
                fencedContext.transactionOwner = undefined;
        }
    }
    const client = await getPool().connect();
    try {
        await resetSessionState(client);
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    }
    catch (err) {
        await client.query('ROLLBACK');
        throw err;
    }
    finally {
        client.release();
    }
}
/**
 * Runs SELECT 1 and returns pool diagnostics + PostgreSQL metadata.
 * Used by GET /api/health. PG-019: includes cloud compatibility reporting.
 */
export async function dbHealthCheck() {
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
        let pgVersion;
        let extensions = [];
        let vectorAvailable = false;
        let ageAvailable = false;
        try {
            const versionRow = await p.query('SELECT version()');
            pgVersion = versionRow.rows[0]?.version;
            const extRows = await p.query("SELECT extname FROM pg_extension WHERE extname IN ('vector', 'age', 'pgcrypto') ORDER BY extname");
            extensions = extRows.rows.map(r => r.extname);
            vectorAvailable = extensions.includes('vector');
            ageAvailable = extensions.includes('age');
        }
        catch {
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
            extensionStatus: { vector: vectorAvailable, age: ageAvailable },
            connectionLimit: _serverMaxConnections ?? undefined,
        };
    }
    catch {
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
export async function initDb() {
    await ensureMigrations();
    await seedDefaultAdmin();
    await seedWorkerSettings();
}
// ── Seed Worker Settings ─────────────────────────────────────────────────
async function seedWorkerSettings() {
    await execute(`INSERT INTO worker_settings (key, value)
     VALUES ('max_concurrent_runs', '3')
     ON CONFLICT (key) DO NOTHING`);
}
// ── Seed Default Admin ───────────────────────────────────────────────────
async function seedDefaultAdmin() {
    const existing = await queryOne("SELECT id FROM users WHERE email = 'admin@rorca.local'");
    if (!existing) {
        const hasPasswordHash = await queryOne(`SELECT EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'users'
           AND column_name = 'password_hash'
       ) AS exists`);
        if (hasPasswordHash?.exists) {
            // bcrypt hash of 'rorca123' (cost 10) for legacy/local-auth schemas.
            const defaultHash = '$2b$10$BMXqmRMejhhifW5gs6Ju.eI.cxoG/k7iW5sGJ86Nb4WloLowY.qxy';
            await execute(`INSERT INTO users (id, email, display_name, password_hash, role, plan, email_verified_at)
         VALUES ('local-admin', 'admin@rorca.local', 'Admin', $1, 'admin', 'pro', NOW())`, [defaultHash]);
        }
        else {
            await execute(`INSERT INTO users (id, email, display_name, role, plan, email_verified_at)
         VALUES ('local-admin', 'admin@rorca.local', 'Admin', 'admin', 'pro', NOW())`);
        }
        logger.info('[db] Seeded default admin user (admin@rorca.local)');
    }
    else {
        await execute("UPDATE users SET plan = 'pro' WHERE email = 'admin@rorca.local' AND plan = 'free'");
    }
}
// ── Graceful Shutdown ────────────────────────────────────────────────────
async function shutdown() {
    const closing = [];
    if (_pool) {
        logger.info('[db] Closing application pool...');
        closing.push(_pool.end());
        _pool = null;
    }
    if (_operationalPool) {
        logger.info('[db] Closing operational pool...');
        closing.push(_operationalPool.end());
        _operationalPool = null;
    }
    await Promise.allSettled(closing);
    if (closing.length > 0)
        logger.info('[db] Pools closed');
}
// Exported for tests that need to close the pool to release connections
export const closePool = shutdown;
// Register shutdown handlers unconditionally, but check RORCA_PROCESS_ROLE at
// runtime (not import time) — ES module hoisting means env vars set in worker.ts
// aren't available when this module's top-level code evaluates.
// Worker and engine processes manage their own pool lifecycle.
process.on('SIGTERM', () => {
    if (process.env.RORCA_PROCESS_ROLE !== 'engine' && process.env.RORCA_PROCESS_ROLE !== 'worker') {
        shutdown().catch(() => { });
    }
});
process.on('SIGINT', () => {
    if (process.env.RORCA_PROCESS_ROLE !== 'engine' && process.env.RORCA_PROCESS_ROLE !== 'worker') {
        shutdown().catch(() => { });
    }
});
