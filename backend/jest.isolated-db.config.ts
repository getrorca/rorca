/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Broad local lane for a caller-provisioned, freshly migrated, dedicated-owner
 * PostgreSQL 16 `_test` database. Unlike certification, this does not claim or
 * fabricate the immutable human-provisioned authority receipt checked by
 * jest.setup.ts. `jest.env.ts` still fail-closes through test-db-safety.
 */
import type { Config } from 'jest';
import base from './jest.config';

const {
  globalSetup: _globalSetup,
  globalTeardown: _globalTeardown,
  ...isolatedBase
} = base;

const config: Config = {
  ...isolatedBase,
};

export default config;
