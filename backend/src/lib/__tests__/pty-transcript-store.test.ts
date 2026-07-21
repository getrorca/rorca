/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

const transcriptQueryMock = jest.fn();
const transcriptTransactionMock = jest.fn();

jest.mock('../../db/index', () => ({
  query: (...args: unknown[]) => transcriptQueryMock(...args),
  transaction: (...args: unknown[]) => transcriptTransactionMock(...args),
}));

import { ConflictError, ValidationError } from '../errors';
import {
  PtyTranscriptNormalizer,
  PtyTranscriptRecorder,
  decodeTranscriptCursor,
  encodeTranscriptCursor,
  listPtyTranscriptEvents,
} from '../pty-transcript-store';

const GENERATION_ID = '123e4567-e89b-42d3-a456-426614174000';

describe('PTY transcript contract primitives', () => {
  beforeEach(() => jest.clearAllMocks());

  it('round-trips a generation-bound monotonic cursor and rejects stale generations', () => {
    const cursor = encodeTranscriptCursor(GENERATION_ID, 42);
    expect(decodeTranscriptCursor(cursor, GENERATION_ID)).toBe(42);
    expect(() => decodeTranscriptCursor(cursor, '223e4567-e89b-42d3-a456-426614174000'))
      .toThrow(ConflictError);
    expect(() => decodeTranscriptCursor('not-a-cursor', GENERATION_ID)).toThrow(ValidationError);
  });

  it('removes ANSI screen repaint bytes while preserving readable line order', () => {
    const normalizer = new PtyTranscriptNormalizer();
    const lines = [
      ...normalizer.accept(Buffer.from('\x1b[2Jthinking 1\rthinking 2\nTool finished\npartial utf8: ')),
      ...normalizer.accept(Buffer.from([0xe2, 0x82])),
      ...normalizer.accept(Buffer.from([0xac, 0x0a])),
      ...normalizer.finish(),
    ];
    expect(lines).toEqual(['thinking 2', 'Tool finished', 'partial utf8: €']);
    expect(lines.join('\n')).not.toContain('\x1b');
  });

  it('returns one bounded ordered page and reports a durable sequence gap', async () => {
    transcriptQueryMock.mockResolvedValue(Array.from({ length: 101 }, (_, index) => ({
      event_id: `${String(index + 1).padStart(8, '0')}-e89b-42d3-a456-426614174000`,
      contract_version: 1,
      generation_id: GENERATION_ID,
      run_id: 77,
      workspace_id: 'ws-1',
      story_id: 'PTY-003',
      seq: index + 2,
      event_type: 'model_message',
      event_source: 'terminal_normalized',
      role: 'assistant',
      correlation_id: null,
      payload: { text: `line ${index}` },
      payload_bytes: 20,
      payload_sha256: 'a'.repeat(64),
      redacted: false,
      truncated: false,
      presentation: true,
      authoritative: false,
      created_at: new Date().toISOString(),
    })));
    const page = await listPtyTranscriptEvents({ runId: 77, generationId: GENERATION_ID, limit: 100 });
    expect(page.items).toHaveLength(100);
    expect(page.hasMore).toBe(true);
    expect(page.items[0].seq).toBe(2);
    expect(page.items[99].seq).toBe(101);
    expect(page.gaps).toEqual([{ afterSeq: 0, beforeSeq: 2, missingCount: 1, reason: 'sequence_gap' }]);
    expect(decodeTranscriptCursor(page.nextCursor!, GENERATION_ID)).toBe(101);
    expect(transcriptQueryMock).toHaveBeenCalledWith(expect.stringContaining('LIMIT $4'), [77, GENERATION_ID, 0, 101]);
  });

  it('bounds a no-newline terminal repaint stream instead of retaining it forever', () => {
    const normalizer = new PtyTranscriptNormalizer();
    const lines = normalizer.accept(Buffer.from('x'.repeat(40_000)));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => Buffer.byteLength(line) <= 8_000)).toBe(true);
  });

  it('coalesces narrow full-screen repaint lines into bounded transcript blocks', async () => {
    const appender = jest.fn(async (_generation: unknown, _input: any) => ({} as never));
    const recorder = new PtyTranscriptRecorder({
      runId: 77,
      generationId: GENERATION_ID,
      generationToken: '323e4567-e89b-42d3-a456-426614174000',
    }, appender);

    recorder.recordModelBytes(Buffer.from(`${'0123456789\r\n'.repeat(2_000)}`, 'utf8'));
    await recorder.drain();

    const modelWrites = appender.mock.calls.filter((call) => call[1].eventType === 'model_message');
    expect(modelWrites.length).toBeGreaterThan(0);
    expect(modelWrites.length).toBeLessThan(10);
    expect(modelWrites.every((call) => Buffer.byteLength(call[1].payload.text, 'utf8') <= 16 * 1024)).toBe(true);
  });

  it('bounds recorder backpressure and persists an explicit gap instead of retaining an unbounded promise chain', async () => {
    let releaseFirst!: () => void;
    const firstWriteBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let callCount = 0;
    const appender = jest.fn(async (_generation: unknown, _input: any) => {
      callCount += 1;
      if (callCount === 1) await firstWriteBlocked;
      return {} as never;
    });
    const recorder = new PtyTranscriptRecorder({
      runId: 77,
      generationId: GENERATION_ID,
      generationToken: '323e4567-e89b-42d3-a456-426614174000',
    }, appender, { maxPendingEvents: 2 });

    recorder.recordHostNotice('start', 'block persistence');
    for (let index = 0; index < 25; index += 1) {
      recorder.recordStructured({
        eventType: 'model_message',
        eventSource: 'terminal_normalized',
        role: 'assistant',
        payload: { text: `repaint ${index}` },
        presentation: true,
      });
    }
    releaseFirst();
    await recorder.drain();

    expect(appender.mock.calls.length).toBeLessThanOrEqual(4);
    expect(appender.mock.calls.some((call) => call[1].eventType === 'gap'
      && call[1].payload.code === 'transcript_recorder_backpressure'
      && call[1].payload.droppedEvents > 0)).toBe(true);
  });

  it('retries with one stable event identity and records recovery explicitly', async () => {
    const appender = jest.fn()
      .mockRejectedValueOnce(new Error('transient one'))
      .mockRejectedValueOnce(new Error('transient two'))
      .mockResolvedValue({});
    const recorder = new PtyTranscriptRecorder({
      runId: 77,
      generationId: GENERATION_ID,
      generationToken: '323e4567-e89b-42d3-a456-426614174000',
    }, appender);
    recorder.recordHostNotice('test', 'retry me');
    await recorder.drain();

    expect(appender).toHaveBeenCalledTimes(4);
    const attemptedIds = appender.mock.calls.slice(0, 3).map((call) => call[1].eventId);
    expect(new Set(attemptedIds).size).toBe(1);
    expect(appender.mock.calls[3][1]).toMatchObject({
      eventType: 'error',
      eventSource: 'recovery',
      payload: expect.objectContaining({ code: 'transcript_write_retried', retryAttempts: 3 }),
    });
  });
});
