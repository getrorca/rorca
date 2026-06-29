/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * US-039 — Hardening primitives for large external repos. Covers limit
 * resolution + env overrides, the bounded concurrency runner (global +
 * per-key + queue shedding), retrieval clamping/capping, payload caps with
 * actionable errors, and composite cache-key construction.
 */

import {
  getContextLimits,
  BoundedConcurrencyRunner,
  clampRetrievalLimits,
  capCandidates,
  assertPayloadWithinCap,
  assertCandidateWithinCap,
  buildContextCacheKey,
  hashRetrievalPolicy,
  byteLength,
} from '../context-limits';
import { PayloadTooLargeError, TooManyRequestsError } from '../errors';

const LIMIT_ENV = [
  'RORCA_HYDRATION_CONCURRENCY',
  'RORCA_HYDRATION_WS_CONCURRENCY',
  'RORCA_HYDRATION_QUEUE_DEPTH',
  'RORCA_GIT_MAP_CONCURRENCY',
  'RORCA_RETRIEVAL_MAX_CANDIDATES',
  'RORCA_RETRIEVAL_MAX_FILES',
  'RORCA_RETRIEVAL_MAX_DEPTH',
  'RORCA_RETRIEVAL_MAX_EXCERPTS',
  'RORCA_RETRIEVAL_MAX_TOKENS',
  'RORCA_TRACE_MAX_PAYLOAD_BYTES',
  'RORCA_CANDIDATE_MAX_PAYLOAD_BYTES',
];

describe('context-limits', () => {
  beforeEach(() => {
    for (const key of LIMIT_ENV) delete process.env[key];
  });

  describe('getContextLimits', () => {
    it('returns conservative defaults', () => {
      const limits = getContextLimits();
      expect(limits.hydrationGlobalConcurrency).toBe(4);
      expect(limits.hydrationPerWorkspaceConcurrency).toBe(1);
      expect(limits.maxCandidates).toBe(500);
      expect(limits.maxRetrievalTokens).toBe(200_000);
      expect(limits.maxTracePayloadBytes).toBe(1_000_000);
    });

    it('honours env overrides', () => {
      process.env.RORCA_HYDRATION_CONCURRENCY = '12';
      process.env.RORCA_RETRIEVAL_MAX_CANDIDATES = '50';
      const limits = getContextLimits();
      expect(limits.hydrationGlobalConcurrency).toBe(12);
      expect(limits.maxCandidates).toBe(50);
    });

    it('clamps non-positive / garbage env to a floor of 1', () => {
      process.env.RORCA_HYDRATION_CONCURRENCY = '0';
      process.env.RORCA_RETRIEVAL_MAX_CANDIDATES = 'not-a-number';
      const limits = getContextLimits();
      expect(limits.hydrationGlobalConcurrency).toBe(1);
      // garbage falls back to the default
      expect(limits.maxCandidates).toBe(500);
    });
  });

  describe('BoundedConcurrencyRunner', () => {
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    };

    it('bounds global concurrency', async () => {
      const runner = new BoundedConcurrencyRunner(2, 10, 10);
      let active = 0;
      let peak = 0;
      const gate = deferred();

      const task = () =>
        runner.run('any', async () => {
          active += 1;
          peak = Math.max(peak, active);
          await gate.promise;
          active -= 1;
        });

      const all = Promise.all([task(), task(), task(), task()]);
      // Let the first batch acquire slots.
      await new Promise((r) => setImmediate(r));
      expect(peak).toBe(2); // never more than globalMax concurrent
      gate.resolve();
      await all;
      expect(peak).toBe(2);
    });

    it('bounds per-key concurrency below the global cap', async () => {
      const runner = new BoundedConcurrencyRunner(10, 1, 10);
      let activeForKey = 0;
      let peakForKey = 0;
      const gate = deferred();

      const task = () =>
        runner.run('ws-1', async () => {
          activeForKey += 1;
          peakForKey = Math.max(peakForKey, activeForKey);
          await gate.promise;
          activeForKey -= 1;
        });

      const all = Promise.all([task(), task(), task()]);
      await new Promise((r) => setImmediate(r));
      expect(peakForKey).toBe(1); // per-key cap holds even though global allows 10
      gate.resolve();
      await all;
    });

    it('sheds work with TooManyRequestsError when the queue is full', async () => {
      const runner = new BoundedConcurrencyRunner(1, 1, 1);
      const gate = deferred();
      // 1 running + 1 queued = at capacity.
      const running = runner.run('ws', () => gate.promise);
      const queued = runner.run('ws', async () => undefined);

      await expect(runner.run('ws', async () => undefined)).rejects.toBeInstanceOf(
        TooManyRequestsError,
      );

      gate.resolve();
      await Promise.all([running, queued]);
    });

    it('drains the queue as slots free up', async () => {
      const runner = new BoundedConcurrencyRunner(1, 1, 5);
      const order: number[] = [];
      const gate = deferred();

      const first = runner.run('ws', async () => {
        order.push(1);
        await gate.promise;
      });
      const second = runner.run('ws', async () => {
        order.push(2);
      });

      await new Promise((r) => setImmediate(r));
      expect(order).toEqual([1]); // second is still queued
      gate.resolve();
      await Promise.all([first, second]);
      expect(order).toEqual([1, 2]);
      expect(runner.snapshot()).toEqual({ active: 0, queued: 0, keys: 0 });
    });
  });

  describe('clampRetrievalLimits', () => {
    it('passes through requests under the ceiling untouched', () => {
      const result = clampRetrievalLimits({ maxTokens: 1000, maxCandidates: 10 });
      expect(result.maxTokens).toBe(1000);
      expect(result.maxCandidates).toBe(10);
      expect(result.clamped).toEqual([]);
    });

    it('clamps over-ceiling requests and names them', () => {
      const result = clampRetrievalLimits({ maxTokens: 9_999_999, maxCandidates: 100_000 });
      expect(result.maxTokens).toBe(200_000);
      expect(result.maxCandidates).toBe(500);
      expect(result.clamped).toEqual(expect.arrayContaining(['maxTokens', 'maxCandidates']));
    });

    it('defaults omitted fields to the ceiling', () => {
      const result = clampRetrievalLimits({});
      expect(result.maxFiles).toBe(200);
      expect(result.maxExcerpts).toBe(50);
      expect(result.clamped).toEqual([]);
    });
  });

  describe('capCandidates', () => {
    it('returns the full list when within the cap', () => {
      const { kept, droppedCount } = capCandidates([1, 2, 3]);
      expect(kept).toEqual([1, 2, 3]);
      expect(droppedCount).toBe(0);
    });

    it('truncates and reports drops over the cap', () => {
      process.env.RORCA_RETRIEVAL_MAX_CANDIDATES = '2';
      const { kept, droppedCount } = capCandidates([1, 2, 3, 4, 5]);
      expect(kept).toEqual([1, 2]);
      expect(droppedCount).toBe(3);
    });
  });

  describe('payload caps', () => {
    it('passes payloads within the cap', () => {
      expect(() => assertPayloadWithinCap(100, 1000, 'Test')).not.toThrow();
    });

    it('throws an actionable PayloadTooLargeError over the cap', () => {
      expect(() => assertPayloadWithinCap(2000, 1000, 'Retrieval trace')).toThrow(
        PayloadTooLargeError,
      );
      try {
        assertPayloadWithinCap(2000, 1000, 'Retrieval trace');
      } catch (err) {
        expect((err as Error).message).toContain('2000 bytes');
        expect((err as Error).message).toContain('1000-byte cap');
        expect((err as Error).message).toMatch(/retry/i);
      }
    });

    it('rejects an over-cap single candidate', () => {
      process.env.RORCA_CANDIDATE_MAX_PAYLOAD_BYTES = '32';
      const big = { id: 'c1', ref: 'a/b.ts', reason: 'x'.repeat(200) };
      expect(() => assertCandidateWithinCap(big, big.ref)).toThrow(PayloadTooLargeError);
    });

    it('accepts a small candidate', () => {
      const small = { id: 'c1', ref: 'a/b.ts' };
      expect(() => assertCandidateWithinCap(small, small.ref)).not.toThrow();
    });

    it('byteLength measures UTF-8 bytes', () => {
      expect(byteLength('abc')).toBe(3);
      expect(byteLength('é')).toBe(2);
    });
  });

  describe('cache keys', () => {
    it('includes workspace, git SHA, file hash, brief hash, and policy hash', () => {
      const key = buildContextCacheKey({
        namespace: 'retrieve',
        workspaceId: 'ws-1',
        gitSha: 'abc123def456',
        contentHash: 'fffeee',
        briefHash: 'brief99',
        policy: { maxTokens: 1000 },
      });
      expect(key).toContain('ws=ws-1');
      expect(key).toContain('sha=abc123def456');
      expect(key).toContain('fh=fffeee');
      expect(key).toContain('bh=brief99');
      expect(key).toContain(':retrieve');
      expect(key).toContain(`pol=${hashRetrievalPolicy({ maxTokens: 1000 })}`);
    });

    it('differs when the git SHA differs', () => {
      const base = { namespace: 'r', workspaceId: 'ws', briefHash: 'b', policy: {} };
      const a = buildContextCacheKey({ ...base, gitSha: 'sha-a' });
      const b = buildContextCacheKey({ ...base, gitSha: 'sha-b' });
      expect(a).not.toBe(b);
    });

    it('differs when the retrieval policy differs', () => {
      const base = { namespace: 'r', workspaceId: 'ws', gitSha: 'sha', briefHash: 'b' };
      const a = buildContextCacheKey({ ...base, policy: { maxTokens: 1000 } });
      const b = buildContextCacheKey({ ...base, policy: { maxTokens: 2000 } });
      expect(a).not.toBe(b);
    });

    it('hashes policy independent of key order', () => {
      expect(hashRetrievalPolicy({ a: 1, b: 2 })).toBe(hashRetrievalPolicy({ b: 2, a: 1 }));
    });

    it('falls back to sentinels for missing dimensions', () => {
      const key = buildContextCacheKey({ namespace: 'r', workspaceId: 'ws' });
      expect(key).toContain('sha=nosha');
      expect(key).toContain('fh=-');
      expect(key).toContain('bh=-');
      expect(key).toContain('pol=-');
    });
  });
});
