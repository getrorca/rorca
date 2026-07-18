/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Canonical workspace/repository GitHub credential resolver.
 *
 * A configured GitHub App binding always wins. Its installation token is minted
 * for exactly one immutable repository. If that binding is stale, mismatched, or
 * unavailable, resolution fails closed: a broader PAT/OAuth/env credential is
 * never silently substituted. PAT/OAuth remain an explicit migration fallback
 * only when the workspace has no App binding.
 */
import { getOAuthToken } from './integration-vault';
import {
  getWorkspaceGithubAppBinding,
  resolveRepositoryInstallationToken,
  type GithubAppTokenMetadata,
} from './github-app-credential-provider';
import { ValidationError } from './errors';

export type GitHubTokenSource =
  | 'github-app-installation'
  | 'workspace-oauth'
  | 'workspace-pat'
  | 'legacy-global';

export interface ResolvedGitHubToken {
  token: string;
  source: GitHubTokenSource;
  metadata?: GithubAppTokenMetadata | { fallback: 'explicit-workspace' | 'explicit-legacy-env' };
}

export type GithubCredentialPurpose = 'routine' | 'checks' | 'reviewed-delivery';

export interface ResolveWorkspaceGitHubTokenOptions {
  /** Exact repository authority expected by the caller. */
  repository?: { owner: string; name: string };
  /** Checks and reviewed delivery apply stricter permissions and disable env fallback. */
  purpose?: GithubCredentialPurpose;
  /** Allow the legacy global GITHUB_TOKEN only for non-sensitive migration endpoints. */
  allowLegacyGlobal?: boolean;
  /** Compatibility alias for allowLegacyGlobal. */
  allowEnvFallback?: boolean;
}

function requiredPermissions(purpose: GithubCredentialPurpose): Record<string, 'read' | 'write'> {
  if (purpose === 'checks') {
    return { checks: 'write', statuses: 'write', contents: 'read', pull_requests: 'read' };
  }
  if (purpose === 'reviewed-delivery') {
    return { checks: 'read', statuses: 'read', contents: 'read', pull_requests: 'write' };
  }
  return {};
}

export async function resolveWorkspaceGitHubToken(
  workspaceId: string,
  options: ResolveWorkspaceGitHubTokenOptions = {},
): Promise<ResolvedGitHubToken | null> {
  const purpose = options.purpose ?? 'routine';
  const binding = await getWorkspaceGithubAppBinding(workspaceId);
  if (binding) {
    const repository = options.repository ?? { owner: binding.repoOwner, name: binding.repoName };
    const installation = await resolveRepositoryInstallationToken(
      workspaceId,
      repository,
      requiredPermissions(purpose),
    );
    if (!installation) {
      // A binding was observed immediately before resolution. Disappearance is
      // uncertain authority, not permission to escalate to an ambient token.
      throw new ValidationError('GitHub App binding changed during credential resolution');
    }
    return {
      token: installation.token,
      source: 'github-app-installation',
      metadata: installation.metadata,
    };
  }

  // Explicit workspace OAuth/PAT fallback during migration.
  const oauth = await getOAuthToken(workspaceId, 'github', 'oauth_access');
  if (oauth?.token) {
    return { token: oauth.token, source: 'workspace-oauth', metadata: { fallback: 'explicit-workspace' } };
  }
  const apiKey = await getOAuthToken(workspaceId, 'github', 'api_key');
  if (apiKey?.token) {
    return { token: apiKey.token, source: 'workspace-pat', metadata: { fallback: 'explicit-workspace' } };
  }

  // Ambient credentials are never valid for Checks or reviewed delivery.
  if (purpose === 'routine' && (options.allowLegacyGlobal || options.allowEnvFallback)) {
    const envToken = process.env.GITHUB_TOKEN;
    if (envToken && envToken.trim().length > 0) {
      return { token: envToken.trim(), source: 'legacy-global', metadata: { fallback: 'explicit-legacy-env' } };
    }
  }
  return null;
}
