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
const MIGRATIONS_ADVISORY_LOCK_KEY = 8_244_250_520_000;
// ── Connection ────────────────────────────────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/rorca';
export function createPool() {
    return new Pool({ connectionString: DATABASE_URL });
}
export function createPoolForConnectionString(connectionString) {
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
export function checkDuplicatePrefixes(filenames) {
    const prefixMap = new Map();
    for (const file of filenames) {
        const match = file.match(/^(\d+)/);
        if (!match)
            continue;
        const prefix = parseInt(match[1], 10);
        const existing = prefixMap.get(prefix) ?? [];
        existing.push(file);
        prefixMap.set(prefix, existing);
    }
    const duplicates = [];
    for (const [prefix, files] of prefixMap) {
        if (files.length > 1) {
            duplicates.push(`  prefix ${prefix}: ${files.join(', ')}`);
        }
    }
    if (duplicates.length > 0) {
        throw new Error(`[pg-migrate] DUPLICATE migration prefixes detected — rename conflicting files before starting:\n${duplicates.join('\n')}`);
    }
}
// ── Migration runner ──────────────────────────────────────────────────────
export async function runPgMigrations(pool) {
    const ownPool = !pool;
    if (!pool)
        pool = createPool();
    let client = await pool.connect();
    let advisoryLockHeld = false;
    try {
        // Serialize migration runners across server/worker/dev processes.
        // Without this, two processes can both observe a migration as unapplied and race
        // to INSERT the same version into schema_migrations, crashing one side during dev startup.
        await client.query('SELECT pg_advisory_lock($1)', [MIGRATIONS_ADVISORY_LOCK_KEY]);
        advisoryLockHeld = true;
        // Ensure the application schema exists before any unqualified migration SQL runs.
        // Without this, early migrations (e.g. 001_init.sql) land in public on a fresh
        // database because rorca does not exist yet, while later reruns use rorca first.
        // That split creates duplicate tables across schemas and breaks idempotency.
        await client.query('CREATE SCHEMA IF NOT EXISTS rorca');
        // Pin search_path for the migration session. Include rorca so new RLS migrations
        // can reference app tables (run_output_chunks, pipeline_runs, etc.) by unqualified name.
        await client.query('SET search_path TO rorca, public');
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
        const appliedVersions = new Set(applied.map(r => Number(r.version)));
        // PG-019: Migrations that create extensions may fail on managed services
        // (e.g., Supabase pre-installs pgvector, Neon doesn't support AGE).
        // Extension migration filenames contain these keywords for detection.
        const EXTENSION_MIGRATION_PATTERNS = ['048_pgcrypto', '049_pgvector_embeddings', '050_knowledge_graph'];
        function isExtensionMigration(filename) {
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
            // AGE graph names are PostgreSQL schemas. The legacy graph was named
            // `rorca`, which now intentionally belongs to application tables. If AGE
            // is installed but that graph was never created, executing migration 050
            // would LOAD AGE, fail at create_graph('rorca'), and poison the backend
            // session after rollback. Skip it before LOAD; the supported rorca_v2
            // bootstrap uses its own non-conflicting graph schema.
            if (file.startsWith('050_knowledge_graph')) {
                // Keep the useful, non-conflicting part of the legacy migration: install
                // AGE when this PostgreSQL distribution and role support it. Failure is
                // intentionally non-fatal so managed/lite databases continue migrating.
                try {
                    await client.query('CREATE EXTENSION IF NOT EXISTS age');
                }
                catch (err) {
                    console.warn(`[pg-migrate] AGE extension unavailable; continuing in graph-lite mode: ${err.message || err}`);
                }
                const catalog = await client.query(`SELECT to_regclass('ag_catalog.ag_graph')::text AS graph_catalog`);
                let legacyGraphExists = false;
                if (catalog.rows[0]?.graph_catalog) {
                    const graph = await client.query(`SELECT EXISTS (SELECT 1 FROM ag_catalog.ag_graph WHERE name = 'rorca') AS exists`);
                    legacyGraphExists = Boolean(graph.rows[0]?.exists);
                }
                if (!legacyGraphExists) {
                    await client.query('INSERT INTO public.schema_migrations (version, filename, skipped_in_lite_mode) VALUES ($1, $2, TRUE)', [version, `${file} [skipped: application schema collision]`]);
                    skippedCount++;
                    console.warn('[pg-migrate] Skipping legacy rorca AGE graph: application schema owns that name; use rorca_v2 bootstrap');
                    continue;
                }
            }
            const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
            // Wrap each migration in a transaction
            try {
                await client.query('BEGIN');
                // Re-assert search_path per migration transaction because some migrations
                // temporarily switch it to public and do not restore it for the session.
                await client.query('SET LOCAL search_path TO rorca, public');
                await client.query(sql);
                try {
                    await client.query('INSERT INTO public.schema_migrations (version, filename) VALUES ($1, $2)', [version, file]);
                }
                catch (err) {
                    if (err.code !== '23505') {
                        throw err;
                    }
                }
                await client.query('COMMIT');
                appliedCount++;
                console.log(`[pg-migrate] Applied: ${file}`);
            }
            catch (err) {
                // Try to rollback — may fail if connection was killed (e.g. LOAD 'age' crash)
                try {
                    await client.query('ROLLBACK');
                }
                catch { /* connection may be dead */ }
                // PG-019: Extension migrations are non-fatal on managed services.
                // Some managed Postgres providers pre-install extensions (CREATE EXTENSION
                // fails with "already loaded") or don't support them at all (AGE on
                // Supabase/Neon). Mark as applied so we don't retry, and continue.
                // LOAD 'age' can kill the backend process entirely, terminating the connection.
                if (isExtensionMigration(file)) {
                    console.warn(`[pg-migrate] Extension migration failed (non-fatal): ${file}`);
                    console.warn(`[pg-migrate] Reason: ${err.message || err}`);
                    // AGE's LOAD can leave the backend session poisoned even when the SQL
                    // error is non-fatal. Destroy the pooled connection so later DDL runs
                    // on a fresh backend instead of inheriting AGE hooks.
                    try {
                        client.release(true);
                    }
                    catch { /* already released or dead */ }
                    client = await pool.connect();
                    await client.query('SET search_path TO rorca, public');
                    // Record as applied to prevent retries
                    try {
                        await client.query('INSERT INTO public.schema_migrations (version, filename, skipped_in_lite_mode) VALUES ($1, $2, TRUE)', [version, `${file} [skipped: extension unavailable]`]);
                    }
                    catch {
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
    }
    finally {
        // Restore search_path before releasing connection back to pool.
        // We set search_path=public above; without restoring, subsequent queries
        // on this pooled connection miss the rorca schema (same bug as AGE pool poisoning).
        try {
            await client.query('SET search_path TO rorca, public');
        }
        catch { /* best-effort */ }
        if (advisoryLockHeld) {
            try {
                await client.query('SELECT pg_advisory_unlock($1)', [MIGRATIONS_ADVISORY_LOCK_KEY]);
            }
            catch { /* best-effort */ }
        }
        client.release();
        if (ownPool)
            await pool.end();
    }
}
export async function prepareLiteSkippedMigrationsForReplay(pool) {
    const ownPool = !pool;
    if (!pool)
        pool = createPool();
    const client = await pool.connect();
    try {
        await client.query(`
      ALTER TABLE public.schema_migrations
      ADD COLUMN IF NOT EXISTS skipped_in_lite_mode BOOLEAN NOT NULL DEFAULT FALSE
    `);
        const { rows } = await client.query(`
      SELECT version::text
      FROM public.schema_migrations
      WHERE skipped_in_lite_mode = TRUE
         OR filename LIKE '%[skipped: extension unavailable]%'
      ORDER BY version ASC
    `);
        const versions = rows.map((row) => Number(row.version));
        if (versions.length === 0)
            return [];
        await client.query('DELETE FROM public.schema_migrations WHERE version = ANY($1::bigint[])', [versions]);
        return versions;
    }
    finally {
        client.release();
        if (ownPool)
            await pool.end();
    }
}
// ── CLI entrypoint ────────────────────────────────────────────────────────
const isDirectRun = typeof require !== 'undefined' && require.main === module;
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
