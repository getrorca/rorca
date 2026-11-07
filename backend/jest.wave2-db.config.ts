/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
/** Fresh, invocation-provisioned Wave 2 DB integration lane; caller owns lifecycle. */
import type { Config } from 'jest';
import base from './jest.config';
const { globalSetup: _globalSetup, globalTeardown: _globalTeardown, setupFiles: _setupFiles,
  setupFilesAfterEnv: _setupFilesAfterEnv, ...dbBase } = base;
const config: Config = { ...dbBase, globalSetup: '<rootDir>/jest.wave2-db-global-setup.ts',
  setupFiles: ['<rootDir>/jest.wave2-db-env.ts'], testMatch: [
    '**/src/lib/__tests__/governed-mission-service.integration.test.ts',
    '**/src/db/__tests__/wave2-9ff4-remediation.integration.test.ts',
  ] };
export default config;
