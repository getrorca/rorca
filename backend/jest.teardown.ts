/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * jest.teardown.ts — Jest globalTeardown for PostgreSQL test database
 *
 * By default: truncates all tables (keeps schema for fast re-runs).
 * If KEEP_TEST_DB=false: drops the entire test database.
 */

import { Pool } from 'pg';

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

function assertSafeTestDbUrl(url: string): void {
  const dbName = new URL(url).pathname.slice(1);
  if (!dbName.endsWith('_test')) {
    throw new Error(`[jest-teardown] Refusing to truncate/drop non-test database "${dbName}"`);
  }
}

assertSafeTestDbUrl(TEST_DB_URL);

function parseDbUrl(url: string): { dbName: string; maintenanceUrl: string } {
  const parsed = new URL(url);
  const dbName = parsed.pathname.slice(1);
  parsed.pathname = '/postgres';
  return { dbName, maintenanceUrl: parsed.toString() };
}

export default async function globalTeardown(): Promise<void> {
  const destructiveTeardownEnabled = process.env.RORCA_ENABLE_JEST_DB_TEARDOWN === 'true';
  if (!destructiveTeardownEnabled) {
    console.log('[jest-teardown] Skipped DB truncate/drop (set RORCA_ENABLE_JEST_DB_TEARDOWN=true to enable on *_test DB only)');
    return;
  }

  const keepTestDb = process.env.KEEP_TEST_DB !== 'false';

  if (keepTestDb) {
    // Truncate all user tables (fast, keeps schema for re-runs)
    const pool = new Pool({ connectionString: TEST_DB_URL });
    try {
      const db = await pool.query<{ current_database: string }>('SELECT current_database()');
      const currentDb = db.rows[0]?.current_database ?? '';
      if (!currentDb.endsWith('_test')) {
        throw new Error(`[jest-teardown] Refusing to truncate connected database "${currentDb || '(unknown)'}"`);
      }

      const { rows } = await pool.query(`
        SELECT schemaname, tablename FROM pg_tables
        WHERE schemaname IN ('public', 'rorca')
          AND tablename != 'schema_migrations'
        ORDER BY tablename
      `);
      if (rows.length > 0) {
        const tableNames = rows.map(r => `"${r.schemaname}"."${r.tablename}"`).join(', ');
        await pool.query(`TRUNCATE ${tableNames} CASCADE`);
      }
      console.log(`[jest-teardown] Truncated ${rows.length} tables (KEEP_TEST_DB=true)`);
    } finally {
      await pool.end();
    }
  } else {
    // Drop the entire test database
    const { dbName, maintenanceUrl } = parseDbUrl(TEST_DB_URL);

    // First close any remaining connections to the test DB
    const adminPool = new Pool({ connectionString: maintenanceUrl });
    try {
      await adminPool.query(`
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()
      `, [dbName]);

      await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      console.log(`[jest-teardown] Dropped test database: ${dbName}`);
    } finally {
      await adminPool.end();
    }
  }
}
