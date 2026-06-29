/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * PG-013: Tiered Context Cache
 *
 * In-memory cache for frequently-accessed context during pipeline runs.
 * Three tiers:
 *   - Hot  (TTL 5 min, auto-refresh): direction layers, workspace config, active agent profile
 *   - Warm (TTL 2 min, first-access): recent memory entries, installed skills, echolocation
 *   - Cold (never cached): historical memory, archived specs, WAL events, analytics
 *
 * Bounded to MAX_ENTRIES with LRU eviction. Estimated ~2-5MB for rich workspaces.
 */

import { query, queryOne } from '../db/index';
import { logger } from './logger';

// ─── Types ──────────────────────────────────────────────────────────────────

export type CacheTier = 'hot' | 'warm';

export interface CacheEntry<T = unknown> {
  value: T;
  tier: CacheTier;
  ttlMs: number;
  createdAt: number;
  lastAccessedAt: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  entries: number;
  memoryBytes: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const HOT_TTL_MS = 5 * 60 * 1000;   // 5 minutes
const WARM_TTL_MS = 2 * 60 * 1000;  // 2 minutes
const MAX_ENTRIES = 1000;

// ─── Direction layer result type ────────────────────────────────────────────

export interface DirectionLayers {
  l1?: string;
  l2?: string;
  l3?: string;
  teamL1?: string;
  teamL2?: string;
  schemaSnapshot?: string;
}

// ─── Singleton Cache ────────────────────────────────────────────────────────

const store = new Map<string, CacheEntry>();
let hits = 0;
let misses = 0;

/** Estimate memory usage of the cache (rough). */
function estimateMemoryBytes(): number {
  let bytes = 0;
  for (const [key, entry] of store) {
    bytes += key.length * 2; // JS strings are UTF-16
    bytes += 64; // CacheEntry overhead (tier, ttlMs, timestamps)
    const val = entry.value;
    if (typeof val === 'string') {
      bytes += val.length * 2;
    } else if (val !== null && val !== undefined && typeof val !== 'symbol') {
      // Rough JSON size estimate for objects
      try { bytes += JSON.stringify(val).length * 2; } catch { bytes += 64; }
    }
  }
  return bytes;
}

/** Evict expired entries, then LRU if over MAX_ENTRIES. */
function evict(): void {
  const now = Date.now();

  // 1. Remove expired entries
  for (const [key, entry] of store) {
    if (now - entry.createdAt > entry.ttlMs) {
      store.delete(key);
    }
  }

  // 2. LRU eviction if still over limit
  if (store.size > MAX_ENTRIES) {
    const sorted = [...store.entries()].sort(
      (a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt,
    );
    const toRemove = store.size - MAX_ENTRIES;
    for (let i = 0; i < toRemove; i++) {
      store.delete(sorted[i][0]);
    }
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** Get a cached value. Returns null on miss or expiry. */
export function get<T>(key: string): T | null {
  const entry = store.get(key);
  if (!entry) {
    misses++;
    return null;
  }

  // Check TTL expiry
  if (Date.now() - entry.createdAt > entry.ttlMs) {
    store.delete(key);
    misses++;
    return null;
  }

  entry.lastAccessedAt = Date.now();
  hits++;
  return entry.value as T;
}

/** Set a cache entry with explicit tier. */
export function set(key: string, value: unknown, tier: CacheTier, ttlMs?: number): void {
  const effectiveTtl = ttlMs ?? (tier === 'hot' ? HOT_TTL_MS : WARM_TTL_MS);
  const now = Date.now();

  store.set(key, {
    value,
    tier,
    ttlMs: effectiveTtl,
    createdAt: now,
    lastAccessedAt: now,
  });

  // Trigger eviction if needed
  if (store.size > MAX_ENTRIES) {
    evict();
  }
}

/** Invalidate a single key. */
export function invalidate(key: string): void {
  store.delete(key);
}

/** Invalidate all keys matching a glob pattern. Supports trailing `*` wildcard. */
export function invalidatePattern(pattern: string): void {
  if (!pattern.includes('*')) {
    store.delete(pattern);
    return;
  }

  const prefix = pattern.replace(/\*.*$/, '');
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) {
      store.delete(key);
    }
  }
}

/** Return cache statistics. */
export function cacheStats(): CacheStats {
  // Clean expired entries before reporting
  evict();

  const total = hits + misses;
  return {
    hits,
    misses,
    hitRate: total > 0 ? Math.round((hits / total) * 10000) / 10000 : 0,
    entries: store.size,
    memoryBytes: estimateMemoryBytes(),
  };
}

/** Reset stats (for testing). */
export function resetStats(): void {
  hits = 0;
  misses = 0;
}

/** Clear all entries and stats (for testing). */
export function clearAll(): void {
  store.clear();
  hits = 0;
  misses = 0;
}

// ─── Domain-Specific Helpers ────────────────────────────────────────────────

/**
 * Fetch direction layers for a workspace — cache-first.
 * Hot tier: TTL 5 min. On miss, fetches from DB and populates cache.
 */
export async function getDirectionLayers(workspaceId: string): Promise<DirectionLayers> {
  const cacheKey = `workspace:${workspaceId}:direction:layers`;
  const cached = get<DirectionLayers>(cacheKey);
  if (cached) {
    logger.debug({ workspaceId, cacheKey }, '[context-cache] direction layers HIT');
    return cached;
  }

  logger.debug({ workspaceId, cacheKey }, '[context-cache] direction layers MISS — fetching from DB');

  // L1: global standards
  const l1Row = await queryOne<{ content_yaml: string }>(
    `SELECT content_yaml FROM direction_layers WHERE layer = 1 AND COALESCE(workspace_id, '') = '' AND COALESCE(domain, '') = ''`,
  );

  // Get workspace domain (domains is a JSON array — use first element for L2 matching)
  const wsRow = await queryOne<{ domains: string | null }>(
    'SELECT domains FROM workspaces WHERE id = $1',
    [workspaceId],
  );
  const domainsArr: string[] = wsRow?.domains ? JSON.parse(wsRow.domains) : [];
  const domain = domainsArr[0] ?? null;

  // L2: domain conventions
  const l2Row = domain
    ? await queryOne<{ content_yaml: string }>(
        `SELECT content_yaml FROM direction_layers WHERE layer = 2 AND domain = $1 AND COALESCE(workspace_id, '') = ''`,
        [domain],
      )
    : undefined;

  // L3: project context
  const l3Row = await queryOne<{ content_yaml: string }>(
    `SELECT content_yaml FROM direction_layers WHERE layer = 3 AND workspace_id = $1 AND COALESCE(domain, '') = ''`,
    [workspaceId],
  );

  // Auto-hydrated context
  const ctx = await queryOne<{ schema_snapshot: string | null }>(
    `SELECT schema_snapshot FROM workspace_context WHERE workspace_id = $1`,
    [workspaceId],
  );

  // Team layers
  const access = await queryOne<{ team_id: string }>(
    'SELECT team_id FROM workspace_access WHERE workspace_id = $1 LIMIT 1',
    [workspaceId],
  );

  let teamL1: string | undefined;
  let teamL2: string | undefined;
  if (access) {
    const tl1 = await queryOne<{ content_yaml: string }>(
      `SELECT content_yaml FROM direction_layers WHERE layer = 1 AND team_id = $1 AND COALESCE(workspace_id,'') = '' AND COALESCE(domain,'') = ''`,
      [access.team_id],
    );
    const tl2 = await queryOne<{ content_yaml: string }>(
      `SELECT content_yaml FROM direction_layers WHERE layer = 2 AND team_id = $1 AND COALESCE(workspace_id,'') = '' AND COALESCE(domain,'') = ''`,
      [access.team_id],
    );
    teamL1 = tl1?.content_yaml;
    teamL2 = tl2?.content_yaml;
  }

  const result: DirectionLayers = {
    l1: l1Row?.content_yaml,
    l2: l2Row?.content_yaml,
    l3: l3Row?.content_yaml,
    teamL1,
    teamL2,
    schemaSnapshot: ctx?.schema_snapshot || undefined,
  };

  set(cacheKey, result, 'hot');
  return result;
}

/**
 * Fetch recent memory entries for a workspace — cache-first.
 * Warm tier: TTL 2 min. Returns the last 30 days of memory entries.
 */
export async function getRecentMemory(workspaceId: string): Promise<Array<{ text: string; ts: string }>> {
  const cacheKey = `workspace:${workspaceId}:memory:recent`;
  const cached = get<Array<{ text: string; ts: string }>>(cacheKey);
  if (cached) {
    logger.debug({ workspaceId }, '[context-cache] recent memory HIT');
    return cached;
  }

  logger.debug({ workspaceId }, '[context-cache] recent memory MISS — fetching from DB');

  const rows = await query<{ content: string; created_at: string }>(
    `SELECT content, created_at FROM memories
     WHERE workspace_id = $1 AND deleted_at IS NULL
     ORDER BY created_at DESC LIMIT 50`,
    [workspaceId],
  );

  const entries = rows
    .filter(r => r.content.length > 0)
    .map(r => ({ text: r.content, ts: r.created_at }));

  set(cacheKey, entries, 'warm');
  return entries;
}

/**
 * Fetch installed skills for a workspace — cache-first.
 * Warm tier: TTL 2 min.
 */
export async function getInstalledSkills(workspaceId: string): Promise<Array<{ name: string; content: string }>> {
  const cacheKey = `workspace:${workspaceId}:skills:installed`;
  const cached = get<Array<{ name: string; content: string }>>(cacheKey);
  if (cached) {
    return cached;
  }

  const rows = await query<{ name: string; content: string }>(
    `SELECT name, content FROM installed_skills`,
  );

  set(cacheKey, rows, 'warm');
  return rows;
}

// Sentinel to distinguish "not in cache" from "cached null"
const CACHE_NULL = Symbol.for('__context_cache_null__');

/**
 * Fetch workspace config (.rorca/config.json routing rules) — cache-first.
 * Hot tier: TTL 5 min.
 */
export async function getWorkspaceConfig(workspaceId: string): Promise<Record<string, unknown> | null> {
  const cacheKey = `workspace:${workspaceId}:config`;
  const entry = store.get(cacheKey);
  if (entry && (Date.now() - entry.createdAt <= entry.ttlMs)) {
    entry.lastAccessedAt = Date.now();
    hits++;
    const val = entry.value;
    return val === CACHE_NULL ? null : val as Record<string, unknown>;
  }
  if (entry) store.delete(cacheKey); // expired
  misses++;

  // Config is stored on filesystem, not in DB. Check via workspace path.
  const wsRow = await queryOne<{ path: string }>(
    'SELECT path FROM workspaces WHERE id = $1',
    [workspaceId],
  );

  if (!wsRow) {
    set(cacheKey, CACHE_NULL, 'hot');
    return null;
  }

  try {
    const fs = await import('fs');
    const pathMod = await import('path');
    const configPath = pathMod.join(wsRow.path, '.rorca', 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      set(cacheKey, config, 'hot');
      return config;
    }
  } catch {
    // Config parse error — return null, don't cache
    return null;
  }

  set(cacheKey, CACHE_NULL, 'hot');
  return null;
}

/**
 * Fetch active agent profile for a workspace — cache-first.
 * Hot tier: TTL 5 min.
 */
export async function getActiveAgentProfile(workspaceId: string): Promise<Record<string, unknown> | null> {
  const cacheKey = `workspace:${workspaceId}:agent-profile`;
  const entry = store.get(cacheKey);
  if (entry && (Date.now() - entry.createdAt <= entry.ttlMs)) {
    entry.lastAccessedAt = Date.now();
    hits++;
    const val = entry.value;
    return val === CACHE_NULL ? null : val as Record<string, unknown>;
  }
  if (entry) store.delete(cacheKey); // expired
  misses++;

  const row = await queryOne<Record<string, unknown>>(
    `SELECT * FROM agent_profiles WHERE workspace_id = $1 AND is_active = true LIMIT 1`,
    [workspaceId],
  );

  const result = row || null;
  set(cacheKey, result ?? CACHE_NULL, 'hot');
  return result;
}

/**
 * Pre-populate cache for a workspace. Called at pipeline run start.
 * Loads all hot + warm entries so stories get cache hits from story 1.
 */
export async function warmup(workspaceId: string): Promise<void> {
  logger.info({ workspaceId }, '[context-cache] warming up cache for workspace');
  const start = Date.now();

  // Hot tier — direction layers, config, agent profile
  await Promise.all([
    getDirectionLayers(String(workspaceId)),
    getWorkspaceConfig(String(workspaceId)),
    getActiveAgentProfile(String(workspaceId)),
  ]);

  // Warm tier — recent memory, installed skills
  await Promise.all([
    getRecentMemory(String(workspaceId)),
    getInstalledSkills(String(workspaceId)),
  ]);

  const elapsed = Date.now() - start;
  logger.info({ workspaceId, elapsedMs: elapsed, entries: store.size }, '[context-cache] warmup complete');
}

// ─── Invalidation Helpers (for route handlers) ─────────────────────────────

/** Invalidate direction layer cache for a workspace. */
export function invalidateDirection(workspaceId?: string): void {
  if (workspaceId) {
    invalidatePattern(`workspace:${workspaceId}:direction:*`);
  } else {
    // Global layer changed — invalidate ALL workspace direction caches
    invalidatePattern('workspace:*:direction:*');
  }
}

/** Invalidate recent memory cache for a workspace. */
export function invalidateMemory(workspaceId: string): void {
  invalidatePattern(`workspace:${workspaceId}:memory:*`);
}

/** Invalidate config cache for a workspace. */
export function invalidateConfig(workspaceId: string): void {
  invalidate(`workspace:${workspaceId}:config`);
}

/** Invalidate skills cache for a workspace. */
export function invalidateSkills(workspaceId: string): void {
  invalidatePattern(`workspace:${workspaceId}:skills:*`);
}

/**
 * Invalidate ALL cached context for a workspace (direction, memory, skills,
 * config, agent profile, and any composite retrieval keys). Used when the
 * workspace's underlying state has shifted out from under the cache.
 */
export function invalidateWorkspaceContext(workspaceId: string): void {
  invalidatePattern(`workspace:${workspaceId}:*`);
  invalidatePattern(`ctx:*:ws=${workspaceId}:*`);
}

/**
 * US-039: Evict a workspace's cached context when hydration is stale relative
 * to the working tree. Stale = the current git SHA differs from the hydrated
 * SHA, or there is no hydrated SHA at all. Returns true if the cache was
 * invalidated. Keeps cached context honestly keyed by git SHA without requiring
 * every reader to thread the SHA through its key.
 */
export function invalidateOnStaleness(
  workspaceId: string,
  currentSha: string | null | undefined,
  hydratedSha: string | null | undefined,
): boolean {
  const stale = !hydratedSha || (!!currentSha && currentSha !== hydratedSha);
  if (stale) {
    invalidateWorkspaceContext(workspaceId);
    logger.debug(
      { workspaceId, currentSha, hydratedSha },
      '[context-cache] invalidated workspace context — hydration stale',
    );
    return true;
  }
  return false;
}
