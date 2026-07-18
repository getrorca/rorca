/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

jest.mock('../integration-vault', () => ({ getOAuthToken: jest.fn() }));
jest.mock('../github-app-credential-provider', () => ({
  getWorkspaceGithubAppBinding: jest.fn(),
  resolveRepositoryInstallationToken: jest.fn(),
}));

import { getOAuthToken } from '../integration-vault';
import { getWorkspaceGithubAppBinding, resolveRepositoryInstallationToken } from '../github-app-credential-provider';
import { resolveWorkspaceGitHubToken } from '../github-token-resolver';

const binding = { repoOwner: 'acme', repoName: 'widgets' };
const appToken = {
  token: 'ghs_repo_only',
  metadata: {
    source: 'github-app-installation' as const, bindingId: 'b1', appId: 1, appSlug: 'rorca', installationId: 2,
    repositoryId: 3, repository: { owner: 'acme', name: 'widgets' }, permissions: { checks: 'read' },
    expiresAt: '2026-07-17T13:00:00.000Z',
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GITHUB_TOKEN;
  (getOAuthToken as jest.Mock).mockResolvedValue(null);
  (getWorkspaceGithubAppBinding as jest.Mock).mockResolvedValue(null);
});

test('App binding takes precedence and PAT/OAuth are not consulted', async () => {
  (getWorkspaceGithubAppBinding as jest.Mock).mockResolvedValue(binding);
  (resolveRepositoryInstallationToken as jest.Mock).mockResolvedValue(appToken);
  const result = await resolveWorkspaceGitHubToken('ws-1', {
    repository: { owner: 'acme', name: 'widgets' }, purpose: 'reviewed-delivery',
  });
  expect(result).toEqual({ token: 'ghs_repo_only', source: 'github-app-installation', metadata: appToken.metadata });
  expect(resolveRepositoryInstallationToken).toHaveBeenCalledWith('ws-1', { owner: 'acme', name: 'widgets' }, {
    checks: 'read', statuses: 'read', contents: 'read', pull_requests: 'write',
  });
  expect(getOAuthToken).not.toHaveBeenCalled();
});

test('uncertain App state fails closed without broader fallback', async () => {
  (getWorkspaceGithubAppBinding as jest.Mock).mockResolvedValue(binding);
  (resolveRepositoryInstallationToken as jest.Mock).mockRejectedValue(new Error('installation drift'));
  (getOAuthToken as jest.Mock).mockResolvedValue({ token: 'ghp_broad' });
  process.env.GITHUB_TOKEN = 'ghp_ambient';
  await expect(resolveWorkspaceGitHubToken('ws-1', {
    repository: { owner: 'acme', name: 'widgets' }, purpose: 'checks', allowEnvFallback: true,
  })).rejects.toThrow('installation drift');
  expect(getOAuthToken).not.toHaveBeenCalled();
});

test('explicit workspace PAT remains compatible when no App binding exists', async () => {
  (getOAuthToken as jest.Mock).mockImplementation(async (_workspace: string, _provider: string, type: string) =>
    type === 'api_key' ? { token: 'ghp_workspace' } : null);
  await expect(resolveWorkspaceGitHubToken('ws-1')).resolves.toEqual({
    token: 'ghp_workspace', source: 'workspace-pat', metadata: { fallback: 'explicit-workspace' },
  });
});

test('ambient fallback is denied for sensitive purposes even when requested', async () => {
  process.env.GITHUB_TOKEN = 'ghp_ambient';
  await expect(resolveWorkspaceGitHubToken('ws-1', {
    purpose: 'reviewed-delivery', allowLegacyGlobal: true,
  })).resolves.toBeNull();
  await expect(resolveWorkspaceGitHubToken('ws-1', {
    purpose: 'routine', allowLegacyGlobal: true,
  })).resolves.toEqual({ token: 'ghp_ambient', source: 'legacy-global', metadata: { fallback: 'explicit-legacy-env' } });
});
