/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const queryOne = jest.fn();
const broadcastAll = jest.fn();

jest.mock('../../db/index', () => ({
  queryOne: (...args: unknown[]) => queryOne(...args),
  execute: jest.fn(),
}));
jest.mock('../sse-hub', () => ({ broadcastAll: (...args: unknown[]) => broadcastAll(...args) }));

import { replayFallbackResults } from '../fallback-replay';
import { flushFallbackWrites, writeFallbackResult, type FallbackResultEntry } from '../resilient-post';

function entry(key: string, storyId: string): FallbackResultEntry {
  return {
    type: 'wal', storyId, status: 'story_token_update', runId: 7,
    retries: 1, ts: '2026-07-15T00:00:00.000Z', idempotencyKey: key,
    coalesceKey: `7:${storyId}`, sequence: 1,
    payload: {
      event_type: 'story_token_update', workspace_id: 'test-ws', story_id: storyId,
      idempotency_key: key, occurred_at: '2026-07-15T00:00:00.000Z',
      payload: { run_id: 7, story_id: storyId, cumulative_input: 10 },
    },
  };
}

describe('fallback replay idempotency', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-fallback-replay-'));
    queryOne.mockReset();
    broadcastAll.mockReset();
  });

  afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

  test('replays wave finalization only through the canonical atomic story-result poster', async () => {
    const finalization: FallbackResultEntry = {
      type: 'story_result', storyId: 'US-WAVE', status: 'pass', runId: 9,
      retries: 3, ts: '2026-07-20T00:00:00.000Z', idempotencyKey: 'wave-finalize:9:US-WAVE',
      payload: {
        runId: 9,
        storyId: 'US-WAVE',
        status: 'pass',
        integrationFinalization: {
          attempt: 1,
          resultingHead: 'a'.repeat(40),
          finalizationIdentity: { idempotencyKey: 'wave-finalize:9:US-WAVE', revision: 'a'.repeat(40), receiptHash: 'b'.repeat(64) },
        },
      },
    };
    await writeFallbackResult(cwd, finalization);
    await flushFallbackWrites(cwd);

    const withoutPoster = await replayFallbackResults(cwd, 'test-ws');
    expect(withoutPoster).toMatchObject({ invalid: 1, retained: true, atomicFinalizations: 0 });

    const poster = jest.fn(async () => 'inserted' as const);
    const replayed = await replayFallbackResults(cwd, 'test-ws', { storyResultPoster: poster });
    expect(replayed).toMatchObject({ inserted: 1, invalid: 0, retained: false, atomicFinalizations: 1 });
    expect(poster).toHaveBeenCalledWith(expect.objectContaining({ integrationFinalization: expect.any(Object) }));
    expect(queryOne).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO story_results'), expect.anything());
  });

  test('retains an interrupted journal and safely skips prior inserts on retry', async () => {
    await writeFallbackResult(cwd, entry('key-1', 'US-001'));
    await writeFallbackResult(cwd, entry('key-2', 'US-002'));
    await flushFallbackWrites(cwd);

    const persisted = new Set<string>();
    let failSecondOnce = true;
    queryOne.mockImplementation(async (sql: string, values: unknown[]) => {
      if (!sql.includes('INSERT INTO wal_events')) return undefined;
      const key = values[5] as string;
      if (key === 'key-2' && failSecondOnce) {
        failSecondOnce = false;
        throw new Error('isolated test pool pressure');
      }
      if (persisted.has(key)) return undefined;
      persisted.add(key);
      return {
        id: persisted.size, ts: values[6], event_type: values[0],
        workspace_id: values[1], spec_id: null, story_id: values[3],
        actor: 'ralph', payload: values[4],
      };
    });

    const first = await replayFallbackResults(cwd, 'test-ws');
    expect(first.retained).toBe(true);
    expect(fs.existsSync(path.join(cwd, '.rorca-results.jsonl'))).toBe(true);

    const second = await replayFallbackResults(cwd, 'test-ws');
    expect(second).toMatchObject({ total: 2, inserted: 1, duplicates: 1, retained: false });
    expect(fs.existsSync(path.join(cwd, '.rorca-results.jsonl'))).toBe(false);
    expect(persisted).toEqual(new Set(['key-1', 'key-2']));
    expect(broadcastAll).toHaveBeenCalledTimes(2);
  });
});
