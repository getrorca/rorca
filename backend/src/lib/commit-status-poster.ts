/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * US-027: Post GitHub commit status checks for each story as it progresses through the pipeline.
 *
 * Subscribes to WAL events (story_started, story_passed, story_failed) and posts
 * commit statuses to the GitHub Statuses API. Uses the existing GitHubRateLimiter
 * for rate limit compliance.
 *
 * Error tolerance is critical: GitHub API failures NEVER block pipeline execution.
 * All failures are logged to integration_audit_log table.
 */

import { execSync } from 'child_process';
import { subscribe, type WalEvent } from './sse-hub';
import { queryOne, execute } from '../db/index';
import { resolveWorkspaceGitHubToken } from './github-token-resolver';
import { getGithubRepositoryAuthority, githubRepoApiUrl, isFullGitObjectId } from './github-repository-authority';
import { fetchGithubWithTimeout } from './github-app-credential-provider';
import { githubRateLimiter } from './github-rate-limiter';
import { logger } from './logger';
import {
  extractGithubProviderError,
  formatGithubProviderError,
  sanitizeGithubProviderException,
} from './github-provider-error';
import {
  authorizeCanonicalWalEvent,
  authorizeStoryPassEvent,
  authorizeTerminalStoryEvent,
} from './github-poster-authority';

// ─── Types ───────────────────────────────────────────────────────────────────

interface PipelineRunRow {
  id: number;
  worktree_path: string | null;
  branch_name: string | null;
  workspace_id: string;
}

interface WorkspaceRow {
  path: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Get only the credential bound to this workspace/repository. */
async function getGithubToken(workspaceId: string, owner: string, repo: string): Promise<string | null> {
  const resolved = await resolveWorkspaceGitHubToken(workspaceId, {
    repository: { owner, name: repo },
    purpose: 'statuses-write',
  });
  return resolved?.token ?? null;
}

/** Get GitHub repo info for a workspace. Returns null if not connected. */
async function getRepoInfo(workspaceId: string): Promise<{ owner: string; repo: string } | null> {
  const authority = await getGithubRepositoryAuthority(workspaceId, { requireActive: true });
  return authority ? { owner: authority.owner, repo: authority.name } : null;
}

/** Get HEAD SHA for the run's working directory (worktree or workspace root). */
async function resolveBranchHead(runId: number | null, workspaceId: string): Promise<string | null> {
  let cwd: string | null = null;

  if (runId) {
    const run = await queryOne<PipelineRunRow>(
      'SELECT worktree_path, workspace_id FROM pipeline_runs WHERE id = $1 AND workspace_id = $2',
      [runId, workspaceId],
    );
    if (run?.worktree_path) {
      cwd = run.worktree_path;
    }
  }

  if (!cwd) {
    const ws = await queryOne<WorkspaceRow>('SELECT path FROM workspaces WHERE id = $1', [workspaceId]);
    if (ws) cwd = ws.path;
  }

  if (!cwd) return null;

  try {
    return execSync('git rev-parse HEAD', { cwd, encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

/** Build target_url pointing to the Run View. */
function buildRunViewUrl(runId: number | null): string {
  const baseUrl = process.env.RORCA_BASE_URL || 'http://localhost:5210';
  if (runId) return `${baseUrl}/runs/${runId}`;
  return baseUrl;
}

/** Log an integration API call result to integration_audit_log. */
async function logAudit(
  workspaceId: string,
  eventType: string,
  statusCode: number | null,
  errorMessage: string | null,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await execute(
      `INSERT INTO integration_audit_log (workspace_id, provider, event_type, status_code, error_message, payload)
       VALUES ($1, 'github', $2, $3, $4, $5)`,
      [workspaceId, eventType, statusCode, errorMessage, JSON.stringify(payload)],
    );
  } catch (err) {
    logger.debug({ err }, '[CommitStatus] Failed to write audit log');
  }
}

/** Post a commit status to GitHub, logging success/failure to audit log. */
async function postStatus(
  owner: string,
  repo: string,
  sha: string,
  state: 'pending' | 'success' | 'failure' | 'error',
  context: string,
  description: string,
  targetUrl: string,
  workspaceId: string,
): Promise<void> {
  const token = await getGithubToken(workspaceId, owner, repo);
  if (!token) {
    logger.debug('[CommitStatus] No GitHub token — skipping status post');
    return;
  }

  const url = githubRepoApiUrl(owner, repo, `/statuses/${sha}`);
  const body = {
    state,
    context,
    description: description.slice(0, 140), // GitHub caps at 140 chars
    target_url: targetUrl,
  };

  try {
    const res = await githubRateLimiter.execute(() =>
      fetchGithubWithTimeout(fetch, url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify(body),
      }),
    );

    if (!res.ok) {
      const providerError = extractGithubProviderError(res, 'GITHUB_COMMIT_STATUS_FAILED');
      logger.warn({ providerError }, `[CommitStatus] GitHub API error posting ${state} for ${context}`);
      await logAudit(workspaceId, 'commit_status_failed', res.status, formatGithubProviderError(providerError), { sha, state, context, providerRequestId: providerError.requestId });
    } else {
      logger.info(`[CommitStatus] Posted ${state} for ${context} to ${owner}/${repo}@${sha.slice(0, 7)}`);
      await logAudit(workspaceId, 'commit_status_posted', res.status, null, { sha, state, context });
    }
  } catch (err) {
    const providerError = sanitizeGithubProviderException(err, 'GITHUB_COMMIT_STATUS_FAILED');
    logger.warn({ providerError }, `[CommitStatus] Failed to post ${state} for ${context}`);
    await logAudit(workspaceId, 'commit_status_failed', null, formatGithubProviderError(providerError), { sha, state, context });
  }
}

// ─── WAL Event Handler ──────────────────────────────────────────────────────

export async function handleCommitStatusWalEvent(event: WalEvent): Promise<void> {
  const { event_type, story_id } = event;
  if (!story_id || !['story_started', 'story_passed', 'story_failed'].includes(event_type)) return;

  // Finish every local trust, ownership, closeout, and commit check before even
  // resolving repository authority or an App/PAT token.
  const authorized = event_type === 'story_passed'
    ? await authorizeStoryPassEvent(event)
    : event_type === 'story_failed'
      ? await authorizeTerminalStoryEvent(event)
      : await authorizeCanonicalWalEvent(event);
  if (!authorized) return;
  if (event_type === 'story_started'
    && (authorized.run.status !== 'running'
      || !['starting', 'pty_attached', 'running'].includes(authorized.run.lifecycleStatus))) {
    return;
  }

  const workspaceId = authorized.run.workspaceId;
  const runId = authorized.run.id;
  const payload = authorized.payload;
  const storyTitle = typeof payload.story_title === 'string' ? payload.story_title : story_id;
  let sha: string | null = null;
  if (event_type === 'story_passed') {
    sha = (authorized as Awaited<ReturnType<typeof authorizeStoryPassEvent>>)?.commitSha ?? null;
  } else {
    sha = await resolveBranchHead(runId, workspaceId);
  }
  if (!isFullGitObjectId(sha)) return;

  const repoInfo = await getRepoInfo(workspaceId);
  if (!repoInfo) {
    logger.debug(`[CommitStatus] No GitHub connection for workspace ${workspaceId} — skipping`);
    return;
  }
  const contextStr = `rorca/${story_id}: ${storyTitle}`;
  const targetUrl = buildRunViewUrl(runId);
  if (event_type === 'story_started') {
    await postStatus(repoInfo.owner, repoInfo.repo, sha, 'pending', contextStr, `Running ${story_id}...`, targetUrl, workspaceId);
  } else if (event_type === 'story_passed') {
    await postStatus(repoInfo.owner, repoInfo.repo, sha, 'success', contextStr, `${story_id} passed`, targetUrl, workspaceId);
  } else {
    const reason = typeof payload.reason === 'string' ? payload.reason : 'unknown';
    await postStatus(repoInfo.owner, repoInfo.repo, sha, 'failure', contextStr, `${story_id} failed: ${reason}`, targetUrl, workspaceId);
  }
}

// ─── Startup ─────────────────────────────────────────────────────────────────

/**
 * Subscribe to WAL events and post GitHub commit statuses for story progress.
 * Call once at server startup.
 */
export function startCommitStatusPoster(): void {
  subscribe((event: WalEvent) => {
    handleCommitStatusWalEvent(event).catch((err) => {
      // Never let commit status errors break the event pipeline
      logger.debug({ err }, '[CommitStatus] Error handling WAL event');
    });
  });
  logger.info('[CommitStatus] Commit status poster subscribed to WAL events');
}
