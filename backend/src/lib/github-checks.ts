import * as fs from 'fs';
import * as path from 'path';
import { queryOne } from '../db/index';
import { decryptToken } from '../lib/auth-utils';
import { broadcastAll, type WalEvent } from './sse-hub';
import { logger } from './logger';
import { githubRateLimiter } from './github-rate-limiter';

// ─── Types ───────────────────────────────────────────────────────────────────

interface WorkspaceRow {
  id: string;
  label: string;
  path: string;
}

interface UserStory {
  id: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
  passes?: boolean;
  [key: string]: unknown;
}

interface GitHubConnectionRow {
  encrypted_token: string;
}

export type CheckState = 'pending' | 'success' | 'failure' | 'error';

export const CHECK_NAME = 'rorca/spec-compliance';

// ─── GitHub token resolution ─────────────────────────────────────────────────

/**
 * Resolve a GitHub access token for API calls.
 * Looks up the first github_connection in the DB (user OAuth token).
 */
async function getGithubToken(): Promise<string | null> {
  const row = await queryOne<GitHubConnectionRow>(
    'SELECT encrypted_token FROM github_connections LIMIT 1'
  );
  if (!row) return null;
  return decryptToken(row.encrypted_token);
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
): Promise<boolean> {
  const token = await getGithubToken();
  if (!token) {
    logger.error('[Checks] No GitHub token available to post commit status');
    return false;
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/statuses/${sha}`;
  const body: Record<string, string> = {
    state,
    context: CHECK_NAME,
    description: description.slice(0, 140), // GitHub caps at 140 chars
  };
  if (targetUrl) {
    body.target_url = targetUrl;
  }

  try {
    const res = await githubRateLimiter.execute(() =>
      fetch(url, {
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
      const text = await res.text();
      logger.error({ text }, `[Checks] GitHub status API error (${res.status})`);
      return false;
    }

    logger.info(`[Checks] Posted ${state} status to ${owner}/${repo}@${sha.slice(0, 7)}`);
    return true;
  } catch (err) {
    logger.error({ err }, '[Checks] Failed to post commit status');
    return false;
  }
}

// ─── Fetch PR changed files ─────────────────────────────────────────────────

interface PrFile {
  filename: string;
  patch?: string;
}

async function fetchPrChangedFiles(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<PrFile[]> {
  const token = await getGithubToken();
  if (!token) return [];

  const files: PrFile[] = [];
  let page = 1;
  const perPage = 100;

  // Fetch up to 3 pages (300 files) to avoid excessive API calls
  while (page <= 3) {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=${perPage}&page=${page}`;
    try {
      const res = await githubRateLimiter.execute(() =>
        fetch(url, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        }),
      );
      if (!res.ok) break;
      const pageFiles = await res.json() as PrFile[];
      files.push(...pageFiles);
      if (pageFiles.length < perPage) break;
      page++;
    } catch {
      break;
    }
  }

  return files;
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

// ─── Main handler: evaluate PR and post status ───────────────────────────────

export interface CheckResult {
  state: CheckState;
  description: string;
  criteria: CriterionCoverage[];
  storyIds: string[];
  specId: string | null;
}

/**
 * Evaluate a PR against linked story acceptance criteria and post a GitHub status check.
 * Called when a PR is opened or updated (synchronize).
 */
export async function evaluatePrAndPostCheck(
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  prTitle: string,
  branchName: string,
  workspaceId: string,
): Promise<CheckResult | null> {
  // Import extractStoryIds from webhook-handlers (avoiding circular dep)
  const { extractStoryIds } = require('../routes/webhook-handlers');
  const storyIds: string[] = extractStoryIds(prTitle, branchName);

  if (storyIds.length === 0) {
    logger.info(`[Checks] No story IDs in PR #${prNumber}, skipping check`);
    return null;
  }

  // Look up workspace to find spec files
  const workspace = await queryOne<WorkspaceRow>(
    'SELECT * FROM workspaces WHERE id = $1',
    [workspaceId],
  );
  if (!workspace) {
    logger.error(`[Checks] Workspace ${workspaceId} not found`);
    return null;
  }

  // Find matching specs and stories
  const allCriteria: string[] = [];
  let specId: string | null = null;
  const storyIdSet = new Set(storyIds);

  for (const subdir of ['approved', 'pending']) {
    const dir = path.join(workspace.path, 'forge', 'specs', subdir);
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    } catch {
      continue;
    }

    for (const file of files) {
      try {
        const content = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        const stories: UserStory[] = content.userStories ?? [];
        for (const story of stories) {
          if (storyIdSet.has(story.id) && story.acceptanceCriteria) {
            allCriteria.push(...story.acceptanceCriteria);
            if (!specId) specId = file.replace('.json', '');
          }
        }
      } catch {
        // Skip malformed files
      }
    }
  }

  if (allCriteria.length === 0) {
    logger.info(`[Checks] No acceptance criteria found for stories: ${storyIds.join(', ')}`);
    // Post a neutral success since there's nothing to check
    const result: CheckResult = {
      state: 'success',
      description: 'No acceptance criteria to verify',
      criteria: [],
      storyIds,
      specId,
    };
    await postCommitStatus(owner, repo, headSha, 'success', result.description, buildTargetUrl(workspaceId, specId, storyIds[0]));
    await emitCheckWalEvent(workspaceId, headSha, result);
    return result;
  }

  // Post pending status while we analyze
  await postCommitStatus(
    owner, repo, headSha, 'pending',
    `Checking ${allCriteria.length} acceptance criteria...`,
    buildTargetUrl(workspaceId, specId, storyIds[0]),
  );

  // Fetch changed files from the PR
  const changedFiles = await fetchPrChangedFiles(owner, repo, prNumber);

  // Evaluate coverage
  const coverage = checkCriteriaCoverage(allCriteria, changedFiles);
  const coveredCount = coverage.filter(c => c.covered).length;
  const totalCount = coverage.length;
  const allCovered = coveredCount === totalCount;

  const state: CheckState = allCovered ? 'success' : 'failure';
  const description = allCovered
    ? `All ${totalCount} acceptance criteria covered`
    : `${coveredCount}/${totalCount} acceptance criteria covered`;

  const targetUrl = buildTargetUrl(workspaceId, specId, storyIds[0]);

  await postCommitStatus(owner, repo, headSha, state, description, targetUrl);

  const result: CheckResult = {
    state,
    description,
    criteria: coverage,
    storyIds,
    specId,
  };

  await emitCheckWalEvent(workspaceId, headSha, result);

  return result;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildTargetUrl(
  workspaceId: string,
  specId: string | null,
  storyId?: string,
): string {
  const baseUrl = process.env.RORCA_BASE_URL || 'http://localhost:5210';
  if (specId && storyId) {
    return `${baseUrl}/specs/${specId}?story=${storyId}&workspace=${workspaceId}`;
  }
  if (specId) {
    return `${baseUrl}/specs/${specId}?workspace=${workspaceId}`;
  }
  return `${baseUrl}/?workspace=${workspaceId}`;
}

async function emitCheckWalEvent(workspaceId: string, sha: string, result: CheckResult): Promise<void> {
  const payload = JSON.stringify({
    sha,
    state: result.state,
    description: result.description,
    story_ids: result.storyIds,
    spec_id: result.specId,
    criteria_total: result.criteria.length,
    criteria_covered: result.criteria.filter(c => c.covered).length,
  });

  const walEvent = await queryOne<WalEvent>(
    `INSERT INTO wal_events (event_type, workspace_id, actor, payload) VALUES ('github_check_posted', $1, 'github', $2) RETURNING *`,
    [workspaceId, payload],
  );

  if (walEvent) {
    broadcastAll(walEvent);
  }
}
