/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Bounded HTTP delivery and durable fallback journaling for execution-engine
 * callbacks. Critical state transitions retain the historical retry defaults;
 * high-frequency cumulative telemetry uses CoalescingPostQueue instead.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';

const POST_MAX_RETRIES = 3;
const POST_RETRY_DELAY_MS = 1_000;
const POST_TIMEOUT_MS = 10_000;
const FALLBACK_FILENAME = '.rorca-results.jsonl';
const DEFAULT_FALLBACK_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_FALLBACK_MAX_ENTRIES = 2_000;
const MAX_FALLBACK_RECORD_BYTES = 256 * 1024;

export interface RetryPostOptions {
  maxRetries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** POST with bounded retry. The same body is reused so ingest keys remain stable. */
export async function retryPost(
  url: string,
  body: Record<string, unknown>,
  label: string,
  options: RetryPostOptions = {},
): Promise<boolean> {
  const maxRetries = options.maxRetries ?? POST_MAX_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? POST_RETRY_DELAY_MS;
  const timeoutMs = options.timeoutMs ?? POST_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;

  if (!Number.isInteger(maxRetries) || maxRetries < 1) {
    throw new RangeError('maxRetries must be a positive integer');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be positive');
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const resp = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (resp.ok) return true;
      logger.error(`[resilient-post] ${label} attempt ${attempt}/${maxRetries}: HTTP ${resp.status}`);
    } catch (err: any) {
      const message = err?.name === 'AbortError'
        ? `timed out after ${timeoutMs}ms`
        : (err?.message ?? err);
      logger.error(`[resilient-post] ${label} attempt ${attempt}/${maxRetries}: ${message}`);
    } finally {
      clearTimeout(timeoutId);
    }

    if (attempt < maxRetries && retryDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    }
  }
  return false;
}

export interface FallbackResultEntry {
  type: 'wal' | 'story_result';
  storyId: string | null;
  status: string | null;
  runId: number;
  retries: number;
  ts: string;
  /** Stable across retries/replay; enforced by backend unique indexes. */
  idempotencyKey?: string;
  /** Latest cumulative entry wins during bounded journal compaction. */
  coalesceKey?: string;
  sequence?: number;
  payload: Record<string, unknown>;
}

function positiveEnvInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function fallbackLimits(): { maxBytes: number; maxEntries: number } {
  return {
    maxBytes: positiveEnvInt('RORCA_FALLBACK_MAX_BYTES', DEFAULT_FALLBACK_MAX_BYTES),
    maxEntries: positiveEnvInt('RORCA_FALLBACK_MAX_ENTRIES', DEFAULT_FALLBACK_MAX_ENTRIES),
  };
}

function serializedBytes(entries: FallbackResultEntry[]): number {
  return entries.reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry)) + 1, 0);
}

/**
 * De-duplicate retry copies and retain only the latest cumulative telemetry for
 * each coalesce key. Capacity pressure removes coalescible telemetry first and
 * never silently drops critical WAL/story-result entries.
 */
export function compactFallbackEntries(
  input: FallbackResultEntry[],
  limits = fallbackLimits(),
): FallbackResultEntry[] {
  const byId = new Map<string, number>();
  const byCoalesceKey = new Map<string, number>();
  const keep = new Array(input.length).fill(true);

  for (let index = 0; index < input.length; index++) {
    const entry = input[index];
    if (entry.idempotencyKey) {
      const prior = byId.get(entry.idempotencyKey);
      if (prior !== undefined) keep[prior] = false;
      byId.set(entry.idempotencyKey, index);
    }
    if (entry.coalesceKey) {
      const prior = byCoalesceKey.get(entry.coalesceKey);
      if (prior !== undefined) keep[prior] = false;
      byCoalesceKey.set(entry.coalesceKey, index);
    }
  }

  const compacted = input.filter((_entry, index) => keep[index]);
  while (compacted.length > limits.maxEntries || serializedBytes(compacted) > limits.maxBytes) {
    const removable = compacted.findIndex(entry => Boolean(entry.coalesceKey));
    if (removable < 0) {
      throw new Error('fallback journal capacity exhausted by non-coalescible safety events');
    }
    compacted.splice(removable, 1);
  }
  return compacted;
}

function parseFallbackText(text: string): FallbackResultEntry[] {
  const entries: FallbackResultEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as FallbackResultEntry;
      if (parsed && (parsed.type === 'wal' || parsed.type === 'story_result') && parsed.payload) {
        entries.push(parsed);
      }
    } catch {
      logger.error(`[resilient-post] Skipping malformed fallback line: ${line.slice(0, 100)}`);
    }
  }
  return entries;
}

const journalWrites = new Map<string, Promise<boolean>>();
const journalEntryCounts = new Map<string, number>();

async function appendFallbackResult(cwd: string, entry: FallbackResultEntry): Promise<boolean> {
  const filePath = path.join(cwd, FALLBACK_FILENAME);
  const line = `${JSON.stringify(entry)}\n`;
  if (Buffer.byteLength(line) > MAX_FALLBACK_RECORD_BYTES) {
    logger.error(`[resilient-post] Refusing oversized fallback record (${Buffer.byteLength(line)} bytes)`);
    return false;
  }

  try {
    await fs.promises.mkdir(cwd, { recursive: true });
    const limits = fallbackLimits();
    const size = await fs.promises.stat(filePath).then(stat => stat.size).catch(() => 0);
    let currentText: string | null = null;
    let currentCount = journalEntryCounts.get(filePath);
    if (currentCount === undefined) {
      currentText = size > 0 ? await fs.promises.readFile(filePath, 'utf8').catch(() => '') : '';
      currentCount = parseFallbackText(currentText).length;
    }
    if (size + Buffer.byteLength(line) <= limits.maxBytes && currentCount + 1 <= limits.maxEntries) {
      await fs.promises.appendFile(filePath, line, 'utf8');
      journalEntryCounts.set(filePath, currentCount + 1);
    } else {
      const current = currentText ?? await fs.promises.readFile(filePath, 'utf8').catch(() => '');
      const compacted = compactFallbackEntries([...parseFallbackText(current), entry], limits);
      const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      await fs.promises.writeFile(tmpPath, compacted.map(value => JSON.stringify(value)).join('\n') + '\n', 'utf8');
      await fs.promises.rename(tmpPath, filePath);
      journalEntryCounts.set(filePath, compacted.length);
    }
    logger.info(`[resilient-post] Wrote fallback result: ${entry.type} ${entry.storyId ?? 'n/a'} → ${filePath}`);
    return true;
  } catch (err: any) {
    logger.error(`[resilient-post] Failed to write fallback file ${filePath}: ${err?.message ?? err}`);
    return false;
  }
}

/** Serialize async appends per journal so parallel stories cannot interleave lines. */
export function writeFallbackResult(cwd: string, entry: FallbackResultEntry): Promise<boolean> {
  const filePath = path.join(cwd, FALLBACK_FILENAME);
  const prior = journalWrites.get(filePath) ?? Promise.resolve(true);
  const next = prior.catch(() => false).then(() => appendFallbackResult(cwd, entry));
  journalWrites.set(filePath, next);
  void next.finally(() => {
    if (journalWrites.get(filePath) === next) journalWrites.delete(filePath);
  });
  return next;
}

export async function flushFallbackWrites(cwd?: string): Promise<void> {
  const selected = [...journalWrites.entries()]
    .filter(([filePath]) => !cwd || filePath === path.join(cwd, FALLBACK_FILENAME))
    .map(([, promise]) => promise);
  await Promise.allSettled(selected);
}

export function readFallbackResults(cwd: string): FallbackResultEntry[] {
  const filePath = path.join(cwd, FALLBACK_FILENAME);
  if (!fs.existsSync(filePath)) return [];
  try {
    return compactFallbackEntries(parseFallbackText(fs.readFileSync(filePath, 'utf8')));
  } catch (err: any) {
    logger.error(`[resilient-post] Failed to compact fallback file ${filePath}: ${err?.message ?? err}`);
    return parseFallbackText(fs.readFileSync(filePath, 'utf8'));
  }
}

export function deleteFallbackFile(cwd: string): void {
  const filePath = path.join(cwd, FALLBACK_FILENAME);
  journalEntryCounts.delete(filePath);
  try { fs.unlinkSync(filePath); } catch { /* absent */ }
}

export function getFallbackFilename(): string {
  return FALLBACK_FILENAME;
}

export interface CoalescingPostItem {
  key: string;
  url: string;
  body: Record<string, unknown>;
  label: string;
  fallback: FallbackResultEntry;
}

export interface CoalescingPostQueueOptions {
  maxPending?: number;
  concurrency?: number;
  timeoutMs?: number;
  retryDelayMs?: number;
  maxRetries?: number;
  failureCooldownMs?: number;
  fetchImpl?: typeof fetch;
  persistFallback?: (entry: FallbackResultEntry) => Promise<boolean>;
}

export interface CoalescingPostQueueStats {
  pending: number;
  active: number;
  accepted: number;
  coalesced: number;
  delivered: number;
  fallbackWrites: number;
  rejected: number;
  maxObservedActive: number;
}

/**
 * Latest-value queue for cumulative telemetry. At most one pending value exists
 * per key; active requests and total pending keys are bounded. Enqueue never
 * waits on network or disk.
 */
export class CoalescingPostQueue {
  private readonly pending = new Map<string, CoalescingPostItem>();
  private readonly active = new Map<string, CoalescingPostItem>();
  private readonly persisted = new Set<string>();
  private readonly io = new Set<Promise<unknown>>();
  private readonly maxPersistedIds = 4_096;
  private accepting = true;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private blockedUntil = 0;
  private readonly maxPending: number;
  private readonly concurrency: number;
  private readonly failureCooldownMs: number;
  private readonly postOptions: RetryPostOptions;
  private readonly persistFallback: (entry: FallbackResultEntry) => Promise<boolean>;
  private readonly counters = {
    accepted: 0,
    coalesced: 0,
    delivered: 0,
    fallbackWrites: 0,
    rejected: 0,
    maxObservedActive: 0,
  };

  constructor(options: CoalescingPostQueueOptions = {}) {
    this.maxPending = options.maxPending ?? 64;
    this.concurrency = options.concurrency ?? 2;
    this.failureCooldownMs = options.failureCooldownMs ?? 2_000;
    this.postOptions = {
      timeoutMs: options.timeoutMs ?? 750,
      maxRetries: options.maxRetries ?? 1,
      retryDelayMs: options.retryDelayMs ?? 0,
      fetchImpl: options.fetchImpl,
    };
    this.persistFallback = options.persistFallback ?? (async () => false);
    if (this.maxPending < 1 || this.concurrency < 1) throw new RangeError('queue bounds must be positive');
  }

  enqueue(item: CoalescingPostItem): boolean {
    if (!this.accepting) {
      this.counters.rejected++;
      this.trackPersist(item);
      return false;
    }

    const existing = this.pending.get(item.key);
    if (existing) {
      this.pending.set(item.key, item);
      this.counters.coalesced++;
      this.counters.accepted++;
      this.scheduleDrain();
      return true;
    }

    if (this.pending.size >= this.maxPending) {
      const oldestKey = this.pending.keys().next().value as string | undefined;
      if (oldestKey) {
        const evicted = this.pending.get(oldestKey)!;
        this.pending.delete(oldestKey);
        this.trackPersist(evicted);
      }
    }

    this.pending.set(item.key, item);
    this.counters.accepted++;
    this.scheduleDrain();
    return true;
  }

  stats(): CoalescingPostQueueStats {
    return {
      pending: this.pending.size,
      active: this.active.size,
      ...this.counters,
    };
  }

  async flushKey(key: string, deadlineMs = 1_250): Promise<void> {
    const deadline = Date.now() + deadlineMs;
    while ((this.pending.has(key) || this.active.has(key)) && Date.now() < deadline) {
      this.drain();
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (this.pending.has(key) || this.active.has(key)) {
      const pending = this.pending.get(key);
      const active = this.active.get(key);
      this.pending.delete(key);
      if (pending) await this.persistOnce(pending);
      if (active) await this.persistOnce(active);
    }
    await this.waitForTrackedIo(deadline);
  }

  async shutdown(deadlineMs = 2_000): Promise<void> {
    this.accepting = false;
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
    const deadline = Date.now() + deadlineMs;
    while ((this.pending.size > 0 || this.active.size > 0) && Date.now() < deadline) {
      // Do not defeat the outage cooldown during shutdown: doing so can create
      // a final request burst while prior timed-out server handlers still run.
      if (Date.now() < this.blockedUntil && this.active.size === 0) break;
      this.drain();
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    const remaining = [...this.pending.values(), ...this.active.values()];
    this.pending.clear();
    await Promise.allSettled(remaining.map(item => this.persistOnce(item)));
    await this.waitForTrackedIo(deadline);
  }

  private scheduleDrain(): void {
    if (this.wakeTimer) return;
    const delay = Math.max(0, this.blockedUntil - Date.now());
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.drain();
    }, delay);
    this.wakeTimer.unref?.();
  }

  private drain(): void {
    if (Date.now() < this.blockedUntil) {
      this.scheduleDrain();
      return;
    }
    while (this.active.size < this.concurrency && this.pending.size > 0) {
      const candidate = [...this.pending.entries()].find(([key]) => !this.active.has(key));
      if (!candidate) return;
      const [key, item] = candidate;
      this.pending.delete(key);
      this.active.set(key, item);
      this.counters.maxObservedActive = Math.max(this.counters.maxObservedActive, this.active.size);
      const operation = this.deliver(item).finally(() => {
        this.active.delete(key);
        this.io.delete(operation);
        this.scheduleDrain();
      });
      this.io.add(operation);
    }
  }

  private async deliver(item: CoalescingPostItem): Promise<void> {
    const ok = await retryPost(item.url, item.body, item.label, this.postOptions);
    if (ok) {
      this.counters.delivered++;
      return;
    }
    this.blockedUntil = Date.now() + this.failureCooldownMs;
    // A newer cumulative value supersedes this failed value.
    if (!this.pending.has(item.key)) await this.persistOnce(item);
  }

  private trackPersist(item: CoalescingPostItem): void {
    const operation = this.persistOnce(item).finally(() => this.io.delete(operation));
    this.io.add(operation);
  }

  private async persistOnce(item: CoalescingPostItem): Promise<void> {
    const id = item.fallback.idempotencyKey ?? JSON.stringify(item.fallback.payload);
    if (this.persisted.has(id)) return;
    this.persisted.add(id);
    if (this.persisted.size > this.maxPersistedIds) {
      const oldest = this.persisted.values().next().value as string | undefined;
      if (oldest !== undefined) this.persisted.delete(oldest);
    }
    if (await this.persistFallback(item.fallback)) this.counters.fallbackWrites++;
  }

  private async waitForTrackedIo(deadline: number): Promise<void> {
    while (this.io.size > 0 && Date.now() < deadline) {
      await Promise.race([
        Promise.allSettled([...this.io]),
        new Promise(resolve => setTimeout(resolve, Math.max(1, deadline - Date.now()))),
      ]);
    }
  }
}
