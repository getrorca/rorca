/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Exact invocation cleanup; the parent wrapper repeats this idempotently on failure/signal. */

import { cleanupIsolatedTestDatabase } from './src/lib/test-db-harness';

export default async function globalTeardown(): Promise<void> {
  // resetModules-based legacy suites can leave released idle clients owned by
  // historical module copies. Their test-only 250 ms idle timeout closes them
  // before this exact invocation server is removed, avoiding teardown races.
  await new Promise(resolve => setTimeout(resolve, 500));
  await cleanupIsolatedTestDatabase();
  console.log('[jest-teardown] removed exact invocation-owned PostgreSQL resources');
}
