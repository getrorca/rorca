/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * US-017: Tests for GitHubRateLimiter.
 *
 * Covers: header tracking, rate limit blocking, exponential backoff on 429,
 * circuit breaker state transitions (closed→open→half-open→closed),
 * and the status endpoint response shape.
 */

import { GitHubRateLimiter } from '../lib/github-rate-limiter';
import { TooManyRequestsError, ServiceUnavailableError } from '../lib/errors';

// Suppress logger output during tests
jest.mock('../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

function mockResponse(
  status: number,
  headers: Record<string, string> = {},
): Response {
  const h = new Headers(headers);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name: string) => h.get(name),
    },
    text: async () => '',
    json: async () => ({}),
  } as unknown as Response;
}

describe('GitHubRateLimiter', () => {
  let limiter: GitHubRateLimiter;

  beforeEach(() => {
    limiter = new GitHubRateLimiter();
    // Make sleep instant so tests don't wait for real backoff delays
    jest.spyOn(limiter as any, 'sleep').mockResolvedValue(undefined);
  });

  // ─── Header tracking ──────────────────────────────────────────────────────

  describe('header tracking', () => {
    it('updates remaining/limit/resetAt from response headers', async () => {
      const fn = jest.fn().mockResolvedValue(
        mockResponse(200, {
          'x-ratelimit-remaining': '4500',
          'x-ratelimit-limit': '5000',
          'x-ratelimit-reset': '1742302800',
        }),
      );

      await limiter.execute(fn);

      const status = limiter.getStatus();
      expect(status.remaining).toBe(4500);
      expect(status.limit).toBe(5000);
      expect(status.resetAt).toBe(new Date(1742302800 * 1000).toISOString());
      expect(status.circuitState).toBe('closed');
    });
  });

  // ─── Default (empty) state ────────────────────────────────────────────────

  describe('default state', () => {
    it('returns default status when no calls have been made', () => {
      const status = limiter.getStatus();
      expect(status).toEqual({
        remaining: 5000,
        limit: 5000,
        resetAt: null,
        circuitState: 'closed',
      });
    });
  });

  // ─── Rate limit blocking ──────────────────────────────────────────────────

  describe('rate limit blocking', () => {
    it('throws TooManyRequestsError when remaining < 100 and reset is in the future', async () => {
      const futureEpoch = Math.floor(Date.now() / 1000) + 3600;
      limiter._setRemaining(50);
      limiter._setResetEpoch(futureEpoch);

      const fn = jest.fn();
      await expect(limiter.execute(fn)).rejects.toThrow(TooManyRequestsError);
      expect(fn).not.toHaveBeenCalled();
    });

    it('allows requests when remaining < 100 but reset has passed', async () => {
      const pastEpoch = Math.floor(Date.now() / 1000) - 60;
      limiter._setRemaining(50);
      limiter._setResetEpoch(pastEpoch);

      const fn = jest.fn().mockResolvedValue(mockResponse(200));
      const res = await limiter.execute(fn);
      expect(res.status).toBe(200);
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  // ─── 429 with exponential backoff ─────────────────────────────────────────

  describe('429 backoff', () => {
    it('retries on 429 with backoff, then throws TooManyRequestsError on exhaustion', async () => {
      const fn = jest.fn().mockResolvedValue(
        mockResponse(429, { 'retry-after': '1' }),
      );

      await expect(limiter.execute(fn)).rejects.toThrow(TooManyRequestsError);
      // Initial + 4 retries = 5 total calls
      expect(fn).toHaveBeenCalledTimes(5);
    });

    it('succeeds after 429 if a subsequent retry returns 200', async () => {
      const fn = jest.fn()
        .mockResolvedValueOnce(mockResponse(429))
        .mockResolvedValueOnce(mockResponse(200));

      const res = await limiter.execute(fn);
      expect(res.status).toBe(200);
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('uses Retry-After header value when present', async () => {
      const sleepSpy = jest.spyOn(limiter as any, 'sleep').mockResolvedValue(undefined);

      const fn = jest.fn()
        .mockResolvedValueOnce(mockResponse(429, { 'retry-after': '5' }))
        .mockResolvedValueOnce(mockResponse(200));

      await limiter.execute(fn);
      // First sleep should use retry-after (5s = 5000ms)
      expect(sleepSpy).toHaveBeenCalledWith(5000);
    });
  });

  // ─── Circuit breaker ──────────────────────────────────────────────────────

  describe('circuit breaker', () => {
    it('opens after 10 consecutive failures', async () => {
      limiter._setConsecutiveFailures(9);

      const fn = jest.fn().mockRejectedValue(new Error('Network error'));

      await expect(limiter.execute(fn)).rejects.toThrow('Network error');
      expect(limiter.getStatus().circuitState).toBe('open');
    });

    it('fails fast with ServiceUnavailableError (503) when circuit is open', async () => {
      limiter._setCircuitState('open', Date.now());

      const fn = jest.fn();
      await expect(limiter.execute(fn)).rejects.toThrow(ServiceUnavailableError);
      expect(fn).not.toHaveBeenCalled();
    });

    it('503 error message includes retry time', async () => {
      limiter._setCircuitState('open', Date.now());

      try {
        await limiter.execute(jest.fn());
        throw new Error('should have thrown');
      } catch (err: any) {
        expect(err.message).toContain('circuit breaker open');
        expect(err.message).toContain('retry after');
      }
    });

    it('transitions to half-open after 5 minutes', () => {
      limiter._setCircuitState('open', Date.now() - 5 * 60 * 1000);

      const status = limiter.getStatus();
      expect(status.circuitState).toBe('half-open');
    });

    it('stays open before 5 minutes', () => {
      limiter._setCircuitState('open', Date.now() - 4 * 60 * 1000);

      const status = limiter.getStatus();
      expect(status.circuitState).toBe('open');
    });

    it('closes on successful half-open test request', async () => {
      limiter._setCircuitState('half-open');
      const fn = jest.fn().mockResolvedValue(mockResponse(200));

      await limiter.execute(fn);

      expect(limiter.getStatus().circuitState).toBe('closed');
    });

    it('re-opens on failed half-open test request', async () => {
      limiter._setCircuitState('half-open');

      const fn = jest.fn().mockRejectedValue(new Error('Still broken'));

      await expect(limiter.execute(fn)).rejects.toThrow('Still broken');
      expect(limiter.getStatus().circuitState).toBe('open');
    });

    it('full lifecycle: closed → open → half-open → closed', async () => {
      // Start closed
      expect(limiter.getStatus().circuitState).toBe('closed');

      // 10 consecutive failures → open
      limiter._setConsecutiveFailures(9);
      const failFn = jest.fn().mockRejectedValue(new Error('fail'));
      await expect(limiter.execute(failFn)).rejects.toThrow();
      expect(limiter.getStatus().circuitState).toBe('open');

      // Simulate 5 minutes passing → half-open
      limiter._setCircuitState('open', Date.now() - 5 * 60 * 1000);
      expect(limiter.getStatus().circuitState).toBe('half-open');

      // Successful test request → closed
      const successFn = jest.fn().mockResolvedValue(mockResponse(200));
      await limiter.execute(successFn);
      expect(limiter.getStatus().circuitState).toBe('closed');
    });
  });

  // ─── 5xx retry ────────────────────────────────────────────────────────────

  describe('5xx retry', () => {
    it('retries on 500 errors with backoff', async () => {
      const fn = jest.fn()
        .mockResolvedValueOnce(mockResponse(500))
        .mockResolvedValueOnce(mockResponse(200));

      const res = await limiter.execute(fn);
      expect(res.status).toBe(200);
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('returns 500 response after exhausting retries', async () => {
      const fn = jest.fn().mockResolvedValue(mockResponse(500));

      const res = await limiter.execute(fn);
      expect(res.status).toBe(500);
      expect(fn).toHaveBeenCalledTimes(5);
    });
  });

  // ─── Success resets failures ──────────────────────────────────────────────

  describe('success resets failures', () => {
    it('resets consecutive failures on successful response', async () => {
      limiter._setConsecutiveFailures(5);
      const fn = jest.fn().mockResolvedValue(mockResponse(200));

      await limiter.execute(fn);

      expect(limiter.getStatus().circuitState).toBe('closed');
    });
  });
});
