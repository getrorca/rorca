/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Resolve the GitHub token to use for a given workspace.
 *
 * Resolution order (highest precedence first):
 *   1. Workspace OAuth access token (integration_tokens, token_type='oauth_access')
 *   2. Workspace personal access token / API key (integration_tokens, token_type='api_key')
 *   3. Legacy global token in the env (GITHUB_TOKEN) — only when allowLegacyGlobal
 *      or allowEnvFallback is set, so read-only endpoints can opt in.
 *
 * Returns null when no usable token is found, so callers can degrade to an
 * "unconfigured / not connected" state rather than throwing.
 */
import { getOAuthToken } from './integration-vault';

export type GitHubTokenSource =
  | 'workspace-oauth'
  | 'workspace-pat'
  | 'legacy-global';

export interface ResolvedGitHubToken {
  token: string;
  source: GitHubTokenSource;
}

export interface ResolveWorkspaceGitHubTokenOptions {
  /** Allow falling back to a legacy global token (GITHUB_TOKEN env). */
  allowLegacyGlobal?: boolean;
  /** Allow falling back to the GITHUB_TOKEN env var. */
  allowEnvFallback?: boolean;
}

export async function resolveWorkspaceGitHubToken(
  workspaceId: string,
  options: ResolveWorkspaceGitHubTokenOptions = {},
): Promise<ResolvedGitHubToken | null> {
  // 1. Workspace OAuth access token.
  const oauth = await getOAuthToken(workspaceId, 'github', 'oauth_access');
  if (oauth?.token) {
    return { token: oauth.token, source: 'workspace-oauth' };
  }

  // 2. Workspace personal access token / API key.
  const apiKey = await getOAuthToken(workspaceId, 'github', 'api_key');
  if (apiKey?.token) {
    return { token: apiKey.token, source: 'workspace-pat' };
  }

  // 3. Legacy global env token, only when explicitly permitted.
  if (options.allowLegacyGlobal || options.allowEnvFallback) {
    const envToken = process.env.GITHUB_TOKEN;
    if (envToken && envToken.trim().length > 0) {
      return { token: envToken.trim(), source: 'legacy-global' };
    }
  }

  return null;
}
