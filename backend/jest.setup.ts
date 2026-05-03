/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * jest.setup.ts — Jest globalSetup for PostgreSQL test database
 *
 * Connects to the Postgres test database, creates it if it doesn't exist,
 * runs all pg-migrations, and enables required extensions (vector, age).
 *
 * Derives the test DB URL from DATABASE_URL by appending _test to the db name.
 */

import { Pool } from 'pg';
import { runPgMigrations } from './src/db/pg-index';

function deriveTestDbUrl(): string {
  if (process.env.DATABASE_URL_TEST) return process.env.DATABASE_URL_TEST;
  const prodUrl = process.env.DATABASE_URL || 'postgres://rorca:rorca@localhost:5433/rorca';
  try {
    const parsed = new URL(prodUrl);
    const dbName = parsed.pathname.slice(1);
    if (!dbName.endsWith('_test')) {
      parsed.pathname = `/${dbName}_test`;
    }
    return parsed.toString();
  } catch {
    return 'postgres://rorca:rorca@localhost:5433/rorca_test';
  }
}

const TEST_DB_URL = deriveTestDbUrl();

/**
 * Parse connection string to extract database name and build a "maintenance" URL
 * that connects to the default 'postgres' database (for CREATE DATABASE).
 */
function parseDbUrl(url: string): { dbName: string; maintenanceUrl: string } {
  const parsed = new URL(url);
  const dbName = parsed.pathname.slice(1); // strip leading /
  parsed.pathname = '/postgres';
  return { dbName, maintenanceUrl: parsed.toString() };
}

export default async function globalSetup(): Promise<void> {
  const { dbName, maintenanceUrl } = parseDbUrl(TEST_DB_URL);

  // 1. Connect to 'postgres' DB and recreate test DB fresh every time.
  //    This prevents stale schema state (e.g., dual public/rorca schema tables)
  //    from causing migration failures (ON CONFLICT resolves wrong table).
  const adminPool = new Pool({ connectionString: maintenanceUrl });
  try {
    // Terminate existing connections to the test DB and retry drop+create
    // pg_terminate_backend is async — terminated backends may linger briefly,
    // causing DROP DATABASE to see stale state or CREATE DATABASE to race.
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await adminPool.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [dbName],
        );
        // Give terminated backends time to fully disconnect
        await new Promise(resolve => setTimeout(resolve, 200));
        await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
        await adminPool.query(`CREATE DATABASE "${dbName}" OWNER rorca`);
        console.log(`[jest-setup] Recreated test database: ${dbName}`);
        break;
      } catch (err: any) {
        if (attempt === maxRetries) throw err;
        console.warn(`[jest-setup] Attempt ${attempt} failed (${err.message}), retrying in 500ms...`);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  } finally {
    await adminPool.end();
  }

  // Install AGE on a short-lived bootstrap connection so the main test pool
  // doesn't inherit any extension setup instability during migrations.
  const agePool = new Pool({ connectionString: TEST_DB_URL, max: 1 });
  try {
    await agePool.query('CREATE EXTENSION IF NOT EXISTS age');
  } catch {
    /* AGE may be unavailable on some hosts, non-fatal */
  } finally {
    await agePool.end();
  }

  // 2. Connect to the test DB and enable extensions + run migrations
  //    Pool size 1 prevents AGE LOAD 'age' from poisoning idle connections
  const testPool = new Pool({ connectionString: TEST_DB_URL, max: 1 });
  try {
    // Test harness shim for Supabase/PostgREST auth helpers used by RLS migrations.
    // Local Postgres doesn't provide auth schema/functions, so create minimal stubs.
    await testPool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated;
        END IF;
      END $$;
    `);

    await testPool.query(`CREATE SCHEMA IF NOT EXISTS auth`);

    await testPool.query(`
      CREATE OR REPLACE FUNCTION auth.uid()
      RETURNS UUID
      LANGUAGE sql
      STABLE
      AS $$
        SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$
    `);

    await testPool.query(`
      CREATE OR REPLACE FUNCTION auth.jwt()
      RETURNS JSONB
      LANGUAGE sql
      STABLE
      AS $$
        SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
      $$
    `);

    // Enable extensions — these are safe to run multiple times
    try {
      await testPool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    } catch { /* extension may not be available, non-fatal */ }
    try {
      await testPool.query('CREATE EXTENSION IF NOT EXISTS vector');
    } catch { /* pgvector may not be installed, non-fatal */ }
    // Tests run in lite-mode semantics. Pre-mark the AGE graph migration as
    // skipped so globalSetup never executes LOAD 'age', which poisons later DDL
    // in this local harness even when the migration is rolled back.
    await testPool.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        version BIGINT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        filename TEXT NOT NULL,
        skipped_in_lite_mode BOOLEAN NOT NULL DEFAULT FALSE
      )
    `);
    await testPool.query(`
      INSERT INTO public.schema_migrations (version, filename, skipped_in_lite_mode)
      VALUES (50, '050_knowledge_graph.sql [skipped: test lite mode]', TRUE)
      ON CONFLICT (version) DO NOTHING
    `);

    // 3. Run all pg-migrations
    await runPgMigrations(testPool);
    await testPool.query('SET search_path TO rorca, public');

    // Test-compatibility shim: many legacy tests still insert password_hash even
    // though the migrated local schema drops it. Re-add a harmless column in the
    // test database only so older fixtures keep working.
    await testPool.query(`
      ALTER TABLE rorca.users
      ADD COLUMN IF NOT EXISTS password_hash TEXT NOT NULL DEFAULT 'x'
    `);

    // Test-only grant shim so RLS tests exercise policies instead of failing on SQL GRANTs.
    await testPool.query(`GRANT USAGE ON SCHEMA public, rorca, auth TO authenticated`);
    await testPool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public, rorca, auth TO authenticated`);
    await testPool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public, rorca TO authenticated`);
    await testPool.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public, rorca, auth TO authenticated`);

    console.log('[jest-setup] Migrations applied to test database');
  } finally {
    await testPool.end();
  }

  // 4. Export the test DB URL so all tests use it
  process.env.DATABASE_URL = TEST_DB_URL;
}
