/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

const mockExecute = jest.fn();
const mockQueryOne = jest.fn();
const mockClientQuery = jest.fn();
const mockPoolConnect = jest.fn();
const mockClientRelease = jest.fn();

jest.mock('../../db/index', () => ({
  pool: { connect: (...args: unknown[]) => mockPoolConnect(...args) },
  execute: (...args: unknown[]) => mockExecute(...args),
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
}));

import {
  emitLifecycleInvalidation,
  lifecycleRequestHash,
  runIdempotentLifecycleMutation,
} from '../lifecycle-mutations';
import { subscribe, type WalEvent } from '../sse-hub';

beforeEach(() => {
  jest.clearAllMocks();
  mockExecute.mockResolvedValue({ rowCount: 1 });
  mockClientQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes('SELECT request_hash')) {
      const row = await mockQueryOne(sql, params);
      return { rows: row ? [row] : [] };
    }
    await mockExecute(sql, params);
    return { rows: [] };
  });
  mockPoolConnect.mockResolvedValue({ query: mockClientQuery, release: mockClientRelease });
});

describe('durable lifecycle mutation replay and invalidation', () => {
  test('returns a completed restart replay without invoking the mutation again', async () => {
    const request = { workspaceId: 'ws-a', specId: 'safe-spec' };
    mockQueryOne.mockResolvedValue({
      request_hash: lifecycleRequestHash(request),
      status: 'completed',
      response_status: 201,
      response_body: { runId: 88, queued: true },
    });
    const mutate = jest.fn();

    const result = await runIdempotentLifecycleMutation({
      workspaceId: 'ws-a',
      operation: 'retry-dispatch',
      idempotencyKey: 'dispatch-001',
      request,
      mutate,
    });

    expect(result).toEqual({ value: { runId: 88, queued: true }, replayed: true, responseStatus: 201 });
    expect(mutate).not.toHaveBeenCalled();
  });

  test('serializes concurrent pending claims so the mutation executes once', async () => {
    const request = { workspaceId: 'ws-a', specId: 'safe-spec' };
    const requestHash = lifecycleRequestHash(request);
    let row = {
      request_hash: requestHash,
      status: 'pending',
      response_status: null as number | null,
      response_body: null as unknown,
    };
    let lock = Promise.resolve();
    mockPoolConnect.mockImplementation(async () => {
      let unlock: (() => void) | undefined;
      return {
        query: async (sql: string, params?: unknown[]) => {
          if (sql.includes('pg_advisory_lock')) {
            const previous = lock;
            lock = new Promise<void>((resolve) => { unlock = resolve; });
            await previous;
          } else if (sql.includes('pg_advisory_unlock')) {
            unlock?.();
          } else if (sql.includes('SELECT request_hash')) {
            return { rows: [{ ...row }] };
          } else if (sql.includes('UPDATE lifecycle_mutation_requests')) {
            row = { ...row, status: 'completed', response_status: Number(params?.[3]), response_body: JSON.parse(String(params?.[4])) };
          }
          return { rows: [] };
        },
        release: mockClientRelease,
      };
    });
    const mutate = jest.fn(async () => ({ runId: 91 }));
    const call = () => runIdempotentLifecycleMutation({
      workspaceId: 'ws-a', operation: 'retry-dispatch', idempotencyKey: 'dispatch-091', request, mutate,
    });

    const [first, second] = await Promise.all([call(), call()]);

    expect(mutate).toHaveBeenCalledTimes(1);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(first.value).toEqual(second.value);
  });

  test('rejects a replay key reused with different input before mutation', async () => {
    mockQueryOne.mockResolvedValue({
      request_hash: lifecycleRequestHash({ workspaceId: 'ws-a', specId: 'other-spec' }),
      status: 'pending',
      response_status: null,
      response_body: null,
    });

    await expect(runIdempotentLifecycleMutation({
      workspaceId: 'ws-a',
      operation: 'recompile',
      idempotencyKey: 'recompile-001',
      request: { workspaceId: 'ws-a', specId: 'safe-spec' },
      mutate: jest.fn(),
    })).rejects.toThrow('reused with a different lifecycle request');
  });

  test('publishes the exact bounded WAL metadata only after durable insertion', async () => {
    const delivered: WalEvent[] = [];
    const unsubscribe = subscribe((event) => delivered.push(event));
    const walEvent: WalEvent = {
      id: 9,
      ts: '2026-07-15T12:00:00.000Z',
      event_type: 'lifecycle_changed',
      workspace_id: 'ws-a',
      spec_id: 'safe-spec',
      story_id: null,
      actor: 'lifecycle-api',
      payload: JSON.stringify({
        workspaceId: 'ws-a',
        specId: 'safe-spec',
        phaseId: 'qa',
        runId: 88,
        changeKind: 'retry_dispatched',
      }),
    };
    mockQueryOne.mockResolvedValue(walEvent);

    try {
      await emitLifecycleInvalidation({
        workspaceId: 'ws-a',
        specId: 'safe-spec',
        phaseId: 'qa',
        runId: 88,
        changeKind: 'retry_dispatched',
      });
    } finally {
      unsubscribe();
    }

    expect(delivered).toEqual([walEvent]);
    expect(mockQueryOne).toHaveBeenCalledWith(
      expect.stringContaining("VALUES ('lifecycle_changed'"),
      ['ws-a', 'safe-spec', JSON.stringify({
        workspaceId: 'ws-a',
        specId: 'safe-spec',
        phaseId: 'qa',
        runId: 88,
        changeKind: 'retry_dispatched',
      })],
    );
    expect(JSON.stringify(mockQueryOne.mock.calls[0])).not.toMatch(/slack|credential|attachment|rawLog/i);
  });
});
