/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { awaitRequiredStartupReadiness, terminateFailedStartup } from '../startup-readiness';

describe('awaitRequiredStartupReadiness', () => {
  test('does not resolve until queue registration and every required recovery step completes in order', async () => {
    const order: string[] = [];
    let releaseStoryRecovery!: () => void;
    const storyRecovery = new Promise<void>((resolve) => { releaseStoryRecovery = resolve; });

    const readiness = awaitRequiredStartupReadiness({
      initializeTransport: async () => { order.push('queues'); },
      recoverPublications: async () => { order.push('publications'); return { scanned: 2 }; },
      cleanupOrphanRuns: async () => { order.push('orphans'); },
      recoverStoryLogs: async () => { order.push('story-logs'); await storyRecovery; },
    });
    let ready = false;
    void readiness.then(() => { ready = true; });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).toEqual(['queues', 'publications', 'orphans', 'story-logs']);
    expect(ready).toBe(false);
    releaseStoryRecovery();
    await expect(readiness).resolves.toEqual({ publicationRecovery: { scanned: 2 } });
    expect(ready).toBe(true);
  });

  test('fails closed and never starts later recovery after queue initialization fails', async () => {
    const recoverPublications = jest.fn(async () => ({ scanned: 0 }));

    await expect(awaitRequiredStartupReadiness({
      initializeTransport: async () => { throw new Error('queue registration failed'); },
      recoverPublications,
      cleanupOrphanRuns: async () => undefined,
      recoverStoryLogs: async () => undefined,
    })).rejects.toThrow('queue registration failed');
    expect(recoverPublications).not.toHaveBeenCalled();
  });
});

  test('stops initialized resources before terminating nonzero', async () => {
    const order: string[] = [];
    await terminateFailedStartup({
      stopResources: async () => { order.push('stop'); },
      terminate: (code) => { order.push(`exit:${code}`); },
    });
    expect(order).toEqual(['stop', 'exit:1']);
  });
