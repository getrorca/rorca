/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

jest.mock('../../db/index', () => ({ queryOne: jest.fn() }));

import { queryOne } from '../../db/index';
import { AutonomousPrDeliveryJobPayload } from '../pg-boss-schemas';
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

test('Git/GitHub object authority exposes only the supported 40-hex contract', () => {
  expect(isFullGitObjectId('a'.repeat(40))).toBe(true);
  expect(isFullGitObjectId('A'.repeat(64))).toBe(false);
  expect(AutonomousPrDeliveryJobPayload.safeParse({
    deliveryId: '00000000-0000-4000-8000-000000000001', expectedHeadSha: 'a'.repeat(40),
  }).success).toBe(true);
  expect(AutonomousPrDeliveryJobPayload.safeParse({
    deliveryId: '00000000-0000-4000-8000-000000000001', expectedHeadSha: 'a'.repeat(64),
  }).success).toBe(false);
  expect(isFullGitObjectId('a'.repeat(41))).toBe(false);
  expect(isFullGitObjectId('g'.repeat(40))).toBe(false);
});

test('canonical authority rejects requested repository confusion', async () => {
  (queryOne as jest.Mock).mockResolvedValue({
    workspace_id: 'ws-1', repo_owner: 'acme', repo_name: 'widgets',
    authority_source: 'github-app-installation', authority_status: 'active',
    binding_id: 'binding-1', installation_id: 77, repository_id: 99,
    webhook_configured: true, signed_delivery_observed: false, connected_at: null, last_webhook_at: null,
  });
  await expect(getGithubRepositoryAuthority('ws-1', {
    requireActive: true,
    expectedRepository: { owner: 'acme', name: 'other' },
  })).rejects.toThrow('does not match canonical workspace GitHub authority');
});
