/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Config } from 'jest';
import base from './jest.config';

const {
  globalSetup: _globalSetup,
  globalTeardown: _globalTeardown,
  setupFiles: _setupFiles,
  setupFilesAfterEnv: _setupFilesAfterEnv,
  ...unitBase
} = base;

const config: Config = {
  ...unitBase,
  testMatch: ['**/src/lib/__tests__/api-model-launchers-linux-path.test.ts'],
};

export default config;
