/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * US-017: Outbound rate limiter for GitHub API calls.
 *
 * Tracks remaining requests via X-RateLimit-Remaining/Reset headers,
 * implements exponential backoff on 429, and a circuit breaker that
 * opens after 10 consecutive failures (5-minute open window).
 *
 * All outbound GitHub API calls must go through `githubRateLimiter.execute()`.
 */
import { TooManyRequestsError, ServiceUnavailableError, AppError } from './errors';
import { logger } from './logger';

// ─── Types ───────────────────────────────────────────────────────────────────

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface RateLimitStatus {
  remaining: number;
  limit: number;
  resetAt: string | null;
  circuitState: CircuitState;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 5000;
const REMAINING_THRESHOLD = 100;
const MAX_CONSECUTIVE_FAILURES = 10;
const CIRCUIT_OPEN_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 16000;
const MAX_RETRIES = 4; // 1s, 2s, 4s, 8s, 16s = 5 attempts total (initial + 4 retries)

// ─── GitHubRateLimiter ──────────────────────────────────────────────────────

export class GitHubRateLimiter {
  private remaining: number = DEFAULT_LIMIT;
  private limit: number = DEFAULT_LIMIT;
  private resetEpoch: number | null = null; // Unix seconds
  private consecutiveFailures: number = 0;
  private circuitState: CircuitState = 'closed';
  private circuitOpenedAt: number = 0; // Date.now() ms

  /** Execute a GitHub API call through the rate limiter. */
  async execute(fn: () => Promise<Response>): Promise<Response> {
    this.checkCircuitTransition();

    if (this.circuitState === 'open') {
      const resetTime = new Date(this.circuitOpenedAt + CIRCUIT_OPEN_DURATION_MS).toISOString();
      throw new ServiceUnavailableError(
        `GitHub API temporarily unavailable — circuit breaker open, retry after ${resetTime}`,
      );
    }

    // Block if remaining is below threshold and reset hasn't passed
    if (this.remaining < REMAINING_THRESHOLD && this.resetEpoch) {
      const now = Math.floor(Date.now() / 1000);
      if (now < this.resetEpoch) {
        const resetDate = new Date(this.resetEpoch * 1000).toISOString();
        throw new TooManyRequestsError(
          `GitHub API rate limit nearly exhausted (${this.remaining} remaining). Resets at ${resetDate}`,
        );
      }
      // Reset window has passed — clear state
      this.remaining = this.limit;
      this.resetEpoch = null;
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fn();
        this.updateFromHeaders(response);

        if (response.status === 429) {
          const retryAfter = this.parseRetryAfter(response);
          const backoffMs = retryAfter
            ? retryAfter * 1000
            : Math.min(BACKOFF_BASE_MS * Math.pow(2, attempt), BACKOFF_MAX_MS);

          this.recordFailure();
          if (attempt < MAX_RETRIES) {
            await this.sleep(backoffMs);
            continue;
          }
          throw new TooManyRequestsError('GitHub API rate limit exceeded after retries');
        }

        if (response.status >= 500) {
          this.recordFailure();
          if (attempt < MAX_RETRIES) {
            const backoffMs = Math.min(BACKOFF_BASE_MS * Math.pow(2, attempt), BACKOFF_MAX_MS);
            await this.sleep(backoffMs);
            continue;
          }
          return response;
        }

        // Success — reset failure counter
        this.recordSuccess();
        return response;
      } catch (err) {
        // Re-throw our own errors (circuit open, rate limit)
        if (err instanceof AppError) {
          throw err;
        }
        // Network/fetch error
        lastError = err as Error;
        this.recordFailure();
        if (attempt < MAX_RETRIES) {
          const backoffMs = Math.min(BACKOFF_BASE_MS * Math.pow(2, attempt), BACKOFF_MAX_MS);
          await this.sleep(backoffMs);
          continue;
        }
      }
    }

    throw lastError ?? new Error('GitHub API call failed after retries');
  }

  /** Get current rate limit status. */
  getStatus(): RateLimitStatus {
    this.checkCircuitTransition();
    return {
      remaining: this.remaining,
      limit: this.limit,
      resetAt: this.resetEpoch ? new Date(this.resetEpoch * 1000).toISOString() : null,
      circuitState: this.circuitState,
    };
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private updateFromHeaders(response: Response): void {
    const remaining = response.headers.get('x-ratelimit-remaining');
    const limit = response.headers.get('x-ratelimit-limit');
    const reset = response.headers.get('x-ratelimit-reset');

    if (remaining !== null) this.remaining = parseInt(remaining, 10);
    if (limit !== null) this.limit = parseInt(limit, 10);
    if (reset !== null) this.resetEpoch = parseInt(reset, 10);
  }

  private parseRetryAfter(response: Response): number | null {
    const header = response.headers.get('retry-after');
    if (!header) return null;
    const seconds = parseInt(header, 10);
    return isNaN(seconds) ? null : seconds;
  }

  private recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && this.circuitState === 'closed') {
      this.circuitState = 'open';
      this.circuitOpenedAt = Date.now();
      logger.warn(
        `[GitHubRateLimiter] Circuit breaker OPEN after ${this.consecutiveFailures} consecutive failures. Will retry in 5 minutes.`,
      );
    } else if (this.circuitState === 'half-open') {
      // Test request failed — reopen
      this.circuitState = 'open';
      this.circuitOpenedAt = Date.now();
      logger.warn('[GitHubRateLimiter] Half-open test failed. Circuit breaker re-OPENED.');
    }
  }

  private recordSuccess(): void {
    if (this.circuitState === 'half-open') {
      logger.info('[GitHubRateLimiter] Half-open test succeeded. Circuit breaker CLOSED.');
    }
    this.consecutiveFailures = 0;
    this.circuitState = 'closed';
  }

  /** Lazily check if an open circuit should transition to half-open. */
  private checkCircuitTransition(): void {
    if (this.circuitState === 'open') {
      const elapsed = Date.now() - this.circuitOpenedAt;
      if (elapsed >= CIRCUIT_OPEN_DURATION_MS) {
        this.circuitState = 'half-open';
        logger.info('[GitHubRateLimiter] Circuit breaker HALF-OPEN. Allowing 1 test request.');
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ─── Test helpers (exposed for unit tests) ─────────────────────────────────

  /** @internal Reset all state — for testing only. */
  _reset(): void {
    this.remaining = DEFAULT_LIMIT;
    this.limit = DEFAULT_LIMIT;
    this.resetEpoch = null;
    this.consecutiveFailures = 0;
    this.circuitState = 'closed';
    this.circuitOpenedAt = 0;
  }

  /** @internal Force circuit state — for testing only. */
  _setCircuitState(state: CircuitState, openedAt?: number): void {
    this.circuitState = state;
    if (openedAt !== undefined) this.circuitOpenedAt = openedAt;
  }

  /** @internal Force consecutive failures — for testing only. */
  _setConsecutiveFailures(n: number): void {
    this.consecutiveFailures = n;
  }

  /** @internal Force remaining count — for testing only. */
  _setRemaining(n: number): void {
    this.remaining = n;
  }

  /** @internal Force reset epoch — for testing only. */
  _setResetEpoch(epoch: number | null): void {
    this.resetEpoch = epoch;
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

export const githubRateLimiter = new GitHubRateLimiter();
