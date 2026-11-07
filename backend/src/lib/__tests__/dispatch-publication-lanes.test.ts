/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { PoolClient } from 'pg';
import { retryHash } from '../retry-governance';

const mockQueryOne = jest.fn();
const mockTransaction = jest.fn();

jest.mock('../../db/index', () => ({
  query: jest.fn(),
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
  transaction: (...args: unknown[]) => mockTransaction(...args),
}));

import {
  PIPELINE_DIRECT_RUN_QUEUE,
  PIPELINE_RUN_QUEUE,
  claimDispatchForWorker,
  pipelineRunQueueForPayload,
  prepareDispatchPublication,
  releaseDispatchWorkerClaim,
} from '../dispatch-publication';

beforeEach(() => {
  jest.clearAllMocks();
});

test('routes isolated and direct-workspace payloads to distinct durable lanes', () => {
  expect(pipelineRunQueueForPayload({ worktreePath: '/tmp/run-worktree' })).toBe(PIPELINE_RUN_QUEUE);
  expect(pipelineRunQueueForPayload({ worktreePath: null })).toBe(PIPELINE_DIRECT_RUN_QUEUE);
  expect(pipelineRunQueueForPayload({})).toBe(PIPELINE_DIRECT_RUN_QUEUE);
});

test('preparation persists the exact selected lane with immutable payload identity', async () => {
  mockQueryOne.mockResolvedValue({
    boss_job_id: '11111111-1111-4111-8111-111111111111',
    queue_name: PIPELINE_DIRECT_RUN_QUEUE,
  });
  const payload = { runId: 41, worktreePath: null };
  await expect(prepareDispatchPublication({
    runId: 41,
    owner: 'publisher-1',
    requestHash: `sha256:${'a'.repeat(64)}`,
    effectiveOptionsHash: `sha256:${'b'.repeat(64)}`,
    payload,
  })).resolves.toEqual({
    bossJobId: '11111111-1111-4111-8111-111111111111',
    payloadHash: retryHash(payload),
    queueName: PIPELINE_DIRECT_RUN_QUEUE,
  });

  const [sql, params] = mockQueryOne.mock.calls[0] as [string, unknown[]];
  expect(sql).toContain('queue_name = CASE WHEN payload IS NULL THEN $7 ELSE queue_name END');
  expect(sql).toContain('payload = $6::jsonb AND queue_name = $7');
  expect(params[6]).toBe(PIPELINE_DIRECT_RUN_QUEUE);
});

test('a callback from the wrong lane cannot claim a publication', async () => {
  const payload = { runId: 42, worktreePath: null };
  const bossJobId = '22222222-2222-4222-8222-222222222222';
  const client = {
    query: jest.fn(async (sqlValue: unknown) => {
      const sql = String(sqlValue);
      if (sql.includes('FROM pipeline_runs WHERE id = $1 FOR UPDATE')) {
        return { rows: [{
          workspace_id: 'workspace-a', status: 'queued', dispatch_request_hash: null,
          campaign_dispatch_authorization_hash: null, trigger_options: null,
        }] };
      }
      if (sql.includes('pipeline_run_cancellation_requests')) return { rows: [] };
      if (sql.includes('pipeline_dispatch_publications')) {
        return { rows: [{
          state: 'published', boss_job_id: bossJobId, payload_hash: retryHash(payload),
          lease_expires_at: null, queue_name: PIPELINE_RUN_QUEUE,
        }] };
      }
      return { rows: [] };
    }),
  } as unknown as PoolClient;
  mockTransaction.mockImplementation(async (callback: (client: PoolClient) => unknown) => callback(client));

  await expect(claimDispatchForWorker({
    runId: 42,
    bossJobId,
    payload,
    workerId: 'worker-1',
    queueName: PIPELINE_DIRECT_RUN_QUEUE,
  })).resolves.toEqual({
    claimed: false,
    reason: 'publication_queue_mismatch',
    workspaceId: 'workspace-a',
  });
});

test('capacity loss releases only the exact never-started worker claim', async () => {
  mockQueryOne.mockResolvedValue({ run_id: 44 });
  await expect(releaseDispatchWorkerClaim({
    runId: 44,
    bossJobId: '44444444-4444-4444-8444-444444444444',
    workerId: 'worker-capacity',
    reason: 'workspace_capacity_exhausted_before_start',
  })).resolves.toBeUndefined();

  const [sql, params] = mockQueryOne.mock.calls[0] as [string, unknown[]];
  expect(sql).toContain("SET state = 'published'");
  expect(sql).toContain("state = 'claimed' AND lease_owner = $3");
  expect(params).toEqual([
    44,
    '44444444-4444-4444-8444-444444444444',
    'worker-capacity',
    'workspace_capacity_exhausted_before_start',
  ]);
});
