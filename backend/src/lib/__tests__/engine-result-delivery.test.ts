/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConflictError } from '../errors';
import {
  createEngineResultDeliveryContext,
  deliverEngineStoryResult,
} from '../engine-result-delivery';
import {
  flushFallbackWrites,
  readFallbackResults,
  writeFallbackResult,
  type FallbackResultEntry,
} from '../resilient-post';

function transportFailure(): Error & { code: string } {
  return Object.assign(new Error('connection terminated during transaction'), { code: '08006' });
}

describe('run-scoped engine result delivery', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-engine-delivery-'));
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('two concurrent story outages journal complete results and WAL only at the stable run root', async () => {
    const storyRoots = ['US-001', 'US-002'].map(storyId => {
      const cwd = path.join(root, '.rorca-worktrees', storyId);
      fs.mkdirSync(cwd, { recursive: true });
      return { storyId, cwd };
    });
    const context = createEngineResultDeliveryContext(77, 'ws-stable-root', root);
    const persist = jest.fn(async () => { throw transportFailure(); });
    const observedAt = new Date('2026-07-18T12:00:00.000Z');

    const deliveries = await Promise.allSettled(storyRoots.map(({ storyId }) =>
      deliverEngineStoryResult(context, {
        storyId,
        status: 'fail',
        logPath: path.join(root, 'logs', `${storyId}.log`),
        idempotencyKey: `story-result:${storyId}`,
      }, { persist, now: () => observedAt })));
    expect(deliveries.every(result => result.status === 'rejected')).toBe(true);

    await Promise.all(storyRoots.map(({ storyId }) => {
      const wal: FallbackResultEntry = {
        type: 'wal',
        storyId,
        status: 'story_failed',
        runId: 77,
        retries: 3,
        ts: observedAt.toISOString(),
        idempotencyKey: `wal:${storyId}`,
        payload: {
          event_type: 'story_failed',
          workspace_id: 'ws-stable-root',
          story_id: storyId,
          payload: { run_id: 77, story_id: storyId },
        },
      };
      return writeFallbackResult(context.fallbackRoot, wal);
    }));
    await flushFallbackWrites(context.fallbackRoot);

    for (const { cwd } of storyRoots) {
      expect(fs.existsSync(path.join(cwd, '.rorca-results.jsonl'))).toBe(false);
      fs.rmSync(cwd, { recursive: true, force: true });
    }
    const entries = readFallbackResults(root);
    expect(entries).toHaveLength(4);
    expect(entries.filter(entry => entry.type === 'story_result').map(entry => entry.storyId).sort())
      .toEqual(['US-001', 'US-002']);
    expect(entries.filter(entry => entry.type === 'wal').map(entry => entry.storyId).sort())
      .toEqual(['US-001', 'US-002']);
    expect(fs.existsSync(path.join(root, '.rorca-results.jsonl'))).toBe(true);
  });

  test('permanent canonical conflicts throw without creating a replay record', async () => {
    const context = createEngineResultDeliveryContext(78, 'ws-permanent', root);
    await expect(deliverEngineStoryResult(context, {
      storyId: 'US-CONFLICT',
      status: 'pass',
      idempotencyKey: 'story-result:conflict',
    }, {
      persist: async () => { throw new ConflictError('immutable payload mismatch'); },
    })).rejects.toThrow('immutable payload mismatch');
    await flushFallbackWrites(root);
    expect(readFallbackResults(root)).toEqual([]);
  });
});
