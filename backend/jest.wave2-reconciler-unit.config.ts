/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import type { Config } from 'jest';
import base from './jest.config';

const {
  globalSetup: _globalSetup,
  globalTeardown: _globalTeardown,
  setupFiles: _setupFiles,
  setupFilesAfterEnv: _setupFilesAfterEnv,
  ...rest
} = base;

const config: Config = {
  ...rest,
  testMatch: [
    '**/src/lib/__tests__/spec-post-save-workflow.test.ts',
    '**/src/lib/__tests__/spec-post-save-reconciliation.test.ts',
    '**/src/lib/__tests__/strict-memory-sandbox.test.ts',
    '**/src/lib/__tests__/strict-spec-memory.test.ts',
    '**/src/lib/__tests__/csrf.test.ts',
    '**/src/lib/__tests__/memory-projection.test.ts',
    '**/src/lib/__tests__/spec-job-handlers-memory.test.ts',
    '**/src/lib/__tests__/spec-job-worker-ownership.test.ts',
    '**/src/lib/__tests__/spec-job-publication.test.ts',
    '**/src/lib/__tests__/spec-job-recovery-cas.test.ts',
    '**/src/lib/__tests__/recovery-contract-discovery.test.ts',
    '**/src/routes/__tests__/recovery.test.ts',
    '**/src/routes/__tests__/mission-control-contract.test.ts',
    '**/src/routes/__tests__/mission-control-runtime-http.test.ts',
    '**/src/lib/__tests__/spec-readiness.test.ts',
    '**/src/__tests__/mcp-aegis.test.ts',
    '**/src/__tests__/swagger-parity-gate.test.ts',
    '**/src/lib/__tests__/github-openapi-mcp-contract.test.ts',
    '**/src/routes/__tests__/closeout-reconciliation-public.test.ts',
    '**/src/db/__tests__/spec-post-save-reconciliation-migration.test.ts',
    '**/src/db/__tests__/strict-spec-memory-migration.test.ts',
    '**/src/db/__tests__/wave2-reconciler-remediation-migration.test.ts',
  ],
};
export default config;
