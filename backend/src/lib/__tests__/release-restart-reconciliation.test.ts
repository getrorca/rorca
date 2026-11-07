/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

const execute = jest.fn();
const query = jest.fn().mockResolvedValue([]);
const queryOne = jest.fn();
const persistTerminal = jest.fn();
const relayTerminal = jest.fn();
const transactionQueries: Array<{ sql: string; params: unknown[] }> = [];
let intentState: Record<string, any>;
let canonicalRunStatus = 'release_pending';
let canonicalRunFence = 'restart-fence';

const transaction = jest.fn(async (fn: (client: { query: jest.Mock }) => Promise<unknown>) => fn({
  query: jest.fn(async (sql: string, params: unknown[] = []) => {
    transactionQueries.push({ sql, params });
    if (sql.includes('pg_advisory_xact_lock')) return { rowCount: 1, rows: [] };
    if (sql.includes('SELECT run.status')) {
      return {
        rowCount: 1,
        rows: [{
          status: canonicalRunStatus,
          dispatch_fence: canonicalRunFence,
          intent_fence: intentState.dispatch_fence,
          cancellation_requested: false,
        }],
      };
    }
    if (sql.includes('step_state = jsonb_set')) {
      if (intentState.status === 'pending') intentState.status = 'processing';
      intentState.step_state = { ...intentState.step_state, [String(params[1])]: params[2] };
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes("SET status = 'processing'")) {
      intentState.status = 'processing';
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes("SET status = 'done'")) {
      const exactFence = params[3] === canonicalRunFence && params[3] === intentState.dispatch_fence;
      if (canonicalRunStatus !== 'release_pending' || !exactFence) return { rowCount: 0, rows: [] };
      canonicalRunStatus = 'done';
      return { rowCount: 1, rows: [{ id: 81 }] };
    }
    if (sql.includes('UPDATE wal_events SET outbox_ready_at')) {
      return { rowCount: 2, rows: [{ id: 401 }, { id: 501 }] };
    }
    if (sql.includes("SET status = 'completed'")) {
      intentState.status = 'completed';
      return { rowCount: 1, rows: [{ id: 81 }] };
    }
    return { rowCount: 1, rows: [{ id: 81 }] };
  }),
}));

jest.mock('../../db/index', () => ({
  execute: (...args: unknown[]) => execute(...args),
  query: (...args: unknown[]) => query(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
  transaction: (fn: (client: { query: jest.Mock }) => Promise<unknown>) => transaction(fn),
}));
jest.mock('../merge-handler', () => ({ performMerge: jest.fn() }));
jest.mock('../release-identity', () => ({
  revalidateRunReleaseIdentity: jest.fn().mockResolvedValue(undefined),
  withRunReleaseLock: async (_identity: unknown, fn: () => Promise<unknown>) => fn(),
  withGithubReleaseActuation: jest.fn(),
}));
jest.mock('../github-repository-authority', () => ({
  getGithubRepositoryAuthority: jest.fn(),
  githubRepoApiUrl: jest.fn(),
  isFullGitObjectId: (value: unknown) => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value),
}));
jest.mock('../github-app-credential-provider', () => ({ fetchGithubWithTimeout: jest.fn() }));
jest.mock('../github-rate-limiter', () => ({ githubRateLimiter: { execute: jest.fn() } }));
jest.mock('../github-provider-error', () => ({ githubProviderError: jest.fn() }));
jest.mock('../run-closeout-authority', () => ({
  loadHostRunCloseoutReference: jest.fn().mockResolvedValue({
    reference: {
      id: 401,
      runId: 81,
      workspaceId: 'ws-restart',
      ingestKey: 'host-closeout-81',
      identityHash: 'e'.repeat(64),
    },
    payload: { status: 'done', integrated_revision: 'a'.repeat(40) },
  }),
}));
jest.mock('../trusted-wal', () => ({
  persistTrustedWalEvent: (...args: unknown[]) => persistTerminal(...args),
  relayTrustedWalEvent: (...args: unknown[]) => relayTerminal(...args),
  trustedWalReference: (row: Record<string, unknown>) => ({
    id: row.id,
    ingestKey: row.ingest_key,
    identityHash: row.event_identity_hash,
    eventType: row.event_type,
    workspaceId: row.workspace_id,
    runId: row.canonical_run_id,
    specId: row.spec_id,
    storyId: row.story_id,
    source: row.trusted_source,
    storyResultId: row.story_result_id,
    payload: row.payload,
  }),
}));

import { reconcileRunReleaseIntent } from '../release-authority';

const intent = {
  run_id: 81,
  workspace_id: 'ws-restart',
  spec_id: 'restart-spec',
  authorized_sha: 'a'.repeat(40),
  branch_name: 'run/restart',
  execution_workspace_path: '/workspace',
  execution_worktree_path: '/worktree',
  repository_owner: null,
  repository_name: null,
  repository_authority_source: null,
  repository_binding_id: null,
  repository_installation_id: null,
  repository_id: null,
  merge_strategy: 'branch-only',
  auto_merge: false,
  external_send: false,
  identity_hash: 'b'.repeat(64),
  dispatch_fence: 'restart-fence',
  status: 'processing',
  step_state: {},
  base_branch: 'main',
  base_sha: 'd'.repeat(40),
  provider_release_ref: null,
  integration_checkout_path: '/integration',
  merge_commit_sha: null,
  terminal_event_id: null,
  host_closeout_event_id: 401,
  host_closeout_identity_hash: 'e'.repeat(64),
};
const reference = {
  id: 501,
  ingestKey: 'run-finished:81',
  identityHash: 'c'.repeat(64),
  eventType: 'run_finished',
  workspaceId: 'ws-restart',
  runId: 81,
  specId: 'restart-spec',
  storyId: null,
  source: 'worker',
  storyResultId: null,
  payload: { status: 'done' },
};

beforeEach(() => {
  jest.clearAllMocks();
  transactionQueries.length = 0;
  canonicalRunStatus = 'release_pending';
  canonicalRunFence = 'restart-fence';
  intentState = structuredClone(intent);
  execute.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('SET terminal_event_id = $2')) intentState.terminal_event_id = Number(params[1]);
    if (sql.includes("SET status = 'pending'")) intentState.status = 'pending';
    return { rowCount: 1 };
  });
  queryOne.mockImplementation(async (sql: string) => {
    if (sql.includes('pipeline_run_release_intents')) return structuredClone(intentState);
    if (sql.includes('wal_events')) {
      return {
        id: reference.id,
        ingest_key: reference.ingestKey,
        event_identity_hash: reference.identityHash,
        event_type: reference.eventType,
        workspace_id: reference.workspaceId,
        canonical_run_id: reference.runId,
        spec_id: reference.specId,
        story_id: reference.storyId,
        trusted_source: reference.source,
        story_result_id: reference.storyResultId,
        payload: reference.payload,
      };
    }
    return undefined;
  });
  persistTerminal.mockResolvedValue({ reference, duplicate: false });
  relayTerminal.mockResolvedValue(undefined);
});

test('durable terminal intent precedes done and relay, with one idempotent outcome', async () => {
  await expect(reconcileRunReleaseIntent(81)).resolves.toEqual({ runId: 81, status: 'completed' });
  expect(persistTerminal.mock.invocationCallOrder[0]).toBeLessThan(relayTerminal.mock.invocationCallOrder[0]);
  expect(relayTerminal).toHaveBeenCalledWith(reference);
  expect(persistTerminal).toHaveBeenCalledTimes(1);
  expect(transactionQueries).toEqual(expect.arrayContaining([
    expect.objectContaining({
      sql: expect.stringContaining('dispatch_fence = $4'),
      params: expect.arrayContaining(['restart-fence']),
    }),
  ]));
});

test('failure after durable terminal persistence is restart-reconciled without a second identity', async () => {
  relayTerminal.mockRejectedValueOnce(new Error('crash boundary after done')).mockResolvedValueOnce(undefined);
  await expect(reconcileRunReleaseIntent(81)).resolves.toMatchObject({ status: 'blocked' });
  await expect(reconcileRunReleaseIntent(81)).resolves.toEqual({ runId: 81, status: 'completed' });
  expect(persistTerminal).toHaveBeenCalledTimes(1);
  expect(relayTerminal).toHaveBeenCalledTimes(2);
  expect(relayTerminal.mock.calls[0][0]).toEqual(relayTerminal.mock.calls[1][0]);
});

test('changed canonical dispatch fence blocks terminal persistence and relay', async () => {
  canonicalRunFence = 'superseding-fence';
  await expect(reconcileRunReleaseIntent(81)).resolves.toEqual({
    runId: 81,
    status: 'blocked',
    error: 'canonical release dispatch fence changed',
  });
  expect(persistTerminal).not.toHaveBeenCalled();
  expect(relayTerminal).not.toHaveBeenCalled();
});
