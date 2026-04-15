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
