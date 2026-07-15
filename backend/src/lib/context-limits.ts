/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * context-limits.ts — US-039 hardening primitives for large external repos.
 *
 * Single source of truth for the bounds that keep the Context Intelligence
 * Platform safe on large/hostile repositories:
 *   - hydration concurrency (global + per-workspace) with a bounded wait queue
 *   - retrieval caps (candidates / files / traversal depth / excerpts / tokens)
 *   - trace + candidate payload byte caps with actionable errors
 *   - composite cache-key construction keyed by workspace + git SHA + file hash
 *     + brief hash + retrieval policy, so stale or policy-divergent entries
 *     never alias each other.
 *
 * Every limit is env-overridable so operators can tune for huge monorepos
 * without code changes. All values are clamped to a sane floor of 1 so a
 * mis-typed env var can never disable a bound entirely.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { PayloadTooLargeError, TooManyRequestsError } from './errors';
import { loadCaptureIgnore, shortHash } from './context-safety';

// ════════════════════════════════════════════════════════════════════════════
// Limit configuration
// ════════════════════════════════════════════════════════════════════════════

export interface ContextLimits {
  /** Max hydrations executing concurrently across all workspaces in this process. */
  hydrationGlobalConcurrency: number;
  /** Max hydrations executing concurrently for a single workspace. */
  hydrationPerWorkspaceConcurrency: number;
  /** Max hydration jobs allowed to wait for a concurrency slot before shedding. */
  hydrationQueueDepth: number;
  /** Max parallel git-map LLM chunk summarizations. */
  gitMapConcurrency: number;

  /** Hard ceiling on candidates fed into ranking (protects the O(n²) MMR pass). */
  maxCandidates: number;
  /** Hard ceiling on distinct files surfaced by retrieval. */
  maxFiles: number;
  /** Max graph/seed traversal depth. */
  maxTraversalDepth: number;
  /** Max excerpts emitted per retrieval. */
  maxExcerpts: number;
  /** Absolute ceiling on the retrieval token budget a caller may request. */
  maxRetrievalTokens: number;

  /** Max serialized bytes for a persisted retrieval trace payload. */
  maxTracePayloadBytes: number;
  /** Max serialized bytes for a single retrieval candidate. */
  maxCandidatePayloadBytes: number;
}

/** Default bounds — conservative enough to survive large external repos. */
const DEFAULTS: ContextLimits = {
  hydrationGlobalConcurrency: 4,
  hydrationPerWorkspaceConcurrency: 1,
  hydrationQueueDepth: 64,
  gitMapConcurrency: 5,

  maxCandidates: 500,
  maxFiles: 200,
  maxTraversalDepth: 4,
  maxExcerpts: 50,
  maxRetrievalTokens: 200_000,

  maxTracePayloadBytes: 1_000_000,
  maxCandidatePayloadBytes: 64_000,
};

/** Read a positive integer env override, clamped to a floor of 1. */
function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, parsed);
}

/**
 * Resolve the active context limits, honouring env overrides. Cheap enough to
 * call per-request; not memoized so tests can mutate env between calls.
 */
export function getContextLimits(): ContextLimits {
  return {
    hydrationGlobalConcurrency: readInt('RORCA_HYDRATION_CONCURRENCY', DEFAULTS.hydrationGlobalConcurrency),
    hydrationPerWorkspaceConcurrency: readInt('RORCA_HYDRATION_WS_CONCURRENCY', DEFAULTS.hydrationPerWorkspaceConcurrency),
    hydrationQueueDepth: readInt('RORCA_HYDRATION_QUEUE_DEPTH', DEFAULTS.hydrationQueueDepth),
    gitMapConcurrency: readInt('RORCA_GIT_MAP_CONCURRENCY', DEFAULTS.gitMapConcurrency),

    maxCandidates: readInt('RORCA_RETRIEVAL_MAX_CANDIDATES', DEFAULTS.maxCandidates),
    maxFiles: readInt('RORCA_RETRIEVAL_MAX_FILES', DEFAULTS.maxFiles),
    maxTraversalDepth: readInt('RORCA_RETRIEVAL_MAX_DEPTH', DEFAULTS.maxTraversalDepth),
    maxExcerpts: readInt('RORCA_RETRIEVAL_MAX_EXCERPTS', DEFAULTS.maxExcerpts),
    maxRetrievalTokens: readInt('RORCA_RETRIEVAL_MAX_TOKENS', DEFAULTS.maxRetrievalTokens),

    maxTracePayloadBytes: readInt('RORCA_TRACE_MAX_PAYLOAD_BYTES', DEFAULTS.maxTracePayloadBytes),
    maxCandidatePayloadBytes: readInt('RORCA_CANDIDATE_MAX_PAYLOAD_BYTES', DEFAULTS.maxCandidatePayloadBytes),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Bounded concurrency runner (global + per-key) with a shedding wait queue
// ════════════════════════════════════════════════════════════════════════════

interface Waiter {
  key: string;
  resolve: () => void;
}

/**
 * A keyed semaphore: bounds both the total number of concurrent tasks and the
 * number concurrent for any single key. Tasks that cannot acquire a slot wait
 * FIFO; once the wait queue is full, further `run()` calls are shed with a
 * {@link TooManyRequestsError} rather than growing memory without bound.
 */
export class BoundedConcurrencyRunner {
  private global = 0;
  private readonly perKey = new Map<string, number>();
  private readonly queue: Waiter[] = [];

  constructor(
    private readonly globalMax: number,
    private readonly perKeyMax: number,
    private readonly maxQueueDepth: number,
  ) {}

  private canAcquire(key: string): boolean {
    return this.global < this.globalMax && (this.perKey.get(key) ?? 0) < this.perKeyMax;
  }

  private acquire(key: string): void {
    this.global += 1;
    this.perKey.set(key, (this.perKey.get(key) ?? 0) + 1);
  }

  private release(key: string): void {
    this.global = Math.max(0, this.global - 1);
    const next = (this.perKey.get(key) ?? 1) - 1;
    if (next <= 0) this.perKey.delete(key);
    else this.perKey.set(key, next);

    // Wake the first waiter that can now acquire a slot. One slot freed → one wake.
    for (let i = 0; i < this.queue.length; i += 1) {
      const waiter = this.queue[i];
      if (this.canAcquire(waiter.key)) {
        this.queue.splice(i, 1);
        this.acquire(waiter.key);
        waiter.resolve();
        break;
      }
    }
  }

  /** Run `fn` once a slot is available for `key`. Throws if the queue is full. */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.canAcquire(key)) {
      this.acquire(key);
    } else {
      if (this.queue.length >= this.maxQueueDepth) {
        throw new TooManyRequestsError(
          `Hydration concurrency limit reached (${this.globalMax} global / ${this.perKeyMax} per workspace) ` +
            `and the wait queue is full (${this.maxQueueDepth}). Retry shortly or raise RORCA_HYDRATION_QUEUE_DEPTH.`,
        );
      }
      await new Promise<void>((resolve) => {
        this.queue.push({ key, resolve });
      });
      // On resolve the releasing task already acquired our slot on our behalf.
    }

    try {
      return await fn();
    } finally {
      this.release(key);
    }
  }

  /** Inspect live counts (for diagnostics/tests). */
  snapshot(): { active: number; queued: number; keys: number } {
    return { active: this.global, queued: this.queue.length, keys: this.perKey.size };
  }
}

let hydrationRunner: BoundedConcurrencyRunner | null = null;

/** Process-wide hydration concurrency gate, built lazily from current limits. */
export function hydrationConcurrency(): BoundedConcurrencyRunner {
  if (!hydrationRunner) {
    const limits = getContextLimits();
    hydrationRunner = new BoundedConcurrencyRunner(
      limits.hydrationGlobalConcurrency,
      limits.hydrationPerWorkspaceConcurrency,
      limits.hydrationQueueDepth,
    );
  }
  return hydrationRunner;
}

/** Reset the hydration gate (tests only). */
export function resetHydrationConcurrency(): void {
  hydrationRunner = null;
}

// ════════════════════════════════════════════════════════════════════════════
// Retrieval limit enforcement
// ════════════════════════════════════════════════════════════════════════════

export interface RetrievalLimitRequest {
  maxTokens?: number;
  maxCandidates?: number;
  maxFiles?: number;
  maxDepth?: number;
  maxExcerpts?: number;
}

export interface ClampedRetrievalLimits {
  maxTokens: number;
  maxCandidates: number;
  maxFiles: number;
  maxDepth: number;
  maxExcerpts: number;
  /** Names of fields whose requested value exceeded the limit and was clamped. */
  clamped: string[];
}

/**
 * Clamp a caller's requested retrieval bounds to the active ceilings. Requests
 * below the ceiling pass through untouched; requests above it are clamped down
 * and named in `clamped` so callers can surface the adjustment honestly.
 */
export function clampRetrievalLimits(
  req: RetrievalLimitRequest,
  limits: ContextLimits = getContextLimits(),
): ClampedRetrievalLimits {
  const clamped: string[] = [];
  const cap = (requested: number | undefined, ceiling: number, name: string): number => {
    if (requested === undefined) return ceiling;
    const floored = Math.max(1, Math.floor(requested));
    if (floored > ceiling) {
      clamped.push(name);
      return ceiling;
    }
    return floored;
  };

  return {
    maxTokens: cap(req.maxTokens, limits.maxRetrievalTokens, 'maxTokens'),
    maxCandidates: cap(req.maxCandidates, limits.maxCandidates, 'maxCandidates'),
    maxFiles: cap(req.maxFiles, limits.maxFiles, 'maxFiles'),
    maxDepth: cap(req.maxDepth, limits.maxTraversalDepth, 'maxDepth'),
    maxExcerpts: cap(req.maxExcerpts, limits.maxExcerpts, 'maxExcerpts'),
    clamped,
  };
}

/**
 * Truncate a candidate list to the active ceiling. Returns the kept slice and
 * how many were dropped, so callers can log/flag the truncation rather than
 * silently losing evidence.
 */
export function capCandidates<T>(
  candidates: readonly T[],
  limits: ContextLimits = getContextLimits(),
): { kept: T[]; droppedCount: number } {
  if (candidates.length <= limits.maxCandidates) {
    return { kept: candidates.slice(), droppedCount: 0 };
  }
  return {
    kept: candidates.slice(0, limits.maxCandidates),
    droppedCount: candidates.length - limits.maxCandidates,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Payload caps
// ════════════════════════════════════════════════════════════════════════════

/** UTF-8 byte length of a string. */
export function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * Assert that a serialized payload is within `capBytes`. Throws an actionable
 * {@link PayloadTooLargeError} naming the offender, the measured size, and how
 * to remediate.
 */
export function assertPayloadWithinCap(
  serializedBytes: number,
  capBytes: number,
  label: string,
  remediation = 'Reduce candidate count, excerpt length, or token budget and retry.',
): void {
  if (serializedBytes > capBytes) {
    throw new PayloadTooLargeError(
      `${label} payload is ${serializedBytes} bytes, exceeding the ${capBytes}-byte cap. ${remediation}`,
    );
  }
}

/** Assert a single candidate's serialized size is within the per-candidate cap. */
export function assertCandidateWithinCap(
  candidate: unknown,
  identifier: string,
  limits: ContextLimits = getContextLimits(),
): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(candidate) ?? '';
  } catch {
    serialized = String(candidate);
  }
  assertPayloadWithinCap(
    byteLength(serialized),
    limits.maxCandidatePayloadBytes,
    `Retrieval candidate '${identifier}'`,
    'Truncate the candidate excerpt/reason fields before persisting.',
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Workspace content fingerprints for dirty/non-git cache keys
// ════════════════════════════════════════════════════════════════════════════

/** Max bytes read from each file while computing dirty/non-git content hashes. */
export const MAX_CONTENT_HASH_BYTES_PER_FILE = 64 * 1024;

export interface WorkspaceContentHashOptions {
  /** File cap for the bounded fingerprint walk. Defaults to active retrieval maxFiles. */
  maxFiles?: number;
  /** Directory traversal cap. Defaults to active retrieval maxDepth. */
  maxDepth?: number;
}

export interface WorkspaceContentHashResult {
  /** SHA-256 digest over bounded file paths + metadata + content prefixes. */
  hash: string;
  /** Number of files included in the digest. */
  fileCount: number;
  /** True when maxFiles/maxDepth prevented a complete workspace walk. */
  truncated: boolean;
  maxFiles: number;
  maxDepth: number;
}

function readFilePrefix(absPath: string, maxBytes: number): Buffer {
  const fd = fs.openSync(absPath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Compute a bounded workspace content fingerprint for cache keys when git SHA
 * alone is insufficient (dirty working trees or non-git workspaces). The walk
 * respects `.rorca-captureignore` + built-in excludes and is capped by the
 * active retrieval maxFiles/maxDepth so large external repos cannot force an
 * unbounded filesystem scan.
 */
export function computeWorkspaceContentHash(
  workspacePath: string,
  options: WorkspaceContentHashOptions = {},
  limits: ContextLimits = getContextLimits(),
): WorkspaceContentHashResult | null {
  const root = path.resolve(workspacePath);
  let rootStat: fs.Stats;
  try {
    rootStat = fs.statSync(root);
  } catch {
    return null;
  }
  if (!rootStat.isDirectory()) return null;

  const maxFiles = Math.max(1, Math.min(Math.floor(options.maxFiles ?? limits.maxFiles), limits.maxFiles));
  const maxDepth = Math.max(1, Math.min(Math.floor(options.maxDepth ?? limits.maxTraversalDepth), limits.maxTraversalDepth));
  const ignore = loadCaptureIgnore(root);
  const digest = createHash('sha256');
  const dirs: Array<{ absPath: string; relPath: string; depth: number }> = [{ absPath: root, relPath: '', depth: 0 }];
  const maxEntries = Math.max(maxFiles, maxFiles * 4);
  let entryCount = 0;
  let fileCount = 0;
  let truncated = false;

  digest.update(`root:${path.basename(root)}\nmaxFiles:${maxFiles}\nmaxDepth:${maxDepth}\nmaxEntries:${maxEntries}\n`);

  while (dirs.length > 0 && fileCount < maxFiles) {
    const current = dirs.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.absPath, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      continue;
    }

    for (const entry of entries) {
      const relPath = current.relPath ? `${current.relPath}/${entry.name}` : entry.name;
      if (ignore.ignores(relPath) || (entry.isDirectory() && ignore.ignores(`${relPath}/`))) {
        continue;
      }
      if (entryCount >= maxEntries) {
        truncated = true;
        digest.update(`entry-limit:${relPath}\n`);
        dirs.length = 0;
        break;
      }
      entryCount += 1;

      const absPath = path.join(current.absPath, entry.name);
      if (entry.isDirectory()) {
        if (current.depth >= maxDepth) {
          truncated = true;
          digest.update(`depth-limit:${relPath}\n`);
          continue;
        }
        dirs.push({ absPath, relPath, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;

      if (fileCount >= maxFiles) {
        truncated = true;
        digest.update(`file-limit:${relPath}\n`);
        dirs.length = 0;
        break;
      }

      try {
        const stat = fs.statSync(absPath);
        const prefix = readFilePrefix(absPath, MAX_CONTENT_HASH_BYTES_PER_FILE);
        digest.update(`file:${relPath}\nsize:${stat.size}\nmtime:${Math.floor(stat.mtimeMs)}\nbytes:${prefix.length}\n`);
        digest.update(prefix);
        digest.update('\n');
        fileCount += 1;
        if (stat.size > prefix.length) {
          digest.update(`prefix-only:${relPath}\n`);
        }
      } catch {
        digest.update(`unreadable:${relPath}\n`);
      }
    }
  }

  if (dirs.length > 0 && fileCount >= maxFiles) {
    truncated = true;
    digest.update(`file-limit:queued:${dirs[0].relPath}\n`);
  }

  return {
    hash: digest.digest('hex'),
    fileCount,
    truncated,
    maxFiles,
    maxDepth,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Composite cache keys (workspace + git SHA + file hash + brief + policy)
// ════════════════════════════════════════════════════════════════════════════

/** Bump when the cache-key layout changes — invalidates all prior keys. */
export const CACHE_KEY_VERSION = 'v1';

/** Deterministic JSON with sorted keys so policy hashing is order-independent. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(',')}}`;
}

/** Stable 12-char hash of a retrieval policy object (key-order independent). */
export function hashRetrievalPolicy(policy: unknown): string {
  return shortHash(stableStringify(policy), 12);
}

export interface ContextCacheKeyParts {
  /** Logical sub-key, e.g. 'retrieve', 'direction', 'seeds'. */
  namespace: string;
  workspaceId: string;
  /** Current git SHA — distinguishes branches/commits. */
  gitSha?: string | null;
  /** Content/file hash — distinguishes dirty working trees. */
  contentHash?: string | null;
  /** Brief hash — distinguishes queries. */
  briefHash?: string | null;
  /** Retrieval policy object — distinguishes token budget / graph mode / caps. */
  policy?: unknown;
}

/**
 * Build a cache key that is unique per (workspace, git SHA, file hash, brief,
 * retrieval policy). Any change in those dimensions yields a different key, so
 * a stale commit or a divergent policy can never serve another's cached value.
 */
export function buildContextCacheKey(parts: ContextCacheKeyParts): string {
  const sha = (parts.gitSha ?? '').slice(0, 16) || 'nosha';
  const fh = (parts.contentHash ?? '').slice(0, 16) || '-';
  const bh = (parts.briefHash ?? '').slice(0, 16) || '-';
  const pol = parts.policy === undefined ? '-' : hashRetrievalPolicy(parts.policy);
  return `ctx:${CACHE_KEY_VERSION}:ws=${parts.workspaceId}:sha=${sha}:fh=${fh}:bh=${bh}:pol=${pol}:${parts.namespace}`;
}
