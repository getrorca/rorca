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
import { githubRateLimiter } from './github-rate-limiter';
import { logger } from './logger';

// ─── Types ───────────────────────────────────────────────────────────────────

interface GitHubWebhookRow {
  workspace_id: string;
  repo_owner: string;
  repo_name: string;
}

interface StoryCommitRow {
  commit_sha: string;
}

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
    purpose: 'checks',
  });
  return resolved?.token ?? null;
}

/** Get GitHub repo info for a workspace. Returns null if not connected. */
async function getRepoInfo(workspaceId: string): Promise<{ owner: string; repo: string } | null> {
  const row = await queryOne<GitHubWebhookRow>(
    'SELECT repo_owner, repo_name FROM workspace_github_webhooks WHERE workspace_id = $1',
    [workspaceId],
  );
  if (!row) return null;
  return { owner: row.repo_owner, repo: row.repo_name };
}

/** Resolve commit SHA for a story. Falls back to branch HEAD if no story_commits entry. */
async function resolveCommitSha(
  storyId: string,
  specId: string | null,
  runId: number | null,
  workspaceId: string,
): Promise<string | null> {
  // Primary: story_commits table (written by execution-engine.ts after gitCommitStory)
  if (specId) {
    const row = await queryOne<StoryCommitRow>(
      'SELECT commit_sha FROM story_commits WHERE story_id = $1 AND spec_id = $2 ORDER BY pushed_at DESC LIMIT 1',
      [storyId, specId],
    );
    if (row) return row.commit_sha;
  }

  // Fallback: branch HEAD from the workspace/worktree
  return resolveBranchHead(runId, workspaceId);
}

/** Get HEAD SHA for the run's working directory (worktree or workspace root). */
async function resolveBranchHead(runId: number | null, workspaceId: string): Promise<string | null> {
  let cwd: string | null = null;

  if (runId) {
    const run = await queryOne<PipelineRunRow>(
      'SELECT worktree_path, workspace_id FROM pipeline_runs WHERE id = $1',
      [runId],
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

  const url = `https://api.github.com/repos/${owner}/${repo}/statuses/${sha}`;
  const body = {
    state,
    context,
    description: description.slice(0, 140), // GitHub caps at 140 chars
    target_url: targetUrl,
  };

  try {
    const res = await githubRateLimiter.execute(() =>
      fetch(url, {
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
      const text = await res.text();
      logger.warn({ status: res.status }, `[CommitStatus] GitHub API error posting ${state} for ${context}`);
      await logAudit(workspaceId, 'commit_status_failed', res.status, text, { sha, state, context });
    } else {
      logger.info(`[CommitStatus] Posted ${state} for ${context} to ${owner}/${repo}@${sha.slice(0, 7)}`);
      await logAudit(workspaceId, 'commit_status_posted', res.status, null, { sha, state, context });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, `[CommitStatus] Failed to post ${state} for ${context}`);
    await logAudit(workspaceId, 'commit_status_failed', null, message, { sha, state, context });
  }
}

// ─── WAL Event Handler ──────────────────────────────────────────────────────

async function handleWalEvent(event: WalEvent): Promise<void> {
  const { event_type, workspace_id, story_id, spec_id, payload: rawPayload } = event;

  if (!workspace_id || !story_id) return;
  if (event_type !== 'story_started' && event_type !== 'story_passed' && event_type !== 'story_failed') return;

  const payload = rawPayload ? JSON.parse(rawPayload) : {};
  const runId: number | null = typeof payload.run_id === 'number' ? payload.run_id : null;
  const storyTitle: string = (payload.story_title as string) || story_id;

  // Check if GitHub is connected for this workspace
  const repoInfo = await getRepoInfo(workspace_id);
  if (!repoInfo) {
    logger.debug(`[CommitStatus] No GitHub connection for workspace ${workspace_id} — skipping`);
    return;
  }

  const contextStr = `rorca/${story_id}: ${storyTitle}`;
  const targetUrl = buildRunViewUrl(runId);

  if (event_type === 'story_started') {
    // For pending status, use branch HEAD (story hasn't committed yet)
    const sha = await resolveBranchHead(runId, workspace_id);
    if (!sha) {
      logger.debug(`[CommitStatus] No commit SHA for ${story_id} — skipping pending status`);
      return;
    }
    await postStatus(repoInfo.owner, repoInfo.repo, sha, 'pending', contextStr, `Running ${story_id}...`, targetUrl, workspace_id);
  } else if (event_type === 'story_passed') {
    // Story passed — use the committed SHA from story_commits
    const sha = await resolveCommitSha(story_id, spec_id, runId, workspace_id);
    if (!sha) {
      logger.debug(`[CommitStatus] No commit SHA for ${story_id} — skipping success status`);
      return;
    }
    await postStatus(repoInfo.owner, repoInfo.repo, sha, 'success', contextStr, `${story_id} passed`, targetUrl, workspace_id);
  } else if (event_type === 'story_failed') {
    const reason = (payload.reason as string) || 'unknown';
    // For failed stories, try story_commits first (may have partial commits), fall back to HEAD
    const sha = await resolveCommitSha(story_id, spec_id, runId, workspace_id);
    if (!sha) {
      logger.debug(`[CommitStatus] No commit SHA for ${story_id} — skipping failure status`);
      return;
    }
    await postStatus(repoInfo.owner, repoInfo.repo, sha, 'failure', contextStr, `${story_id} failed: ${reason}`, targetUrl, workspace_id);
  }
}

// ─── Startup ─────────────────────────────────────────────────────────────────

/**
 * Subscribe to WAL events and post GitHub commit statuses for story progress.
 * Call once at server startup.
 */
export function startCommitStatusPoster(): void {
  subscribe((event: WalEvent) => {
    handleWalEvent(event).catch((err) => {
      // Never let commit status errors break the event pipeline
      logger.debug({ err }, '[CommitStatus] Error handling WAL event');
    });
  });
  logger.info('[CommitStatus] Commit status poster subscribed to WAL events');
}
