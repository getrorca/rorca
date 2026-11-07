/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */
import type { Config } from 'jest';
import base from './jest.config';
const { globalSetup: _globalSetup, globalTeardown: _globalTeardown, setupFiles: _setupFiles,
  setupFilesAfterEnv: _setupFilesAfterEnv, ...unitBase } = base;
const config: Config = { ...unitBase, testMatch: [
  '**/src/lib/__tests__/rorca-managed-executor.test.ts',
  '**/src/lib/__tests__/pi-managed-continuation-controller.test.ts',
  '**/src/lib/__tests__/completion-protocol-contracts.test.ts',
  '**/src/lib/__tests__/completion-runner.test.ts',
  '**/src/lib/__tests__/completion-runner-persistence.test.ts',
  '**/src/lib/__tests__/completion-runner-production-dispatch.test.ts',
] };
export default config;
