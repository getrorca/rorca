/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Jest global setup for the pre-provisioned certification database.
 *
 * Authority objects are human-provisioned and immutable here. The harness
 * verifies them, then applies only already-authorized application migrations.
 */

import { Pool } from 'pg';
import { runPgMigrations } from './src/db/pg-index';
import {
  assertConnectedTestDatabase,
  resolveTestDatabaseUrl,
} from './src/lib/test-db-safety';

const TEST_DB_URL = resolveTestDatabaseUrl();

interface AuthorityReadinessRow {
  authenticated_role: boolean;
  auth_schema: boolean;
  rorca_schema: boolean;
  auth_uid: boolean;
  auth_jwt: boolean;
  pgcrypto_extension: boolean;
  vector_extension: boolean;
  age_extension: boolean;
  migrations_table: boolean;
  age_skip_receipt: boolean;
  password_hash_column: boolean;
  workspace_members_table: boolean;
}

function missingAuthorityObjects(row: AuthorityReadinessRow | undefined): string[] {
  if (!row) return ['authority readiness row'];
  return Object.entries(row)
    .filter(([, ready]) => ready !== true)
    .map(([name]) => name);
}

export default async function globalSetup(): Promise<void> {
  const pool = new Pool({ connectionString: TEST_DB_URL, max: 1 });
  try {
    const connected = await assertConnectedTestDatabase(pool, TEST_DB_URL);
    const readiness = await pool.query<AuthorityReadinessRow>(`
      SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') AS authenticated_role,
             to_regnamespace('auth') IS NOT NULL AS auth_schema,
             to_regnamespace('rorca') IS NOT NULL AS rorca_schema,
             to_regprocedure('auth.uid()') IS NOT NULL AS auth_uid,
             to_regprocedure('auth.jwt()') IS NOT NULL AS auth_jwt,
             EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') AS pgcrypto_extension,
             EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS vector_extension,
             EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'age') AS age_extension,
             to_regclass('public.schema_migrations') IS NOT NULL AS migrations_table,
             EXISTS (
               SELECT 1
                 FROM public.schema_migrations
                WHERE version = 50
                  AND skipped_in_lite_mode = TRUE
             ) AS age_skip_receipt,
             EXISTS (
               SELECT 1
                 FROM information_schema.columns
                WHERE table_schema = 'rorca'
                  AND table_name = 'users'
                  AND column_name = 'password_hash'
             ) AS password_hash_column,
             to_regclass('rorca.workspace_members') IS NOT NULL AS workspace_members_table
    `);
    const missing = missingAuthorityObjects(readiness.rows[0]);
    if (missing.length > 0) {
      throw new Error(
        `[jest-setup] Pre-provisioned certification database is incomplete: ${missing.join(', ')}`,
      );
    }

    // The migration runner verifies and advances application-owned migration
    // state only. Authority objects above are never provisioned by this harness.
    await runPgMigrations(pool);
    console.log(`[jest-setup] Verified ${connected.user}@${connected.database}; application migrations are current`);
  } finally {
    await pool.end();
  }

  // Pin the same immutable URL for worker processes.
  process.env.RORCA_TEST_DATABASE_URL = TEST_DB_URL;
  process.env.DATABASE_URL_TEST = TEST_DB_URL;
  process.env.DATABASE_URL = TEST_DB_URL;
}
