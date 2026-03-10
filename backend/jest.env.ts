/**
 * jest.env.ts — Per-worker environment setup
 *
 * Runs before each test file (setupFiles). Sets DATABASE_URL so the
 * db/index.ts pool connects to the test database.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST
  || process.env.DATABASE_URL
  || 'postgres://rorca:rorca@localhost:5432/rorca_test';

process.env.NODE_ENV = 'test';
