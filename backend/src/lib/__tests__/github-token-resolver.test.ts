/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

jest.mock('../integration-vault', () => ({ getOAuthToken: jest.fn() }));
jest.mock('../github-app-credential-provider', () => ({ resolveRepositoryInstallationToken: jest.fn() }));
jest.mock('../github-repository-authority', () => ({ getGithubRepositoryAuthority: jest.fn() }));

import { getOAuthToken } from '../integration-vault';
import { resolveRepositoryInstallationToken } from '../github-app-credential-provider';
import { getGithubRepositoryAuthority } from '../github-repository-authority';
import { resolveWorkspaceGitHubToken } from '../github-token-resolver';

const appAuthority = { owner: 'acme', name: 'widgets', source: 'github-app-installation', status: 'active' };
const patAuthority = { owner: 'acme', name: 'widgets', source: 'pat-oauth-fallback', status: 'active' };
const appToken = {
  token: 'ghs_repo_only',
  metadata: {
    source: 'github-app-installation' as const, bindingId: 'b1', appId: 1, appSlug: 'rorca', installationId: 2,
    repositoryId: 3, repository: { owner: 'acme', name: 'widgets' }, permissions: { metadata: 'read', checks: 'read' },
    expiresAt: '2026-07-17T13:00:00.000Z',
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GITHUB_TOKEN;
  (getOAuthToken as jest.Mock).mockResolvedValue(null);
  (getGithubRepositoryAuthority as jest.Mock).mockResolvedValue(null);
});

test('App authority takes precedence and PAT/OAuth are not consulted', async () => {
  (getGithubRepositoryAuthority as jest.Mock).mockResolvedValue(appAuthority);
  (resolveRepositoryInstallationToken as jest.Mock).mockResolvedValue(appToken);
  const result = await resolveWorkspaceGitHubToken('ws-1', {
    repository: { owner: 'acme', name: 'widgets' }, purpose: 'reviewed-delivery',
  });
  expect(result).toEqual({ token: 'ghs_repo_only', source: 'github-app-installation', metadata: appToken.metadata });
  expect(resolveRepositoryInstallationToken).toHaveBeenCalledWith('ws-1', { owner: 'acme', name: 'widgets' }, {
    checks: 'read', contents: 'read', pull_requests: 'read', statuses: 'read',
  });
  expect(getOAuthToken).not.toHaveBeenCalled();
});

test('uncertain App state fails closed without broader fallback', async () => {
  (getGithubRepositoryAuthority as jest.Mock).mockResolvedValue(appAuthority);
  (resolveRepositoryInstallationToken as jest.Mock).mockRejectedValue(new Error('installation drift'));
  (getOAuthToken as jest.Mock).mockResolvedValue({ token: 'ghp_broad' });
  process.env.GITHUB_TOKEN = 'ghp_ambient';
  await expect(resolveWorkspaceGitHubToken('ws-1', {
    repository: { owner: 'acme', name: 'widgets' }, purpose: 'checks', allowEnvFallback: true,
  })).rejects.toThrow('installation drift');
  expect(getOAuthToken).not.toHaveBeenCalled();
});

test('explicit workspace PAT remains compatible only under canonical exact-repo authority', async () => {
  (getGithubRepositoryAuthority as jest.Mock).mockResolvedValue(patAuthority);
  (getOAuthToken as jest.Mock).mockImplementation(async (_workspace: string, _provider: string, type: string) =>
    type === 'api_key' ? { token: 'ghp_workspace' } : null);
  await expect(resolveWorkspaceGitHubToken('ws-1', { repository: { owner: 'acme', name: 'widgets' } })).resolves.toEqual({
    token: 'ghp_workspace', source: 'workspace-pat',
    metadata: { fallback: 'explicit-workspace', repository: { owner: 'acme', name: 'widgets' } },
  });
  expect(getGithubRepositoryAuthority).toHaveBeenCalledWith('ws-1', {
    requireActive: true, expectedRepository: { owner: 'acme', name: 'widgets' },
  });
});

test('ambient credentials are never accepted as repository authority', async () => {
  process.env.GITHUB_TOKEN = 'ghp_ambient';
  await expect(resolveWorkspaceGitHubToken('ws-1', {
    purpose: 'reviewed-delivery', allowLegacyGlobal: true,
  })).resolves.toBeNull();
  await expect(resolveWorkspaceGitHubToken('ws-1', {
    purpose: 'routine', allowLegacyGlobal: true,
  })).resolves.toBeNull();
  expect(getOAuthToken).not.toHaveBeenCalled();
});
