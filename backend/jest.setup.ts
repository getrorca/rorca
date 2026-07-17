/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * jest.setup.ts — Jest globalSetup for PostgreSQL test database
 *
 * Connects only to an explicitly configured PostgreSQL test database, verifies
 * the server-reported database name, runs migrations, and enables extensions.
 * Database/role provisioning is intentionally outside Jest.
 */

import { Pool } from 'pg';
import { runPgMigrations } from './src/db/pg-index';
import {
  assertConnectedTestDatabase,
  resolveTestDatabaseUrl,
} from './src/lib/test-db-safety';

const TEST_DB_URL = resolveTestDatabaseUrl();

export default async function globalSetup(): Promise<void> {
  // Database creation is deliberately outside Jest. The configured login must
  // already own a dedicated *_test database and need not have CREATEDB or any
  // production privileges. Verify server truth before schema or data changes.
  const verificationPool = new Pool({ connectionString: TEST_DB_URL, max: 1 });
  try {
    const connected = await assertConnectedTestDatabase(verificationPool, TEST_DB_URL);
    console.log(`[jest-setup] Verified dedicated database ${connected.database} as ${connected.user}`);
  } finally {
    await verificationPool.end();
  }

  // Install AGE on a short-lived bootstrap connection so the main test pool
  // doesn't inherit any extension setup instability during migrations.
  const agePool = new Pool({ connectionString: TEST_DB_URL, max: 1 });
  try {
    await assertConnectedTestDatabase(agePool, TEST_DB_URL);
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
    await assertConnectedTestDatabase(testPool, TEST_DB_URL);

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

    // Test-compatibility shim: production auth-utils (and every RLS-aware route +
    // test fixture) resolves workspace membership via a `workspace_members` table
    // keyed by (workspace_id, user_auth_id, role). That table is not provisioned
    // by the local pg-migrations set, so create it in the test DB only. Without it
    // the shared analytics/RLS test fixtures fail in beforeEach before any
    // assertion runs ("relation workspace_members does not exist").
    await testPool.query(`
      CREATE TABLE IF NOT EXISTS rorca.workspace_members (
        workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE CASCADE,
        user_auth_id UUID NOT NULL,
        role TEXT NOT NULL DEFAULT 'viewer',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, user_auth_id)
      )
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

  // Pin the same immutable URL for worker processes.
  process.env.RORCA_TEST_DATABASE_URL = TEST_DB_URL;
  process.env.DATABASE_URL_TEST = TEST_DB_URL;
  process.env.DATABASE_URL = TEST_DB_URL;
}
