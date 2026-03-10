import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  // PostgreSQL test DB setup + teardown
  globalSetup: '<rootDir>/jest.setup.ts',
  globalTeardown: '<rootDir>/jest.teardown.ts',
  // Per-test file setup: set DATABASE_URL for the test pool
  setupFiles: ['<rootDir>/jest.env.ts'],
  // chokidar v5 is ESM-only; replace it with an auto-mock for all tests
  moduleNameMapper: {
    '^chokidar$': '<rootDir>/src/__mocks__/chokidar.js',
  },
  // Extend timeout for DB-backed integration tests
  testTimeout: 30_000,
};

export default config;
