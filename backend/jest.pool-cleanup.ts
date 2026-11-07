/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Per-suite process-mode pinning and pool cleanup.
 *
 * Shared global data resets are forbidden: they race background work, destroy
 * beforeAll fixtures, and can bypass append-only evidence guarantees through
 * cascading operations. Suites must use workspace-scoped unique fixtures and
 * clean only their own mutable rows when necessary.
 */

beforeAll(() => {
  process.env.NODE_ENV = 'test';
});

afterAll(async () => {
  try {
    const dbMod = require('./src/db/index');
    if (typeof dbMod.closePool === 'function') {
      await dbMod.closePool();
    }
  } catch {
    // The pool may be absent or already closed; this path is non-destructive.
  } finally {
    process.env.NODE_ENV = 'test';
  }
});
