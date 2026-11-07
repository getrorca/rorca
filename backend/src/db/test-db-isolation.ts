/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { readIsolatedTestDatabaseState, resolveTestDatabaseUrl } from '../lib/test-db-safety';
import { assertIsolatedDatabaseTarget, assertTestDatabaseCapability, isTestDatabaseProcess } from './test-db-policy';

/** Synchronous, fail-closed, and always called before constructing/using pg. */
export function assertTestDatabaseAccess(target: string | undefined): void {
  if (!isTestDatabaseProcess(process.env)) return;
  assertTestDatabaseCapability(process.env);
  // resolve checks ready state, live owner/lease, topology and env consistency.
  // The extra targets come from that lease, never from ambient URL selectors.
  const runtimeUrl = resolveTestDatabaseUrl();
  const state = readIsolatedTestDatabaseState();
  assertIsolatedDatabaseTarget(target, [
    runtimeUrl, state.migrationDatabaseUrl!, state.canonicalWriterDatabaseUrl!,
  ]);
}
