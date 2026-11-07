/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

jest.mock('../../db/index', () => ({
  execute: jest.fn(),
  query: jest.fn(),
  queryOne: jest.fn(),
  transaction: jest.fn(),
}));
jest.mock('../run-closeout-authority', () => ({
  loadHostRunCloseoutReference: jest.fn(),
}));
jest.mock('../github-repository-authority', () => ({
  getGithubRepositoryAuthority: jest.fn(),
  githubRepoApiUrl: jest.fn(),
  assertGithubRef: jest.fn(),
}));
jest.mock('../forgejo-token-credential-provider', () => ({
  getWorkspaceForgejoCredential: jest.fn(),
}));
jest.mock('../forgejo-release-authority', () => ({
  prepareForgejoHostRunReleaseIntent: jest.fn(),
  reconcileForgejoRunReleaseIntent: jest.fn(),
}));
jest.mock('../github-token-resolver', () => ({ resolveWorkspaceGitHubToken: jest.fn() }));
jest.mock('../github-app-credential-provider', () => ({ fetchGithubWithTimeout: jest.fn() }));
jest.mock('../github-rate-limiter', () => ({ githubRateLimiter: { execute: jest.fn() } }));
jest.mock('../github-provider-error', () => ({ githubProviderError: jest.fn() }));

import { queryOne, transaction } from '../../db/index';
import { loadHostRunCloseoutReference } from '../run-closeout-authority';
import { getGithubRepositoryAuthority } from '../github-repository-authority';
import { getWorkspaceForgejoCredential } from '../forgejo-token-credential-provider';
import {
  prepareForgejoHostRunReleaseIntent,
  reconcileForgejoRunReleaseIntent,
} from '../forgejo-release-authority';
import { prepareRunReleaseIntent, reconcileRunReleaseIntent } from '../release-authority';

const SHA = 'a'.repeat(40);
let root: string;
let workspace: string;
let worktree: string;

beforeEach(() => {
  jest.clearAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-forgejo-route-'));
  workspace = path.join(root, 'workspace');
  worktree = path.join(root, 'worktree');
  fs.mkdirSync(workspace);
  fs.mkdirSync(worktree);
  (loadHostRunCloseoutReference as jest.Mock).mockResolvedValue({
    reference: { id: 9001, identityHash: `sha256:${'9'.repeat(64)}` },
    payload: { status: 'done', integrated_revision: SHA, accepted_story_ids: ['STORY-1'] },
    ready: true,
  });
  (getGithubRepositoryAuthority as jest.Mock).mockResolvedValue(null);
  (getWorkspaceForgejoCredential as jest.Mock).mockResolvedValue({ status: 'active' });
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('host release preparation selects the active Forgejo authority when GitHub is absent', async () => {
  const input = {
    hostAuthority: {
      runId: 501,
      workspaceId: 'hermes',
      specId: 'forgejo-route',
      releaseEligible: true,
      finalCommitSha: SHA,
      branchName: 'run/forgejo-route',
      repositoryTopLevel: workspace,
      checkoutPath: worktree,
      expectedStoryIds: ['STORY-1'],
    },
    mergeStrategy: 'draft-pr' as const,
    autoMerge: false,
    externalSend: true,
    expectedDispatchFence: 'dispatch-501',
  };
  const routedIdentity = {
    runId: 501,
    workspaceId: 'hermes',
    specId: 'forgejo-route',
    authorizedSha: SHA,
    branchName: 'run/forgejo-route',
  };
  (prepareForgejoHostRunReleaseIntent as jest.Mock).mockResolvedValue(routedIdentity);

  await expect(prepareRunReleaseIntent(input as never)).resolves.toBe(routedIdentity);
  expect(prepareForgejoHostRunReleaseIntent).toHaveBeenCalledWith(input);
  expect(transaction).not.toHaveBeenCalled();
});

test('generic pending-release reconciliation delegates Forgejo intents', async () => {
  (queryOne as jest.Mock).mockResolvedValue({
    run_id: 501,
    status: 'pending',
    repository_authority_source: 'forgejo-token',
  });
  (reconcileForgejoRunReleaseIntent as jest.Mock).mockResolvedValue({ runId: 501, status: 'completed' });

  await expect(reconcileRunReleaseIntent(501)).resolves.toEqual({ runId: 501, status: 'completed' });
  expect(reconcileForgejoRunReleaseIntent).toHaveBeenCalledWith(501);
});
