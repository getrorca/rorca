/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

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
import { bootstrapRorcaV2GraphForLifecycle } from '../lib/graph-contract';

const MIGRATIONS_ADVISORY_LOCK_KEY = 8_244_250_520_000;

// ── Connection ────────────────────────────────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/rorca';

export function createPool(): Pool {
  return new Pool({ connectionString: DATABASE_URL });
}

export function createPoolForConnectionString(connectionString: string): Pool {
  return new Pool({ connectionString });
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
 */
export function checkDuplicatePrefixes(filenames: string[]): void {
  const prefixMap = new Map<number, string[]>();

  for (const file of filenames) {
    const match = file.match(/^(\d+)/);
    if (!match) continue;
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

  let client = await pool.connect();
  let clientUsable = true;
  let advisoryLockHeld = false;
  let migrationsCompleted = false;

  const acquireMigrationSession = async (): Promise<void> => {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATIONS_ADVISORY_LOCK_KEY]);
    advisoryLockHeld = true;
    await client.query('SET search_path TO rorca, public');
  };

  try {
    // Serialize migration runners across server/worker/dev processes. The lock
    // belongs to this exact session and is reacquired after client replacement.
    await acquireMigrationSession();

    // Ensure the application schema exists before any unqualified migration SQL runs.
    // Without this, early migrations (e.g. 001_init.sql) land in public on a fresh
    // database because rorca does not exist yet, while later reruns use rorca first.
    // That split creates duplicate tables across schemas and breaks idempotency.
    await client.query('CREATE SCHEMA IF NOT EXISTS rorca');

    // acquireMigrationSession pinned rorca/public on the lock-owning session.

    // Ensure schema_migrations tracking table exists in public explicitly.
    // On a brand-new database the rorca schema may not exist yet, so an unqualified
    // CREATE TABLE would land in public on first boot but in rorca on later boots,
    // splitting migration tracking across schemas and breaking idempotent reruns.
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        version BIGINT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        filename TEXT NOT NULL,
        skipped_in_lite_mode BOOLEAN NOT NULL DEFAULT FALSE
      )
    `);

    await client.query(`
      ALTER TABLE public.schema_migrations
      ADD COLUMN IF NOT EXISTS skipped_in_lite_mode BOOLEAN NOT NULL DEFAULT FALSE
    `);

    await client.query(`
      DO $$
      BEGIN
        IF to_regclass('rorca.schema_migrations') IS NOT NULL THEN
          INSERT INTO public.schema_migrations (version, applied_at, filename, skipped_in_lite_mode)
          SELECT version, applied_at, filename, FALSE
          FROM rorca.schema_migrations
          ON CONFLICT (version) DO NOTHING;
        END IF;
      END $$;
    `);

    // Resolve migrations directory without assuming CommonJS __dirname.
    const migrationDirCandidates = [
      typeof __dirname !== 'undefined' ? path.join(__dirname, 'pg-migrations') : '',
      typeof __dirname !== 'undefined' ? path.join(__dirname, '..', '..', 'src', 'db', 'pg-migrations') : '',
      path.join(process.cwd(), 'src', 'db', 'pg-migrations'),
      path.join(process.cwd(), 'dist', 'db', 'pg-migrations'),
    ].filter(Boolean);

    const migrationsDir = migrationDirCandidates.find((candidate) => fs.existsSync(candidate));

    if (!migrationsDir) {
      console.error(`[pg-migrate] Migrations directory not found. Tried: ${migrationDirCandidates.join(', ')}`);
      process.exit(1);
    }

    // Read and sort migration files by numeric prefix (ascending).
    //
    // Two filename formats are supported and coexist indefinitely:
    //   Sequential:  001_init.sql         → version 1
    //   Timestamp:   20260314150000_x.sql → version 20260314150000
    //
    // Timestamps naturally sort after all sequential numbers (max sequential ≈ 999,
    // min timestamp ≈ 20000000000000). Numeric sort is mandatory — lexicographic
    // sort would break ordering ("20260313" < "3" as strings).
    const allFiles = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql'));

    // Fail fast on duplicate numeric prefixes BEFORE applying any migrations.
    checkDuplicatePrefixes(allFiles);

    const files = allFiles
      .sort((a, b) => {
        const aNum = parseInt(a.match(/^(\d+)/)?.[1] ?? '0', 10);
        const bNum = parseInt(b.match(/^(\d+)/)?.[1] ?? '0', 10);
        return aNum - bNum;
      });

    // Fetch already-applied versions.
    // pg returns BIGINT as strings — coerce to numbers for Set.has() lookups.
    const { rows: applied } = await client.query('SELECT version FROM public.schema_migrations');
    let appliedVersions = new Set(applied.map(r => Number(r.version)));
    const refreshAppliedVersions = async (): Promise<void> => {
      const refreshed = await client.query('SELECT version FROM public.schema_migrations');
      appliedVersions = new Set(refreshed.rows.map(r => Number(r.version)));
    };
    const replacePoisonedMigrationSession = async (): Promise<void> => {
      advisoryLockHeld = false; // destroying this backend releases its session lock
      try { client.release(true); } catch { /* already released or dead */ }
      clientUsable = false;
      client = await pool!.connect();
      clientUsable = true;
      try {
        await acquireMigrationSession();
        // Another runner may have applied migrations while this process did not
        // own the lock. Refresh before any catalog, DDL, or marker write.
        await refreshAppliedVersions();
      } catch (error) {
        if (advisoryLockHeld) {
          try { await client.query('SELECT pg_advisory_unlock($1)', [MIGRATIONS_ADVISORY_LOCK_KEY]); } catch { /* best effort */ }
        }
        advisoryLockHeld = false;
        try { client.release(true); } catch { /* unusable replacement */ }
        clientUsable = false;
        throw error;
      }
    };

    const persistMigrationMarker = async (
      version: number,
      filename: string,
      skippedInLiteMode: boolean,
    ): Promise<void> => {
      const inserted = await client.query<{ filename: string; skipped_in_lite_mode: boolean }>(
        `INSERT INTO public.schema_migrations (version, filename, skipped_in_lite_mode)
         VALUES ($1, $2, $3)
         ON CONFLICT (version) DO NOTHING
         RETURNING filename, skipped_in_lite_mode`,
        [version, filename, skippedInLiteMode],
      );
      const marker = inserted.rows[0] ?? (await client.query<{ filename: string; skipped_in_lite_mode: boolean }>(
        `SELECT filename, skipped_in_lite_mode
         FROM public.schema_migrations WHERE version = $1`,
        [version],
      )).rows[0];
      if (!marker || marker.filename !== filename
        || Boolean(marker.skipped_in_lite_mode) !== skippedInLiteMode) {
        throw new Error(`[pg-migrate] Durable migration marker conflict for version ${version}`);
      }
    };

    // PG-019: Migrations that create extensions may fail on managed services
    // (e.g., Supabase pre-installs pgvector, Neon doesn't support AGE).
    // Extension migration filenames contain these keywords for detection.
    const EXTENSION_MIGRATION_PATTERNS = ['048_pgcrypto', '049_pgvector_embeddings', '050_knowledge_graph'];

    function isExtensionMigration(filename: string): boolean {
      const lower = filename.toLowerCase();
      return EXTENSION_MIGRATION_PATTERNS.some(pat => lower.includes(pat));
    }

    let appliedCount = 0;
    let skippedCount = 0;

    for (const file of files) {
      // Extract version number from filename prefix.
      // Accepts both 3-digit sequential ("001_init.sql" → 1) and
      // 14-digit timestamp ("20260314150000_x.sql" → 20260314150000).
      // parseInt() is safe for 14-digit timestamps: max ~2×10^13 < Number.MAX_SAFE_INTEGER (~9×10^15).
      // schema_migrations.version is BIGINT (migration 079) — no overflow.
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

      // AGE graph names are PostgreSQL schemas. The obsolete graph was named
      // `rorca`, which now belongs exclusively to application tables. Handle
      // migration 050 without executing historical graph DDL, then run the
      // idempotent rorca_v2 lifecycle bootstrap after every migration pass —
      // including when version 050 was recorded by an older release.
      if (file.startsWith('050_knowledge_graph')) {
        // Keep the useful, non-conflicting part of the legacy migration: install
        // AGE when this PostgreSQL distribution and role support it. Failure is
        // intentionally non-fatal so managed/lite databases continue migrating.
        try {
          await client.query('CREATE EXTENSION IF NOT EXISTS age');
        } catch (err) {
          console.warn(`[pg-migrate] AGE extension unavailable; continuing in graph-lite mode: ${(err as Error).message || err}`);

          // Loading AGE can install backend hooks before CREATE EXTENSION later
          // fails. Replace the poisoned session, reacquire the same global lock,
          // restore search_path, and refresh the ledger before continuing.
          await replacePoisonedMigrationSession();
          if (appliedVersions.has(version)) {
            skippedCount++;
            continue;
          }
          // CREATE/LOAD failed, so graph catalog probing is neither authoritative
          // nor necessarily permitted. Persist the graph-lite decision under the
          // replacement session's reacquired lock and continue fail-closed.
          await persistMigrationMarker(version, `${file} [skipped: extension unavailable]`, true);
          appliedVersions.add(version);
          skippedCount++;
          continue;
        }

        // Never execute the historical migration body: it is capability-only,
        // and graph ownership belongs to the lifecycle bootstrap below.
        await persistMigrationMarker(version, `${file} [graph bootstrap: rorca_v2]`, false);
        appliedVersions.add(version);
        appliedCount++;
        console.log('[pg-migrate] AGE capability recorded; rorca_v2 lifecycle bootstrap pending');
        continue;
      }

      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

      // Wrap each migration in a transaction
      try {
        await client.query('BEGIN');
        // Re-assert search_path per migration transaction because some migrations
        // temporarily switch it to public and do not restore it for the session.
        await client.query('SET LOCAL search_path TO rorca, public');
        await client.query(sql);
        await persistMigrationMarker(version, file, false);
        await client.query('COMMIT');
        appliedVersions.add(version);
        appliedCount++;
        console.log(`[pg-migrate] Applied: ${file}`);
      } catch (err) {
        // Try to rollback — may fail if connection was killed (e.g. LOAD 'age' crash)
        try { await client.query('ROLLBACK'); } catch { /* connection may be dead */ }

        // PG-019: Extension migrations are non-fatal on managed services.
        // Some managed Postgres providers pre-install extensions (CREATE EXTENSION
        // fails with "already loaded") or don't support them at all (AGE on
        // Supabase/Neon). Mark as applied so we don't retry, and continue.
        // LOAD 'age' can kill the backend process entirely, terminating the connection.
        if (isExtensionMigration(file)) {
          console.warn(`[pg-migrate] Extension migration failed (non-fatal): ${file}`);
          console.warn(`[pg-migrate] Reason: ${(err as Error).message || err}`);

          // AGE's LOAD can leave the backend session poisoned even when the SQL
          // error is non-fatal. Replace it under a newly acquired lock and
          // refresh versions before deciding whether this runner writes a marker.
          await replacePoisonedMigrationSession();
          if (appliedVersions.has(version)) {
            skippedCount++;
            continue;
          }

          // The marker is migration authority. Any write/readback failure aborts;
          // graph-lite operation must never be reported from memory alone.
          await persistMigrationMarker(version, `${file} [skipped: extension unavailable]`, true);
          appliedVersions.add(version);
          skippedCount++;
          continue;
        }

        console.error(`[pg-migrate] FAILED: ${file}`);
        console.error(err);
        throw err;
      }
    }

    console.log(`[pg-migrate] Done. Applied: ${appliedCount}, Skipped: ${skippedCount}, Total: ${files.length}`);
    migrationsCompleted = true;
  } finally {
    // Restore search_path before releasing connection back to pool.
    // We set search_path=public above; without restoring, subsequent queries
    // on this pooled connection miss the rorca schema (same bug as AGE pool poisoning).
    if (clientUsable) {
      try { await client.query('SET search_path TO rorca, public'); } catch { /* best-effort */ }
      if (advisoryLockHeld) {
        try { await client.query('SELECT pg_advisory_unlock($1)', [MIGRATIONS_ADVISORY_LOCK_KEY]); } catch { /* best-effort */ }
      }
      client.release();
    }
    try {
      if (migrationsCompleted) {
        const graphLifecycle = await bootstrapRorcaV2GraphForLifecycle(pool);
        if (graphLifecycle.available) {
          console.log(`[pg-migrate] Graph bootstrap ready: ${graphLifecycle.graphName} (${graphLifecycle.labels.length} keyed labels)`);
        } else {
          console.warn(`[pg-migrate] Graph Lite active: rorca_v2 bootstrap ${graphLifecycle.reason}${graphLifecycle.errorCode ? ` (${graphLifecycle.errorCode})` : ''}`);
        }
      }
    } finally {
      if (ownPool) await pool.end();
    }
  }
}

export async function prepareLiteSkippedMigrationsForReplay(pool?: Pool): Promise<number[]> {
  const ownPool = !pool;
  if (!pool) pool = createPool();

  const client = await pool.connect();
  let advisoryLockHeld = false;
  try {
    // Marker deletion is migration authority. Serialize it with every runner on
    // the same session and keep selection/deletion in one transaction.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATIONS_ADVISORY_LOCK_KEY]);
    advisoryLockHeld = true;
    await client.query('BEGIN');
    await client.query(`
      ALTER TABLE public.schema_migrations
      ADD COLUMN IF NOT EXISTS skipped_in_lite_mode BOOLEAN NOT NULL DEFAULT FALSE
    `);

    const { rows } = await client.query<{ version: string }>(`
      SELECT version::text
      FROM public.schema_migrations
      WHERE skipped_in_lite_mode = TRUE
         OR filename LIKE '%[skipped: extension unavailable]%'
      ORDER BY version ASC
      FOR UPDATE
    `);

    const versions = rows.map((row) => Number(row.version));
    if (versions.length > 0) {
      await client.query(
        `DELETE FROM public.schema_migrations
         WHERE version = ANY($1::bigint[])
           AND (skipped_in_lite_mode = TRUE OR filename LIKE '%[skipped: extension unavailable]%')`,
        [versions],
      );
    }
    await client.query('COMMIT');
    return versions;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ }
    throw error;
  } finally {
    if (advisoryLockHeld) {
      try { await client.query('SELECT pg_advisory_unlock($1)', [MIGRATIONS_ADVISORY_LOCK_KEY]); } catch { /* session release clears it */ }
    }
    client.release();
    if (ownPool) await pool.end();
  }
}

// ── CLI entrypoint ────────────────────────────────────────────────────────
const isDirectRun = typeof require !== 'undefined'
  && typeof module !== 'undefined'
  && require.main === module;
if (isDirectRun) {
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
