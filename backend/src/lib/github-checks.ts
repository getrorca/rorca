/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { resolveWorkspaceGitHubToken } from './github-token-resolver';
import { logger } from './logger';
import { githubRateLimiter } from './github-rate-limiter';
import { githubRepoApiUrl, isFullGitObjectId } from './github-repository-authority';
import { fetchGithubWithTimeout } from './github-app-credential-provider';
import { extractGithubProviderError, sanitizeGithubProviderException } from './github-provider-error';

export type CheckState = 'pending' | 'success' | 'failure' | 'error';

export const CHECK_NAME = 'rorca/spec-compliance';
/** Manual operator evidence is intentionally excluded from governed delivery. */
export const MANUAL_CHECK_NAME = 'rorca/manual-spec-compliance';

// ─── GitHub token resolution ─────────────────────────────────────────────────

/** Resolve only the purpose-narrow credential bound to this workspace/repository. */
async function getGithubToken(
  workspaceId: string,
  owner: string,
  repo: string,
  purpose: 'pulls-read' | 'statuses-write',
): Promise<string | null> {
  const resolved = await resolveWorkspaceGitHubToken(workspaceId, {
    repository: { owner, name: repo },
    purpose,
  });
  return resolved?.token ?? null;
}

// ─── Post commit status ──────────────────────────────────────────────────────

/**
 * Post a commit status check to GitHub via the Statuses API.
 * Uses POST /repos/{owner}/{repo}/statuses/{sha}
 */
export async function postCommitStatus(
  owner: string,
  repo: string,
  sha: string,
  state: CheckState,
  description: string,
  targetUrl?: string,
  workspaceId?: string,
  context = CHECK_NAME,
): Promise<boolean> {
  if (!workspaceId) {
    logger.error('[Checks] Workspace authority is required to post commit status');
    return false;
  }
  if (!isFullGitObjectId(sha)) {
    logger.error('[Checks] Full immutable commit SHA is required to post commit status');
    return false;
  }
  const token = await getGithubToken(workspaceId, owner, repo, 'statuses-write');
  if (!token) {
    logger.error('[Checks] No GitHub token available to post commit status');
    return false;
  }

  const url = githubRepoApiUrl(owner, repo, `/statuses/${sha}`);
  const body: Record<string, string> = {
    state,
    context,
    description: description.slice(0, 140), // GitHub caps at 140 chars
  };
  if (targetUrl) {
    body.target_url = targetUrl;
  }

  try {
    const res = await githubRateLimiter.execute(() =>
      fetchGithubWithTimeout(fetch, url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify(body),
      }),
    );

    if (!res.ok) {
      const providerError = extractGithubProviderError(res, 'GITHUB_MANUAL_STATUS_FAILED');
      logger.error({ providerError }, `[Checks] GitHub status API error (${res.status})`);
      return false;
    }

    logger.info(`[Checks] Posted ${state} status to ${owner}/${repo}@${sha.slice(0, 7)}`);
    return true;
  } catch (err) {
    const providerError = sanitizeGithubProviderException(err, 'GITHUB_MANUAL_STATUS_FAILED');
    logger.error({ providerError }, '[Checks] Failed to post commit status');
    return false;
  }
}

// ─── Fetch PR changed files ─────────────────────────────────────────────────

interface PrFile {
  filename: string;
  patch?: string;
}

// ─── Acceptance criteria coverage detection ──────────────────────────────────

/**
 * Extract keywords from an acceptance criterion string.
 * Strips common filler words and returns lowercase tokens.
 */
function extractKeywords(criterion: string): string[] {
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'need', 'must',
    'and', 'or', 'but', 'if', 'then', 'else', 'when', 'where', 'that',
    'this', 'these', 'those', 'it', 'its', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'as', 'into', 'not', 'no',
    'all', 'each', 'every', 'any', 'both', 'such', 'than', 'too',
    'so', 'only', 'very', 'just', 'also', 'about', 'up', 'out',
    'given', 'user', 'system', 'i', 'me', 'my', 'we', 'they',
  ]);

  return criterion
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));
}

export interface CriterionCoverage {
  criterion: string;
  covered: boolean;
  matchedKeywords: string[];
}

/**
 * Check whether PR changed files contain keywords matching each acceptance criterion.
 * A criterion is considered covered if at least 2 of its keywords appear in the
 * combined content of changed filenames + patches.
 */
export function checkCriteriaCoverage(
  criteria: string[],
  changedFiles: PrFile[],
): CriterionCoverage[] {
  // Build a searchable text blob from file names and patches
  const searchText = changedFiles
    .map(f => `${f.filename}\n${f.patch || ''}`)
    .join('\n')
    .toLowerCase();

  return criteria.map(criterion => {
    const keywords = extractKeywords(criterion);
    if (keywords.length === 0) {
      return { criterion, covered: true, matchedKeywords: [] };
    }

    const matchedKeywords = keywords.filter(kw => searchText.includes(kw));
    // Require at least 2 keyword matches, or all keywords if there are fewer than 2
    const threshold = Math.min(2, keywords.length);
    const covered = matchedKeywords.length >= threshold;

    return { criterion, covered, matchedKeywords };
  });
}

// ─── Retired automatic PR status compatibility export ──────────────────────

export interface CheckResult {
  state: CheckState;
  description: string;
  criteria: CriterionCoverage[];
  storyIds: string[];
  specId: string | null;
}

/**
 * Retained for source compatibility. PR webhook events never invoke provider mutation.
 */
export async function evaluatePrAndPostCheck(
  _owner: string,
  _repo: string,
  prNumber: number,
  _headSha: string,
  _prTitle: string,
  _branchName: string,
  _workspaceId: string,
): Promise<CheckResult | null> {
  // Compatibility export only. Automatic PR status mutation is retired; the
  // durable terminal Check Run reconciler is the sole automatic projector.
  logger.info(`[Checks] Automatic PR #${prNumber} status evaluation is disabled`);
  return null;
}
