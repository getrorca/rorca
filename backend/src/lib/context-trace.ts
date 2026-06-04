/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * context-trace.ts — Canonical context-trace contract for runs (CTM-001).
 *
 * Two halves of the same contract:
 *
 *  1. ContextTraceEvent — a stable, lightweight metadata event emitted on the
 *     hot path (SSE / WAL). It carries identity (traceId/runId/seq), a phase,
 *     a status, a timestamp, lightweight metrics, and a `rawRef` pointer to the
 *     full raw payload — never the payload itself.
 *
 *  2. ContextTraceArtifactWriter — an append-only, gzip-compressed NDJSON
 *     artifact written off the hot path under `.rorca/`. Each line is one raw
 *     payload record keyed by the same deterministic `rawRef` carried in the
 *     event, so a consumer can lazily recover the full payload without schema
 *     guessing.
 *
 * Design invariants:
 *  - `rawRef` is deterministic and monotonic *within a run*: `r{runId}:{seq}`.
 *    `seq` is a zero-based, gap-free counter scoped to the run. This makes it
 *    unique within a run, safe for SSE de-duplication (last-seq-wins), and
 *    cheap for lazy lookup (scan NDJSON for matching rawRef).
 *  - Artifact writes are append-only — records are never rewritten or deleted
 *    in place. Recovery is therefore a forward scan with no schema migration.
 *  - Every writer operation is nonfatal: a failed startup, append, flush, or
 *    close must never throw into story execution. Failures are logged and the
 *    writer transitions to a disabled state.
 */

import * as fs from 'fs';
import * as path from 'path';
import { gzipSync, gunzipSync } from 'zlib';
import { logger } from './logger';

// ─── Trace Phases & Status ───────────────────────────────────────────────────

/**
 * Phase of the context trace. `context` covers context assembly/injection for a
 * story. The remaining phases reserve room for future skill / MCP / memory
 * trace surfaces without a contract break.
 */
export type ContextTracePhase =
  | 'context'
  | 'skill'
  | 'mcp'
  | 'memory'
  | 'prompt';

export const CONTEXT_TRACE_PHASES: readonly ContextTracePhase[] = [
  'context',
  'skill',
  'mcp',
  'memory',
  'prompt',
] as const;

export type ContextTraceStatus = 'start' | 'ok' | 'partial' | 'error';

// ─── Metrics ─────────────────────────────────────────────────────────────────

/**
 * Lightweight, optional metrics carried inline on the event. Anything heavy
 * (the actual context text, file contents, tool payloads) belongs in the raw
 * artifact referenced by `rawRef`, NOT here.
 */
export interface ContextTraceMetrics {
  tokens?: number;
  bytes?: number;
  fileCount?: number;
  durationMs?: number;
}

// ─── Event Shape ─────────────────────────────────────────────────────────────

/**
 * Stable context-trace metadata event. Emitted on the hot path; the full raw
 * payload is recoverable via `rawRef` from the run's NDJSON artifact.
 */
export interface ContextTraceEvent {
  /** Stable identity of the logical trace stream (per run + phase family). */
  traceId: string;
  /** Numeric run id (matches pipeline_runs.id). */
  runId: number;
  /** Optional story correlation. */
  storyId?: string | null;
  /** Monotonic, gap-free sequence within the run. */
  seq: number;
  /** Deterministic pointer to the raw payload record: `r{runId}:{seq}`. */
  rawRef: string;
  /** Trace phase (context | skill | mcp | memory | prompt). */
  phase: ContextTracePhase;
  /** Lifecycle status for this event. */
  status: ContextTraceStatus;
  /** ISO-8601 emission timestamp. */
  ts: string;
  /** Optional lightweight metrics. */
  metrics?: ContextTraceMetrics;
  /** Short human label (e.g. "L1-L5 synthesis", "skill:excalidraw"). */
  label?: string;
}

/**
 * One raw payload record persisted in the NDJSON artifact. Keyed by the same
 * `rawRef` as the lightweight event so lazy lookup is a direct match.
 */
export interface ContextTraceRawRecord {
  rawRef: string;
  runId: number;
  seq: number;
  phase: ContextTracePhase;
  ts: string;
  /** Arbitrary raw payload — the heavy context that is kept off the hot path. */
  payload: unknown;
}

// ─── WAL transport (CTM-002) ─────────────────────────────────────────────────

/**
 * WAL / SSE event type carrying a context-trace metadata event. The browser
 * filters on this type, parses the embedded {@link ContextTraceEvent} from the
 * WAL `payload`, and resolves the raw payload lazily via `rawRef`.
 */
export const CONTEXT_TRACE_WAL_EVENT_TYPE = 'context_trace';

/**
 * Shape of the WAL `payload` for a `context_trace` event. It carries the full
 * lightweight {@link ContextTraceEvent} plus `run_id` for the run-scoped SSE
 * filtering convention used by other engine WAL events (snake_case `run_id`).
 *
 * It deliberately never carries the raw payload — only the `rawRef` pointer.
 */
export interface ContextTraceWalPayload extends ContextTraceEvent {
  run_id: number;
}

/**
 * Build the metadata-only WAL payload for a context-trace event. Pure mapping —
 * guarantees the heavy payload is never embedded on the hot path.
 */
export function toContextTraceWalPayload(event: ContextTraceEvent): ContextTraceWalPayload {
  return {
    traceId: event.traceId,
    runId: event.runId,
    storyId: event.storyId ?? null,
    seq: event.seq,
    rawRef: event.rawRef,
    phase: event.phase,
    status: event.status,
    ts: event.ts,
    metrics: event.metrics,
    label: event.label,
    run_id: event.runId,
  };
}

// ─── Deterministic rawRef scheme ─────────────────────────────────────────────

const RAW_REF_PATTERN = /^r(\d+):(\d+)$/;

/**
 * Build the deterministic rawRef for a run + sequence.
 * Scheme: `r{runId}:{seq}` — unique within a run, monotonic with seq.
 */
export function makeRawRef(runId: number, seq: number): string {
  // Coerce pg-bigint strings that arrive as `string` at runtime despite the
  // declared `number` type — the pg driver returns BIGINT columns as strings.
  const rid = typeof runId === 'string' ? Number(runId) : runId;
  const s = typeof seq === 'string' ? Number(seq) : seq;
  if (!Number.isInteger(rid) || rid < 0) {
    throw new RangeError(`makeRawRef: runId must be a non-negative integer, got ${runId}`);
  }
  if (!Number.isInteger(s) || s < 0) {
    throw new RangeError(`makeRawRef: seq must be a non-negative integer, got ${seq}`);
  }
  return `r${rid}:${s}`;
}

/** Parse a rawRef back into its components, or null if malformed. */
export function parseRawRef(rawRef: string): { runId: number; seq: number } | null {
  const match = RAW_REF_PATTERN.exec(rawRef);
  if (!match) return null;
  return { runId: Number(match[1]), seq: Number(match[2]) };
}

// ─── Paths ───────────────────────────────────────────────────────────────────

const RORCA_DIR = '.rorca';
const TRACE_DIR = 'traces';
const ARTIFACT_EXT = '.ndjson.gz';

/** Directory holding per-run context-trace artifacts. */
export function getTraceDir(cwd: string): string {
  return path.join(cwd, RORCA_DIR, TRACE_DIR);
}

/** Deterministic artifact path for a run's context-trace NDJSON. */
export function getTraceArtifactPath(cwd: string, runId: number): string {
  return path.join(getTraceDir(cwd), `${runId}${ARTIFACT_EXT}`);
}

// ─── Artifact Reader (lazy recovery) ─────────────────────────────────────────

/**
 * Read and decompress all raw records for a run. gzip members written
 * back-to-back by the writer decompress as a single concatenated stream, so the
 * artifact is recoverable without schema guessing. Nonfatal: a missing or
 * corrupt artifact yields an empty list rather than throwing.
 */
export function readTraceRecords(cwd: string, runId: number): ContextTraceRawRecord[] {
  const file = getTraceArtifactPath(cwd, runId);
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return [];
  }

  if (buf.length === 0) return [];

  let text: string;
  try {
    text = gunzipSync(buf).toString('utf8');
  } catch (err) {
    logger.warn({ err, runId }, '[context-trace] artifact decompress failed');
    return [];
  }

  const records: ContextTraceRawRecord[] = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      records.push(JSON.parse(line) as ContextTraceRawRecord);
    } catch {
      // Skip a single malformed line; recovery is best-effort and append-only.
    }
  }
  return records;
}

/**
 * Lazily resolve a single raw payload by its deterministic rawRef. Returns null
 * when the ref is malformed, points at a different run, or is not present.
 */
export function lookupTraceRecord(cwd: string, rawRef: string): ContextTraceRawRecord | null {
  const parsed = parseRawRef(rawRef);
  if (!parsed) return null;
  const records = readTraceRecords(cwd, parsed.runId);
  return records.find((r) => r.rawRef === rawRef) ?? null;
}

// ─── Artifact Writer ─────────────────────────────────────────────────────────

export interface ContextTraceWriterOptions {
  cwd: string;
  runId: number;
}

/**
 * Append-only, gzip-compressed NDJSON artifact writer for a single run.
 *
 * Each `append()` allocates the next deterministic `seq`/`rawRef`, writes one
 * gzip-compressed NDJSON member to disk, and returns the rawRef so the caller
 * can stamp it onto the lightweight ContextTraceEvent. Duplicate or
 * out-of-band rawRefs are rejected (deterministic, monotonic guarantee).
 *
 * Every method is nonfatal: filesystem or serialization failures disable the
 * writer and are logged, but never throw into story execution.
 */
export class ContextTraceArtifactWriter {
  readonly runId: number;
  readonly artifactPath: string;

  private seq = 0;
  private readonly seenRefs = new Set<string>();
  private fd: number | null = null;
  private disabled = false;
  private closed = false;

  constructor(opts: ContextTraceWriterOptions) {
    this.runId = opts.runId;
    this.artifactPath = getTraceArtifactPath(opts.cwd, opts.runId);
    this.start();
  }

  /** Whether this writer is live (started and not disabled/closed). */
  get isActive(): boolean {
    return !this.disabled && !this.closed && this.fd !== null;
  }

  /** Next sequence that would be allocated (also the count of appends so far). */
  get nextSeq(): number {
    return this.seq;
  }

  /**
   * Open the append-only file descriptor. Nonfatal: a failure disables the
   * writer. Synchronous append (O_APPEND) keeps each record durable and
   * immediately readable, with no async write buffer that could be lost.
   */
  private start(): void {
    try {
      const dir = path.dirname(this.artifactPath);
      fs.mkdirSync(dir, { recursive: true });
      // 'a' (O_APPEND) keeps the artifact append-only across writer restarts.
      this.fd = fs.openSync(this.artifactPath, 'a');
    } catch (err) {
      logger.warn({ err, runId: this.runId }, '[context-trace] writer startup failed');
      this.disabled = true;
      this.fd = null;
    }
  }

  /**
   * Append a raw payload, returning the deterministic rawRef assigned to it,
   * or null if the writer is inactive or the append failed (nonfatal).
   *
   * @param phase   trace phase for this record
   * @param payload arbitrary raw payload (kept off the hot path)
   * @param meta    optional storyId / timestamp override
   */
  append(
    phase: ContextTracePhase,
    payload: unknown,
    meta?: { ts?: string },
  ): string | null {
    if (!this.isActive || this.fd === null) {
      return null;
    }

    const seq = this.seq;
    const rawRef = makeRawRef(this.runId, seq);

    // Deterministic monotonic guarantee: never emit the same rawRef twice.
    if (this.seenRefs.has(rawRef)) {
      logger.warn({ runId: this.runId, rawRef }, '[context-trace] duplicate sequence rejected');
      return null;
    }

    const record: ContextTraceRawRecord = {
      rawRef,
      runId: this.runId,
      seq,
      phase,
      ts: meta?.ts ?? new Date().toISOString(),
      payload,
    };

    let line: string;
    try {
      line = JSON.stringify(record) + '\n';
    } catch (err) {
      // Malformed / circular payload — record a safe placeholder instead so the
      // sequence stays gap-free and the failure is non-fatal.
      logger.warn({ err, runId: this.runId, rawRef }, '[context-trace] payload serialization failed');
      try {
        line = JSON.stringify({
          ...record,
          payload: { __traceError: 'unserializable_payload' },
        }) + '\n';
      } catch {
        this.disabled = true;
        return null;
      }
    }

    try {
      const compressed = gzipSync(Buffer.from(line, 'utf8'), { level: 6 });
      fs.writeSync(this.fd, compressed);
    } catch (err) {
      logger.warn({ err, runId: this.runId, rawRef }, '[context-trace] append write failed');
      this.disabled = true;
      return null;
    }

    this.seenRefs.add(rawRef);
    this.seq += 1;
    return rawRef;
  }

  /**
   * Build a lightweight ContextTraceEvent for a freshly appended record.
   * Returns null when the append failed (nonfatal), so callers can skip the
   * SSE emit cleanly.
   */
  appendEvent(
    phase: ContextTracePhase,
    payload: unknown,
    opts?: {
      status?: ContextTraceStatus;
      storyId?: string | null;
      metrics?: ContextTraceMetrics;
      label?: string;
      ts?: string;
    },
  ): ContextTraceEvent | null {
    const ts = opts?.ts ?? new Date().toISOString();
    const seqAtAppend = this.seq;
    const rawRef = this.append(phase, payload, { ts });
    if (!rawRef) return null;

    return {
      traceId: `trace:${this.runId}:${phase}`,
      runId: this.runId,
      storyId: opts?.storyId ?? null,
      seq: seqAtAppend,
      rawRef,
      phase,
      status: opts?.status ?? 'ok',
      ts,
      metrics: opts?.metrics,
      label: opts?.label,
    };
  }

  /** Force durable persistence of appended records to disk. Nonfatal. */
  flush(): void {
    if (!this.isActive || this.fd === null) return;
    try {
      fs.fsyncSync(this.fd);
    } catch (err) {
      // fsync can fail on some filesystems; records are already in the page
      // cache and readable. Non-fatal.
      logger.warn({ err, runId: this.runId }, '[context-trace] flush fsync failed');
    }
  }

  /**
   * Idempotent close. Safe to call multiple times; subsequent calls are no-ops.
   * Nonfatal — a close failure is logged but never thrown.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    const fd = this.fd;
    this.fd = null;
    if (fd === null) return;

    try {
      fs.closeSync(fd);
    } catch (err) {
      logger.warn({ err, runId: this.runId }, '[context-trace] close failed');
    }
  }
}

/**
 * Create a writer for a run. Never throws — on failure returns an inactive
 * writer whose `append`/`appendEvent` simply return null.
 */
export function createContextTraceWriter(cwd: string, runId: number): ContextTraceArtifactWriter {
  return new ContextTraceArtifactWriter({ cwd, runId });
}

// ─── Retention / Cleanup Extension Point ─────────────────────────────────────

const DEFAULT_TRACE_RETENTION_DAYS = 14;

/** Resolve trace artifact retention window (days). */
export function getTraceRetentionDays(): number {
  const raw = parseInt(process.env.RORCA_TRACE_RETENTION_DAYS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TRACE_RETENTION_DAYS;
}

/**
 * Extension point for bounding local disk usage of trace artifacts.
 *
 * Deletes `*.ndjson.gz` artifacts older than `retentionDays`. Nonfatal: any
 * per-file or directory error is logged and skipped so cleanup can never crash
 * a run or a scheduled prune. Returns the number of artifacts removed.
 */
export function pruneExpiredTraceArtifacts(
  cwd: string,
  retentionDays = getTraceRetentionDays(),
): number {
  const dir = getTraceDir(cwd);
  let removed = 0;

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    // No trace dir yet (or unreadable) — nothing to prune.
    return 0;
  }

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  for (const entry of entries) {
    if (!entry.endsWith(ARTIFACT_EXT)) continue;
    const full = path.join(dir, entry);
    try {
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(full);
        removed += 1;
      }
    } catch (err) {
      logger.warn({ err, file: full }, '[context-trace] retention prune skipped a file');
    }
  }

  return removed;
}
