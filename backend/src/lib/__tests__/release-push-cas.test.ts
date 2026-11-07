/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

const providerFetch = jest.fn();
const spawnSync = jest.fn();

jest.mock('child_process', () => ({
  execFileSync: jest.fn(),
  spawnSync: (...args: unknown[]) => spawnSync(...args),
}));
jest.mock('../../db/index', () => ({ execute: jest.fn(), query: jest.fn(), queryOne: jest.fn(), transaction: jest.fn() }));
jest.mock('../merge-handler', () => ({ performMerge: jest.fn() }));
jest.mock('../release-identity', () => ({
  revalidateRunReleaseIdentity: jest.fn().mockResolvedValue(undefined),
  withRunReleaseLock: async (_identity: unknown, fn: () => Promise<unknown>) => fn(),
  withGithubReleaseActuation: async (identity: unknown, _purpose: unknown, fn: (value: unknown) => Promise<unknown>) => fn({
    identity, authority: { owner: 'getrorca', name: 'rorca' },
    credential: { token: 'memory-only', source: 'github-app-installation' },
  }),
}));
jest.mock('../github-repository-authority', () => ({
  getGithubRepositoryAuthority: jest.fn(), assertGithubRef: jest.fn(),
  githubRepoApiUrl: (_owner: string, _name: string, suffix: string) => `https://api.github.test${suffix}`,
}));
jest.mock('../github-token-resolver', () => ({ resolveWorkspaceGitHubToken: jest.fn() }));
jest.mock('../github-app-credential-provider', () => ({
  fetchGithubWithTimeout: (_fetch: unknown, url: unknown, init: unknown) => providerFetch(url, init),
}));
jest.mock('../github-rate-limiter', () => ({ githubRateLimiter: { execute: (fn: () => Promise<unknown>) => fn() } }));
jest.mock('../github-provider-error', () => ({ githubProviderError: () => new Error('provider error') }));
jest.mock('../trusted-wal', () => ({ persistTrustedWalEvent: jest.fn(), relayTrustedWalEvent: jest.fn(), trustedWalReference: jest.fn() }));

import { pushExactForTests } from '../release-authority';

const A = 'a'.repeat(40);
const M = 'c'.repeat(40);
const B = 'b'.repeat(40);
const identity = {
  runId: 92, workspaceId: 'ws-push', specId: 'push', authorizedSha: A, branchName: 'run/push',
  workspaceRealpath: '/workspace', worktreeRealpath: '/worktree', baseBranch: 'main', baseSha: A,
  providerReleaseRef: null, integrationCheckoutPath: '/integration',
  repository: { owner: 'getrorca', name: 'rorca', source: 'github-app-installation', bindingId: 'b', installationId: 1, repositoryId: 2 },
};

function ref(sha: string): Response {
  return { ok: true, status: 200, headers: new Headers(), json: async () => ({ object: { sha } }) } as Response;
}

beforeEach(() => {
  jest.clearAllMocks();
  spawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });
});

test('direct base push uses provider force-with-lease CAS and verifies exact result', async () => {
  providerFetch.mockResolvedValueOnce(ref(A)).mockResolvedValueOnce(ref(M));
  await expect(pushExactForTests(identity as never, M, 'main', A)).resolves.toBeUndefined();
  expect(spawnSync).toHaveBeenCalledTimes(1);
  expect(spawnSync.mock.calls[0][1]).toContain(`--force-with-lease=refs/heads/main:${A}`);
  expect(spawnSync.mock.calls[0][1]).toContain(`${M}:refs/heads/main`);
});

test('provider base advance before direct push fails without invoking git', async () => {
  providerFetch.mockResolvedValueOnce(ref(B));
  await expect(pushExactForTests(identity as never, M, 'main', A)).rejects.toThrow(/advanced before exact CAS/);
  expect(spawnSync).not.toHaveBeenCalled();
});

test('provider race during direct push is uncertain and never trusted as success', async () => {
  providerFetch.mockResolvedValueOnce(ref(A)).mockResolvedValueOnce(ref(B));
  await expect(pushExactForTests(identity as never, M, 'main', A)).rejects.toThrow(/raced during exact CAS/);
  expect(spawnSync).toHaveBeenCalledTimes(1);
});

test('replay after exact provider CAS observes target and does not push twice', async () => {
  providerFetch.mockResolvedValueOnce(ref(M));
  await expect(pushExactForTests(identity as never, M, 'main', A)).resolves.toBeUndefined();
  expect(spawnSync).not.toHaveBeenCalled();
});
