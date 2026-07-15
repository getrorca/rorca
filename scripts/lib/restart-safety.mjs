// Copyright (c) 2026 Rorca Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Require positive, bounded readiness evidence before any documented managed
 * backend/worker takeover or restart. Unknown/null/string counts fail closed.
 */
export function assertRestartSafeHealth(health) {
  if (!health || health.db_connected !== true || health.readiness?.confirmed !== true) {
    throw new Error('refusing take-over: bounded database readiness is not confirmed');
  }
  if (!Number.isSafeInteger(health.active_runs) || health.active_runs !== 0) {
    throw new Error('refusing take-over: active pipeline runs are not confirmed to be zero');
  }
}
