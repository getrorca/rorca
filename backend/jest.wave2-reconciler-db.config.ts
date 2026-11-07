/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
/** Invocation-owned exact post-save reconciliation PostgreSQL/pg-boss lane. */
import type { Config } from 'jest';
import base from './jest.config';
const {
  globalSetup: _globalSetup,
  globalTeardown: _globalTeardown,
  setupFiles: _setupFiles,
  moduleNameMapper: _moduleNameMapper,
  ...rest
} = base;
const config: Config = {
  ...rest,
  globalSetup: '<rootDir>/jest.wave2-db-global-setup.ts',
  setupFiles: ['<rootDir>/jest.wave2-db-env.ts'],
  setupFilesAfterEnv: [
    ...(rest.setupFilesAfterEnv ?? []),
    '<rootDir>/jest.pg-boss.setup.ts',
  ],
  moduleNameMapper: {
    '^chokidar$': '<rootDir>/src/__mocks__/chokidar.js',
    '^pdf-parse$': '<rootDir>/src/__mocks__/pdf-parse.js',
  },
  testMatch: [
    '**/src/db/__tests__/spec-post-save-reconciliation.integration.test.ts',
    '**/src/db/__tests__/strict-spec-memory.integration.test.ts',
  ],
  testTimeout: 60_000,
  maxWorkers: 1,
};
export default config;
