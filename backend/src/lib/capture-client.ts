/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * US-026: Capture Sidecar API client with local JSONL queue.
 *
 * This is the HTTP client the `rorca-capture` sidecar (US-025) uses to talk to
 * Rorca's ingestion API (US-032). It provides:
 *
 *   1. `health()` — reachability check against `GET /api/context-events/health`
 *   2. `submitEvent(event)` — submit a single context event (online)
 *   3. `submitCandidate(candidate)` — submit a single memory candidate (online)
 *   4. `flushQueue()` — idempotently flush the local JSONL queue to the server
 *
 * The local JSONL queue (`CaptureQueue`) is an offline buffer: when the sidecar
 * cannot reach Rorca, it writes redacted, versioned, idempotency-keyed payloads
 * to a local `.rorca-capture-queue.jsonl` file. When connectivity returns,
 * `flushQueue()` replays them in order, preserving failed entries so they can be
 * retried later (no silent drops).
 *
 * Design doc: docs/context-intelligence-platform.md §2.4, §3 (local queue =
 * offline buffer), §6 (Shared Contracts).
 */

import * as fs from 'fs';
import * as path from 'path';
import { contextEventSchema, type ContextEvent, memoryCandidateSchema, type MemoryCandidate } from './capture-contracts';
import { redactObject } from './context-safety';

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

/** A single entry in the local JSONL queue. */
export interface QueueEntry {
  /** Queue format version so the flush loop can evolve the on-disk format. */
  version: number;
  /** Stable, client-generated de-dupe key. */
  idempotencyKey: string;
  /** Entry type — maps to the ingestion endpoint to replay against. */
  type: 'event' | 'candidate';
  /** Redacted, validated payload (ContextEvent or MemoryCandidate). */
  payload: ContextEvent | MemoryCandidate;
  /** When this entry was queued (epoch ms). */
  queuedAt: number;
  /** Number of failed flush attempts so far (incremented per flush cycle). */
  retryCount: number;
  /** Last error message if a flush attempt failed, for diagnostics. */
  lastError?: string;
}

/** Result of submitting a single item to the API. */
export interface SubmitResult {
  id: number;
  created: boolean;
}

/** Per-entry result from a batch flush. */
export interface FlushEntryResult {
  index: number;
  idempotencyKey: string;
  success: boolean;
  error?: string;
}

/** Aggregate result of a flush cycle. */
export interface FlushResult {
  succeeded: number;
  failed: number;
  entries: FlushEntryResult[];
}

// ════════════════════════════════════════════════════════════════════════════
// Capture Queue (local JSONL)
// ════════════════════════════════════════════════════════════════════════════

const QUEUE_FILENAME = '.rorca-capture-queue.jsonl';
const QUEUE_FORMAT_VERSION = 1;

/**
 * Local JSONL queue for the capture sidecar's offline buffer.
 *
 * Each line is a JSON-encoded {@link QueueEntry}. The file is append-only during
 * enqueue and rewritten (atomically) after a flush removes successfully-replayed
 * entries. Failed entries are preserved in-place so the next flush retries them.
 */
export class CaptureQueue {
  readonly filePath: string;

  constructor(dir: string) {
    this.filePath = path.join(dir, QUEUE_FILENAME);
  }

  /** Number of entries currently in the queue. */
  get length(): number {
    return this.readAll().length;
  }

  /** True if the queue file exists and is non-empty. */
  get isEmpty(): boolean {
    try {
      const stat = fs.statSync(this.filePath);
      return stat.size === 0;
    } catch {
      return true;
    }
  }

  /**
   * Append a context event to the queue. The payload is redacted and validated
   * before being written to disk. Returns the idempotency key for reference.
   */
  enqueueEvent(event: ContextEvent): string {
    // Validate against the contract (throws ZodError on invalid shape).
    const parsed = contextEventSchema.parse(event);

    // Redact secrets from the payload before it hits disk.
    const redactedPayload = redactObject(parsed.payload).value as Record<string, unknown>;
    const safeEvent: ContextEvent = { ...parsed, payload: redactedPayload };

    const entry: QueueEntry = {
      version: QUEUE_FORMAT_VERSION,
      idempotencyKey: safeEvent.idempotencyKey,
      type: 'event',
      payload: safeEvent,
      queuedAt: Date.now(),
      retryCount: 0,
    };

    this.append(entry);
    return safeEvent.idempotencyKey;
  }

  /**
   * Append a memory candidate to the queue. The body is redacted before
   * being written to disk. Returns the idempotency key for reference.
   */
  enqueueCandidate(candidate: MemoryCandidate): string {
    // Validate against the contract.
    const parsed = memoryCandidateSchema.parse(candidate);

    const entry: QueueEntry = {
      version: QUEUE_FORMAT_VERSION,
      idempotencyKey: parsed.idempotencyKey,
      type: 'candidate',
      payload: parsed,
      queuedAt: Date.now(),
      retryCount: 0,
    };

    this.append(entry);
    return parsed.idempotencyKey;
  }

  /**
   * Read all entries from the queue file.
   * Invalid lines (parse errors, unknown versions) are silently skipped to keep
   * the queue resilient to partial writes.
   */
  readAll(): QueueEntry[] {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      if (!raw.trim()) return [];
      const entries: QueueEntry[] = [];
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed) as QueueEntry;
          if (entry && typeof entry.version === 'number' && entry.idempotencyKey) {
            entries.push(entry);
          }
        } catch {
          // Corrupt line — skip so the rest of the queue is still usable.
        }
      }
      return entries;
    } catch (err: unknown) {
      // File doesn't exist yet — empty queue.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  /**
   * Remove successfully-flushed entries from the queue, keeping failed entries
   * for the next retry cycle. The rewrite is atomic via a temp-file rename.
   *
   * @param succeededKeys — idempotency keys of entries that were successfully flushed.
   */
  removeSucceeded(succeededKeys: Set<string>): void {
    const all = this.readAll();
    const remaining = all.filter((e) => !succeededKeys.has(e.idempotencyKey));

    if (remaining.length === 0) {
      // All entries flushed — remove the queue file to signal "clean".
      try { fs.unlinkSync(this.filePath); } catch { /* non-fatal */ }
      return;
    }

    // Write remaining entries to a temp file, then atomically rename.
    const tmpPath = this.filePath + '.tmp';
    const lines = remaining.map((e) => JSON.stringify(e) + '\n').join('');
    fs.writeFileSync(tmpPath, lines, 'utf8');
    fs.renameSync(tmpPath, this.filePath);
  }

  /**
   * Mark entries as failed (increment retryCount, store error).
   * The queue file is rewritten with updated retry metadata.
   *
   * @param failedKeys — map of idempotency key to error message.
   */
  markFailed(failedKeys: Map<string, string>): void {
    if (failedKeys.size === 0) return;

    const all = this.readAll();
    let changed = false;
    for (const entry of all) {
      const err = failedKeys.get(entry.idempotencyKey);
      if (err) {
        entry.retryCount += 1;
        entry.lastError = err;
        changed = true;
      }
    }

    if (!changed) return;

    const tmpPath = this.filePath + '.tmp';
    const lines = all.map((e) => JSON.stringify(e) + '\n').join('');
    fs.writeFileSync(tmpPath, lines, 'utf8');
    fs.renameSync(tmpPath, this.filePath);
  }

  /** Clear the queue entirely (for testing). */
  clear(): void {
    try { fs.unlinkSync(this.filePath); } catch { /* non-fatal */ }
  }

  private append(entry: QueueEntry): void {
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(this.filePath, line, 'utf8');
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Capture API Client
// ════════════════════════════════════════════════════════════════════════════

/** Options for constructing a {@link CaptureClient}. */
export interface CaptureClientOptions {
  /** Base URL of the Rorca backend (e.g. `http://localhost:3030`). */
  baseUrl: string;
  /** Optional API key for auth-gated deployments. */
  apiKey?: string;
  /** Optional fetch implementation (for testing with mock fetch). */
  fetch?: typeof fetch;
  /** Request timeout in ms. Default: 10_000. */
  timeoutMs?: number;
}

/**
 * HTTP client for the capture sidecar to talk to Rorca's ingestion API.
 *
 * Usage:
 * ```typescript
 * const client = new CaptureClient({ baseUrl: 'http://localhost:3030' });
 * const ok = await client.health();
 * const result = await client.submitEvent(myEvent);
 * const flush = await client.flushQueue(queue);
 * ```
 */
export class CaptureClient {
  readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: CaptureClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  // ── Health ──────────────────────────────────────────────────────────────

  /**
   * Check if the Rorca backend is reachable and its DB is connected.
   * Returns `true` for a healthy response, `false` otherwise.
   */
  async health(): Promise<boolean> {
    try {
      const res = await this.request('GET', '/api/context-events/health');
      if (!res.ok) return false;
      const body = await res.json() as { status?: string };
      return body?.status === 'ok';
    } catch {
      return false;
    }
  }

  // ── Submit Event ────────────────────────────────────────────────────────

  /**
   * Submit a single context event to the ingestion API.
   * Idempotent: submitting the same idempotency key twice returns the original
   * row (with `created: false`).
   */
  async submitEvent(event: ContextEvent): Promise<SubmitResult> {
    const res = await this.request('POST', '/api/context-events/events', {
      event,
    });
    return this.parseSubmitResult(res);
  }

  // ── Submit Candidate ────────────────────────────────────────────────────

  /**
   * Submit a single memory candidate to the ingestion API.
   * Idempotent: submitting the same idempotency key twice returns the original
   * row (with `created: false`).
   */
  async submitCandidate(candidate: MemoryCandidate): Promise<SubmitResult> {
    const res = await this.request('POST', '/api/context-events/candidates', {
      candidate,
    });
    return this.parseSubmitResult(res);
  }

  // ── Flush Queue ─────────────────────────────────────────────────────────

  /**
   * Flush all entries from a local {@link CaptureQueue} to the ingestion API.
   *
   * The flush is idempotent: each entry carries a unique idempotency key,
   * so replaying the same queue twice produces no duplicates.
   *
   * **Preserves failed entries:** entries that fail during flush remain in the
   * queue file (with incremented `retryCount` and stored error) so they can be
   * retried on the next flush cycle. No entries are silently dropped.
   *
   * @param queue — the local queue to drain.
   * @param maxBatchSize — max entries per HTTP request (default 50).
   * @returns aggregate result with per-entry success/failure.
   */
  async flushQueue(queue: CaptureQueue, maxBatchSize = 50): Promise<FlushResult> {
    const entries = queue.readAll();
    if (entries.length === 0) {
      return { succeeded: 0, failed: 0, entries: [] };
    }

    const result: FlushResult = { succeeded: 0, failed: 0, entries: [] };

    // Process in batches to keep HTTP payloads reasonable.
    for (let offset = 0; offset < entries.length; offset += maxBatchSize) {
      const batch = entries.slice(offset, offset + maxBatchSize);

      const flushEntries = batch.map((e) => ({
        type: e.type,
        payload: e.payload,
      }));

      try {
        const res = await this.request('POST', '/api/context-events/flush', {
          entries: flushEntries,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({})) as { error?: string };
          throw new Error(body?.error ?? `HTTP ${res.status}: ${res.statusText}`);
        }
        const body = (await res.json()) as {
          succeeded: number;
          failed: Array<{ index: number; idempotencyKey: string; error: string }>;
        };

        // Map server-side failures back to the original entries.
        const failedKeys = new Map<string, string>();
        for (const f of body.failed ?? []) {
          failedKeys.set(f.idempotencyKey, f.error);
          result.entries.push({
            index: offset + f.index,
            idempotencyKey: f.idempotencyKey,
            success: false,
            error: f.error,
          });
          result.failed += 1;
        }

        // Success = entries in batch NOT in the failed set.
        const succeededKeys = new Set<string>();
        for (const e of batch) {
          if (!failedKeys.has(e.idempotencyKey)) {
            succeededKeys.add(e.idempotencyKey);
            result.entries.push({
              index: offset + batch.indexOf(e),
              idempotencyKey: e.idempotencyKey,
              success: true,
            });
            result.succeeded += 1;
          }
        }

        // Remove succeeded entries from the queue file; failed ones stay.
        queue.removeSucceeded(succeededKeys);
        queue.markFailed(failedKeys);

      } catch (err: unknown) {
        // Entire batch failed (network error, server 5xx) — mark all entries.
        const message = err instanceof Error ? err.message : 'Network error';
        const failedKeys = new Map<string, string>();
        for (const e of batch) {
          failedKeys.set(e.idempotencyKey, message);
          result.entries.push({
            index: offset + batch.indexOf(e),
            idempotencyKey: e.idempotencyKey,
            success: false,
            error: message,
          });
          result.failed += 1;
        }
        queue.markFailed(failedKeys);
      }
    }

    return result;
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private async request(method: string, urlPath: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await this.fetchImpl(`${this.baseUrl}${urlPath}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  private async parseSubmitResult(res: Response): Promise<SubmitResult> {
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(body?.error ?? `HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json() as Promise<SubmitResult>;
  }
}
