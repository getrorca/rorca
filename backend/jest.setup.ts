/**
 * jest.setup.ts — Jest globalSetup for PostgreSQL test database
 *
 * Connects to the Postgres test database, creates it if it doesn't exist,
 * runs all pg-migrations, and enables required extensions (vector, age).
 *
 * DATABASE_URL_TEST or postgres://rorca:rorca@localhost:5432/rorca_test
 */

import { Pool } from 'pg';
import { runPgMigrations } from './src/db/pg-index';

const TEST_DB_URL = process.env.DATABASE_URL_TEST
  || 'postgres://rorca:rorca@localhost:5432/rorca_test';

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

  // 1. Connect to 'postgres' DB and create test DB if needed
  const adminPool = new Pool({ connectionString: maintenanceUrl });
  try {
    const { rows } = await adminPool.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [dbName],
    );
    if (rows.length === 0) {
      // CREATE DATABASE cannot run inside a transaction
      await adminPool.query(`CREATE DATABASE "${dbName}"`);
      console.log(`[jest-setup] Created test database: ${dbName}`);
    }
  } finally {
    await adminPool.end();
  }

  // 2. Connect to the test DB and enable extensions + run migrations
  const testPool = new Pool({ connectionString: TEST_DB_URL });
  try {
    // Enable extensions — these are safe to run multiple times
    try {
      await testPool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    } catch { /* extension may not be available, non-fatal */ }
    try {
      await testPool.query('CREATE EXTENSION IF NOT EXISTS vector');
    } catch { /* pgvector may not be installed, non-fatal */ }
    try {
      await testPool.query('CREATE EXTENSION IF NOT EXISTS age');
      await testPool.query("LOAD 'age'");
      await testPool.query('SET search_path = ag_catalog, "$user", public');
    } catch { /* AGE may not be installed, non-fatal */ }

    // 3. Run all pg-migrations
    await runPgMigrations(testPool);
    console.log('[jest-setup] Migrations applied to test database');
  } finally {
    await testPool.end();
  }

  // 4. Export the test DB URL so all tests use it
  process.env.DATABASE_URL = TEST_DB_URL;
}
