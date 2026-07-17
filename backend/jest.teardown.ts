/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Jest global teardown is intentionally non-destructive.
 *
 * Per-test cleanup already runs against a verified dedicated database. Database
 * truncation, recreation, and drop are provisioning operations and must never be
 * triggered implicitly when a test process exits.
 */
export default async function globalTeardown(): Promise<void> {
  console.log('[jest-teardown] No database mutation (provisioning is external to Jest)');
}
