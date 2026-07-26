/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

const execute = jest.fn().mockResolvedValue({ rowCount: 1 });
const query = jest.fn().mockResolvedValue([]);
const queryOne = jest.fn();
const persistTerminal = jest.fn();
const relayTerminal = jest.fn();

jest.mock('../../db/index', () => ({
  execute: (...args: unknown[]) => execute(...args),
  query: (...args: unknown[]) => query(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
  transaction: async (fn: (client: { query: jest.Mock }) => Promise<unknown>) => fn({
    query: jest.fn(async (sql: string) => ({
      rowCount: sql.includes('UPDATE wal_events') ? 2 : 1,
      rows: [{ id: 81 }],
    })),
  }),
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
const reference = { id: 501, runId: 81, identityHash: 'c'.repeat(64) };

beforeEach(() => {
  jest.clearAllMocks();
  execute.mockResolvedValue({ rowCount: 1 });
  queryOne.mockResolvedValue({ ...intent });
  persistTerminal.mockResolvedValue({ reference, duplicate: false });
  relayTerminal.mockResolvedValue(undefined);
});

test('durable terminal intent precedes done and relay, with one idempotent outcome', async () => {
  await expect(reconcileRunReleaseIntent(81)).resolves.toEqual({ runId: 81, status: 'completed' });
  expect(persistTerminal.mock.invocationCallOrder[0]).toBeLessThan(relayTerminal.mock.invocationCallOrder[0]);
  expect(relayTerminal).toHaveBeenCalledWith(reference);
});

test('failure after durable terminal persistence is restart-reconciled without a second identity', async () => {
  relayTerminal.mockRejectedValueOnce(new Error('crash boundary after done')).mockResolvedValueOnce(undefined);
  await expect(reconcileRunReleaseIntent(81)).resolves.toMatchObject({ status: 'blocked' });
  persistTerminal.mockResolvedValue({ reference, duplicate: true });
  await expect(reconcileRunReleaseIntent(81)).resolves.toEqual({ runId: 81, status: 'completed' });
  expect(persistTerminal).toHaveBeenCalledTimes(2);
  expect(persistTerminal.mock.calls[0][0]).toEqual(persistTerminal.mock.calls[1][0]);
  expect(relayTerminal).toHaveBeenCalledTimes(2);
});
