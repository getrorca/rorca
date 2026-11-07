/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
/** DB-independent governed Mission Control contract/conformance lane. */
import type { Config } from 'jest';
import base from './jest.config';
const { globalSetup: _globalSetup, globalTeardown: _globalTeardown, setupFiles: _setupFiles,
  setupFilesAfterEnv: _setupFilesAfterEnv, ...unitBase } = base;
const config: Config = { ...unitBase, testMatch: [
  '**/src/lib/__tests__/governed-contracts.test.ts',
  '**/src/lib/__tests__/dispatch-receiver-process-boundary.test.ts',
  '**/src/lib/__tests__/governed-prerequisite-gate.test.ts',
  '**/src/lib/__tests__/governed-mission-service.test.ts',
  '**/src/lib/__tests__/spec-job-worker-ownership.test.ts',
  '**/src/lib/__tests__/managed-executor-compatibility-projection.test.ts',
  '**/src/routes/__tests__/mission-control-contract.test.ts',
  '**/src/routes/__tests__/mission-control-runtime-http.test.ts',
  '**/src/db/__tests__/wave2-governed-migration.test.ts',
  '**/src/lib/__tests__/postgres-image-safety-static.test.ts',
] };
export default config;
