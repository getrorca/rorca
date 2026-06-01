/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Request, Response, NextFunction } from 'express';
import type { AuthUser } from '../lib/auth-utils';
import { query, queryOne } from '../db/index';

// ─── In-memory sliding window store ───
interface WindowEntry {
  timestamps: number[];
}

// Key = "userId:endpoint" or "ip:endpoint", value = sliding window timestamps
const windows = new Map<string, WindowEntry>();

// Cleanup stale entries every 5 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function startCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of windows) {
      // Remove entries where all timestamps are older than 2 minutes (max window)
      entry.timestamps = entry.timestamps.filter(t => now - t < 120_000);
      if (entry.timestamps.length === 0) {
        windows.delete(key);
      }
    }
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
}

startCleanup();

// ─── Config cache (loaded from DB) ───
interface RateLimitConfig {
  endpoint_pattern: string;
  tier: string;
  max_requests: number;
  window_seconds: number;
}

let configCache: RateLimitConfig[] | null = null;
let configCacheTime = 0;
const CONFIG_CACHE_TTL_MS = 30_000; // Reload from DB every 30s

// ─── Fallback user cache (pre-loaded at startup) ───
let fallbackUserId: string | null = null;

/**
 * Load rate limit config from DB into in-memory cache (async).
 * Called at startup and periodically via invalidateRateLimitCache().
 */
async function loadConfigAsync(): Promise<RateLimitConfig[]> {
  try {
    configCache = await query<RateLimitConfig>(
      'SELECT endpoint_pattern, tier, max_requests, window_seconds FROM rate_limits'
    );
  } catch {
    // Table may not exist yet during initial migration
    configCache = [];
  }
  configCacheTime = Date.now();
  return configCache;
}

/**
 * Get config from cache synchronously (for use in middleware).
 * If cache is stale, triggers an async reload but returns stale data immediately.
 */
function getConfigSync(): RateLimitConfig[] {
  const now = Date.now();
  if (configCache && now - configCacheTime < CONFIG_CACHE_TTL_MS) {
    return configCache;
  }
  // Trigger async reload in background, return stale data (or empty if first call)
  loadConfigAsync().catch(() => {});
  return configCache ?? [];
}

/** Invalidate the config cache (e.g. after admin changes limits) */
export function invalidateRateLimitCache(): Promise<void> {
  configCache = null;
  configCacheTime = 0;
  // Trigger async reload and return promise (callers can await for test synchronization)
  return loadConfigAsync().then(() => {}).catch(() => {});
}

/**
 * Pre-load the fallback user ID at startup.
 * Must be called during server init before requests are served.
 */
export async function initFallbackUser(): Promise<void> {
  try {
    const row = await queryOne<{ id: string }>('SELECT id FROM users LIMIT 1');
    fallbackUserId = row?.id ?? null;
  } catch {
    fallbackUserId = null;
  }
}

/**
 * Initialize rate limiter caches at startup.
 * Loads rate limit config and fallback user from DB.
 */
export async function initRateLimiterCache(): Promise<void> {
  await Promise.all([loadConfigAsync(), initFallbackUser()]);
}

/** Clear all in-memory windows (useful for testing) */
export function resetRateLimitWindows(): void {
  windows.clear();
}

/** Stop the cleanup timer (useful for testing) */
export function stopCleanupTimer(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

// ─── Route matching ───

/**
 * Match a request against an endpoint_pattern like "POST /api/specs/generate"
 * or "POST /api/specs/:id/add-stories". Supports Express-style :param segments.
 */
function matchesPattern(method: string, path: string, pattern: string): boolean {
  if (pattern === '*') return true;

  const spaceIdx = pattern.indexOf(' ');
  if (spaceIdx === -1) return false;

  const patternMethod = pattern.substring(0, spaceIdx);
  const patternPath = pattern.substring(spaceIdx + 1);

  if (patternMethod !== method) return false;

  const patternParts = patternPath.split('/');
  const pathParts = path.split('/');

  if (patternParts.length !== pathParts.length) return false;

  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) continue; // wildcard segment
    if (patternParts[i] !== pathParts[i]) return false;
  }
  return true;
}

/**
 * Find the best matching rate limit config for a request.
 * More specific patterns take priority over '*' wildcard.
 */
function findLimit(method: string, path: string, tier: string): { maxRequests: number; windowSeconds: number } {
  const configs = getConfigSync();

  // Find specific endpoint match first, then fall back to wildcard
  let specific: RateLimitConfig | undefined;
  let wildcard: RateLimitConfig | undefined;

  for (const cfg of configs) {
    if (cfg.tier !== tier) continue;
    if (cfg.endpoint_pattern === '*') {
      wildcard = cfg;
    } else if (matchesPattern(method, path, cfg.endpoint_pattern)) {
      specific = cfg;
    }
  }

  const match = specific || wildcard;
  if (!match) {
    // No config found — use sensible defaults
    return tier === 'authenticated'
      ? { maxRequests: 100, windowSeconds: 60 }
      : { maxRequests: 20, windowSeconds: 60 };
  }

  return { maxRequests: match.max_requests, windowSeconds: match.window_seconds };
}

// ─── Rate limit exemptions ───
// These endpoints are exempt from rate limiting:
// - Health check: monitoring tools (Docker, Kubernetes, load balancers) poll frequently
// - SSE endpoints: long-lived connections, not per-request rate limited
const EXEMPT_PATTERNS = [
  'GET /api/health',                           // health check
  'GET /api/pipeline/stream',                  // SSE event stream
  'GET /api/pipeline/runs/:id/output',         // SSE terminal output
  'GET /api/pipeline/runs/:id/stories/:storyId/output', // SSE story output
  'GET /api/pipeline/runs/:id/stories/:storyId/log',    // SSE story log
];

function isExempt(method: string, path: string): boolean {
  for (const pattern of EXEMPT_PATTERNS) {
    if (matchesPattern(method, path, pattern)) {
      return true;
    }
  }
  return false;
}

// ─── Middleware ───

/**
 * Express middleware that enforces per-user (authenticated) or per-IP
 * (unauthenticated) rate limiting using an in-memory sliding window.
 *
 * Exempt endpoints: /api/health, /api/pipeline/stream, SSE endpoints.
 * These are not rate-limited to support monitoring tools and long-lived connections.
 */
export function rateLimiter(req: Request, res: Response, next: NextFunction): void {
  // Skip rate limiting in test environment (dedicated rate-limiter tests opt in via RATE_LIMIT_ENABLED)
  if (process.env.NODE_ENV === 'test' && process.env.RATE_LIMIT_ENABLED !== 'true') {
    next();
    return;
  }

  const method = req.method;
  const pathOnly = req.path;

  // Skip rate limiting for exempt endpoints
  if (isExempt(method, pathOnly)) {
    next();
    return;
  }

  let user = (req as Request & { user?: AuthUser }).user;
  // Auth is globally bypassed in single-user mode — fall back to cached user
  // so all requests count as authenticated (100/min vs 20/min unauthenticated).
  if (!user && fallbackUserId) {
    user = { id: fallbackUserId, email: '', supabaseId: fallbackUserId, role: 'user' } as AuthUser;
  }
  const tier = user ? 'authenticated' : 'unauthenticated';

  const { maxRequests, windowSeconds } = findLimit(method, pathOnly, tier);
  const windowMs = windowSeconds * 1000;

  // Build key: userId for authenticated, IP for unauthenticated
  const identity = user ? `user:${user.id}` : `ip:${req.ip || req.socket.remoteAddress || 'unknown'}`;
  const key = `${identity}:${method}:${pathOnly}`;

  // Debug logging (only in verbose mode)
  if (process.env.RATE_LIMIT_DEBUG === 'true') {
    console.log(`[RateLimit] ${method} ${pathOnly} — ${tier} (${maxRequests}/${windowSeconds}s)`);
  }

  const now = Date.now();
  let entry = windows.get(key);
  if (!entry) {
    entry = { timestamps: [] };
    windows.set(key, entry);
  }

  // Slide the window: remove timestamps older than windowMs
  const windowStart = now - windowMs;
  entry.timestamps = entry.timestamps.filter(t => t > windowStart);

  if (entry.timestamps.length >= maxRequests) {
    // Find when the oldest request in the window expires
    const oldestInWindow = entry.timestamps[0];
    const retryAfterMs = (oldestInWindow + windowMs) - now;
    const retryAfterSec = Math.ceil(retryAfterMs / 1000);

    res.set('Retry-After', String(retryAfterSec));
    res.set('X-RateLimit-Limit', String(maxRequests));
    res.set('X-RateLimit-Remaining', '0');
    res.set('X-RateLimit-Reset', String(Math.ceil((oldestInWindow + windowMs) / 1000)));
    res.status(429).json({
      error: 'Too many requests',
      retryAfter: retryAfterSec,
    });
    return;
  }

  // Record this request
  entry.timestamps.push(now);

  // Set informational headers
  res.set('X-RateLimit-Limit', String(maxRequests));
  res.set('X-RateLimit-Remaining', String(maxRequests - entry.timestamps.length));

  next();
}
