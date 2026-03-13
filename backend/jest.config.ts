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
  // pdf-parse loads pdfjs-dist which requires browser APIs (DOMMatrix etc.) not in Node
  moduleNameMapper: {
    '^chokidar$': '<rootDir>/src/__mocks__/chokidar.js',
    '^pdf-parse$': '<rootDir>/src/__mocks__/pdf-parse.js',
  },
  // Extend timeout for DB-backed integration tests
  testTimeout: 30_000,
  // Force Jest to exit after all tests complete (prevents hanging async ops from keeping process alive)
  forceExit: true,
  // Run test files serially to prevent DB conflicts between test files sharing the same test DB
  maxWorkers: 1,
};

export default config;
