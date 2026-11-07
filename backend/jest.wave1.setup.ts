/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Canonical-migration setup for a fresh externally provisioned Wave 1 DB. */
import { Pool } from 'pg';
import { runPgMigrations } from './src/db/pg-index';
import {
  assertConnectedTestDatabase,
  claimFreshTestDatabaseInvocation,
  redactedTestDatabaseUrl,
  resolveTestDatabaseUrl,
} from './src/lib/test-db-safety';

export default async function wave1GlobalSetup(): Promise<void> {
  const databaseUrl = resolveTestDatabaseUrl();
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const before = await assertConnectedTestDatabase(pool, databaseUrl);
    console.log(`[wave1-db] resolved_url=${redactedTestDatabaseUrl(databaseUrl)}`);
    console.log(`[wave1-db] database=${before.database} owner=${before.owner} user=${before.user} postgres_major=${before.postgresMajor} rolsuper=${before.superuser}`);
    await claimFreshTestDatabaseInvocation(pool, databaseUrl, process.env.RORCA_TEST_INVOCATION_ID!);
    console.log(`[wave1-db] invocation=${process.env.RORCA_TEST_INVOCATION_ID} freshness=claimed`);
    await runPgMigrations(pool);
    const migrationCount = await pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM schema_migrations');
    console.log(`[wave1-db] canonical_migrations=${migrationCount.rows[0]?.count ?? '0'}`);
  } finally {
    await pool.end();
  }
}
