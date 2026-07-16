/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import {
  CoalescingPostQueue,
  compactFallbackEntries,
  flushFallbackWrites,
  readFallbackResults,
  retryPost,
  writeFallbackResult,
  type FallbackResultEntry,
} from '../resilient-post';

function fallback(story: string, sequence: number): FallbackResultEntry {
  const idempotencyKey = `token:${story}:${sequence}`;
  return {
    type: 'wal', storyId: story, status: 'story_token_update', runId: 42,
    retries: 1, ts: new Date(sequence).toISOString(), idempotencyKey,
    coalesceKey: `42:${story}`, sequence,
    payload: {
      event_type: 'story_token_update', idempotency_key: idempotencyKey,
      payload: { run_id: 42, story_id: story, cumulative_input: sequence },
    },
  };
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}

async function close(server: http.Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

describe('CoalescingPostQueue load/contention resilience', () => {
  test('parallelism=3 burst stays non-blocking and bounds slow endpoint concurrency', async () => {
    let serverActive = 0;
    let maxServerActive = 0;
    const server = http.createServer((req, res) => {
      req.resume();
      serverActive++;
      maxServerActive = Math.max(maxServerActive, serverActive);
      setTimeout(() => {
        serverActive--;
        if (!res.destroyed) { res.statusCode = 201; res.end('{}'); }
      }, 150);
    });
    const port = await listen(server);
    const persisted: FallbackResultEntry[] = [];
    const queue = new CoalescingPostQueue({
      concurrency: 2, maxPending: 8, timeoutMs: 25, maxRetries: 1,
      failureCooldownMs: 10,
      persistFallback: async entry => { persisted.push(entry); return true; },
    });

    const started = performance.now();
    for (let sequence = 1; sequence <= 100; sequence++) {
      for (const story of ['US-001', 'US-002', 'US-003']) {
        const entry = fallback(story, sequence);
        queue.enqueue({
          key: entry.coalesceKey!, url: `http://127.0.0.1:${port}/api/wal`,
          body: entry.payload, label: 'WAL:story_token_update', fallback: entry,
        });
      }
    }
    const enqueueMs = performance.now() - started;
    await queue.shutdown(500);
    await close(server);

    const latest = compactFallbackEntries(persisted);
    expect(enqueueMs).toBeLessThan(250);
    expect(queue.stats().maxObservedActive).toBeLessThanOrEqual(2);
    expect(maxServerActive).toBeLessThanOrEqual(2);
    expect(queue.stats().coalesced).toBeGreaterThan(250);
    expect(latest).toHaveLength(3);
    expect(latest.map(entry => entry.sequence).sort()).toEqual([100, 100, 100]);
  });

  test('queue capacity applies explicit fallback backpressure instead of growing memory', async () => {
    const persisted: FallbackResultEntry[] = [];
    const fetchImpl = jest.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;
    const queue = new CoalescingPostQueue({
      maxPending: 2, concurrency: 1, timeoutMs: 25, maxRetries: 1,
      fetchImpl,
      persistFallback: async entry => { persisted.push(entry); return true; },
    });
    for (const story of ['US-001', 'US-002', 'US-003']) {
      const entry = fallback(story, 1);
      queue.enqueue({ key: entry.coalesceKey!, url: 'http://127.0.0.1:1/api/wal', body: entry.payload, label: 'bounded', fallback: entry });
    }

    expect(queue.stats().pending).toBeLessThanOrEqual(2);
    await queue.shutdown(250);
    expect(compactFallbackEntries(persisted)).toHaveLength(3);
  });

  test('one unavailable endpoint attempt is bounded far below the old 30+ second path', async () => {
    const server = http.createServer();
    const port = await listen(server);
    await close(server);
    const started = performance.now();
    const ok = await retryPost(
      `http://127.0.0.1:${port}/api/wal`, {}, 'unavailable',
      { timeoutMs: 50, maxRetries: 1, retryDelayMs: 0 },
    );
    expect(ok).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('bounded fallback journal', () => {
  let cwd: string;
  const originalMaxBytes = process.env.RORCA_FALLBACK_MAX_BYTES;
  const originalMaxEntries = process.env.RORCA_FALLBACK_MAX_ENTRIES;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-wal-fallback-'));
    process.env.RORCA_FALLBACK_MAX_BYTES = '2048';
    process.env.RORCA_FALLBACK_MAX_ENTRIES = '10';
  });

  afterEach(() => {
    if (originalMaxBytes === undefined) delete process.env.RORCA_FALLBACK_MAX_BYTES;
    else process.env.RORCA_FALLBACK_MAX_BYTES = originalMaxBytes;
    if (originalMaxEntries === undefined) delete process.env.RORCA_FALLBACK_MAX_ENTRIES;
    else process.env.RORCA_FALLBACK_MAX_ENTRIES = originalMaxEntries;
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  test('serializes parallel writes and compacts cumulative telemetry to latest values', async () => {
    await Promise.all(Array.from({ length: 50 }, (_value, index) =>
      writeFallbackResult(cwd, fallback(`US-00${(index % 3) + 1}`, index + 1))));
    await flushFallbackWrites(cwd);

    const entries = readFallbackResults(cwd);
    expect(entries).toHaveLength(3);
    expect(fs.statSync(path.join(cwd, '.rorca-results.jsonl')).size).toBeLessThanOrEqual(2048);
    const latestByStory = new Map(entries.map(entry => [entry.storyId, entry.sequence]));
    expect(latestByStory.get('US-001')).toBe(49);
    expect(latestByStory.get('US-002')).toBe(50);
    expect(latestByStory.get('US-003')).toBe(48);
  });
});
