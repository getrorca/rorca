/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * CI-independent Wave 1 unit/contract lane. It deliberately has no database
 * setup: DB-backed conformance uses the separately fenced dedicated-owner lane.
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
  testMatch: [
    '**/src/lib/__tests__/wave-1-stabilization.test.ts',
    '**/src/lib/__tests__/closeout-reconciliation-build-identity.test.ts',
    '**/src/lib/__tests__/run-closeout-reconciliation-preview.test.ts',
    '**/src/lib/__tests__/run-closeout-reconciliation-projection.test.ts',
    '**/src/lib/__tests__/run-closeout-reconciliation-recovery.test.ts',
    '**/src/lib/__tests__/provider-human-closeout-owner.test.ts',
    '**/src/lib/__tests__/csrf.test.ts',
    '**/src/lib/__tests__/test-db-safety.test.ts',
    '**/src/lib/__tests__/protected-wave1-paths.test.ts',
    '**/src/lib/__tests__/run-host-authority.test.ts',
    '**/src/lib/__tests__/retry-dispatch-contract.test.ts',
    '**/src/lib/__tests__/worker-protected-wave1-entrypoints.test.ts',
    '**/src/lib/__tests__/local-review-bundle-adapter.test.ts',
    '**/src/lib/__tests__/provider-neutral-wave1-spec.test.ts',
    '**/src/lib/__tests__/local-delivery-authority.test.ts',
    '**/src/lib/__tests__/github-execution-foundation-architecture.test.ts',
    '**/src/lib/__tests__/delivery-adapter-selection.test.ts',
    '**/src/lib/__tests__/github-app-credential-provider.test.ts',
    '**/src/lib/__tests__/github-review-delivery.test.ts',
    '**/src/routes/__tests__/delivery.test.ts',
    '**/src/routes/__tests__/recovery.test.ts',
    '**/src/routes/__tests__/closeout-reconciliation-public.test.ts',
    '**/src/db/__tests__/run-closeout-reconciliation-migration.test.ts',
    '**/src/db/__tests__/provider-neutral-local-review-bundles-migration.test.ts',
    '**/src/db/__tests__/github-repository-installation-leases-migration.test.ts',
  ],
};

export default config;
