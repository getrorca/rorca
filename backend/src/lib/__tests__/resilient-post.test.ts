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
  retryPostWithOutcome,
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
    let fetchActive = 0;
    let maxFetchActive = 0;
    const fetchImpl = (async (...args: Parameters<typeof fetch>) => {
      fetchActive++;
      maxFetchActive = Math.max(maxFetchActive, fetchActive);
      try {
        return await fetch(...args);
      } finally {
        fetchActive--;
      }
    }) as typeof fetch;
    const queue = new CoalescingPostQueue({
      concurrency: 2, maxPending: 8, timeoutMs: 25, maxRetries: 1,
      failureCooldownMs: 10, fetchImpl,
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
    expect(maxFetchActive).toBeLessThanOrEqual(2);
    // Aborted client requests may remain briefly active in the local HTTP server;
    // client-side delivery concurrency is the queue invariant under test.
    expect(maxServerActive).toBeGreaterThanOrEqual(1);
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

  test('returns permanent 4xx/409 rejection without retrying or relabeling it as transport failure', async () => {
    const fetchImpl = jest.fn(async () => new Response('{}', { status: 409 })) as unknown as typeof fetch;
    const outcome = await retryPostWithOutcome('http://127.0.0.1/story-result', {}, 'conflict', {
      fetchImpl,
      maxRetries: 3,
      retryDelayMs: 0,
    });
    expect(outcome).toEqual({ kind: 'permanent_rejection', attempts: 1, status: 409 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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

  test('preserves the first dependency position when a later retry replaces a result copy', () => {
    const result = { ...fallback('US-001', 1), type: 'story_result' as const, status: 'pass', coalesceKey: undefined };
    const passWal = { ...fallback('US-001', 2), status: 'story_passed', coalesceKey: undefined };
    const retriedResult = { ...result, retries: 3 };
    const compacted = compactFallbackEntries([result, passWal, retriedResult]);
    expect(compacted).toHaveLength(2);
    expect(compacted[0]).toMatchObject({ type: 'story_result', retries: 3 });
    expect(compacted[1]).toMatchObject({ type: 'wal', status: 'story_passed' });
  });

  test('preserves exact trusted relay ordering while retaining the latest result payload', () => {
    const result = (attempt: number): FallbackResultEntry => ({
      type: 'story_result', storyId: 'US-001', status: 'pass', runId: 42,
      retries: attempt, ts: new Date(attempt).toISOString(),
      idempotencyKey: 'story-result:integrated-pass-v1:stable',
      payload: { runId: 42, storyId: 'US-001', status: 'pass', attempt },
    });
    const passRelay: FallbackResultEntry = {
      type: 'wal', storyId: 'US-001', status: 'story_passed', runId: 42,
      retries: 1, ts: new Date(2).toISOString(),
      idempotencyKey: `trusted-wal:v1:${'a'.repeat(64)}`,
      payload: { trusted_relay: { eventType: 'story_passed' } },
    };

    const compacted = compactFallbackEntries([result(1), passRelay, result(3)]);
    expect(compacted.map(entry => entry.type)).toEqual(['story_result', 'wal']);
    expect(compacted[0].payload).toMatchObject({ attempt: 3 });
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
