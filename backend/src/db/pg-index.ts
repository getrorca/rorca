/**
 * pg-index.ts — PostgreSQL migration runner for Rorca
 *
 * Connects via `pg` Pool, creates a `schema_migrations` tracking table,
 * runs each numbered .sql file inside a transaction, and skips
 * already-applied versions.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx tsx backend/src/db/pg-index.ts
 *
 * Or import and call programmatically:
 *   import { runPgMigrations } from './pg-index';
 *   await runPgMigrations();
 */

import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

// ── Connection ────────────────────────────────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/rorca';

export function createPool(): Pool {
  return new Pool({ connectionString: DATABASE_URL });
}

// ── Migration runner ──────────────────────────────────────────────────────
export async function runPgMigrations(pool?: Pool): Promise<void> {
  const ownPool = !pool;
  if (!pool) pool = createPool();

  const client = await pool.connect();

  try {
    // Ensure schema_migrations tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        filename TEXT NOT NULL
      )
    `);

    // Resolve migrations directory (works from both src/ and dist/)
    let migrationsDir = path.join(__dirname, 'pg-migrations');
    if (!fs.existsSync(migrationsDir)) {
      migrationsDir = path.join(__dirname, '..', '..', 'src', 'db', 'pg-migrations');
    }

    if (!fs.existsSync(migrationsDir)) {
      console.error(`[pg-migrate] Migrations directory not found: ${migrationsDir}`);
      process.exit(1);
    }

    // Read and sort migration files
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    // Fetch already-applied versions
    const { rows: applied } = await client.query('SELECT version FROM schema_migrations');
    const appliedVersions = new Set(applied.map(r => r.version));

    // PG-019: Migrations that create extensions may fail on managed services
    // (e.g., Supabase pre-installs pgvector, Neon doesn't support AGE).
    // Extension migration filenames contain these keywords for detection.
    const EXTENSION_MIGRATION_PATTERNS = ['pgvector', 'pgcrypto', 'knowledge_graph', 'age'];

    function isExtensionMigration(filename: string): boolean {
      const lower = filename.toLowerCase();
      return EXTENSION_MIGRATION_PATTERNS.some(pat => lower.includes(pat));
    }

    let appliedCount = 0;
    let skippedCount = 0;

    for (const file of files) {
      // Extract version number from filename: "001_init.sql" → 1
      const match = file.match(/^(\d+)/);
      if (!match) {
        console.warn(`[pg-migrate] Skipping non-numbered file: ${file}`);
        continue;
      }
      const version = parseInt(match[1], 10);

      if (appliedVersions.has(version)) {
        skippedCount++;
        continue;
      }

      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

      // Wrap each migration in a transaction
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version, filename) VALUES ($1, $2)',
          [version, file]
        );
        await client.query('COMMIT');
        appliedCount++;
        console.log(`[pg-migrate] Applied: ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');

        // PG-019: Extension migrations are non-fatal on managed services.
        // Some managed Postgres providers pre-install extensions (CREATE EXTENSION
        // fails with "already loaded") or don't support them at all (AGE on
        // Supabase/Neon). Mark as applied so we don't retry, and continue.
        if (isExtensionMigration(file)) {
          console.warn(`[pg-migrate] Extension migration failed (non-fatal): ${file}`);
          console.warn(`[pg-migrate] Reason: ${(err as Error).message || err}`);
          // Record as applied to prevent retries
          try {
            await client.query(
              'INSERT INTO schema_migrations (version, filename) VALUES ($1, $2)',
              [version, `${file} [skipped: extension unavailable]`]
            );
          } catch {
            // schema_migrations insert itself may fail if version already exists
          }
          skippedCount++;
          continue;
        }

        console.error(`[pg-migrate] FAILED: ${file}`);
        console.error(err);
        throw err;
      }
    }

    console.log(`[pg-migrate] Done. Applied: ${appliedCount}, Skipped: ${skippedCount}, Total: ${files.length}`);
  } finally {
    client.release();
    if (ownPool) await pool.end();
  }
}

// ── CLI entrypoint ────────────────────────────────────────────────────────
if (require.main === module) {
  runPgMigrations()
    .then(() => {
      console.log('[pg-migrate] All migrations applied successfully.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[pg-migrate] Migration failed:', err);
      process.exit(1);
    });
}
