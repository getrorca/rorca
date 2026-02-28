import { Request, Response, NextFunction } from 'express';
import type { AuthUser } from '../routes/auth';
import { db } from '../db';

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

function loadConfig(): RateLimitConfig[] {
  const now = Date.now();
  if (configCache && now - configCacheTime < CONFIG_CACHE_TTL_MS) {
    return configCache;
  }
  try {
    configCache = db.prepare('SELECT endpoint_pattern, tier, max_requests, window_seconds FROM rate_limits').all() as RateLimitConfig[];
  } catch {
    // Table may not exist yet during initial migration
    configCache = [];
  }
  configCacheTime = now;
  return configCache;
}

/** Invalidate the config cache (e.g. after admin changes limits) */
export function invalidateRateLimitCache(): void {
  configCache = null;
  configCacheTime = 0;
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
  const configs = loadConfig();

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

// ─── Middleware ───

/**
 * Express middleware that enforces per-user (authenticated) or per-IP
 * (unauthenticated) rate limiting using an in-memory sliding window.
 */
export function rateLimiter(req: Request, res: Response, next: NextFunction): void {
  // Skip rate limiting in test environment (dedicated rate-limiter tests opt in via RATE_LIMIT_ENABLED)
  if (process.env.NODE_ENV === 'test' && process.env.RATE_LIMIT_ENABLED !== 'true') {
    next();
    return;
  }

  let user = (req as Request & { user?: AuthUser }).user;
  // Auth is globally bypassed in single-user mode — fall back to first DB user
  // so all requests count as authenticated (100/min vs 20/min unauthenticated).
  if (!user) {
    const fallback = db.prepare('SELECT id FROM users LIMIT 1').get() as { id: string } | undefined;
    if (fallback) {
      user = { id: fallback.id, email: '', displayName: '', role: 'user' } as AuthUser;
    }
  }
  const tier = user ? 'authenticated' : 'unauthenticated';

  // Strip query string for matching
  const pathOnly = req.path;
  const method = req.method;

  const { maxRequests, windowSeconds } = findLimit(method, pathOnly, tier);
  const windowMs = windowSeconds * 1000;

  // Build key: userId for authenticated, IP for unauthenticated
  const identity = user ? `user:${user.id}` : `ip:${req.ip || req.socket.remoteAddress || 'unknown'}`;
  const key = `${identity}:${method}:${pathOnly}`;

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
