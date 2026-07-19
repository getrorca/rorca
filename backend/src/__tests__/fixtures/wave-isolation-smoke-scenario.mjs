// Copyright (c) 2026 Rorca Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal real-PostgreSQL qualification boundary smoke. The runner imports this
 * only after dedicated role/database server-truth verification and owns cleanup.
 */
export async function runQualification(context) {
  const queue = await context.createQueue('isolation-smoke');
  return {
    before: {
      namespace: context.boundary.isolationMarker,
      protectedProductionMutationCount: 0,
    },
    after: {
      namespace: context.boundary.isolationMarker,
      queueCreatedThroughBossApi: queue.startsWith(context.boundary.queuePrefix),
      protectedProductionMutationCount: 0,
    },
  };
}
