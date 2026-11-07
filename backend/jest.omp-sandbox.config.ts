/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import type { Config } from 'jest';
import base from './jest.config';

// OMP sandbox qualification is deliberately database-free. Keeping it on a
// dedicated config makes Darwin Seatbelt, Linux bwrap planning, auth snapshot,
// and fail-closed launch checks runnable without provisioning or contacting PG.
const {
  globalSetup: _globalSetup,
  globalTeardown: _globalTeardown,
  setupFiles: _setupFiles,
  setupFilesAfterEnv: _setupFilesAfterEnv,
  ...unitBase
} = base;

const config: Config = {
  ...unitBase,
  testMatch: [
    '**/src/lib/__tests__/ordinary-local-pi-profile.test.ts',
    '**/src/lib/__tests__/omp-managed-executor.test.ts',
    '**/src/lib/__tests__/autonomous-sandbox.test.ts',
    '**/src/lib/__tests__/omp-executor-selection.test.ts',
    '**/src/lib/__tests__/resolve-execution-options.test.ts',
  ],
};

export default config;
