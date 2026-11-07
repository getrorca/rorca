/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Pure pre-connection policy. No pg, filesystem, environment mutation, or I/O. */
export type TestEnvironment = Readonly<Record<string, string | undefined>>;

export function isTestDatabaseProcess(env: TestEnvironment): boolean {
  return env.NODE_ENV === 'test'
    || env.JEST_WORKER_ID !== undefined
    || env.NODE_TEST_CONTEXT !== undefined
    || env.RORCA_TEST_DB_CAPABILITY !== undefined
    || env.JEST_SKIP_RUNTIME_MIGRATIONS !== undefined;
}

export function assertTestDatabaseCapability(env: TestEnvironment): void {
  if (isTestDatabaseProcess(env) && env.RORCA_TEST_DB_CAPABILITY !== 'invocation-lease') {
    throw new Error('[test-db-isolation] Database access denied: explicitly select invocation-lease isolation via the isolated test bootstrap');
  }
}

/** The caller must obtain these URLs from the verified live lease, never env. */
export function assertIsolatedDatabaseTarget(
  target: string | undefined,
  verifiedUrls: readonly string[],
): void {
  if (!target || !verifiedUrls.includes(target)) {
    throw new Error('[test-db-isolation] Database target is not in the verified invocation topology');
  }
  const parsed = new URL(target);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
      || !/^\/rorca_jest_[a-f0-9]{24}_test$/.test(parsed.pathname)) {
    throw new Error('[test-db-isolation] Database target is not a nonce-scoped isolated Jest database');
  }
}
