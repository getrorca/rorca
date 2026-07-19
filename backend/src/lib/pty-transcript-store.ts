/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { randomUUID } from 'crypto';
import { StringDecoder } from 'string_decoder';
import { query, transaction } from '../db/index';
import {
  MAX_TRANSCRIPT_PAYLOAD_BYTES,
  hashContent,
  sanitizeTranscriptPayload,
} from './context-safety';
import {
  ConflictError,
  TranscriptPersistenceError,
  ValidationError,
} from './errors';
import { logger } from './logger';
import { broadcastTopic } from './sse-hub';
import type { PtyGenerationRef } from './run-pty-store';

export const PTY_TRANSCRIPT_CONTRACT_VERSION = 1 as const;
export const DEFAULT_TRANSCRIPT_PAGE_LIMIT = 50;
export const MAX_TRANSCRIPT_PAGE_LIMIT = 100;

export type PtyTranscriptEventType =
  | 'model_message'
  | 'tool_call'
  | 'tool_result'
  | 'host_notice'
  | 'error'
  | 'gap';
export type PtyTranscriptEventSource = 'structured' | 'terminal_normalized' | 'host' | 'recovery';
export type PtyTranscriptRole = 'assistant' | 'system' | 'tool' | 'host';

export interface AppendPtyTranscriptEventInput {
  eventId?: string;
  eventType: PtyTranscriptEventType;
  eventSource: PtyTranscriptEventSource;
  role?: PtyTranscriptRole | null;
  correlationId?: string | null;
  payload: unknown;
  presentation?: boolean;
  authoritative?: boolean;
}

interface StoredTranscriptEventRow {
  event_id: string;
  contract_version: number;
  generation_id: string;
  run_id: number | string;
  workspace_id: string;
  story_id: string;
  seq: number | string;
  event_type: PtyTranscriptEventType;
  event_source: PtyTranscriptEventSource;
  role: PtyTranscriptRole | null;
  correlation_id: string | null;
  payload: unknown;
  payload_bytes: number;
  payload_sha256: string;
  redacted: boolean;
  truncated: boolean;
  presentation: boolean;
  authoritative: boolean;
  created_at: string;
}

export interface PtyTranscriptEvent {
  eventId: string;
  contractVersion: number;
  generationId: string;
  runId: number;
  workspaceId: string;
  storyId: string;
  seq: number;
  eventType: PtyTranscriptEventType;
  eventSource: PtyTranscriptEventSource;
  role: PtyTranscriptRole | null;
  correlationId: string | null;
  payload: unknown;
  payloadBytes: number;
  payloadSha256: string;
  redacted: boolean;
  truncated: boolean;
  presentation: boolean;
  authoritative: boolean;
  createdAt: string;
}

export interface TranscriptGap {
  afterSeq: number;
  beforeSeq: number;
  missingCount: number;
  reason: 'sequence_gap';
}

export interface PtyTranscriptPage {
  contractVersion: number;
  generationId: string;
  items: PtyTranscriptEvent[];
  nextCursor: string | null;
  hasMore: boolean;
  gaps: TranscriptGap[];
}

interface TranscriptCursorPayload {
  v: 1;
  generationId: string;
  seq: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function toTranscriptEvent(row: StoredTranscriptEventRow): PtyTranscriptEvent {
  return {
    eventId: row.event_id,
    contractVersion: Number(row.contract_version),
    generationId: row.generation_id,
    runId: Number(row.run_id),
    workspaceId: row.workspace_id,
    storyId: row.story_id,
    seq: Number(row.seq),
    eventType: row.event_type,
    eventSource: row.event_source,
    role: row.role,
    correlationId: row.correlation_id,
    payload: row.payload,
    payloadBytes: Number(row.payload_bytes),
    payloadSha256: row.payload_sha256,
    redacted: row.redacted,
    truncated: row.truncated,
    presentation: row.presentation,
    authoritative: row.authoritative,
    createdAt: row.created_at,
  };
}

export function ptyTranscriptTopic(runId: number, generationId: string): string {
  return `pty-transcript:${runId}:${generationId}`;
}

export function encodeTranscriptCursor(generationId: string, seq: number): string {
  if (!UUID_PATTERN.test(generationId) || !Number.isSafeInteger(seq) || seq < 0) {
    throw new ValidationError('Invalid PTY transcript cursor identity');
  }
  const payload: TranscriptCursorPayload = { v: 1, generationId, seq };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeTranscriptCursor(cursor: string, expectedGenerationId: string): number {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<TranscriptCursorPayload>;
    if (
      decoded.v !== 1
      || decoded.generationId !== expectedGenerationId
      || !Number.isSafeInteger(decoded.seq)
      || Number(decoded.seq) < 0
    ) {
      throw new Error('cursor identity mismatch');
    }
    return Number(decoded.seq);
  } catch {
    throw new ValidationError('Invalid or stale PTY transcript cursor');
  }
}

function validateTranscriptInput(input: AppendPtyTranscriptEventInput): void {
  if ((input.eventType === 'tool_call' || input.eventType === 'tool_result') && !input.correlationId) {
    throw new ValidationError('Tool transcript events require correlationId');
  }
  if (input.eventId && !UUID_PATTERN.test(input.eventId)) {
    throw new ValidationError('Transcript eventId must be a UUID');
  }
  if (input.correlationId && input.correlationId.length > 512) {
    throw new ValidationError('Transcript correlationId exceeds 512 characters');
  }
}

/**
 * Append one normalized event under a generation lock. Retries keep the same
 * event id and return the existing row, so partial client retries never reorder
 * valid earlier events or duplicate tool/result correlation.
 */
export async function appendPtyTranscriptEvent(
  generation: PtyGenerationRef,
  input: AppendPtyTranscriptEventInput,
): Promise<PtyTranscriptEvent> {
  validateTranscriptInput(input);
  const eventId = input.eventId ?? randomUUID();
  const sanitized = sanitizeTranscriptPayload(input.payload, MAX_TRANSCRIPT_PAYLOAD_BYTES);
  const presentation = input.eventSource === 'terminal_normalized' ? true : Boolean(input.presentation);
  const authoritative = presentation ? false : Boolean(input.authoritative);

  try {
    const event = await transaction(async (client) => {
      const existing = await client.query<StoredTranscriptEventRow>(
        `SELECT * FROM pty_transcript_events WHERE event_id = $1`,
        [eventId],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].generation_id !== generation.generationId) {
          throw new ConflictError('Transcript event identity belongs to another generation');
        }
        return toTranscriptEvent(existing.rows[0]);
      }

      const identity = await client.query<{ workspace_id: string; story_id: string }>(
        `SELECT workspace_id, story_id FROM pty_generations
         WHERE id = $1 AND run_id = $2 AND generation_token = $3`,
        [generation.generationId, generation.runId, generation.generationToken],
      );
      const generationRow = identity.rows[0];
      if (!generationRow) throw new ConflictError('PTY generation identity is stale or mismatched');

      await client.query(
        `INSERT INTO pty_transcript_heads (generation_id) VALUES ($1)
         ON CONFLICT (generation_id) DO NOTHING`,
        [generation.generationId],
      );
      const head = await client.query<{ next_seq: number | string }>(
        `SELECT next_seq FROM pty_transcript_heads WHERE generation_id = $1 FOR UPDATE`,
        [generation.generationId],
      );
      const seq = Number(head.rows[0]?.next_seq);
      if (!Number.isSafeInteger(seq) || seq < 1) {
        throw new TranscriptPersistenceError('Invalid PTY transcript sequence head', {
          generationId: generation.generationId,
        });
      }

      const inserted = await client.query<StoredTranscriptEventRow>(
        `INSERT INTO pty_transcript_events
          (event_id, contract_version, generation_id, run_id, workspace_id, story_id,
           seq, event_type, event_source, role, correlation_id, payload, payload_bytes,
           payload_sha256, redacted, truncated, presentation, authoritative)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb,
                 $13, $14, $15, $16, $17, $18)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING *`,
        [eventId, PTY_TRANSCRIPT_CONTRACT_VERSION, generation.generationId, generation.runId,
          generationRow.workspace_id, generationRow.story_id, seq, input.eventType,
          input.eventSource, input.role ?? null, input.correlationId ?? null,
          sanitized.serialized, sanitized.bytes, hashContent(sanitized.serialized),
          sanitized.redacted, sanitized.truncated, presentation, authoritative],
      );
      if (!inserted.rows[0]) {
        const raced = await client.query<StoredTranscriptEventRow>(
          `SELECT * FROM pty_transcript_events WHERE event_id = $1`,
          [eventId],
        );
        if (!raced.rows[0] || raced.rows[0].generation_id !== generation.generationId) {
          throw new ConflictError('Transcript event identity collision');
        }
        return toTranscriptEvent(raced.rows[0]);
      }

      await client.query(
        `UPDATE pty_transcript_heads SET next_seq = $2, updated_at = NOW()
         WHERE generation_id = $1`,
        [generation.generationId, seq + 1],
      );
      return toTranscriptEvent(inserted.rows[0]);
    });

    broadcastTopic(ptyTranscriptTopic(generation.runId, generation.generationId), {
      cursor: encodeTranscriptCursor(generation.generationId, event.seq),
      event,
      rehydrateRequired: true,
    });
    return event;
  } catch (error) {
    if (error instanceof ConflictError || error instanceof ValidationError || error instanceof TranscriptPersistenceError) {
      throw error;
    }
    logger.error({ error, runId: generation.runId, generationId: generation.generationId, eventId }, '[pty-transcript] append failed');
    throw new TranscriptPersistenceError(undefined, {
      runId: generation.runId,
      generationId: generation.generationId,
      eventId,
    });
  }
}

export async function listPtyTranscriptEvents(input: {
  runId: number;
  generationId: string;
  cursor?: string | null;
  limit?: number;
}): Promise<PtyTranscriptPage> {
  if (!Number.isSafeInteger(input.runId) || input.runId < 1 || !UUID_PATTERN.test(input.generationId)) {
    throw new ValidationError('Invalid run or generation identity');
  }
  const limit = Math.min(
    MAX_TRANSCRIPT_PAGE_LIMIT,
    Math.max(1, Math.floor(input.limit ?? DEFAULT_TRANSCRIPT_PAGE_LIMIT)),
  );
  const afterSeq = input.cursor ? decodeTranscriptCursor(input.cursor, input.generationId) : 0;
  const rows = await query<StoredTranscriptEventRow>(
    `SELECT * FROM pty_transcript_events
     WHERE run_id = $1 AND generation_id = $2 AND seq > $3
     ORDER BY seq ASC LIMIT $4`,
    [input.runId, input.generationId, afterSeq, limit + 1],
  );
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(toTranscriptEvent);
  const gaps: TranscriptGap[] = [];
  let priorSeq = afterSeq;
  for (const event of items) {
    if (event.seq > priorSeq + 1) {
      gaps.push({
        afterSeq: priorSeq,
        beforeSeq: event.seq,
        missingCount: event.seq - priorSeq - 1,
        reason: 'sequence_gap',
      });
    }
    priorSeq = event.seq;
  }
  const last = items.at(-1);
  return {
    contractVersion: PTY_TRANSCRIPT_CONTRACT_VERSION,
    generationId: input.generationId,
    items,
    nextCursor: last ? encodeTranscriptCursor(input.generationId, last.seq) : null,
    hasMore,
    gaps,
  };
}

/** Remove terminal repaint/control bytes and emit bounded readable lines only. */
export class PtyTranscriptNormalizer {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';

  accept(bytes: Buffer): string[] {
    return this.acceptText(this.decoder.write(bytes));
  }

  finish(): string[] {
    const lines = this.acceptText(this.decoder.end());
    const trailing = this.normalizeLine(this.pending);
    this.pending = '';
    if (trailing) lines.push(trailing);
    return lines;
  }

  private acceptText(text: string): string[] {
    // OSC and CSI sequences include terminal titles, colors, cursor movement,
    // and screen clears. They belong only in the exact raw archive.
    const plain = text
      .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
      .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\x1B[@-_]/g, '');
    this.pending += plain;
    const output: string[] = [];
    let newline = this.pending.indexOf('\n');
    while (newline >= 0) {
      const line = this.normalizeLine(this.pending.slice(0, newline));
      this.pending = this.pending.slice(newline + 1);
      if (line) output.push(line);
      newline = this.pending.indexOf('\n');
    }
    // A hostile/no-newline process cannot create an unbounded normalizer state.
    while (Buffer.byteLength(this.pending, 'utf8') > MAX_TRANSCRIPT_PAYLOAD_BYTES) {
      const prefix = this.pending.slice(0, 8_000);
      this.pending = this.pending.slice(prefix.length);
      const normalized = this.normalizeLine(prefix);
      if (normalized) output.push(normalized);
    }
    return output;
  }

  private normalizeLine(line: string): string {
    const repaint = line.replace(/\r$/, '').split('\r').filter(Boolean).at(-1) ?? '';
    return repaint.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trimEnd();
  }
}

export type PtyTranscriptAppender = (
  generation: PtyGenerationRef,
  input: AppendPtyTranscriptEventInput,
) => Promise<PtyTranscriptEvent>;

/** Serialized retrying recorder used by the push-only node-pty callback. */
export class PtyTranscriptRecorder {
  private readonly normalizer = new PtyTranscriptNormalizer();
  private pending: Promise<void> = Promise.resolve();
  private terminalFailure: TranscriptPersistenceError | null = null;

  constructor(
    private readonly generation: PtyGenerationRef,
    private readonly appender: PtyTranscriptAppender = appendPtyTranscriptEvent,
  ) {}

  recordModelBytes(bytes: Buffer): void {
    for (const text of this.normalizer.accept(bytes)) {
      this.enqueue({
        eventType: 'model_message',
        eventSource: 'terminal_normalized',
        role: 'assistant',
        payload: { text },
        presentation: true,
        authoritative: false,
      });
    }
  }

  recordHostNotice(code: string, message: string, details: unknown = null): void {
    this.enqueue({ eventType: 'host_notice', eventSource: 'host', role: 'host', payload: { code, message, details } });
  }

  recordError(code: string, message: string, details: unknown = null): void {
    this.enqueue({ eventType: 'error', eventSource: 'host', role: 'host', payload: { code, message, details } });
  }

  recordStructured(input: AppendPtyTranscriptEventInput): void {
    this.enqueue(input);
  }

  async drain(): Promise<void> {
    for (const text of this.normalizer.finish()) {
      this.enqueue({
        eventType: 'model_message',
        eventSource: 'terminal_normalized',
        role: 'assistant',
        payload: { text },
        presentation: true,
        authoritative: false,
      });
    }
    await this.pending;
    if (this.terminalFailure) throw this.terminalFailure;
  }

  private enqueue(input: AppendPtyTranscriptEventInput): void {
    const stableInput = { ...input, eventId: input.eventId ?? randomUUID() };
    this.pending = this.pending.then(async () => {
      let lastError: unknown;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await this.appender(this.generation, stableInput);
          if (attempt > 1) {
            try {
              await this.appender(this.generation, {
                eventId: randomUUID(),
                eventType: 'error',
                eventSource: 'recovery',
                role: 'host',
                payload: {
                  code: 'transcript_write_retried',
                  message: 'A transcript event required persistence retry before succeeding.',
                  retryAttempts: attempt,
                  recoveredEventId: stableInput.eventId,
                },
              });
            } catch (retryNoticeError) {
              logger.warn({ error: retryNoticeError, eventId: stableInput.eventId }, '[pty-transcript] retry notice could not be appended');
            }
          }
          return;
        } catch (error) {
          lastError = error;
          if (attempt < 3) await new Promise<void>((resolve) => setTimeout(resolve, attempt * 25));
        }
      }
      this.terminalFailure = lastError instanceof TranscriptPersistenceError
        ? lastError
        : new TranscriptPersistenceError(undefined, {
            runId: this.generation.runId,
            generationId: this.generation.generationId,
            eventId: stableInput.eventId,
          });
      logger.error({ error: lastError, runId: this.generation.runId, generationId: this.generation.generationId }, '[pty-transcript] retries exhausted');
    });
  }
}
