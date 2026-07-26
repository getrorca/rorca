/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * @module webhook-handlers
 * @description
 * GitHub webhook event handler utilities. This module does not expose HTTP routes directly.
 * Instead, it registers event handlers via `onGithubEvent()` from webhooks.ts.
 *
 * Registered handlers (via registerWebhookHandlers()):
 * - handlePullRequestMerge: On PR close+merge, marks matching stories as passed in spec JSON
 * - handlePullRequestCheck: On PR open/synchronize/reopen, posts GitHub commit status check
 * - handlePush: On push, maps commit messages to story IDs and records in story_commits table
 * - handlePushSpecDiscovery: On push, detects new/updated spec files and emits WAL events
 *
 * WAL events emitted:
 * - github_pr_merged: When a merged PR contains story IDs from spec files
 * - github_push_commits: When commits reference story IDs
 * - spec_discovered: When a new valid spec file is detected in a push
 * - spec_updated: When an existing spec file is updated in a push
 */
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { queryOne, execute } from '../db/index';
import { broadcastAll, type WalEvent } from '../lib/sse-hub';
import { onGithubEvent } from './webhooks';
import { logger } from '../lib/logger';
import { resolveWorkspaceGitHubToken } from '../lib/github-token-resolver';
import { githubRepoApiUrl } from '../lib/github-repository-authority';
import { fetchGithubWithTimeout } from '../lib/github-app-credential-provider';

// ─── Types ───────────────────────────────────────────────────────────────────

interface WorkspaceRow {
  id: string;
  label: string;
  path: string;
}

interface UserStory {
  id: string;
  title: string;
  passes?: boolean;
  mergedVia?: string;
  [key: string]: unknown;
}

// ─── Story ID extraction ─────────────────────────────────────────────────────

/**
 * Extract story IDs from PR title and branch name.
 * Matches patterns like:
 *   - feat(US-001): description
 *   - feat(US-001, US-002): description
 *   - feat/US-001-some-slug
 *   - feat/US-001-US-002-slug
 */
export function extractStoryIds(title: string, branchName: string): string[] {
  const ids = new Set<string>();

  // Pattern 1: feat(US-XXX) or feat(US-XXX, US-YYY) in title or branch
  const parenPattern = /feat\(([^)]+)\)/gi;
  for (const source of [title, branchName]) {
    let match: RegExpExecArray | null;
    while ((match = parenPattern.exec(source)) !== null) {
      // Split on comma/space to handle multiple IDs inside parens
      const inner = match[1];
      const innerIds = inner.match(/US-\d+/gi) || [];
      for (const id of innerIds) {
        ids.add(id.toUpperCase());
      }
    }
  }

  // Pattern 2: feat/US-XXX-slug in branch name
  const branchPattern = /feat\/((US-\d+)(?:-(US-\d+))*)/gi;
  let branchMatch: RegExpExecArray | null;
  while ((branchMatch = branchPattern.exec(branchName)) !== null) {
    const segment = branchMatch[1];
    const segmentIds = segment.match(/US-\d+/gi) || [];
    for (const id of segmentIds) {
      ids.add(id.toUpperCase());
    }
  }

  // Fallback: scan for any US-XXX pattern in both sources
  if (ids.size === 0) {
    for (const source of [title, branchName]) {
      const fallbackIds = source.match(/US-\d+/gi) || [];
      for (const id of fallbackIds) {
        ids.add(id.toUpperCase());
      }
    }
  }

  return Array.from(ids);
}

// ─── Spec file lookup ────────────────────────────────────────────────────────

function specsDirs(workspacePath: string) {
  const pendingDir = path.join(workspacePath, 'forge', 'specs', 'pending');
  const approvedDir = path.join(workspacePath, 'forge', 'specs', 'approved');
  return { pendingDir, approvedDir };
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
}

/**
 * Find spec files containing any of the given story IDs.
 * Returns array of { specPath, specId, matchedStoryIds }.
 */
function findSpecsWithStories(
  workspacePath: string,
  storyIds: string[],
): Array<{ specPath: string; specId: string; matchedStoryIds: string[] }> {
  const { pendingDir, approvedDir } = specsDirs(workspacePath);
  const results: Array<{ specPath: string; specId: string; matchedStoryIds: string[] }> = [];
  const storyIdSet = new Set(storyIds);

  for (const [dir] of [[approvedDir], [pendingDir]]) {
    for (const file of safeReaddir(dir)) {
      const filePath = path.join(dir, file);
      try {
        const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const stories: UserStory[] = content.userStories ?? [];
        const matched = stories
          .filter(s => storyIdSet.has(s.id))
          .map(s => s.id);
        if (matched.length > 0) {
          results.push({
            specPath: filePath,
            specId: file.replace('.json', ''),
            matchedStoryIds: matched,
          });
        }
      } catch {
        // Skip malformed JSON files
      }
    }
  }

  return results;
}

// ─── PR merge handler ────────────────────────────────────────────────────────

/**
 * Handle pull_request events: when a PR is merged, extract story IDs
 * and mark matching stories as passed in the spec JSON on disk.
 */
export async function handlePullRequestMerge(
  payload: Record<string, any>,
  _event: string,
  workspaceId: string,
): Promise<void> {
  // Only handle merged PRs
  if (payload.action !== 'closed' || !payload.pull_request?.merged) {
    return;
  }

  const pr = payload.pull_request;
  const prTitle: string = pr.title ?? '';
  const branchName: string = pr.head?.ref ?? '';
  const prUrl: string = pr.html_url ?? '';
  const mergeSha: string = pr.merge_commit_sha ?? '';

  const storyIds = extractStoryIds(prTitle, branchName);
  if (storyIds.length === 0) {
    logger.info(`[Webhook] PR merged but no story IDs found in title="${prTitle}" branch="${branchName}"`);
    return;
  }

  logger.info(`[Webhook] PR merged: ${prUrl} — stories: ${storyIds.join(', ')}`);

  // Look up workspace path
  const workspace = await queryOne<WorkspaceRow>(
    'SELECT * FROM workspaces WHERE id = $1',
    [workspaceId]
  );
  if (!workspace) {
    logger.error(`[Webhook] Workspace ${workspaceId} not found`);
    return;
  }

  // Find specs containing these story IDs
  const specMatches = findSpecsWithStories(workspace.path, storyIds);
  if (specMatches.length === 0) {
    logger.info(`[Webhook] No specs found containing stories: ${storyIds.join(', ')}`);
    return;
  }

  const allUpdatedStoryIds: string[] = [];

  for (const { specPath, specId, matchedStoryIds } of specMatches) {
    try {
      // Read and update spec JSON
      const content = JSON.parse(fs.readFileSync(specPath, 'utf8'));
      const stories: UserStory[] = content.userStories ?? [];

      for (const story of stories) {
        if (matchedStoryIds.includes(story.id)) {
          story.passes = true;
          story.mergedVia = prUrl;
        }
      }

      content.userStories = stories;
      fs.writeFileSync(specPath, JSON.stringify(content, null, 2) + '\n');

      allUpdatedStoryIds.push(...matchedStoryIds);

      logger.info(`[Webhook] Updated spec ${specId}: marked ${matchedStoryIds.join(', ')} as passed via PR merge`);
    } catch (err) {
      logger.error({ err }, `[Webhook] Failed to update spec at ${specPath}`);
    }
  }

  // Emit a single WAL event for the PR merge
  if (allUpdatedStoryIds.length > 0) {
    const walEvent = await queryOne<WalEvent>(
      `INSERT INTO wal_events (event_type, workspace_id, actor, payload) VALUES ('github_pr_merged', $1, 'github', $2) RETURNING *`,
      [workspaceId, JSON.stringify({
        pr_url: prUrl,
        story_ids: allUpdatedStoryIds,
        merge_sha: mergeSha,
        branch: branchName,
        title: prTitle,
      })]
    );

    if (walEvent) {
      broadcastAll(walEvent);
    }
  }
}

// ─── Commit → Story ID extraction ───────────────────────────────────────────

/**
 * Extract story IDs from a single commit message.
 * Matches patterns like:
 *   - feat(US-001): description
 *   - feat(US-001, US-002): description
 *   - fix(US-003): description
 * Falls back to scanning for any US-XXX pattern.
 */
export function extractStoryIdsFromCommit(message: string): string[] {
  const ids = new Set<string>();

  // Pattern: feat(US-XXX) or feat(US-XXX, US-YYY) — also fix(), chore(), etc.
  const parenPattern = /\w+\(([^)]*US-\d+[^)]*)\)/gi;
  let match: RegExpExecArray | null;
  while ((match = parenPattern.exec(message)) !== null) {
    const inner = match[1];
    const innerIds = inner.match(/US-\d+/gi) || [];
    for (const id of innerIds) {
      ids.add(id.toUpperCase());
    }
  }

  // Fallback: any US-XXX pattern in the message
  if (ids.size === 0) {
    const fallbackIds = message.match(/US-\d+/gi) || [];
    for (const id of fallbackIds) {
      ids.add(id.toUpperCase());
    }
  }

  return Array.from(ids);
}

// ─── Push handler ───────────────────────────────────────────────────────────

interface PushCommit {
  id: string;
  message: string;
  author: { name: string; email: string; username?: string };
  timestamp: string;
}

/**
 * Handle push events: parse commit messages for story ID patterns
 * and store mappings in the story_commits table.
 */
export async function handlePush(
  payload: Record<string, any>,
  _event: string,
  workspaceId: string,
): Promise<void> {
  const commits: PushCommit[] = payload.commits ?? [];
  if (commits.length === 0) return;

  const workspace = await queryOne<WorkspaceRow>(
    'SELECT * FROM workspaces WHERE id = $1',
    [workspaceId]
  );
  if (!workspace) {
    logger.error(`[Webhook] Workspace ${workspaceId} not found`);
    return;
  }

  let totalLinked = 0;

  for (const commit of commits) {
    const storyIds = extractStoryIdsFromCommit(commit.message);
    if (storyIds.length === 0) continue;

    // Find which specs contain these story IDs
    const specMatches = findSpecsWithStories(workspace.path, storyIds);

    for (const { specId, matchedStoryIds } of specMatches) {
      for (const storyId of matchedStoryIds) {
        const author = commit.author?.username || commit.author?.name || 'unknown';
        const pushedAt = commit.timestamp || new Date().toISOString();
        await execute(
          `INSERT INTO story_commits (story_id, spec_id, workspace_id, commit_sha, commit_message, author, pushed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
          [storyId, specId, workspaceId, commit.id, commit.message, author, pushedAt]
        );
        totalLinked++;
      }
    }
  }

  if (totalLinked > 0) {
    logger.info(`[Webhook] Push: linked ${totalLinked} commit-story mappings for workspace ${workspaceId}`);

    const walEvent = await queryOne<WalEvent>(
      `INSERT INTO wal_events (event_type, workspace_id, actor, payload) VALUES ('github_push_commits', $1, 'github', $2) RETURNING *`,
      [workspaceId, JSON.stringify({
        commits_count: commits.length,
        linked_count: totalLinked,
        ref: payload.ref ?? '',
      })]
    );

    if (walEvent) {
      broadcastAll(walEvent);
    }
  }
}

// ─── PR opened/updated handler — spec compliance check ──────────────────────

/**
 * Handle pull_request events: when a PR is opened or updated (synchronize),
 * evaluate acceptance criteria coverage and post a GitHub commit status check.
 */
export function handlePullRequestCheck(
  payload: Record<string, any>,
  _event: string,
  workspaceId: string,
): void {
  const action = payload.action;
  if (action !== 'opened' && action !== 'synchronize' && action !== 'reopened') {
    return;
  }

  const pr = payload.pull_request;
  if (!pr) return;

  const prTitle: string = pr.title ?? '';
  const branchName: string = pr.head?.ref ?? '';
  const headSha: string = pr.head?.sha ?? '';
  const prNumber: number = pr.number ?? 0;

  if (!headSha || !prNumber) return;

  const repoFullName: string = payload.repository?.full_name ?? '';
  const [owner, repo] = repoFullName.split('/');
  if (!owner || !repo) return;

  // Provider status mutation from PR webhooks is intentionally disabled. The
  // signed event remains local evidence; only the durable exact run Check Run
  // reconciler may project an automatic provider outcome.
  logger.info({ owner, repo, prNumber, headSha, prTitle, branchName, workspaceId },
    '[Webhook] PR update recorded without automatic provider status mutation');
}

// ─── Push spec discovery handler ────────────────────────────────────────────

/** Regex to match spec file paths in push commits */
const SPEC_FILE_PATTERN = /^forge\/specs\/(pending|approved)\/[^/]+\.json$/;

/** Zod schema for validating spec JSON structure */
const SpecUserStorySchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()),
});

const SpecFileSchema = z.object({
  userStories: z.array(SpecUserStorySchema).min(1),
});

/**
 * Fetch raw file content from GitHub API.
 * Returns null if the file cannot be fetched.
 */
async function fetchGithubFileContent(
  owner: string,
  repo: string,
  filePath: string,
  ref: string,
  token: string,
): Promise<string | null> {
  try {
    const url = githubRepoApiUrl(owner, repo, `/contents/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(ref)}`);
    const resp = await fetchGithubWithTimeout(fetch, url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3.raw',
        'User-Agent': 'Rorca/1.0',
      },
    });
    if (!resp.ok) {
      logger.warn(`[Webhook] GitHub API ${resp.status} fetching ${filePath} from ${owner}/${repo}`);
      return null;
    }
    return await resp.text();
  } catch (err) {
    logger.error({ err }, `[Webhook] Failed to fetch ${filePath} from GitHub`);
    return null;
  }
}

/**
 * Handle push events: detect new or updated spec files (forge/specs/pending/*.json
 * or forge/specs/approved/*.json), fetch them from GitHub, validate the JSON
 * structure, and emit WAL events.
 */
export async function handlePushSpecDiscovery(
  payload: Record<string, any>,
  _event: string,
  workspaceId: string,
): Promise<void> {
  const commits: Array<{
    id: string;
    added?: string[];
    modified?: string[];
  }> = payload.commits ?? [];

  if (commits.length === 0) return;

  // Collect unique spec file paths from all commits
  const addedPaths = new Set<string>();
  const modifiedPaths = new Set<string>();

  for (const commit of commits) {
    for (const filePath of commit.added ?? []) {
      if (SPEC_FILE_PATTERN.test(filePath)) {
        addedPaths.add(filePath);
      }
    }
    for (const filePath of commit.modified ?? []) {
      if (SPEC_FILE_PATTERN.test(filePath)) {
        modifiedPaths.add(filePath);
        // If also added in the same push, treat as added
        addedPaths.delete(filePath);
      }
    }
  }

  // Remove from modified if also in added (added takes priority)
  for (const p of addedPaths) {
    modifiedPaths.delete(p);
  }

  const allSpecPaths = new Set([...addedPaths, ...modifiedPaths]);
  if (allSpecPaths.size === 0) return;

  const repoFullName: string = payload.repository?.full_name ?? '';
  const [repoOwner, repoName] = repoFullName.split('/');
  if (!repoOwner || !repoName) return;
  const resolved = await resolveWorkspaceGitHubToken(workspaceId, {
    repository: { owner: repoOwner, name: repoName },
    purpose: 'repository-read',
  });
  if (!resolved) {
    logger.warn('[Webhook] No workspace GitHub credential found — cannot fetch spec files');
    return;
  }
  const token = resolved.token;

  const ref: string = payload.after ?? payload.ref?.replace('refs/heads/', '') ?? 'main';

  for (const filePath of allSpecPaths) {
    const specSlug = path.basename(filePath, '.json');
    const isNew = addedPaths.has(filePath);

    // Fetch file content from GitHub
    const content = await fetchGithubFileContent(repoOwner, repoName, filePath, ref, token);
    if (!content) continue;

    // Parse JSON
    let parsed: Record<string, any>;
    try {
      parsed = JSON.parse(content);
    } catch (parseErr) {
      logger.warn(`Invalid spec file: ${filePath} — ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
      continue;
    }

    // Validate spec structure with Zod safeParse
    const validation = SpecFileSchema.safeParse(parsed);
    if (!validation.success) {
      const errorMsg = validation.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      logger.warn(`Invalid spec file: ${filePath} — ${errorMsg}`);
      continue;
    }

    const storyCount = validation.data.userStories.length;
    const specTitle = parsed.title || specSlug;

    // Check if this spec was previously discovered
    const existing = await queryOne<{ spec_id: string }>(
      'SELECT spec_id FROM spec_sources WHERE spec_id = $1 AND workspace_id = $2',
      [specSlug, workspaceId]
    );

    if (isNew || !existing) {
      // New spec — record source and emit spec_discovered
      await execute(
        `INSERT INTO spec_sources (spec_id, workspace_id, source, source_repo, source_ref, source_sha)
         VALUES ($1, $2, 'github', $3, $4, $5)
         ON CONFLICT (spec_id, workspace_id) DO UPDATE SET source = 'github', source_repo = $3, source_ref = $4, source_sha = $5, discovered_at = NOW()`,
        [specSlug, workspaceId, repoFullName, ref, payload.after ?? null]
      );

      const walEvent = await queryOne<WalEvent>(
        `INSERT INTO wal_events (event_type, workspace_id, spec_id, actor, payload)
         VALUES ('spec_discovered', $1, $2, 'github', $3) RETURNING *`,
        [workspaceId, specSlug, JSON.stringify({
          title: specTitle,
          story_count: storyCount,
          source: 'github',
          repo: repoFullName,
          ref,
          file_path: filePath,
        })]
      );
      if (walEvent) broadcastAll(walEvent);

      logger.info(`[Webhook] Spec discovered from GitHub: ${specSlug} (${storyCount} stories) in ${repoFullName}`);
    } else {
      // Existing spec updated — get previous story count from filesystem for delta
      let oldStoryCount = 0;
      const workspace = await queryOne<{ path: string }>(
        'SELECT path FROM workspaces WHERE id = $1',
        [workspaceId]
      );
      if (workspace) {
        const localPath = path.join(workspace.path, filePath);
        try {
          const localContent = JSON.parse(fs.readFileSync(localPath, 'utf8'));
          oldStoryCount = (localContent.userStories ?? []).length;
        } catch {
          // Local file may not exist yet
        }
      }

      // Update source tracking
      await execute(
        `UPDATE spec_sources SET source_ref = $1, source_sha = $2, discovered_at = NOW()
         WHERE spec_id = $3 AND workspace_id = $4`,
        [ref, payload.after ?? null, specSlug, workspaceId]
      );

      const walEvent = await queryOne<WalEvent>(
        `INSERT INTO wal_events (event_type, workspace_id, spec_id, actor, payload)
         VALUES ('spec_updated', $1, $2, 'github', $3) RETURNING *`,
        [workspaceId, specSlug, JSON.stringify({
          title: specTitle,
          story_count: storyCount,
          old_story_count: oldStoryCount,
          story_count_delta: storyCount - oldStoryCount,
          source: 'github',
          repo: repoFullName,
          ref,
          file_path: filePath,
        })]
      );
      if (walEvent) broadcastAll(walEvent);

      logger.info(`[Webhook] Spec updated from GitHub: ${specSlug} (${oldStoryCount} → ${storyCount} stories) in ${repoFullName}`);
    }

    // Write the spec file to the workspace filesystem so it appears in the kanban
    const workspace = await queryOne<{ path: string }>(
      'SELECT path FROM workspaces WHERE id = $1',
      [workspaceId]
    );
    if (workspace) {
      const localPath = path.join(workspace.path, filePath);
      const dir = path.dirname(localPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(localPath, content, 'utf8');
    }
  }
}

// ─── Register handlers ───────────────────────────────────────────────────────

export function registerWebhookHandlers(): void {
  onGithubEvent('pull_request', handlePullRequestMerge);
  onGithubEvent('pull_request', handlePullRequestCheck);
  onGithubEvent('push', handlePush);
  onGithubEvent('push', handlePushSpecDiscovery);
  logger.info('[Webhook] Registered pull_request merge handler');
  logger.info('[Webhook] Registered pull_request spec-compliance check handler');
  logger.info('[Webhook] Registered push commit-linking handler');
  logger.info('[Webhook] Registered push spec-discovery handler');
}
