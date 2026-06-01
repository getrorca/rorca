/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * US-030: Create GitHub Check Runs for pipeline runs.
 *
 * Subscribes to WAL events (run_started, story_passed, story_failed, story_skipped, run_finished)
 * and manages a GitHub Check Run lifecycle via the Checks API.
 *
 * On run start: POST /repos/:owner/:repo/check-runs with status='in_progress'.
 * On story completion: PATCH output.summary with per-story results table (debounced).
 * On run completion: PATCH with conclusion and annotations for failed stories.
 *
 * Error tolerance: GitHub API failures NEVER block pipeline execution.
 * All failures logged to integration_audit_log.
 */

import { execSync } from 'child_process';
import { subscribe, broadcastAll, type WalEvent } from './sse-hub';
import { query, queryOne, execute } from '../db/index';
import { decryptToken } from './auth-utils';
import { githubRateLimiter } from './github-rate-limiter';
import { logger } from './logger';

// ─── Types ───────────────────────────────────────────────────────────────────

interface GitHubWebhookRow {
  workspace_id: string;
  repo_owner: string;
  repo_name: string;
}

interface GitHubConnectionRow {
  encrypted_token: string;
}

interface PipelineRunRow {
  id: number;
  worktree_path: string | null;
  workspace_id: string;
  spec_path: string;
  branch_name: string | null;
}

interface WorkspaceRow {
  path: string;
}

interface StoryResultRow {
  story_id: string;
  status: string;
  reason: string | null;
  finished_at: string | null;
}

interface StoryProgress {
  storyId: string;
  title: string;
  status: 'pass' | 'fail' | 'skip' | 'in_progress';
  reason?: string;
}

interface CheckRunState {
  checkRunId: number;
  workspaceId: string;
  owner: string;
  repo: string;
  stories: Map<string, StoryProgress>;
  pendingFlush: ReturnType<typeof setTimeout> | null;
}

// GitHub Check Run annotation
interface CheckAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: 'failure' | 'warning' | 'notice';
  message: string;
  title: string;
}

const CHECK_RUN_NAME = 'Rorca Pipeline';

// Active check runs keyed by runId
const activeCheckRuns = new Map<number, CheckRunState>();

// Debounce interval: batch story updates into a single PATCH every 5s
const DEBOUNCE_MS = 5000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getGithubToken(): Promise<string | null> {
  const row = await queryOne<GitHubConnectionRow>(
    'SELECT encrypted_token FROM github_connections LIMIT 1',
  );
  if (!row) return null;
  return decryptToken(row.encrypted_token);
}

async function getRepoInfo(workspaceId: string): Promise<{ owner: string; repo: string } | null> {
  const row = await queryOne<GitHubWebhookRow>(
    'SELECT repo_owner, repo_name FROM workspace_github_webhooks WHERE workspace_id = $1',
    [workspaceId],
  );
  if (!row) return null;
  return { owner: row.repo_owner, repo: row.repo_name };
}

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

function buildRunViewUrl(runId: number | null): string {
  const baseUrl = process.env.RORCA_BASE_URL || 'http://localhost:5210';
  if (runId) return `${baseUrl}/runs/${runId}`;
  return baseUrl;
}

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
    logger.debug({ err }, '[CheckRun] Failed to write audit log');
  }
}

function buildGitHubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

// ─── Story Status Table ─────────────────────────────────────────────────────

const STATUS_EMOJI: Record<string, string> = {
  pass: ':white_check_mark:',
  fail: ':x:',
  skip: ':fast_forward:',
  in_progress: ':hourglass_flowing_sand:',
};

function buildSummaryTable(stories: Map<string, StoryProgress>): string {
  const rows: string[] = [];
  rows.push('| Story | Title | Status |');
  rows.push('|-------|-------|--------|');

  for (const [, story] of stories) {
    const emoji = STATUS_EMOJI[story.status] || ':question:';
    const titleStr = story.title.length > 60 ? story.title.slice(0, 57) + '...' : story.title;
    rows.push(`| ${story.storyId} | ${titleStr} | ${emoji} ${story.status} |`);
  }

  return rows.join('\n');
}

function buildOutputText(stories: Map<string, StoryProgress>, runId: number): string {
  const passed = [...stories.values()].filter(s => s.status === 'pass').length;
  const failed = [...stories.values()].filter(s => s.status === 'fail').length;
  const skipped = [...stories.values()].filter(s => s.status === 'skip').length;
  const total = stories.size;

  const lines: string[] = [];
  lines.push(`## Rorca Pipeline Run #${runId}\n`);
  lines.push(`**Results**: ${passed}/${total} passed, ${failed} failed, ${skipped} skipped\n`);
  lines.push(buildSummaryTable(stories));

  if (failed > 0) {
    lines.push('\n### Failed Stories\n');
    for (const [, story] of stories) {
      if (story.status === 'fail') {
        lines.push(`- **${story.storyId}**: ${story.title}`);
        if (story.reason) lines.push(`  - Reason: ${story.reason}`);
      }
    }
  }

  return lines.join('\n');
}

// ─── Annotation Extraction ──────────────────────────────────────────────────

/**
 * Parse error text for file path and line number references.
 * Patterns matched:
 *   - path/to/file.ts:42
 *   - path/to/file.ts:42:10
 *   - at path/to/file.ts line 42
 */
function extractAnnotations(
  stories: Map<string, StoryProgress>,
  runId: number,
): CheckAnnotation[] {
  const annotations: CheckAnnotation[] = [];
  const fileLineRegex = /(?:^|\s|at\s+)([a-zA-Z0-9_./-]+\.[a-zA-Z]{1,5}):(\d+)/gm;

  for (const [, story] of stories) {
    if (story.status !== 'fail' || !story.reason) continue;

    const matches = story.reason.matchAll(fileLineRegex);
    let hasFileAnnotation = false;

    for (const match of matches) {
      const filePath = match[1];
      const line = parseInt(match[2], 10);
      // Skip common false positives (URLs, node_modules)
      if (filePath.includes('node_modules/') || filePath.startsWith('http')) continue;

      annotations.push({
        path: filePath,
        start_line: line,
        end_line: line,
        annotation_level: 'failure',
        message: `${story.storyId} failed: ${story.reason.slice(0, 200)}`,
        title: `${story.storyId}: ${story.title}`,
      });
      hasFileAnnotation = true;
    }

    // If no file/line extracted, skip annotation for this story (annotations are optional)
    if (!hasFileAnnotation) {
      logger.debug(`[CheckRun] No file/line in error for ${story.storyId} — skipping annotation`);
    }
  }

  // GitHub limits to 50 annotations per API call
  return annotations.slice(0, 50);
}

// ─── GitHub Checks API Calls ────────────────────────────────────────────────

async function createCheckRun(
  owner: string,
  repo: string,
  headSha: string,
  runId: number,
  workspaceId: string,
): Promise<number | null> {
  const token = await getGithubToken();
  if (!token) {
    logger.debug('[CheckRun] No GitHub token — skipping check run creation');
    return null;
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/check-runs`;
  const body = {
    name: CHECK_RUN_NAME,
    head_sha: headSha,
    status: 'in_progress',
    started_at: new Date().toISOString(),
    details_url: buildRunViewUrl(runId),
    output: {
      title: `Pipeline Run #${runId}`,
      summary: 'Pipeline is starting...',
    },
  };

  try {
    const res = await githubRateLimiter.execute(() =>
      fetch(url, {
        method: 'POST',
        headers: buildGitHubHeaders(token),
        body: JSON.stringify(body),
      }),
    );

    if (!res.ok) {
      const text = await res.text();
      logger.warn({ status: res.status }, `[CheckRun] Failed to create check run for run #${runId}`);
      await logAudit(workspaceId, 'check_run_create_failed', res.status, text, { runId, headSha });
      return null;
    }

    const data = await res.json() as { id: number };
    logger.info(`[CheckRun] Created check run ${data.id} for run #${runId} on ${owner}/${repo}@${headSha.slice(0, 7)}`);
    await logAudit(workspaceId, 'check_run_created', res.status, null, { runId, headSha, checkRunId: data.id });
    return data.id;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, `[CheckRun] Error creating check run for run #${runId}`);
    await logAudit(workspaceId, 'check_run_create_failed', null, message, { runId, headSha });
    return null;
  }
}

async function updateCheckRun(
  owner: string,
  repo: string,
  checkRunId: number,
  workspaceId: string,
  update: {
    status?: 'in_progress' | 'completed';
    conclusion?: 'success' | 'failure' | 'neutral';
    output: {
      title: string;
      summary: string;
      text?: string;
      annotations?: CheckAnnotation[];
    };
    completed_at?: string;
  },
): Promise<void> {
  const token = await getGithubToken();
  if (!token) return;

  const url = `https://api.github.com/repos/${owner}/${repo}/check-runs/${checkRunId}`;

  try {
    const res = await githubRateLimiter.execute(() =>
      fetch(url, {
        method: 'PATCH',
        headers: buildGitHubHeaders(token),
        body: JSON.stringify(update),
      }),
    );

    if (!res.ok) {
      const text = await res.text();
      logger.warn({ status: res.status }, `[CheckRun] Failed to update check run ${checkRunId}`);
      await logAudit(workspaceId, 'check_run_update_failed', res.status, text, { checkRunId });
    } else {
      logger.debug(`[CheckRun] Updated check run ${checkRunId}`);
      await logAudit(workspaceId, 'check_run_updated', res.status, null, { checkRunId });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, `[CheckRun] Error updating check run ${checkRunId}`);
    await logAudit(workspaceId, 'check_run_update_failed', null, message, { checkRunId });
  }
}

// ─── Debounced Flush ────────────────────────────────────────────────────────

function scheduleFlush(runId: number): void {
  const state = activeCheckRuns.get(runId);
  if (!state) return;

  // Clear existing timer
  if (state.pendingFlush) {
    clearTimeout(state.pendingFlush);
  }

  state.pendingFlush = setTimeout(() => {
    flushStoryUpdate(runId).catch((err) => {
      logger.debug({ err }, `[CheckRun] Error flushing story update for run #${runId}`);
    });
  }, DEBOUNCE_MS);
}

async function flushStoryUpdate(runId: number): Promise<void> {
  const state = activeCheckRuns.get(runId);
  if (!state) return;

  state.pendingFlush = null;

  const passed = [...state.stories.values()].filter(s => s.status === 'pass').length;
  const failed = [...state.stories.values()].filter(s => s.status === 'fail').length;
  const total = state.stories.size;
  const inProgress = [...state.stories.values()].filter(s => s.status === 'in_progress').length;

  await updateCheckRun(state.owner, state.repo, state.checkRunId, state.workspaceId, {
    status: 'in_progress',
    output: {
      title: `Pipeline Run #${runId} — ${passed} passed, ${failed} failed, ${inProgress} running (${total} total)`,
      summary: buildSummaryTable(state.stories),
    },
  });
}

// ─── WAL Event Handlers ─────────────────────────────────────────────────────

async function handleRunStarted(event: WalEvent): Promise<void> {
  const { workspace_id } = event;
  if (!workspace_id) return;

  const payload = event.payload ? JSON.parse(event.payload) : {};
  const runId: number | null = typeof payload.run_id === 'number' ? payload.run_id : null;
  if (!runId) return;

  // Check if GitHub is connected
  const repoInfo = await getRepoInfo(workspace_id);
  if (!repoInfo) {
    logger.debug(`[CheckRun] No GitHub connection for workspace ${workspace_id} — skipping`);
    return;
  }

  // Resolve HEAD SHA
  const sha = await resolveBranchHead(runId, workspace_id);
  if (!sha) {
    logger.debug(`[CheckRun] No commit SHA for run #${runId} — skipping check run`);
    return;
  }

  // Create the check run
  const checkRunId = await createCheckRun(repoInfo.owner, repoInfo.repo, sha, runId, workspace_id);
  if (!checkRunId) return;

  // Store state for story updates
  activeCheckRuns.set(runId, {
    checkRunId,
    workspaceId: workspace_id,
    owner: repoInfo.owner,
    repo: repoInfo.repo,
    stories: new Map(),
    pendingFlush: null,
  });

  // Emit WAL event for check run creation
  const walPayload = JSON.stringify({ run_id: runId, check_run_id: checkRunId, sha });
  const walEvent = await queryOne<WalEvent>(
    `INSERT INTO wal_events (event_type, workspace_id, actor, payload) VALUES ('check_run_created', $1, 'github', $2) RETURNING *`,
    [workspace_id, walPayload],
  );
  if (walEvent) broadcastAll(walEvent);
}

async function handleStoryEvent(event: WalEvent): Promise<void> {
  const { event_type, workspace_id, story_id } = event;
  if (!workspace_id || !story_id) return;

  const payload = event.payload ? JSON.parse(event.payload) : {};
  const runId: number | null = typeof payload.run_id === 'number' ? payload.run_id : null;
  if (!runId) return;

  const state = activeCheckRuns.get(runId);
  if (!state) return; // No active check run for this pipeline run

  const storyTitle: string = (payload.story_title as string) || story_id;

  let status: StoryProgress['status'];
  if (event_type === 'story_started') {
    status = 'in_progress';
  } else if (event_type === 'story_passed') {
    status = 'pass';
  } else if (event_type === 'story_failed') {
    status = 'fail';
  } else if (event_type === 'story_skipped') {
    status = 'skip';
  } else {
    return;
  }

  state.stories.set(story_id, {
    storyId: story_id,
    title: storyTitle,
    status,
    reason: (payload.reason as string) || undefined,
  });

  // Debounce: batch updates to reduce API calls
  scheduleFlush(runId);
}

async function handleRunFinished(event: WalEvent): Promise<void> {
  const { workspace_id } = event;
  if (!workspace_id) return;

  const payload = event.payload ? JSON.parse(event.payload) : {};
  const runId: number | null = typeof payload.run_id === 'number' ? payload.run_id : null;
  if (!runId) return;

  const state = activeCheckRuns.get(runId);
  if (!state) return;

  // Cancel any pending debounce
  if (state.pendingFlush) {
    clearTimeout(state.pendingFlush);
    state.pendingFlush = null;
  }

  // Fetch final story results from DB (most authoritative source)
  const results = await query<StoryResultRow>(
    'SELECT story_id, status, reason, finished_at FROM story_results WHERE run_id = $1 ORDER BY id',
    [runId],
  );

  // Update state with final results
  for (const r of results) {
    const existing = state.stories.get(r.story_id);
    const status = r.status === 'pass' ? 'pass' : r.status === 'fail' ? 'fail' : 'skip';
    state.stories.set(r.story_id, {
      storyId: r.story_id,
      title: existing?.title || r.story_id,
      status,
      reason: r.reason || existing?.reason,
    });
  }

  // Determine conclusion
  const passed = [...state.stories.values()].filter(s => s.status === 'pass').length;
  const failed = [...state.stories.values()].filter(s => s.status === 'fail').length;
  const skipped = [...state.stories.values()].filter(s => s.status === 'skip').length;
  const total = state.stories.size;

  let conclusion: 'success' | 'failure' | 'neutral';
  if (failed > 0) {
    conclusion = 'failure';
  } else if (total === 0 || (passed === 0 && skipped > 0)) {
    conclusion = 'neutral';
  } else {
    conclusion = 'success';
  }

  // Build annotations for failed stories
  const annotations = extractAnnotations(state.stories, runId);

  // Final PATCH with conclusion
  await updateCheckRun(state.owner, state.repo, state.checkRunId, state.workspaceId, {
    status: 'completed',
    conclusion,
    completed_at: new Date().toISOString(),
    output: {
      title: `Pipeline Run #${runId} — ${conclusion}`,
      summary: buildSummaryTable(state.stories),
      text: buildOutputText(state.stories, runId),
      annotations: annotations.length > 0 ? annotations : undefined,
    },
  });

  // Emit completion WAL event
  const walPayload = JSON.stringify({
    run_id: runId,
    check_run_id: state.checkRunId,
    conclusion,
    passed,
    failed,
    skipped,
    total,
  });
  const walEvent = await queryOne<WalEvent>(
    `INSERT INTO wal_events (event_type, workspace_id, actor, payload) VALUES ('check_run_completed', $1, 'github', $2) RETURNING *`,
    [workspace_id, walPayload],
  );
  if (walEvent) broadcastAll(walEvent);

  // Cleanup
  activeCheckRuns.delete(runId);
}

// ─── WAL Event Router ───────────────────────────────────────────────────────

const HANDLED_EVENTS = new Set([
  'run_started',
  'story_started',
  'story_passed',
  'story_failed',
  'story_skipped',
  'run_finished',
]);

async function handleWalEvent(event: WalEvent): Promise<void> {
  if (!HANDLED_EVENTS.has(event.event_type)) return;

  if (event.event_type === 'run_started') {
    await handleRunStarted(event);
  } else if (event.event_type === 'run_finished') {
    await handleRunFinished(event);
  } else {
    await handleStoryEvent(event);
  }
}

// ─── Startup ────────────────────────────────────────────────────────────────

/**
 * Subscribe to WAL events and manage GitHub Check Runs for pipeline runs.
 * Call once at server startup.
 */
export function startCheckRunPoster(): void {
  subscribe((event: WalEvent) => {
    handleWalEvent(event).catch((err) => {
      // Never let check run errors break the event pipeline
      logger.debug({ err }, '[CheckRun] Error handling WAL event');
    });
  });
  logger.info('[CheckRun] Check run poster subscribed to WAL events');
}
