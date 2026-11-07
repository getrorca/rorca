/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

const mockTransaction = jest.fn();

jest.mock('../../db/index', () => ({
  queryOne: jest.fn(),
  transaction: (...args: unknown[]) => mockTransaction(...args),
}));

jest.mock('../wave-production-policy', () => ({
  assertWavePolicyEnvelopeIntegrity: jest.fn(),
  defaultWaveRolloutPolicy: jest.fn(),
  evaluateWaveProductionPolicy: jest.fn(),
  wavePolicyEnvironment: jest.fn(),
}));

import { claimWaveProductionDispatch } from '../wave-production-governance';

interface RunState {
  workspaceId: string;
  status: string;
  worktreePath: string | null;
  dispatchLeaseActive?: boolean;
}

function sequentialEnvelope(workspaceId: string, runId: number) {
  return {
    workspaceId,
    runId,
    fence: `fence-${runId}`,
    allowed: true,
    rollout: { policyEpoch: 0 },
    effective: { orchestrationMode: 'sequential', parallelism: 1 },
  } as never;
}

function installSerializedDatabase(runs: Map<number, RunState>, cancellations = new Set<number>()) {
  let transactionTail = Promise.resolve();
  const capacityReads: string[] = [];
  const updates: number[] = [];
  const advisoryLocks: string[] = [];

  mockTransaction.mockImplementation(async (operation: (client: { query: Function }) => Promise<unknown>) => {
    const previous = transactionTail;
    const { promise: next, resolve } = Promise.withResolvers<void>();
    transactionTail = next;
    await previous;
    const client = {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('pg_advisory_xact_lock')) {
          advisoryLocks.push(sql);
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('FROM pipeline_runs WHERE id = $1 FOR UPDATE')) {
          const runId = Number(params[0]);
          const run = runs.get(runId);
          return { rows: run ? [{
            workspace_id: run.workspaceId,
            status: run.status,
            orchestration_mode: 'sequential',
            wave_policy_fence: `fence-${runId}`,
            wave_policy_epoch: '0',
            worktree_path: run.worktreePath,
          }] : [], rowCount: run ? 1 : 0 };
        }
        if (sql.includes('FROM pipeline_run_cancellation_requests')) {
          const runId = Number(params[0]);
          return { rows: cancellations.has(runId) ? [{ run_id: runId }] : [], rowCount: cancellations.has(runId) ? 1 : 0 };
        }
        if (sql.includes('FROM wave_parallel_rollout_controls')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('worktree_path IS NULL') && sql.includes('COUNT(*)')) {
          const workspaceId = String(params[0]);
          const excludedRunId = Number(params[1]);
          capacityReads.push(workspaceId);
          const count = [...runs.entries()].filter(([runId, run]) =>
            runId !== excludedRunId
            && run.workspaceId === workspaceId
            && run.worktreePath === null
            && (
              ['running', 'paused', 'pi_native'].includes(run.status)
              || (run.status === 'starting' && run.dispatchLeaseActive !== false)
            )).length;
          return { rows: [{ count: String(count) }], rowCount: 1 };
        }
        if (sql.includes('UPDATE pipeline_runs') && sql.includes("status = 'starting'")) {
          const runId = Number(params[0]);
          const run = runs.get(runId);
          if (!run || run.status !== 'queued') return { rows: [], rowCount: 0 };
          run.status = 'starting';
          updates.push(runId);
          return { rows: [{ dispatch_lease_expires_at: new Date('2026-08-17T12:00:00.000Z') }], rowCount: 1 };
        }
        throw new Error(`Unexpected dispatch SQL: ${sql}`);
      }),
    };
    try {
      return await operation(client);
    } finally {
      resolve();
    }
  });

  return { capacityReads, updates, advisoryLocks };
}

beforeEach(() => {
  mockTransaction.mockReset();
});

it('serializes concurrent direct-workspace claims so only one free slot is consumed', async () => {
  const runs = new Map<number, RunState>([
    [101, { workspaceId: 'workspace-a', status: 'queued', worktreePath: null }],
    [102, { workspaceId: 'workspace-a', status: 'queued', worktreePath: null }],
  ]);
  const observed = installSerializedDatabase(runs);

  const claims = await Promise.all([
    claimWaveProductionDispatch({
      runId: 101, owner: '11111111-1111-4111-8111-111111111111',
      envelope: sequentialEnvelope('workspace-a', 101), nonWorktreeWorkspaceCapacity: 1,
    }),
    claimWaveProductionDispatch({
      runId: 102, owner: '22222222-2222-4222-8222-222222222222',
      envelope: sequentialEnvelope('workspace-a', 102), nonWorktreeWorkspaceCapacity: 1,
    }),
  ]);

  expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
  expect(claims).toContainEqual({ claimed: false, reason: 'workspace_capacity_exhausted' });
  expect(observed.updates).toHaveLength(1);
  expect(observed.advisoryLocks.some((sql) => sql.includes('rorca:wave-capacity:'))).toBe(true);
});

it('fences duplicate delivery and cancellation before a second dispatch transition', async () => {
  const runs = new Map<number, RunState>([
    [201, { workspaceId: 'workspace-a', status: 'queued', worktreePath: null }],
    [202, { workspaceId: 'workspace-a', status: 'queued', worktreePath: null }],
  ]);
  const observed = installSerializedDatabase(runs, new Set([202]));
  const input = {
    runId: 201,
    owner: '11111111-1111-4111-8111-111111111111',
    envelope: sequentialEnvelope('workspace-a', 201),
    nonWorktreeWorkspaceCapacity: 2,
  };

  await expect(claimWaveProductionDispatch(input)).resolves.toMatchObject({ claimed: true });
  await expect(claimWaveProductionDispatch(input)).resolves.toEqual({ claimed: false, reason: 'run_not_queued' });
  await expect(claimWaveProductionDispatch({
    runId: 202,
    owner: '22222222-2222-4222-8222-222222222222',
    envelope: sequentialEnvelope('workspace-a', 202),
    nonWorktreeWorkspaceCapacity: 2,
  })).resolves.toEqual({ claimed: false, reason: 'cancellation_requested' });
  expect(observed.updates).toEqual([201]);
});

it('scopes direct capacity by workspace and skips it for isolated worktrees', async () => {
  const runs = new Map<number, RunState>([
    [301, { workspaceId: 'workspace-a', status: 'running', worktreePath: null }],
    [302, { workspaceId: 'workspace-b', status: 'queued', worktreePath: null }],
    [303, { workspaceId: 'workspace-a', status: 'queued', worktreePath: '/tmp/worktree-303' }],
  ]);
  const observed = installSerializedDatabase(runs);

  await expect(claimWaveProductionDispatch({
    runId: 302,
    owner: '22222222-2222-4222-8222-222222222222',
    envelope: sequentialEnvelope('workspace-b', 302),
    nonWorktreeWorkspaceCapacity: 1,
  })).resolves.toMatchObject({ claimed: true });
  await expect(claimWaveProductionDispatch({
    runId: 303,
    owner: '33333333-3333-4333-8333-333333333333',
    envelope: sequentialEnvelope('workspace-a', 303),
    nonWorktreeWorkspaceCapacity: 1,
  })).resolves.toMatchObject({ claimed: true });

  expect(observed.capacityReads).toEqual(['workspace-b']);
  expect(observed.updates).toEqual([302, 303]);
});

it('does not let an expired starting claim strand direct-workspace capacity', async () => {
  const runs = new Map<number, RunState>([
    [401, {
      workspaceId: 'workspace-a',
      status: 'starting',
      worktreePath: null,
      dispatchLeaseActive: false,
    }],
    [402, { workspaceId: 'workspace-a', status: 'queued', worktreePath: null }],
  ]);
  const observed = installSerializedDatabase(runs);

  await expect(claimWaveProductionDispatch({
    runId: 402,
    owner: '22222222-2222-4222-8222-222222222222',
    envelope: sequentialEnvelope('workspace-a', 402),
    nonWorktreeWorkspaceCapacity: 1,
  })).resolves.toMatchObject({ claimed: true });
  expect(observed.updates).toEqual([402]);
});
