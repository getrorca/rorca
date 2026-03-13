/**
 * jest.teardown.ts — Jest globalTeardown for PostgreSQL test database
 *
 * By default: truncates all tables (keeps schema for fast re-runs).
 * If KEEP_TEST_DB=false: drops the entire test database.
 */

import { Pool } from 'pg';

const TEST_DB_URL = process.env.DATABASE_URL_TEST
  || 'postgres://rorca:rorca@localhost:5432/rorca_test';

function parseDbUrl(url: string): { dbName: string; maintenanceUrl: string } {
  const parsed = new URL(url);
  const dbName = parsed.pathname.slice(1);
  parsed.pathname = '/postgres';
  return { dbName, maintenanceUrl: parsed.toString() };
}

export default async function globalTeardown(): Promise<void> {
  const keepTestDb = process.env.KEEP_TEST_DB !== 'false';

  if (keepTestDb) {
    // Truncate all user tables (fast, keeps schema for re-runs)
    const pool = new Pool({ connectionString: TEST_DB_URL });
    try {
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
