/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Canonical exact-repository GitHub credential resolver. */
import { getOAuthToken } from './integration-vault';
import { resolveRepositoryInstallationToken, type GithubAppTokenMetadata, type GithubPermissionRequest } from './github-app-credential-provider';
import { getGithubRepositoryAuthority } from './github-repository-authority';

export type GitHubTokenSource = 'github-app-installation' | 'workspace-oauth' | 'workspace-pat';
export interface ResolvedGitHubToken {
  token: string;
  source: GitHubTokenSource;
  metadata?: GithubAppTokenMetadata | { fallback: 'explicit-workspace'; repository: { owner: string; name: string } };
}

export type GithubCredentialPurpose =
  | 'repository-read'
  | 'checks-write'
  | 'statuses-write'
  | 'pulls-read'
  | 'pulls-write'
  | 'reviewed-delivery'
  | 'merge'
  | 'workflow-read'
  | 'workflow-dispatch'
  | 'issues-read'
  | 'routine' // compatibility alias for repository-read
  | 'checks'; // compatibility alias for statuses-write + checks-write

export interface ResolveWorkspaceGitHubTokenOptions {
  repository?: { owner: string; name: string };
  purpose?: GithubCredentialPurpose;
  /** Deprecated and intentionally ignored: ambient credentials are not repository authority. */
  allowLegacyGlobal?: boolean;
  /** Deprecated and intentionally ignored: ambient credentials are not repository authority. */
  allowEnvFallback?: boolean;
}

export function githubPermissionsForPurpose(purpose: GithubCredentialPurpose): GithubPermissionRequest {
  switch (purpose) {
    case 'checks': return { checks: 'write', statuses: 'write' };
    case 'checks-write': return { checks: 'write' };
    case 'statuses-write': return { statuses: 'write' };
    case 'pulls-read': return { pull_requests: 'read' };
    case 'pulls-write': return { pull_requests: 'write' };
    case 'reviewed-delivery': return { checks: 'read', contents: 'read', pull_requests: 'read', statuses: 'read' };
    case 'merge': return { contents: 'write', pull_requests: 'write' };
    case 'workflow-read': return { actions: 'read' };
    case 'workflow-dispatch': return { actions: 'write' };
    case 'issues-read': return { issues: 'read' };
    case 'routine':
    case 'repository-read':
    default: return { contents: 'read' };
  }
}

export async function resolveWorkspaceGitHubToken(
  workspaceId: string,
  options: ResolveWorkspaceGitHubTokenOptions = {},
): Promise<ResolvedGitHubToken | null> {
  const authority = await getGithubRepositoryAuthority(workspaceId, { requireActive: true, expectedRepository: options.repository });
  if (!authority) return null;
  const repository = { owner: authority.owner, name: authority.name };
  const purpose = options.purpose ?? 'repository-read';

  if (authority.source === 'github-app-installation') {
    const installation = await resolveRepositoryInstallationToken(
      workspaceId,
      repository,
      githubPermissionsForPurpose(purpose),
    );
    if (!installation) return null;
    return { token: installation.token, source: 'github-app-installation', metadata: installation.metadata };
  }

  const oauth = await getOAuthToken(workspaceId, 'github', 'oauth_access');
  if (oauth?.token) {
    return { token: oauth.token, source: 'workspace-oauth', metadata: { fallback: 'explicit-workspace', repository } };
  }
  const apiKey = await getOAuthToken(workspaceId, 'github', 'api_key');
  if (apiKey?.token) {
    return { token: apiKey.token, source: 'workspace-pat', metadata: { fallback: 'explicit-workspace', repository } };
  }
  return null;
}
