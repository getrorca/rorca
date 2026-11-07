/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { Config } from 'jest';
const config: Config = {
  preset: 'ts-jest', testEnvironment: 'node', maxWorkers: 1,
  testMatch: ['**/__tests__/**/*.test.ts'],
  testPathIgnorePatterns: ['\.node\.test\.ts$'],
  modulePathIgnorePatterns: ['<rootDir>/dist/'],
  moduleNameMapper: { '^chokidar$': '<rootDir>/src/__mocks__/chokidar.js', '^pdf-parse$': '<rootDir>/src/__mocks__/pdf-parse.js', '^pg-boss$': '<rootDir>/src/__mocks__/pg-boss.ts' },
  clearMocks: true,
};
export default config;
