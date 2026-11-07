/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { GithubProviderBinding } from '../authority-provider-adapter';
import { getDeliveryAdapterCatalog } from '../delivery-adapter';
import { GitHubAuthorityProviderAdapter } from '../github-authority-provider-adapter';
import type { GithubInstallationLeaseMetadata } from '../github-app-credential-provider';
import {
  GithubReviewDeliveryOperations,
  GithubReviewDeliveryReceiptSchema,
  assertGithubReviewDeliveryOperation,
  type GithubExternalSendGrant,
} from '../github-review-delivery';

const execFileAsync = promisify(execFile);
const NOW = new Date('2026-08-23T12:00:00.000Z');
const TOKEN = 'github-installation-token-must-never-serialize';
const LEASE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GRANT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REQUEST_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ATTEMPTS = [
  { id: 'd0000000-0000-4000-8000-000000000001', operation: 'scm.branch.write' },
  { id: 'd0000000-0000-4000-8000-000000000002', operation: 'scm.pull_request.write' },
  { id: 'd0000000-0000-4000-8000-000000000003', operation: 'scm.checks.read' },
  { id: 'd0000000-0000-4000-8000-000000000004', operation: 'scm.review.request' },
] as const;

const BINDING: GithubProviderBinding = {
  providerId: 'github-app',
  bindingId: '11111111-1111-4111-8111-111111111111',
  bindingGeneration: 7,
  workspaceId: 'workspace-disposable',
  bindingStatus: 'active',
  registrationStatus: 'active',
  installationStatus: 'active',
  installationId: 99,
  repositoryId: 12345,
  repository: { owner: 'getrorca', name: 'github-execution-qualification' },
  secretReferences: [
    { purpose: 'app-signing', secretId: '22222222-2222-4222-8222-222222222222' },
    { purpose: 'webhook-verification', secretId: '33333333-3333-4333-8333-333333333333' },
  ],
  providerProfileVerified: true,
};

interface RecordedProviderCall {
  method: string;
  path: string;
  body: unknown;
}

interface FakeGithubState {
  baseRevision: string;
  baseTree: string;
  expectedTree: string;
  expectedHead: string;
  branches: Map<string, string>;
  pullRequests: Array<Record<string, unknown>>;
  reviewUsers: Set<string>;
  reviewTeams: Set<string>;
  calls: RecordedProviderCall[];
  commitWrites: number;
  pullRequestCreates: number;
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-github-request-id': 'test-request-1' },
  });
}

function blobSha(content: Buffer): string {
  return crypto.createHash('sha1')
    .update(Buffer.from(`blob ${content.byteLength}\0`, 'utf8'))
    .update(content)
    .digest('hex');
}

function pullRequest(state: FakeGithubState): Record<string, unknown> {
  const branch = [...state.branches.keys()].find((name) => name !== 'main');
  if (!branch) throw new Error('Expected the disposable feature branch');
  return {
    id: 9001,
    number: 41,
    html_url: 'https://github.com/getrorca/github-execution-qualification/pull/41',
    state: 'open',
    head: { ref: branch, sha: state.expectedHead },
    base: { ref: 'main' },
  };
}

function fakeGithub(state: FakeGithubState): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as unknown : null;
    const suffix = decodeURIComponent(url.pathname.replace('/repos/getrorca/github-execution-qualification', ''));
    state.calls.push({ method, path: `${suffix}${url.search}`, body });

    if (method === 'GET' && suffix.startsWith('/git/ref/heads/')) {
      const branch = suffix.slice('/git/ref/heads/'.length);
      const sha = state.branches.get(branch);
      return sha ? response({ object: { sha } }) : response({}, 404);
    }
    if (method === 'GET' && suffix === `/git/commits/${state.baseRevision}`) {
      return response({ sha: state.baseRevision });
    }
    if (method === 'POST' && suffix === '/git/blobs') {
      const payload = body as { content: string; encoding: string };
      expect(payload.encoding).toBe('base64');
      return response({ sha: blobSha(Buffer.from(payload.content, 'base64')) }, 201);
    }
    if (method === 'POST' && suffix === '/git/trees') {
      expect(body).toMatchObject({ base_tree: state.baseTree });
      return response({ sha: state.expectedTree }, 201);
    }
    if (method === 'POST' && suffix === '/git/commits') {
      state.commitWrites += 1;
      const payload = body as Record<string, unknown>;
      expect(payload).toMatchObject({
        tree: state.expectedTree,
        parents: [state.baseRevision],
        author: { name: 'Rorca Automation', email: 'automation@rorca.local', date: NOW.toISOString() },
        committer: { name: 'Rorca Automation', email: 'automation@rorca.local', date: NOW.toISOString() },
      });
      return response({ sha: state.expectedHead }, 201);
    }
    if (method === 'POST' && suffix === '/git/refs') {
      const payload = body as { ref: string; sha: string };
      state.branches.set(payload.ref.replace('refs/heads/', ''), payload.sha);
      return response({ object: { sha: payload.sha } }, 201);
    }
    if (method === 'PATCH' && suffix.startsWith('/git/refs/heads/')) {
      const payload = body as { sha: string; force: boolean };
      expect(payload.force).toBe(false);
      state.branches.set(suffix.slice('/git/refs/heads/'.length), payload.sha);
      return response({ object: { sha: payload.sha } });
    }
    if (method === 'GET' && suffix === '/pulls') {
      return response(state.pullRequests);
    }
    if (method === 'POST' && suffix === '/pulls') {
      state.pullRequestCreates += 1;
      const created = pullRequest(state);
      state.pullRequests.push(created);
      return response(created, 201);
    }
    if (method === 'PATCH' && suffix === '/pulls/41') return response(state.pullRequests[0]);
    if (method === 'GET' && suffix === `/commits/${state.expectedHead}/check-runs`) {
      return response({ check_runs: [
        { id: 502, name: 'lint', status: 'completed', conclusion: 'success' },
        { id: 501, name: 'test', status: 'completed', conclusion: 'success' },
      ] });
    }
    if (suffix === '/pulls/41/requested_reviewers' && method === 'GET') {
      return response({
        users: [...state.reviewUsers].map((login) => ({ login })),
        teams: [...state.reviewTeams].map((slug) => ({ slug })),
      });
    }
    if (suffix === '/pulls/41/requested_reviewers' && method === 'POST') {
      const payload = body as { reviewers: string[]; team_reviewers: string[] };
      payload.reviewers.forEach((reviewer) => state.reviewUsers.add(reviewer));
      payload.team_reviewers.forEach((reviewer) => state.reviewTeams.add(reviewer));
      return response({
        users: [...state.reviewUsers].map((login) => ({ login })),
        teams: [...state.reviewTeams].map((slug) => ({ slug })),
      }, 201);
    }
    return response({}, 404);
  }) as typeof fetch;
}

async function git(cwd: string, args: readonly string[], environment: Record<string, string> = {}): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: '/nonexistent',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      ...environment,
    },
  });
  return stdout.trim();
}

function lease(branchCapabilities: readonly GithubInstallationLeaseMetadata['capabilities'][number][]): GithubInstallationLeaseMetadata {
  return {
    leaseId: LEASE_ID,
    source: 'github-app-installation',
    workspaceId: BINDING.workspaceId,
    bindingId: BINDING.bindingId,
    bindingGeneration: BINDING.bindingGeneration,
    authorityGrantId: GRANT_ID,
    installationId: BINDING.installationId,
    repository: { id: BINDING.repositoryId, ...BINDING.repository },
    capabilities: branchCapabilities,
    permissions: { contents: 'write', pull_requests: 'write', checks: 'read' },
    expiresAt: '2026-08-23T13:00:00.000Z',
  };
}

test('disposable bound journey creates one review branch/commit/PR and replays without duplicates', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'rorca-github-review-test-'));
  const repositoryPath = path.join(fixtureRoot, 'repository');
  const worktreeRoot = path.join(fixtureRoot, 'worktrees');
  await mkdir(repositoryPath);
  try {
    await git(repositoryPath, ['init', '-b', 'main']);
    await writeFile(path.join(repositoryPath, 'baseline.txt'), 'approved base\n');
    await git(repositoryPath, ['add', '--all']);
    await git(repositoryPath, ['commit', '--no-gpg-sign', '-m', 'Approved base'], {
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
      GIT_AUTHOR_DATE: '2026-08-23T10:00:00.000Z',
      GIT_COMMITTER_DATE: '2026-08-23T10:00:00.000Z',
    });
    const baseRevision = await git(repositoryPath, ['rev-parse', 'HEAD']);
    const state: FakeGithubState = {
      baseRevision,
      baseTree: await git(repositoryPath, ['rev-parse', `${baseRevision}^{tree}`]),
      expectedTree: '',
      expectedHead: '',
      branches: new Map([['main', baseRevision]]),
      pullRequests: [],
      reviewUsers: new Set(),
      reviewTeams: new Set(),
      calls: [],
      commitWrites: 0,
      pullRequestCreates: 0,
    };
    const capabilities = [
      'scm.branch.write',
      'scm.pull_request.write',
      'scm.checks.read',
      'scm.review.request',
    ] as const;
    let leaseActive = true;
    const operations = new GithubReviewDeliveryOperations({
      fetch: fakeGithub(state),
      now: () => NOW,
      worktreeRoot,
      withLeaseToken: async <T>(leaseId: string, operation: (
        token: string,
        metadata: GithubInstallationLeaseMetadata,
      ) => Promise<T>): Promise<T> => {
        expect(leaseId).toBe(LEASE_ID);
        if (!leaseActive) throw new Error('Installation lease is revoked');
        return operation(TOKEN, lease(capabilities));
      },
    });
    const adapter = new GitHubAuthorityProviderAdapter(async () => null, () => true, operations);

    const prepared = await adapter.prepareRepository({
      repositoryPath,
      approvedBaseRevision: baseRevision,
      checkoutLabel: 'GEF-003',
    });
    const branch = await adapter.createBranch(prepared, {
      workspaceId: BINDING.workspaceId,
      runId: 20260316000222,
      storyId: 'GEF-003',
    });
    await writeFile(path.join(prepared.checkoutPath, 'reviewed-change.txt'), 'review only\n');
    const commit = await adapter.commit(branch, { message: 'GEF-003: reviewed change', authoredAt: NOW.toISOString() });
    state.expectedHead = commit.headRevision;
    state.expectedTree = await git(prepared.checkoutPath, ['rev-parse', `${commit.headRevision}^{tree}`]);
    const grant: GithubExternalSendGrant = {
      grantId: GRANT_ID,
      workspaceId: BINDING.workspaceId,
      bindingId: BINDING.bindingId,
      bindingGeneration: BINDING.bindingGeneration,
      repository: { id: BINDING.repositoryId, ...BINDING.repository },
      baseBranch: 'main',
      baseRevision,
      branch: branch.branch,
      headRevision: commit.headRevision,
      operations: [...capabilities],
      decision: 'accepted',
      externalSend: true,
      expiresAt: '2026-08-23T13:00:00.000Z',
    };

    const callsBeforeProtectedBranchAttempt = state.calls.length;
    await expect(adapter.pushBranch({
      leaseId: LEASE_ID,
      grant: { ...grant, baseBranch: 'develop', branch: 'main' },
      binding: BINDING,
      commit: { ...commit, branch: 'main' },
    })).rejects.toThrow('Protected or unbound branch delivery is not authorized');
    expect(state.calls).toHaveLength(callsBeforeProtectedBranchAttempt);
    expect(state.branches.get('main')).toBe(baseRevision);

    const callsBeforeRepositoryAttack = state.calls.length;
    await expect(adapter.pushBranch({
      leaseId: LEASE_ID,
      grant: {
        ...grant,
        repository: { id: 54321, owner: 'getrorca', name: 'another-disposable-repository' },
      },
      binding: BINDING,
      commit,
    })).rejects.toThrow('does not match the immutable delivery request');
    expect(state.calls).toHaveLength(callsBeforeRepositoryAttack);

    const callsBeforeArgumentAttack = state.calls.length;
    await expect(adapter.pushBranch({
      leaseId: LEASE_ID,
      grant: { ...grant, headRevision: 'f'.repeat(40) },
      binding: BINDING,
      commit,
    })).rejects.toThrow('does not match the immutable delivery request');
    expect(state.calls).toHaveLength(callsBeforeArgumentAttack);

    const firstPush = await adapter.pushBranch({ leaseId: LEASE_ID, grant, binding: BINDING, commit });
    const firstPull = await adapter.createOrUpdatePullRequest({
      leaseId: LEASE_ID,
      grant,
      binding: BINDING,
      commit,
      title: 'GEF-003 reviewed change',
      body: 'Ready for human review. No merge requested.',
    });
    const checks = await adapter.observeChecks({ leaseId: LEASE_ID, grant, binding: BINDING, commit });
    const firstReview = await adapter.requestReview({
      leaseId: LEASE_ID,
      grant,
      binding: BINDING,
      commit,
      pullRequest: firstPull,
      users: ['reviewer-one'],
    });
    const receipt = adapter.createReceipt({
      lineage: {
        workspaceId: BINDING.workspaceId,
        requestId: REQUEST_ID,
        grantId: GRANT_ID,
        leaseId: LEASE_ID,
        attempts: ATTEMPTS,
      },
      binding: BINDING,
      commit,
      push: firstPush,
      pullRequest: firstPull,
      checks,
      reviewRequest: firstReview,
    });

    expect(GithubReviewDeliveryReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(receipt).toMatchObject({
      workspaceId: BINDING.workspaceId,
      authority: {
        requestId: REQUEST_ID,
        grantId: GRANT_ID,
        leaseId: LEASE_ID,
        attempts: ATTEMPTS,
      },
      installationId: BINDING.installationId,
      repository: { id: BINDING.repositoryId },
      approvedBaseRevision: baseRevision,
      headRevision: commit.headRevision,
      isolatedCheckout: { checkoutId: prepared.checkoutId, approvedRevision: baseRevision },
      branch: branch.branch,
      commit: { authorName: 'Rorca Automation', authorEmail: 'automation@rorca.local' },
      pullRequest: {
        id: 9001,
        number: 41,
        url: 'https://github.com/getrorca/github-execution-qualification/pull/41',
      },
      checks: [
        { id: 501, status: 'completed', conclusion: 'success' },
        { id: 502, status: 'completed', conclusion: 'success' },
      ],
      reviewRequest: { users: ['reviewer-one'], teams: [], requested: true },
      prohibitedEffects: {
        protectedBranchPush: false,
        forcePush: false,
        merge: false,
        tag: false,
        release: false,
        repositoryAdministration: false,
        actionsSecretMutation: false,
        productionDeployment: false,
      },
    });
    expect(JSON.stringify(receipt)).not.toContain(TOKEN);
    expect(JSON.stringify(receipt)).toContain(LEASE_ID);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.checks)).toBe(true);

    expect(await adapter.cleanupRepository(prepared)).toEqual({ replayed: false });
    await expect(stat(prepared.checkoutPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await adapter.cleanupRepository(prepared)).toEqual({ replayed: true });

    const restartedPrepared = await adapter.prepareRepository({
      repositoryPath,
      approvedBaseRevision: baseRevision,
      checkoutLabel: 'GEF-003-restart',
    });
    const restartedBranch = await adapter.createBranch(restartedPrepared, {
      workspaceId: BINDING.workspaceId,
      runId: 20260316000222,
      storyId: 'GEF-003',
    });
    const restartedCommit = await adapter.commit(restartedBranch, {
      message: 'GEF-003: reviewed change',
      authoredAt: NOW.toISOString(),
    });
    expect(restartedBranch).toMatchObject({ branch: branch.branch, replayed: true });
    expect(restartedCommit).toMatchObject({ headRevision: commit.headRevision, replayed: true });

    const replayPush = await adapter.pushBranch({
      leaseId: LEASE_ID, grant, binding: BINDING, commit: restartedCommit,
    });
    const replayPull = await adapter.createOrUpdatePullRequest({
      leaseId: LEASE_ID,
      grant,
      binding: BINDING,
      commit: restartedCommit,
      title: 'GEF-003 reviewed change',
      body: 'Ready for human review. No merge requested.',
    });
    const replayReview = await adapter.requestReview({
      leaseId: LEASE_ID,
      grant,
      binding: BINDING,
      commit: restartedCommit,
      pullRequest: replayPull,
      users: ['reviewer-one'],
    });
    expect({ replayPush, replayPull, replayReview }).toMatchObject({
      replayPush: { replayed: true, headRevision: commit.headRevision },
      replayPull: { replayed: true, id: firstPull.id, number: firstPull.number },
      replayReview: { replayed: true, users: ['reviewer-one'] },
    });
    expect(state.branches.size).toBe(2);
    expect(state.branches.get('main')).toBe(baseRevision);
    expect(state.branches.get(branch.branch)).toBe(commit.headRevision);
    expect(state.commitWrites).toBe(1);
    expect(state.pullRequestCreates).toBe(1);
    expect(state.pullRequests).toHaveLength(1);
    expect(await git(restartedPrepared.checkoutPath, [
      'rev-list', '--count', `${baseRevision}..${restartedCommit.headRevision}`,
    ])).toBe('1');
    expect(await git(restartedPrepared.checkoutPath, ['show', '-s', '--format=%an <%ae>', restartedCommit.headRevision]))
      .toBe('Rorca Automation <automation@rorca.local>');
    expect(await git(repositoryPath, ['rev-parse', 'main'])).toBe(baseRevision);

    const serializedCalls = JSON.stringify(state.calls);
    expect(serializedCalls).not.toContain(TOKEN);
    expect(serializedCalls).not.toMatch(/\/merge|\/git\/tags|\/releases|\/actions\/secrets|\/deployments|\/branches\/main\/protection|\/settings/);
    expect(state.calls.filter((call) => call.path.startsWith('/git/refs') && call.method === 'PATCH'))
      .toEqual([]);


    const callsBeforeRevokedTokenReuse = state.calls.length;
    leaseActive = false;
    await expect(adapter.observeChecks({ leaseId: LEASE_ID, grant, binding: BINDING, commit }))
      .rejects.toThrow('Installation lease is revoked');
    expect(state.calls).toHaveLength(callsBeforeRevokedTokenReuse);
    expect(await adapter.cleanupRepository(restartedPrepared)).toEqual({ replayed: false });
    await expect(stat(restartedPrepared.checkoutPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await adapter.cleanupRepository(restartedPrepared)).toEqual({ replayed: true });
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test.each([
  'credentials.reveal',
  'protected_branch.push',
  'branch.force_push',
  'pull_request.merge',
  'repository.other.read',
  'actions_secret.read',
  'request.arguments.alter',
  'authority.grant.replay',
  'installation_token.reuse',
  'tag.create',
  'release.create',
  'repository.admin',
  'actions_secret.write',
  'deployment.production',
])('rejects injected GitHub request %s and preserves local delivery as the default', (operation) => {
  expect(() => assertGithubReviewDeliveryOperation(operation)).toThrow('not authorized');
  expect(getDeliveryAdapterCatalog().defaultAdapterId).toBe('local-review-bundle');
  expect(getDeliveryAdapterCatalog().adapters[0]).toMatchObject({
    adapterId: 'local-review-bundle',
    default: true,
    requiresNetwork: false,
  });
});
