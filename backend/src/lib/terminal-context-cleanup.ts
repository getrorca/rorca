/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

const cleanupBySessionId = new Map<string, () => Promise<void>>();

export function registerTerminalContextCleanup(sessionId: string, cleanup: () => Promise<void>): void {
  cleanupBySessionId.set(sessionId, cleanup);
}

export async function runTerminalContextCleanup(sessionId: string): Promise<void> {
  const cleanup = cleanupBySessionId.get(sessionId);
  if (!cleanup) {
    return;
  }

  cleanupBySessionId.delete(sessionId);
  await cleanup();
}
