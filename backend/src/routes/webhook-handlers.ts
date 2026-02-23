import * as fs from 'fs';
import * as path from 'path';
import { db } from '../db/index';
import { broadcastAll, type WalEvent } from '../lib/sse-hub';
import { onGithubEvent } from './webhooks';

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
  const pendingDir = path.join(workspacePath, 'scripts', 'ralph', 'specs', 'pending');
  const approvedDir = path.join(workspacePath, 'scripts', 'ralph', 'specs', 'approved');
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
export function handlePullRequestMerge(
  payload: Record<string, any>,
  _event: string,
  workspaceId: string,
): void {
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
    console.log(`[Webhook] PR merged but no story IDs found in title="${prTitle}" branch="${branchName}"`);
    return;
  }

  console.log(`[Webhook] PR merged: ${prUrl} — stories: ${storyIds.join(', ')}`);

  // Look up workspace path
  const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) as WorkspaceRow | undefined;
  if (!workspace) {
    console.error(`[Webhook] Workspace ${workspaceId} not found`);
    return;
  }

  // Find specs containing these story IDs
  const specMatches = findSpecsWithStories(workspace.path, storyIds);
  if (specMatches.length === 0) {
    console.log(`[Webhook] No specs found containing stories: ${storyIds.join(', ')}`);
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

      console.log(`[Webhook] Updated spec ${specId}: marked ${matchedStoryIds.join(', ')} as passed via PR merge`);
    } catch (err) {
      console.error(`[Webhook] Failed to update spec at ${specPath}:`, err);
    }
  }

  // Emit a single WAL event for the PR merge
  if (allUpdatedStoryIds.length > 0) {
    const walResult = db.prepare(
      `INSERT INTO wal_events (event_type, workspace_id, actor, payload) VALUES ('github_pr_merged', ?, 'github', ?)`
    ).run(workspaceId, JSON.stringify({
      pr_url: prUrl,
      story_ids: allUpdatedStoryIds,
      merge_sha: mergeSha,
      branch: branchName,
      title: prTitle,
    }));

    const walEvent = db.prepare('SELECT * FROM wal_events WHERE id = ?').get(
      walResult.lastInsertRowid
    ) as WalEvent;

    broadcastAll(walEvent);
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
export function handlePush(
  payload: Record<string, any>,
  _event: string,
  workspaceId: string,
): void {
  const commits: PushCommit[] = payload.commits ?? [];
  if (commits.length === 0) return;

  const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) as WorkspaceRow | undefined;
  if (!workspace) {
    console.error(`[Webhook] Workspace ${workspaceId} not found`);
    return;
  }

  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO story_commits (story_id, spec_id, workspace_id, commit_sha, commit_message, author, pushed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

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
        insertStmt.run(storyId, specId, workspaceId, commit.id, commit.message, author, pushedAt);
        totalLinked++;
      }
    }
  }

  if (totalLinked > 0) {
    console.log(`[Webhook] Push: linked ${totalLinked} commit-story mappings for workspace ${workspaceId}`);

    const walResult = db.prepare(
      `INSERT INTO wal_events (event_type, workspace_id, actor, payload) VALUES ('github_push_commits', ?, 'github', ?)`
    ).run(workspaceId, JSON.stringify({
      commits_count: commits.length,
      linked_count: totalLinked,
      ref: payload.ref ?? '',
    }));

    const walEvent = db.prepare('SELECT * FROM wal_events WHERE id = ?').get(
      walResult.lastInsertRowid
    ) as WalEvent;

    broadcastAll(walEvent);
  }
}

// ─── Register handlers ───────────────────────────────────────────────────────

export function registerWebhookHandlers(): void {
  onGithubEvent('pull_request', handlePullRequestMerge);
  onGithubEvent('push', handlePush);
  console.log('[Webhook] Registered pull_request merge handler');
  console.log('[Webhook] Registered push commit-linking handler');
}
