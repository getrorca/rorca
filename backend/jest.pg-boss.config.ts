/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { Config } from 'jest';
import baseConfig from './jest.config';

/**
 * Real pg-boss integration configuration.
 *
 * The default Jest configuration maps pg-boss to a no-op unit-test mock. This
 * override keeps the normal isolated PostgreSQL setup while loading pg-boss v10
 * itself for queue, cancellation, and worker lifecycle tests.
 */
const config: Config = {
  ...baseConfig,
  moduleNameMapper: {
    '^chokidar$': '<rootDir>/src/__mocks__/chokidar.js',
    '^pdf-parse$': '<rootDir>/src/__mocks__/pdf-parse.js',
  },
  setupFilesAfterEnv: [
    ...(baseConfig.setupFilesAfterEnv ?? []),
    '<rootDir>/jest.pg-boss.setup.ts',
  ],
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  testTimeout: 60_000,
  maxWorkers: 1,
};

export default config;
