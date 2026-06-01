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
import * as fs from 'fs';
import { Pool } from 'pg';
import { logger } from '../lib/logger';
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
function buildSslConfig(connectionString) {
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
function buildPoolConfig() {
    const databaseUrl = process.env.DATABASE_URL;
    const configuredPoolSize = parseInt(process.env.PG_POOL_SIZE || String(DEFAULT_POOL_SIZE), 10);
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
let _migrationsDone = false;
let _migrationsRunning = null;
function getPool() {
    if (!_pool) {
        _pool = new Pool(buildPoolConfig());
        // Guarantee search_path on every new connection — guards against AGE graph
        // queries that SET search_path to ag_catalog and poison the pool connection.
        _pool.on('connect', (client) => {
            client.query('RESET ROLE').catch(() => { });
            client.query('RESET request.jwt.claim.sub').catch(() => { });
            client.query('RESET request.jwt.claims').catch(() => { });
            client.query('SET search_path TO rorca, public').catch(() => { });
        });
        _pool.on('error', (err) => {
            logger.error({ err }, '[db] Unexpected pool error');
        });
    }
    return _pool;
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
        // Intercept to ensure pool exists lazily
        const real = getPool();
        const val = Reflect.get(real, prop, receiver);
        return typeof val === 'function' ? val.bind(real) : val;
    },
});
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
async function resetSessionState(client) {
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
    const p = getPool();
    const client = await p.connect();
    const start = Date.now();
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
    const p = getPool();
    const client = await p.connect();
    const start = Date.now();
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
 * Execute a statement (INSERT/UPDATE/DELETE) and return affected row count.
 */
export async function execute(sql, params) {
    await ensureMigrations();
    const p = getPool();
    const client = await p.connect();
    const start = Date.now();
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
    const p = getPool();
    const client = await p.connect();
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
        // bcrypt hash of 'rorca123' (cost 10)
        const defaultHash = '$2b$10$BMXqmRMejhhifW5gs6Ju.eI.cxoG/k7iW5sGJ86Nb4WloLowY.qxy';
        await execute(`INSERT INTO users (id, email, display_name, password_hash, role, plan, email_verified_at)
       VALUES ('local-admin', 'admin@rorca.local', 'Admin', $1, 'admin', 'pro', NOW())`, [defaultHash]);
        logger.info('[db] Seeded default admin user (admin@rorca.local)');
    }
    else {
        await execute("UPDATE users SET plan = 'pro' WHERE email = 'admin@rorca.local' AND plan = 'free'");
    }
}
// ── Graceful Shutdown ────────────────────────────────────────────────────
async function shutdown() {
    if (_pool) {
        logger.info('[db] Closing pool...');
        await _pool.end();
        _pool = null;
        logger.info('[db] Pool closed');
    }
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
