/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { gzipSync } from 'zlib';
import { logger as defaultLogger } from './logger';
import {
  CONTEXT_TRACE_ARTIFACT_RECORD_TYPE,
  CONTEXT_TRACE_ARTIFACT_SCHEMA,
  type ContextTraceArtifactRecord,
  type ContextTraceEvent,
  type ContextTraceRawRef,
  type JsonValue,
  parseContextTraceRawRef,
} from '../types/trace';

const DEFAULT_CONTEXT_TRACE_RETENTION_DAYS = 14;
const CONTEXT_TRACE_ARTIFACT_SUFFIX = '.context-trace.ndjson.gz';

export interface TraceArtifactLogger {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
  error(payload: Record<string, unknown>, message: string): void;
}

export interface TraceArtifactFileHandle {
  write(
    buffer: Buffer,
    offset?: number,
    length?: number,
    position?: number | null,
  ): Promise<{ bytesWritten: number; buffer: Buffer }>;
  datasync(): Promise<void>;
  close(): Promise<void>;
}

interface TraceArtifactWriterDeps {
  mkdir?: typeof fs.mkdir;
  openFile?: (path: string, flags: string) => Promise<TraceArtifactFileHandle>;
  gzip?: typeof gzipSync;
}

export interface TraceArtifactWriterOptions extends TraceArtifactWriterDeps {
  workspacePath: string;
  runId: number;
  logger?: TraceArtifactLogger;
}

export interface TraceArtifactWriterState {
  artifactPath: string;
  started: boolean;
  closed: boolean;
  degraded: boolean;
  lastSeq: number;
}

export function buildContextTraceArtifactPath(workspacePath: string, runId: number): string {
  return path.join(workspacePath, 'forge', 'traces', `run-${runId}${CONTEXT_TRACE_ARTIFACT_SUFFIX}`);
}

export function getContextTraceRetentionDays(): number {
  const raw = Number.parseInt(process.env.RORCA_CONTEXT_TRACE_RETENTION_DAYS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CONTEXT_TRACE_RETENTION_DAYS;
}

export async function pruneExpiredContextTraceArtifacts(
  workspacePath: string,
  retentionDays = getContextTraceRetentionDays(),
  log: TraceArtifactLogger = defaultLogger,
  now = new Date(),
): Promise<number> {
  const traceDir = path.join(workspacePath, 'forge', 'traces');
  const cutoffMs = now.getTime() - (retentionDays * 24 * 60 * 60 * 1000);

  try {
    const entries = await fs.readdir(traceDir, { withFileTypes: true });
    let deleted = 0;

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(CONTEXT_TRACE_ARTIFACT_SUFFIX)) continue;
      const artifactPath = path.join(traceDir, entry.name);
      const stats = await fs.stat(artifactPath);
      if (stats.mtimeMs >= cutoffMs) continue;
      await fs.unlink(artifactPath);
      deleted += 1;
    }

    if (deleted > 0) {
      log.info({ deleted, retentionDays, workspacePath }, '[trace-artifact-writer] pruned expired context trace artifacts');
    }

    return deleted;
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? String(err.code) : '';
    if (code === 'ENOENT') return 0;
    log.warn({ err, retentionDays, workspacePath }, '[trace-artifact-writer] retention prune failed');
    return 0;
  }
}

export class TraceArtifactWriter {
  private readonly artifactPath: string;
  private readonly log: TraceArtifactLogger;
  private readonly mkdirImpl: typeof fs.mkdir;
  private readonly openFileImpl: (path: string, flags: string) => Promise<TraceArtifactFileHandle>;
  private readonly gzipImpl: typeof gzipSync;
  private readonly seenRawRefs = new Set<ContextTraceRawRef>();
  private readonly seenSeq = new Set<number>();

  private handle: TraceArtifactFileHandle | null = null;
  private pending: Promise<void> = Promise.resolve();
  private started = false;
  private closed = false;
  private degraded = false;
  private lastSeq = 0;

  constructor(private readonly options: TraceArtifactWriterOptions) {
    this.artifactPath = buildContextTraceArtifactPath(options.workspacePath, options.runId);
    this.log = options.logger ?? defaultLogger;
    this.mkdirImpl = options.mkdir ?? fs.mkdir;
    this.openFileImpl = options.openFile ?? ((filePath, flags) => fs.open(filePath, flags));
    this.gzipImpl = options.gzip ?? gzipSync;
  }

  getState(): TraceArtifactWriterState {
    return {
      artifactPath: this.artifactPath,
      started: this.started,
      closed: this.closed,
      degraded: this.degraded,
      lastSeq: this.lastSeq,
    };
  }

  async start(): Promise<boolean> {
    return this.enqueue(() => this.startInternal());
  }

  async append(event: ContextTraceEvent, payload: unknown): Promise<boolean> {
    return this.enqueue(() => this.appendInternal(event, payload));
  }

  async flush(): Promise<boolean> {
    return this.enqueue(() => this.flushInternal());
  }

  async close(): Promise<boolean> {
    return this.enqueue(() => this.closeInternal());
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.pending.then(task, task);
    this.pending = next.then(() => undefined, () => undefined);
    return next;
  }

  private async startInternal(): Promise<boolean> {
    if (this.closed) {
      this.log.warn({ artifactPath: this.artifactPath }, '[trace-artifact-writer] start ignored after close');
      return false;
    }

    if (this.degraded) return false;
    if (this.handle) return true;

    try {
      await this.mkdirImpl(path.dirname(this.artifactPath), { recursive: true });
      this.handle = await this.openFileImpl(this.artifactPath, 'a');
      this.started = true;
      this.log.info({ artifactPath: this.artifactPath, runId: this.options.runId }, '[trace-artifact-writer] writer started');
      return true;
    } catch (err) {
      await this.degrade('startup failed', { err });
      return false;
    }
  }

  private async appendInternal(event: ContextTraceEvent, payload: unknown): Promise<boolean> {
    if (this.closed) {
      this.log.warn({ rawRef: event.rawRef, artifactPath: this.artifactPath }, '[trace-artifact-writer] append ignored after close');
      return false;
    }

    if (!this.validateEvent(event)) return false;

    const normalizedPayload = normalizeJsonPayload(payload);
    if (!normalizedPayload) {
      this.log.warn({ rawRef: event.rawRef, phase: event.phase }, '[trace-artifact-writer] malformed payload skipped');
      return false;
    }

    const started = await this.startInternal();
    if (!started || !this.handle) return false;

    const record = buildArtifactRecord(event, normalizedPayload.value, normalizedPayload.bytes);
    const line = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
    const compressed = this.gzipImpl(line);

    try {
      const result = await this.handle.write(compressed, 0, compressed.length, null);
      if (result.bytesWritten !== compressed.length) {
        await this.degrade('partial write detected', {
          rawRef: event.rawRef,
          expectedBytes: compressed.length,
          actualBytes: result.bytesWritten,
        });
        return false;
      }

      this.seenSeq.add(event.seq);
      this.seenRawRefs.add(event.rawRef);
      this.lastSeq = event.seq;
      return true;
    } catch (err) {
      await this.degrade('append failed', { err, rawRef: event.rawRef });
      return false;
    }
  }

  private async flushInternal(): Promise<boolean> {
    if (this.closed && !this.handle) return true;
    if (this.degraded || !this.handle) return !this.degraded;

    try {
      await this.handle.datasync();
      return true;
    } catch (err) {
      await this.degrade('flush failed', { err });
      return false;
    }
  }

  private async closeInternal(): Promise<boolean> {
    if (this.closed) return true;

    const flushOk = await this.flushInternal();
    const handle = this.handle;
    this.handle = null;
    this.closed = true;

    if (!handle) return true;

    try {
      await handle.close();
      this.log.info({ artifactPath: this.artifactPath, runId: this.options.runId }, '[trace-artifact-writer] writer closed');
      return flushOk;
    } catch (err) {
      this.log.warn({ err, artifactPath: this.artifactPath }, '[trace-artifact-writer] close failed after degradation');
      return false;
    }
  }

  private validateEvent(event: ContextTraceEvent): boolean {
    const parsed = parseContextTraceRawRef(event.rawRef);
    if (!parsed) {
      this.log.warn({ rawRef: event.rawRef }, '[trace-artifact-writer] invalid rawRef contract');
      return false;
    }

    if (event.runId !== this.options.runId || parsed.runId !== this.options.runId) {
      this.log.warn({ eventRunId: event.runId, writerRunId: this.options.runId, rawRef: event.rawRef }, '[trace-artifact-writer] runId mismatch');
      return false;
    }

    if (parsed.seq !== event.seq) {
      this.log.warn({ rawRef: event.rawRef, eventSeq: event.seq, rawRefSeq: parsed.seq }, '[trace-artifact-writer] rawRef seq mismatch');
      return false;
    }

    if (this.seenSeq.has(event.seq) || this.seenRawRefs.has(event.rawRef)) {
      this.log.warn({ rawRef: event.rawRef, seq: event.seq }, '[trace-artifact-writer] duplicate sequence skipped');
      return false;
    }

    if (event.seq <= this.lastSeq) {
      this.log.warn({ rawRef: event.rawRef, seq: event.seq, lastSeq: this.lastSeq }, '[trace-artifact-writer] non-monotonic sequence skipped');
      return false;
    }

    return true;
  }

  private async degrade(reason: string, payload: Record<string, unknown>): Promise<void> {
    this.degraded = true;
    this.log.error({ artifactPath: this.artifactPath, runId: this.options.runId, ...payload }, `[trace-artifact-writer] ${reason}`);
    const handle = this.handle;
    this.handle = null;
    if (!handle) return;

    try {
      await handle.close();
    } catch (closeErr) {
      this.log.warn({ closeErr, artifactPath: this.artifactPath }, '[trace-artifact-writer] close during degradation failed');
    }
  }
}

function buildArtifactRecord(
  event: ContextTraceEvent,
  payload: JsonValue,
  payloadBytes: number,
): ContextTraceArtifactRecord {
  return {
    schema: CONTEXT_TRACE_ARTIFACT_SCHEMA,
    recordType: CONTEXT_TRACE_ARTIFACT_RECORD_TYPE,
    rawRef: event.rawRef,
    runId: event.runId,
    seq: event.seq,
    traceId: event.traceId,
    phase: event.phase,
    status: event.status,
    ts: event.ts,
    storyId: event.storyId,
    payloadFormat: 'json',
    payloadEncoding: 'identity',
    payloadBytes,
    event,
    payload,
  };
}

function normalizeJsonPayload(payload: unknown): { value: JsonValue; bytes: number } | null {
  if (payload === undefined) return null;

  try {
    const json = JSON.stringify(payload);
    if (json === undefined) return null;
    return {
      value: JSON.parse(json) as JsonValue,
      bytes: Buffer.byteLength(json, 'utf8'),
    };
  } catch {
    return null;
  }
}
