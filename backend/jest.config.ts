/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: [
    '**/__tests__/**/*.test.ts',
    // Applicability resolver acceptance tests intentionally stay beside the small pure module.
    '**/ssdlc/applicability/resolver.test.ts',
  ],
  // PostgreSQL test DB setup + teardown
  globalSetup: '<rootDir>/jest.setup.ts',
  globalTeardown: '<rootDir>/jest.teardown.ts',
  // Per-test file setup: set DATABASE_URL for the test pool
  setupFiles: ['<rootDir>/jest.env.ts'],
  // Per-test teardown: close pg Pool after each test to prevent connection exhaustion
  setupFilesAfterEnv: ['<rootDir>/jest.pool-cleanup.ts'],
  // chokidar v5 is ESM-only; replace it with an auto-mock for all tests
  // pdf-parse loads pdfjs-dist which requires browser APIs (DOMMatrix etc.) not in Node
  // pg-boss creates real DB connections that block TRUNCATE CASCADE — replace with no-op mock
  moduleNameMapper: {
    '^chokidar$': '<rootDir>/src/__mocks__/chokidar.js',
    '^pdf-parse$': '<rootDir>/src/__mocks__/pdf-parse.js',
    // A historical colocated ESM .js artifact otherwise wins Jest's relative
    // resolution over the canonical TypeScript safety module.
    '^.*context-safety$': '<rootDir>/src/lib/context-safety.ts',
    ...(process.env.RORCA_RUN_LIVE_CROSS_CERT === '1'
      ? {}
      : { '^pg-boss$': '<rootDir>/src/__mocks__/pg-boss.ts' }),
  },
  // Exclude pg-boss integration/load tests that require real pg-boss (not the mock).
  // These need the actual worker process running and use real pg-boss concurrency features.
  // Run them separately with npm run test:integration.
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    // Qualification/release harnesses use node:test under tsx and are invoked
    // by dedicated package scripts; Jest must never discover or double-run them.
    '\\.node\\.test\\.ts$',
    'scripts/__tests__/pty-noisy-release-harness\\.test\\.ts$',
    'src/__tests__/pg-boss-cancel\\.test\\.ts',
    'src/__tests__/pg-boss-concurrency\\.test\\.ts',
    'src/__tests__/pg-boss-dlq\\.test\\.ts',
    'src/__tests__/pg-boss-integration\\.test\\.ts',
    'src/__tests__/pg-boss-load\\.test\\.ts',
    'src/__tests__/pg-boss-restart\\.test\\.ts',
    'src/__tests__/pg-boss-scheduler\\.test\\.ts',
    'src/__tests__/pg-boss-zero-downtime\\.test\\.ts',
  ],
  modulePathIgnorePatterns: ['<rootDir>/dist/'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  // Extend timeout for DB-backed integration tests
  testTimeout: 30_000,
  // Never force-exit: leaked workers/timers/listeners are release failures and
  // must remain visible to the broad-suite certification gate. Allow bounded
  // pool/socket cleanup to settle before Jest emits an open-handle warning.
  forceExit: false,
  openHandlesTimeout: 5_000,
  // Files inside each fresh shard database remain serial because many legacy
  // fixtures intentionally use global table names. The official argument-free
  // command runs deterministic native Jest shards sequentially; focused paths
  // remain one invocation. Do not set workerIdleMemoryLimit: Jest 29 then
  // forces even maxWorkers=1 through a child worker instead of true in-band
  // execution, obscuring open-handle ownership.
  maxWorkers: 1,
};

export default config;
