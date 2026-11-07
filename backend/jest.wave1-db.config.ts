/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Fresh PostgreSQL 16/non-superuser/canonical-migration Wave 1 lane. */
import type { Config } from 'jest';
import base from './jest.config';

const config: Config = {
  ...base,
  globalSetup: '<rootDir>/jest.wave1.setup.ts',
  moduleNameMapper: {
    '^chokidar$': '<rootDir>/src/__mocks__/chokidar.js',
    '^pdf-parse$': '<rootDir>/src/__mocks__/pdf-parse.js',
  },
  setupFilesAfterEnv: [
    ...(base.setupFilesAfterEnv ?? []),
    '<rootDir>/jest.pg-boss.setup.ts',
  ],
  testMatch: [
    '**/src/db/__tests__/host-story-attempt-envelope.integration.test.ts',
    '**/src/db/__tests__/local-review-bundles.integration.test.ts',
    '**/src/db/__tests__/governed-retry-worker-composition.integration.test.ts',
    '**/src/db/__tests__/run-closeout-reconciliation-binding.integration.test.ts',
    '**/src/db/__tests__/run-closeout-reconciliation-adversarial.integration.test.ts',
  ],
  // All suites exercise the one deliberately exact managed proof run identity;
  // isolate them serially and let suite teardown remove only test-owned rows.
  maxWorkers: 1,
  testTimeout: 60_000,
};

export default config;
