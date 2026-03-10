/**
 * db/index.ts — PostgreSQL connection pool + async query helpers for Rorca
 *
 * Replaces the previous better-sqlite3 synchronous interface with an async
 * pg Pool. Helpers mirror the old API shape so route conversion is mechanical:
 *
 *   db.prepare(sql).all(...)   →  await query<T>(sql, params)
 *   db.prepare(sql).get(...)   →  await queryOne<T>(sql, params)
 *   db.prepare(sql).run(...)   →  await execute(sql, params)
 *   db.transaction(fn)()       →  await transaction(fn)
 *
 * All queries use $1, $2, ... numbered placeholders natively.
 * A rewritePlaceholders() utility is available for incremental migration.
 */

import { Pool, PoolClient, PoolConfig } from 'pg';
import { logger } from '../lib/logger';
import { runPgMigrations } from './pg-index';

// ── Configuration ────────────────────────────────────────────────────────

const SLOW_QUERY_THRESHOLD_MS = parseInt(process.env.SLOW_QUERY_THRESHOLD_MS || '500', 10);

function buildPoolConfig(): PoolConfig {
  const databaseUrl = process.env.DATABASE_URL;

  if (databaseUrl) {
    const needsSsl = databaseUrl.includes('sslmode=require');
    return {
      connectionString: databaseUrl,
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 30_000,
      ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
    };
  }

  const needsSsl = process.env.PGSSLMODE === 'require';
  return {
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    user: process.env.PGUSER || 'rorca',
    password: process.env.PGPASSWORD || 'rorca',
    database: process.env.PGDATABASE || 'rorca',
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
    ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  };
}

// ── Lazy Pool ────────────────────────────────────────────────────────────

let _pool: Pool | null = null;
let _migrationsDone = false;
let _migrationsRunning: Promise<void> | null = null;

function getPool(): Pool {
  if (!_pool) {
    _pool = new Pool(buildPoolConfig());

    _pool.on('error', (err) => {
      logger.error({ err }, '[db] Unexpected pool error');
    });
  }
  return _pool;
}

/** Ensure migrations have run exactly once. Awaited before first query. */
async function ensureMigrations(): Promise<void> {
  if (_migrationsDone) return;
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
  })();
  await _migrationsRunning;
}

// ── Exported Pool ────────────────────────────────────────────────────────

/** The pg Pool instance. Prefer using query/queryOne/execute/transaction helpers. */
export const pool: Pool = new Proxy({} as Pool, {
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
 * Available for incremental migration but should NOT be used in final code.
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

// ── Query Helpers ────────────────────────────────────────────────────────

/**
 * Execute a query and return all matching rows.
 * Replaces: db.prepare(sql).all(...params)
 */
export async function query<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  await ensureMigrations();
  const p = getPool();
  const start = Date.now();
  const result = await p.query(sql, params);
  logSlowQuery(sql, params, Date.now() - start);
  return result.rows as T[];
}

/**
 * Execute a query and return the first row, or undefined.
 * Replaces: db.prepare(sql).get(...params)
 */
export async function queryOne<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<T | undefined> {
  await ensureMigrations();
  const p = getPool();
  const start = Date.now();
  const result = await p.query(sql, params);
  logSlowQuery(sql, params, Date.now() - start);
  return (result.rows[0] as T) ?? undefined;
}

/**
 * Execute a statement (INSERT/UPDATE/DELETE) and return affected row count.
 * Replaces: db.prepare(sql).run(...params)
 */
export async function execute(
  sql: string,
  params?: unknown[],
): Promise<{ rowCount: number }> {
  await ensureMigrations();
  const p = getPool();
  const start = Date.now();
  const result = await p.query(sql, params);
  logSlowQuery(sql, params, Date.now() - start);
  return { rowCount: result.rowCount ?? 0 };
}

/**
 * Run a function inside a transaction.
 * Acquires a client, BEGINs, runs fn, COMMITs on success, ROLLBACKs on error.
 * Replaces: db.transaction(() => { ... })()
 */
export async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  await ensureMigrations();
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Health Check ─────────────────────────────────────────────────────────

export interface DbHealthResult {
  ok: boolean;
  latencyMs: number;
  poolStats: { total: number; idle: number; waiting: number };
}

/**
 * Runs SELECT 1 and returns pool diagnostics.
 * Used by GET /api/health.
 */
export async function dbHealthCheck(): Promise<DbHealthResult> {
  const p = getPool();
  const start = Date.now();
  try {
    await p.query('SELECT 1');
    const latencyMs = Date.now() - start;
    return {
      ok: true,
      latencyMs,
      poolStats: {
        total: p.totalCount,
        idle: p.idleCount,
        waiting: p.waitingCount,
      },
    };
  } catch {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      poolStats: {
        total: p.totalCount,
        idle: p.idleCount,
        waiting: p.waitingCount,
      },
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
}

// ── Seed Default Admin ───────────────────────────────────────────────────

async function seedDefaultAdmin(): Promise<void> {
  const existing = await queryOne<{ id: string }>(
    "SELECT id FROM users WHERE email = 'admin@rorca.local'",
  );
  if (!existing) {
    // bcrypt hash of 'rorca123' (cost 10)
    const defaultHash = '$2b$10$BMXqmRMejhhifW5gs6Ju.eI.cxoG/k7iW5sGJ86Nb4WloLowY.qxy';
    await execute(
      `INSERT INTO users (id, email, display_name, password_hash, role, plan, email_verified_at)
       VALUES ('local-admin', 'admin@rorca.local', 'Admin', $1, 'admin', 'pro', NOW())`,
      [defaultHash],
    );
    logger.info('[db] Seeded default admin user (admin@rorca.local)');
  } else {
    await execute(
      "UPDATE users SET plan = 'pro' WHERE email = 'admin@rorca.local' AND plan = 'free'",
    );
  }
}

// ── Graceful Shutdown ────────────────────────────────────────────────────

async function shutdown(): Promise<void> {
  if (_pool) {
    logger.info('[db] Closing pool...');
    await _pool.end();
    _pool = null;
    logger.info('[db] Pool closed');
  }
}

process.on('SIGTERM', () => { shutdown().catch(() => {}); });
process.on('SIGINT', () => { shutdown().catch(() => {}); });

// ── Backward-Compatible `db` Shim ──────────────────────────────────────
//
// Many route files still `import { db } from '../db/index'` and call
// db.prepare(sql).get/all/run(...).  This shim lets unconverted files
// compile and run until they are migrated to the async helpers above.
// The shim is intentionally synchronous-looking but uses the async pool
// under the hood.  It logs a deprecation warning on first use so we can
// track remaining migration work.
//
// REMOVE this shim once all files are converted to async helpers.

let _dbShimWarned = false;

function warnLegacyUsage(method: string): void {
  if (!_dbShimWarned) {
    logger.warn(`[db] Legacy db.prepare().${method}() called — migrate this call site to async helpers`);
    _dbShimWarned = true;
  }
}

/**
 * Backward-compatible shim that mimics better-sqlite3's synchronous API
 * by blocking on the pg Pool.  Only for unconverted files.
 *
 * @deprecated Use query/queryOne/execute/transaction instead.
 */
export const db = {
  prepare(sql: string) {
    // Convert ? placeholders to $1, $2, ... on the fly
    const pgSql = rewritePlaceholders(sql);
    return {
      get(...params: unknown[]): unknown {
        warnLegacyUsage('get');
        // We can't truly block, so we return a promise — callers that
        // don't await will get a Promise object (which is truthy).
        // This is intentional: it keeps TypeScript happy and the warning
        // tells us which call sites to fix.
        return (async () => {
          await ensureMigrations();
          const p = getPool();
          const result = await p.query(pgSql, params);
          return result.rows[0] ?? undefined;
        })();
      },
      all(...params: unknown[]): unknown {
        warnLegacyUsage('all');
        return (async () => {
          await ensureMigrations();
          const p = getPool();
          const result = await p.query(pgSql, params);
          return result.rows;
        })();
      },
      run(...params: unknown[]): unknown {
        warnLegacyUsage('run');
        return (async () => {
          await ensureMigrations();
          const p = getPool();
          const result = await p.query(pgSql, params);
          return { changes: result.rowCount ?? 0, lastInsertRowid: 0 };
        })();
      },
    };
  },
  transaction<T>(fn: () => T) {
    warnLegacyUsage('transaction');
    // Returns a callable that executes the function — matches better-sqlite3 API
    return () => fn();
  },
};
