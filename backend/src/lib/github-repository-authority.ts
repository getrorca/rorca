/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { queryOne } from '../db/index';
import { ConflictError, NotFoundError, UnprocessableError, ValidationError } from './errors';
import { isGitSha } from './git-sha';

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH = /^(?!\/)(?!.*(?:\.\.|\/\/|@\{|\\|[~^:?*\[]))(?!.*\.$)[A-Za-z0-9._\/-]{1,255}$/;
const GITHUB_API_ORIGIN = 'https://api.github.com';

export type GithubRepositoryAuthoritySource = 'github-app-installation' | 'pat-oauth-fallback';

export interface GithubRepositoryAuthority {
  workspaceId: string;
  owner: string;
  name: string;
  source: GithubRepositoryAuthoritySource;
  status: 'active' | 'disabled' | 'invalid' | 'retired';
  bindingId: string | null;
  installationId: number | null;
  repositoryId: number | null;
  webhookConfigured: boolean;
  signedDeliveryObserved: boolean;
  connectedAt: string | null;
  lastWebhookAt: string | null;
}

interface AuthorityRow {
  workspace_id: string;
  repo_owner: string;
  repo_name: string;
  authority_source: GithubRepositoryAuthoritySource;
  authority_status: GithubRepositoryAuthority['status'];
  binding_id: string | null;
  installation_id: string | number | null;
  repository_id: string | number | null;
  webhook_configured: boolean;
  signed_delivery_observed: boolean;
  connected_at: string | null;
  last_webhook_at: string | null;
}

export function assertGithubRepositoryIdentity(owner: string, name: string): void {
  if (!OWNER.test(owner) || !REPO.test(name)) {
    throw new ValidationError('Invalid GitHub repository owner or name');
  }
}

export function assertGithubRef(ref: string): void {
  if (!BRANCH.test(ref)) throw new ValidationError('Invalid GitHub branch or ref');
}

export const isFullGitObjectId = isGitSha;

export function githubRepoApiUrl(owner: string, name: string, suffix = ''): string {
  assertGithubRepositoryIdentity(owner, name);
  if (suffix && !suffix.startsWith('/')) throw new ValidationError('GitHub API suffix must begin with /');
  if (/[\\\u0000-\u001f\u007f#]/.test(suffix)) throw new ValidationError('GitHub API suffix is invalid');
  const repositoryPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const url = new URL(`${GITHUB_API_ORIGIN}${repositoryPath}${suffix}`);
  if (url.origin !== GITHUB_API_ORIGIN
    || (url.pathname !== repositoryPath && !url.pathname.startsWith(`${repositoryPath}/`))) {
    throw new ValidationError('GitHub API suffix escapes the canonical repository path');
  }
  return url.toString();
}

export async function getGithubRepositoryAuthority(
  workspaceId: string,
  options: { requireActive?: boolean; expectedRepository?: { owner: string; name: string } } = {},
): Promise<GithubRepositoryAuthority | null> {
  const row = await queryOne<AuthorityRow>(
    `SELECT workspace_id, repo_owner, repo_name, authority_source, authority_status,
            binding_id, installation_id, repository_id, webhook_configured,
            signed_delivery_observed, connected_at, last_webhook_at
       FROM github_workspace_repository_authority
      WHERE workspace_id = $1`,
    [workspaceId],
  );
  if (!row) return null;
  assertGithubRepositoryIdentity(row.repo_owner, row.repo_name);
  const authority: GithubRepositoryAuthority = {
    workspaceId: row.workspace_id,
    owner: row.repo_owner,
    name: row.repo_name,
    source: row.authority_source,
    status: row.authority_status,
    bindingId: row.binding_id,
    installationId: row.installation_id == null ? null : Number(row.installation_id),
    repositoryId: row.repository_id == null ? null : Number(row.repository_id),
    webhookConfigured: row.webhook_configured,
    signedDeliveryObserved: row.signed_delivery_observed,
    connectedAt: row.connected_at,
    lastWebhookAt: row.last_webhook_at,
  };
  if (options.expectedRepository
    && (authority.owner.toLowerCase() !== options.expectedRepository.owner.toLowerCase()
      || authority.name.toLowerCase() !== options.expectedRepository.name.toLowerCase())) {
    throw new ConflictError('Requested repository does not match canonical workspace GitHub authority');
  }
  if (options.requireActive && authority.status !== 'active') {
    throw new UnprocessableError('Canonical GitHub repository authority is not active', 'GITHUB_REPOSITORY_AUTHORITY_INACTIVE', {
      source: authority.source,
      status: authority.status,
    });
  }
  return authority;
}

export async function requireGithubRepositoryAuthority(
  workspaceId: string,
  options: { expectedRepository?: { owner: string; name: string } } = {},
): Promise<GithubRepositoryAuthority> {
  const authority = await getGithubRepositoryAuthority(workspaceId, {
    requireActive: true,
    expectedRepository: options.expectedRepository,
  });
  if (!authority) throw new NotFoundError('Connected GitHub repository', workspaceId);
  return authority;
}
