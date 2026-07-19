/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

const providerFetch = jest.fn();
const revalidate = jest.fn().mockResolvedValue(undefined);

jest.mock('../../db/index', () => ({ execute: jest.fn(), query: jest.fn(), queryOne: jest.fn(), transaction: jest.fn() }));
jest.mock('../merge-handler', () => ({ performMerge: jest.fn() }));
jest.mock('../release-identity', () => ({
  revalidateRunReleaseIdentity: (...args: unknown[]) => revalidate(...args),
  withRunReleaseLock: async (_identity: unknown, fn: () => Promise<unknown>) => fn(),
  withGithubReleaseActuation: async (identity: unknown, _purpose: unknown, fn: (value: unknown) => Promise<unknown>) => fn({
    identity,
    authority: { owner: 'getrorca', name: 'rorca', autoPrTargetBranch: 'main' },
    credential: { token: 'memory-only', source: 'github-app-installation' },
  }),
}));
jest.mock('../github-repository-authority', () => ({
  getGithubRepositoryAuthority: jest.fn(),
  assertGithubRef: jest.fn(),
  githubRepoApiUrl: (_owner: string, _name: string, suffix: string) => `https://api.github.test/repos/getrorca/rorca${suffix}`,
}));
jest.mock('../github-token-resolver', () => ({ resolveWorkspaceGitHubToken: jest.fn() }));
jest.mock('../github-app-credential-provider', () => ({
  fetchGithubWithTimeout: (_fetch: unknown, url: unknown, init: unknown) => providerFetch(url, init),
}));
jest.mock('../github-rate-limiter', () => ({ githubRateLimiter: { execute: (fn: () => Promise<unknown>) => fn() } }));
jest.mock('../github-provider-error', () => ({ githubProviderError: (_response: unknown, code: string) => new Error(code) }));
jest.mock('../trusted-wal', () => ({ persistTrustedWalEvent: jest.fn(), relayTrustedWalEvent: jest.fn(), trustedWalReference: jest.fn() }));

import { createOrFinalizePullRequestForTests } from '../release-authority';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const releaseRef = `rorca/release/run-91-${A.slice(0, 12)}`;
const row = {
  run_id: 91, workspace_id: 'ws-pr', spec_id: 'exact-pr', authorized_sha: A,
  branch_name: 'run/exact-pr', execution_workspace_path: '/workspace', execution_worktree_path: '/worktree',
  repository_owner: 'getrorca', repository_name: 'rorca', repository_authority_source: 'github-app-installation',
  repository_binding_id: 'binding', repository_installation_id: 1, repository_id: 2,
  merge_strategy: 'pr', auto_merge: false, external_send: true, identity_hash: 'c'.repeat(64),
  status: 'processing', step_state: {}, base_branch: 'main', base_sha: 'd'.repeat(40),
  provider_release_ref: releaseRef, integration_checkout_path: '/integration', merge_commit_sha: null, terminal_event_id: null,
};

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body } as Response;
}

function ref(sha: string): Response { return response({ object: { sha } }); }
function pr(sha: string, draft = true): Response {
  return response({ number: 17, state: 'open', draft, head: { sha, ref: releaseRef } });
}

beforeEach(() => { jest.clearAllMocks(); });

test('exact unique provider ref creates and verifies one PR', async () => {
  providerFetch
    .mockResolvedValueOnce(ref(A))
    .mockResolvedValueOnce(response([]))
    .mockResolvedValueOnce(ref(A))
    .mockResolvedValueOnce(response({ number: 17, draft: false }))
    .mockResolvedValueOnce(pr(A, false));
  await expect(createOrFinalizePullRequestForTests(row as never, false)).resolves.toBe(17);
  expect(providerFetch.mock.calls.filter(([, init]) => (init as RequestInit).method === 'POST')).toHaveLength(1);
});

test('A-to-B advance before create blocks provider mutation', async () => {
  providerFetch.mockResolvedValueOnce(ref(B));
  await expect(createOrFinalizePullRequestForTests(row as never, false)).rejects.toThrow(/provider release ref differs/);
  expect(providerFetch.mock.calls.some(([, init]) => (init as RequestInit).method === 'POST')).toBe(false);
});

test('A-to-B advance after lookup and immediately before create blocks mutation', async () => {
  providerFetch
    .mockResolvedValueOnce(ref(A)).mockResolvedValueOnce(response([])).mockResolvedValueOnce(ref(B));
  await expect(createOrFinalizePullRequestForTests(row as never, false)).rejects.toThrow(/provider release ref differs/);
  expect(providerFetch.mock.calls.some(([, init]) => (init as RequestInit).method === 'POST')).toBe(false);
});

test('A-to-B race during create is detected and the PR is quarantined', async () => {
  providerFetch
    .mockResolvedValueOnce(ref(A)).mockResolvedValueOnce(response([])).mockResolvedValueOnce(ref(A))
    .mockResolvedValueOnce(response({ number: 17, draft: false })).mockResolvedValueOnce(pr(B, false))
    .mockResolvedValueOnce(response({ state: 'closed' }));
  await expect(createOrFinalizePullRequestForTests(row as never, false)).rejects.toThrow(/during PR create.*quarantined/);
  expect(providerFetch.mock.calls.some(([, init]) => String((init as RequestInit).body).includes('"state":"closed"'))).toBe(true);
});

test('A-to-B race immediately before draft finalization quarantines without finalizing', async () => {
  providerFetch
    .mockResolvedValueOnce(ref(A)).mockResolvedValueOnce(response([{ number: 17, state: 'open', draft: true, head: { sha: A, ref: releaseRef } }]))
    .mockResolvedValueOnce(ref(A)).mockResolvedValueOnce(pr(B, true)).mockResolvedValueOnce(response({ state: 'closed' }));
  await expect(createOrFinalizePullRequestForTests(row as never, false)).rejects.toThrow(/before draft finalization.*quarantined/);
  expect(providerFetch.mock.calls.some(([, init]) => String((init as RequestInit).body).includes('"draft":false'))).toBe(false);
});

test('A-to-B race during draft finalization is detected and quarantined', async () => {
  providerFetch
    .mockResolvedValueOnce(ref(A)).mockResolvedValueOnce(response([{ number: 17, state: 'open', draft: true, head: { sha: A, ref: releaseRef } }]))
    .mockResolvedValueOnce(ref(A)).mockResolvedValueOnce(pr(A, true))
    .mockResolvedValueOnce(response({ number: 17, draft: false })).mockResolvedValueOnce(pr(B, false))
    .mockResolvedValueOnce(response({ state: 'closed' }));
  await expect(createOrFinalizePullRequestForTests(row as never, false)).rejects.toThrow(/during draft finalization.*quarantined/);
  expect(providerFetch.mock.calls.some(([, init]) => String((init as RequestInit).body).includes('"state":"closed"'))).toBe(true);
});
