/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

jest.mock('../../db/index', () => ({ queryOne: jest.fn() }));

import { queryOne } from '../../db/index';
import {
  getGithubRepositoryAuthority,
  githubRepoApiUrl,
  isFullGitObjectId,
} from '../github-repository-authority';

beforeEach(() => jest.clearAllMocks());

test('repository API URLs cannot escape the validated canonical repository path', () => {
  expect(githubRepoApiUrl('acme', 'widgets', '/issues/12')).toBe('https://api.github.com/repos/acme/widgets/issues/12');
  expect(githubRepoApiUrl('acme', 'widgets', '/pulls?state=open')).toBe('https://api.github.com/repos/acme/widgets/pulls?state=open');
  expect(() => githubRepoApiUrl('acme', 'widgets', '/../user')).toThrow('escapes the canonical repository path');
  expect(() => githubRepoApiUrl('acme', 'widgets', '/hooks\\..\\user')).toThrow('suffix is invalid');
  expect(() => githubRepoApiUrl('..', 'widgets')).toThrow('Invalid GitHub repository');
});

test('full object ids accept only 40 or 64 hexadecimal characters', () => {
  expect(isFullGitObjectId('a'.repeat(40))).toBe(true);
  expect(isFullGitObjectId('A'.repeat(64))).toBe(true);
  expect(isFullGitObjectId('a'.repeat(41))).toBe(false);
  expect(isFullGitObjectId('g'.repeat(40))).toBe(false);
});

test('canonical authority rejects requested repository confusion', async () => {
  (queryOne as jest.Mock).mockResolvedValue({
    workspace_id: 'ws-1', repo_owner: 'acme', repo_name: 'widgets',
    authority_source: 'github-app-installation', authority_status: 'active',
    binding_id: 'binding-1', installation_id: 77, repository_id: 99,
    webhook_verified: true, connected_at: null, last_webhook_at: null,
    auto_pr_enabled: false, auto_pr_target_branch: 'main', auto_pr_reviewers: [], workflow_config: null,
  });
  await expect(getGithubRepositoryAuthority('ws-1', {
    requireActive: true,
    expectedRepository: { owner: 'acme', name: 'other' },
  })).rejects.toThrow('does not match canonical workspace GitHub authority');
});
