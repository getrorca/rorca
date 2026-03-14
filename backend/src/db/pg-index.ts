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

// ── Duplicate-prefix guard ────────────────────────────────────────────────
/**
 * Checks a list of migration filenames for duplicate numeric prefixes.
 *
 * Throws if two or more files share the same prefix number (e.g. 069_foo.sql
 * and 069_bar.sql). Called at startup BEFORE any migrations are applied so
 * the runner never silently skips a file due to a number collision.
 *
 * Zero-padded and non-padded prefixes collide (parseInt('069') === parseInt('69')).
 *
 * @param filenames - Array of .sql migration filenames (may include non-numbered files)
 * @throws Error listing all conflicting filenames if any duplicate prefix is found
 */
export function checkDuplicatePrefixes(filenames: string[]): void {
  const prefixMap = new Map<number, string[]>();

  for (const file of filenames) {
    const match = file.match(/^(\d+)/);
    if (!match) continue; // non-numbered files are ignored
    const prefix = parseInt(match[1], 10);
    const existing = prefixMap.get(prefix) ?? [];
    existing.push(file);
    prefixMap.set(prefix, existing);
  }

  const duplicates: string[] = [];
  for (const [prefix, files] of prefixMap) {
    if (files.length > 1) {
      duplicates.push(`  prefix ${prefix}: ${files.join(', ')}`);
    }
  }

  if (duplicates.length > 0) {
    throw new Error(
      `[pg-migrate] DUPLICATE migration prefixes detected — rename conflicting files before starting:\n${duplicates.join('\n')}`
    );
  }
}

// ── Migration runner ──────────────────────────────────────────────────────
export async function runPgMigrations(pool?: Pool): Promise<void> {
  const ownPool = !pool;
  if (!pool) pool = createPool();

  const client = await pool.connect();

  try {
    // Ensure schema_migrations tracking table exists.
    // version is BIGINT to support 14-digit timestamp prefixes (e.g. 20260313120000).
    // Existing DBs are upgraded from INTEGER → BIGINT via migration 075.
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version BIGINT PRIMARY KEY,
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

    // Read and sort migration files by numeric prefix (ascending).
    //
    // Two filename formats are supported and coexist indefinitely:
    //   Sequential:  001_init.sql        → version 1
    //   Timestamp:   20260313120000_x.sql → version 20260313120000
    //
    // Timestamps naturally sort after all sequential numbers (max sequential ≈ 999,
    // min timestamp ≈ 20000000000000). Numeric sort is mandatory — lexicographic
    // sort would break ordering ("20260313" < "3" as strings).
    //
    // Timestamp format also prevents the duplicate-number collision class seen with
    // parallel feature branches (e.g. the 069/072 collisions in this repo).
    const allFiles = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql'));

    // Fail fast on duplicate numeric prefixes BEFORE applying any migrations.
    // Two parallel branches creating 069_foo.sql and 069_bar.sql would otherwise
    // silently skip one — this throws an error listing the conflicting filenames.
    checkDuplicatePrefixes(allFiles);

    const files = allFiles
      .sort((a, b) => {
        const aMatch = a.match(/^(\d+)/);
        const bMatch = b.match(/^(\d+)/);
        const aNum = aMatch ? parseInt(aMatch[1], 10) : 0;
        const bNum = bMatch ? parseInt(bMatch[1], 10) : 0;
        return aNum - bNum;
      });

    // Fetch already-applied versions
    const { rows: applied } = await client.query('SELECT version FROM schema_migrations');
    const appliedVersions = new Set(applied.map(r => r.version));

    // PG-019: Migrations that create extensions may fail on managed services
    // (e.g., Supabase pre-installs pgvector, Neon doesn't support AGE).
    // Extension migration filenames contain these keywords for detection.
    const EXTENSION_MIGRATION_PATTERNS = ['pgvector', 'pgcrypto', 'knowledge_graph', 'age', 'vector', 'enrich_spec_logs'];

    function isExtensionMigration(filename: string): boolean {
      const lower = filename.toLowerCase();
      return EXTENSION_MIGRATION_PATTERNS.some(pat => lower.includes(pat));
    }

    let appliedCount = 0;
    let skippedCount = 0;

    for (const file of files) {
      // Extract version number from filename prefix.
      // Accepts both 3-digit sequential ("001_init.sql" → 1) and
      // 14-digit timestamp ("20260313120000_x.sql" → 20260313120000).
      // parseInt() is safe for 14-digit timestamps: max ~2×10^13 < Number.MAX_SAFE_INTEGER (~9×10^15).
      // schema_migrations.version is BIGINT (migration 075) — no overflow.
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
