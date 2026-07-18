/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * github-draft-pr.ts — Draft PR lifecycle for pipeline runs.
 *
 * Creates a draft PR at pipeline start, updates body as stories complete,
 * and converts to ready-for-review on successful completion.
 *
 * Flow:
 *   1. createDraftPr() — on run_started (worktree branch only)
 *   2. updateDraftPrProgress() — on story_passed / story_failed
 *   3. finalizeDraftPr() — on run_finished (convert or keep draft)
 *
 * Non-fatal: all errors are caught, logged to integration_audit_log,
 * and emitted as WAL events. Never blocks pipeline execution.
 */

import { query, queryOne, execute } from '../db/index';
import { githubRateLimiter } from './github-rate-limiter';
import { logger } from './logger';
import { renderPrTemplate, PrTemplateData } from './github/pr-template';
import { loadRorcaConfig } from './rorca-config';
import { insertAuditEntry } from '../routes/integration-audit-log';
import { spawnSync } from 'child_process';
import { getGithubRepositoryAuthority, githubRepoApiUrl } from './github-repository-authority';
import { resolveWorkspaceGitHubToken } from './github-token-resolver';
import { fetchGithubWithTimeout } from './github-app-credential-provider';
import {
  extractGithubProviderError,
  formatGithubProviderError,
  githubProviderError,
  sanitizeGithubProviderException,
} from './github-provider-error';

// ─── Types ─────────────────────────────────────────────────────────────────

interface GithubWebhookConfig {
  repo_owner: string;
  repo_name: string;
  auto_pr_enabled: boolean;
  auto_pr_target_branch: string;
  auto_pr_reviewers: string;
}

interface StoryProgress {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  failedStoryIds: string[];
}

// Debounce state per run — prevents hammering GitHub on rapid story completions
const pendingUpdates = new Map<number, NodeJS.Timeout>();
const DEBOUNCE_MS = 5000; // batch updates within 5s window

// ─── Helpers ───────────────────────────────────────────────────────────────

function buildGitHubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

/**
 * Resolve GitHub token for the workspace. Returns null if not configured.
 */
async function resolveGithubContext(workspaceId: string | number, force = false): Promise<{
  token: string;
  config: GithubWebhookConfig;
} | null> {
  try {
    const authority = await getGithubRepositoryAuthority(String(workspaceId), { requireActive: true });
    if (!authority || (!force && !authority.autoPrEnabled)) return null;
    const resolved = await resolveWorkspaceGitHubToken(String(workspaceId), {
      repository: { owner: authority.owner, name: authority.name }, purpose: 'pulls-write',
    });
    if (!resolved) return null;
    return {
      token: resolved.token,
      config: {
        repo_owner: authority.owner,
        repo_name: authority.name,
        auto_pr_enabled: authority.autoPrEnabled,
        auto_pr_target_branch: authority.autoPrTargetBranch,
        auto_pr_reviewers: JSON.stringify(authority.autoPrReviewers),
      },
    };
  } catch {
    return null;
  }
}

async function getStoryProgress(runId: number): Promise<StoryProgress> {
  // Get total stories from the spec
  const runRow = await queryOne<{ spec_path: string; workspace_id: string }>(
    'SELECT spec_path, workspace_id FROM pipeline_runs WHERE id = $1',
    [runId],
  );

  let totalFromSpec = 0;
  if (runRow) {
    try {
      const ws = await queryOne<{ path: string }>(
        'SELECT path FROM workspaces WHERE id = $1',
        [runRow.workspace_id],
      );
      if (ws) {
        const path = await import('path');
        const fs = await import('fs');
        const specFile = path.join(ws.path, runRow.spec_path);
        if (fs.existsSync(specFile)) {
          const spec = JSON.parse(fs.readFileSync(specFile, 'utf-8'));
          totalFromSpec = (spec.userStories ?? []).length;
        }
      }
    } catch { /* non-fatal */ }
  }

  // Story results from DB (latest per story_id)
  type StoryRow = { story_id: string; status: string };
  const storyRows = await query<StoryRow>(
    `SELECT DISTINCT ON (story_id) story_id, status
     FROM story_results WHERE run_id = $1
     ORDER BY story_id, id DESC`,
    [runId],
  );

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failedStoryIds: string[] = [];
  for (const s of storyRows) {
    if (s.status === 'pass') passed++;
    else if (s.status === 'fail') { failed++; failedStoryIds.push(s.story_id); }
    else skipped++;
  }

  const total = totalFromSpec || (passed + failed + skipped);

  return { passed, failed, skipped, total, failedStoryIds };
}

function buildProgressBody(progress: StoryProgress, specTitle: string): string {
  const { passed, failed, skipped, total } = progress;
  const completed = passed + failed + skipped;
  const remaining = Math.max(0, total - completed);

  const lines = [
    `## Pipeline Progress`,
    '',
    `**${completed}/${total}** stories complete`,
    '',
    '| Status | Count |',
    '|--------|-------|',
    `| :white_check_mark: Passed | ${passed} |`,
    `| :x: Failed | ${failed} |`,
    `| :fast_forward: Skipped | ${skipped} |`,
    `| :hourglass: Remaining | ${remaining} |`,
    '',
  ];

  if (progress.failedStoryIds.length > 0) {
    lines.push('### Failed Stories');
    lines.push('');
    for (const id of progress.failedStoryIds) {
      lines.push(`- \`${id}\``);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push(`*Pipeline running — spec: ${specTitle}*`);
  lines.push('*Updated automatically by [Rorca](https://rorca.app)*');

  return lines.join('\n');
}

async function emitWalEvent(
  eventType: string,
  workspaceId: string | number,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await execute(
      `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ($1, $2, $3)`,
      [eventType, String(workspaceId), JSON.stringify(payload)],
    );
  } catch (err) {
    logger.warn({ err, eventType }, '[draft-pr] Failed to emit WAL event');
  }
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Create a draft PR for a pipeline run on a worktree branch.
 * Called from worker.ts after run_started event.
 *
 * Skips silently if:
 * - No GitHub connection
 * - auto_pr_enabled is false
 * - branchName is null (run on main)
 * - PR already exists for this branch
 */
export async function createDraftPr(opts: {
  runId: number;
  workspaceId: string | number;
  branchName: string;
  workspacePath: string;
  specTitle: string;
  totalStories: number;
  force?: boolean;
}): Promise<void> {
  const { runId, workspaceId, branchName, specTitle, totalStories, force } = opts;

  const ctx = await resolveGithubContext(workspaceId, force);
  if (!ctx) {
    logger.debug({ runId, workspaceId }, '[draft-pr] Skipping: GitHub not connected or auto-PR disabled');
    return;
  }

  const { token, config } = ctx;
  const { repo_owner: owner, repo_name: repo } = config;
  const targetBranch = config.auto_pr_target_branch || 'main';

  try {
    // Mark pr_creating
    await execute('UPDATE pipeline_runs SET pr_creating = TRUE WHERE id = $1', [runId]);
    await emitWalEvent('pr_creating', workspaceId, { run_id: runId, branchName });

    // Push branch to remote first (worktree may only exist locally)
    try {
      spawnSync('git', ['push', '-u', 'origin', branchName], {
        cwd: opts.workspacePath,
        encoding: 'utf8',
        timeout: 30000,
      });
    } catch {
      // Non-fatal — branch might already be pushed
    }

    // Check for existing PR on this branch
    const head = `${owner}:${branchName}`;
    const checkUrl = githubRepoApiUrl(owner, repo, `/pulls?head=${encodeURIComponent(head)}&state=open&per_page=1`);
    const checkRes = await githubRateLimiter.execute(() =>
      fetchGithubWithTimeout(fetch, checkUrl, { headers: buildGitHubHeaders(token) }),
    );

    if (!checkRes.ok) throw githubProviderError(checkRes, 'GITHUB_DRAFT_PR_LOOKUP_FAILED');
    const existing = await checkRes.json() as Array<{ number: number }>;
    if (existing.length > 0) {
      // PR already exists — store number and skip creation
      const prNumber = existing[0].number;
      await execute(
        'UPDATE pipeline_runs SET pr_number = $1, pr_creating = FALSE WHERE id = $2',
        [prNumber, runId],
      );
      await emitWalEvent('pr_draft_created', workspaceId, {
        run_id: runId, pr_number: prNumber,
        pr_url: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
        reused: true,
      });
      logger.info({ runId, prNumber }, '[draft-pr] Reusing existing PR');
      return;
    }

    // Create draft PR
    const prTitle = `[WIP] ${specTitle}`;
    const prBody = buildProgressBody(
      { passed: 0, failed: 0, skipped: 0, total: totalStories, failedStoryIds: [] },
      specTitle,
    );

    const createRes = await githubRateLimiter.execute(() =>
      fetchGithubWithTimeout(fetch, githubRepoApiUrl(owner, repo, '/pulls'), {
        method: 'POST',
        headers: buildGitHubHeaders(token),
        body: JSON.stringify({
          title: prTitle,
          head: branchName,
          base: targetBranch,
          body: prBody,
          draft: true,
        }),
      }),
    );

    if (!createRes.ok) throw githubProviderError(createRes, 'GITHUB_DRAFT_PR_CREATE_FAILED');

    const prData = await createRes.json() as { number: number; html_url: string };
    const prNumber = prData.number;

    // Store PR number immediately
    await execute(
      'UPDATE pipeline_runs SET pr_number = $1, pr_creating = FALSE WHERE id = $2',
      [prNumber, runId],
    );

    await emitWalEvent('pr_draft_created', workspaceId, {
      run_id: runId,
      pr_number: prNumber,
      pr_url: prData.html_url,
      branch: branchName,
      target_branch: targetBranch,
    });

    await insertAuditEntry({
      workspaceId: String(workspaceId),
      provider: 'github',
      action: 'api_call_made',
      actorType: 'system',
      details: { action: 'create_draft_pr', pr_number: prNumber, run_id: runId },
    });

    logger.info({ runId, prNumber, prUrl: prData.html_url }, '[draft-pr] Draft PR created');
  } catch (err: unknown) {
    const providerError = sanitizeGithubProviderException(err, 'GITHUB_DRAFT_PR_CREATE_FAILED');
    const errMsg = formatGithubProviderError(providerError);
    logger.error({ providerError, runId, owner, repo, branchName }, '[draft-pr] Draft PR creation failed');

    await execute(
      'UPDATE pipeline_runs SET pr_creating = FALSE, pr_creation_error = $1 WHERE id = $2',
      [errMsg, runId],
    );

    await emitWalEvent('pr_creation_failed', workspaceId, {
      run_id: runId, branch: branchName, error: errMsg,
    });

    await insertAuditEntry({
      workspaceId: String(workspaceId),
      provider: 'github',
      action: 'api_call_failed',
      actorType: 'system',
      details: { action: 'create_draft_pr', error: errMsg, run_id: runId },
    });
  }
}

/**
 * Update the draft PR body with current story progress.
 * Debounced — batches updates within a 5s window to avoid GitHub rate limits.
 * Fire-and-forget.
 */
export function updateDraftPrProgress(runId: number, workspaceId: string | number): void {
  // Clear any pending update for this run
  const existing = pendingUpdates.get(runId);
  if (existing) clearTimeout(existing);

  const timeout = setTimeout(() => {
    pendingUpdates.delete(runId);
    void _doUpdateDraftPrProgress(runId, workspaceId);
  }, DEBOUNCE_MS);

  pendingUpdates.set(runId, timeout);
}

async function _doUpdateDraftPrProgress(runId: number, workspaceId: string | number): Promise<void> {
  try {
    // Get PR number from pipeline_runs
    const runRow = await queryOne<{ pr_number: number | null; spec_path: string }>(
      'SELECT pr_number, spec_path FROM pipeline_runs WHERE id = $1',
      [runId],
    );

    if (!runRow?.pr_number) return; // No draft PR — skip

    const ctx = await resolveGithubContext(workspaceId);
    if (!ctx) return;

    const { token, config } = ctx;
    const { repo_owner: owner, repo_name: repo } = config;

    const progress = await getStoryProgress(runId);
    const specSlug = runRow.spec_path.split('/').pop()?.replace(/\.json$/, '') ?? `run-${runId}`;
    const specTitle = specSlug.replace(/-/g, ' ');
    const body = buildProgressBody(progress, specTitle);

    // Fire-and-forget PATCH — don't await response status
    githubRateLimiter.execute(() =>
      fetchGithubWithTimeout(fetch, githubRepoApiUrl(owner, repo, `/pulls/${runRow.pr_number}`), {
        method: 'PATCH',
        headers: buildGitHubHeaders(token),
        body: JSON.stringify({ body }),
      }),
    ).then(async (res) => {
      if (res.ok) {
        await emitWalEvent('pr_body_updated', workspaceId, {
          run_id: runId,
          pr_number: runRow.pr_number,
          stories_completed: progress.passed + progress.failed + progress.skipped,
          stories_total: progress.total,
        });
      } else {
        const providerError = extractGithubProviderError(res, 'GITHUB_DRAFT_PR_PROGRESS_FAILED');
        logger.warn({ runId, providerError }, '[draft-pr] Progress PATCH failed');
      }
    }).catch((err) => {
      const providerError = sanitizeGithubProviderException(err, 'GITHUB_DRAFT_PR_PROGRESS_FAILED');
      logger.warn({ providerError, runId }, '[draft-pr] Progress PATCH error');
    });
  } catch (err) {
    const providerError = sanitizeGithubProviderException(err, 'GITHUB_DRAFT_PR_PROGRESS_FAILED');
    logger.warn({ providerError, runId }, '[draft-pr] updateDraftPrProgress error');
  }
}

/**
 * Finalize the draft PR on run completion.
 * - All pass: convert to ready-for-review, remove [WIP], set final body
 * - Failure: keep as draft, append failure summary
 *
 * Called from worker.ts after run_finished event.
 */
export async function finalizeDraftPr(opts: {
  runId: number;
  workspaceId: string | number;
  branchName: string;
  workspacePath: string;
  status: string; // 'done' | 'failed' | 'partial_failure'
}): Promise<void> {
  const { runId, workspaceId, branchName, status } = opts;

  // Flush any pending debounced update
  const pending = pendingUpdates.get(runId);
  if (pending) {
    clearTimeout(pending);
    pendingUpdates.delete(runId);
  }

  const runRow = await queryOne<{ pr_number: number | null; spec_path: string }>(
    'SELECT pr_number, spec_path FROM pipeline_runs WHERE id = $1',
    [runId],
  );

  if (!runRow?.pr_number) {
    logger.debug({ runId }, '[draft-pr] No PR to finalize');
    return;
  }

  const ctx = await resolveGithubContext(workspaceId);
  if (!ctx) return;

  const { token, config } = ctx;
  const { repo_owner: owner, repo_name: repo } = config;
  const prNumber = runRow.pr_number;

  try {
    if (status === 'done') {
      // Build final PR body using the template system (same as createOrUpdateAutoPr)
      const specSlug = runRow.spec_path.split('/').pop()?.replace(/\.json$/, '') ?? `run-${runId}`;
      const specTitle = specSlug.replace(/-/g, ' ');
      const targetBranch = config.auto_pr_target_branch || 'main';

      const progress = await getStoryProgress(runId);

      // Load run metadata for full template
      const runMeta = await queryOne<{
        started_at: string | null;
        finished_at: string | null;
        total_input_tokens: number | null;
        total_output_tokens: number | null;
        total_cost_usd: number | null;
        agent_type: string | null;
        agent_model: string | null;
      }>(
        `SELECT started_at, finished_at, total_input_tokens, total_output_tokens,
                total_cost_usd, agent_type, agent_model
         FROM pipeline_runs WHERE id = $1`,
        [runId],
      );

      const inputTokens = runMeta?.total_input_tokens ?? 0;
      const outputTokens = runMeta?.total_output_tokens ?? 0;
      let elapsedSeconds: number | null = null;
      if (runMeta?.started_at && runMeta?.finished_at) {
        elapsedSeconds = Math.round(
          (new Date(runMeta.finished_at).getTime() - new Date(runMeta.started_at).getTime()) / 1000,
        );
      }

      const formatDuration = (s: number | null): string => {
        if (s == null) return 'unknown';
        if (s < 60) return `${s}s`;
        const mins = Math.floor(s / 60);
        const secs = s % 60;
        if (mins < 60) return `${mins}m ${secs}s`;
        const hrs = Math.floor(mins / 60);
        return `${hrs}h ${mins % 60}m`;
      };

      // Load custom template
      let customTemplate: string | undefined;
      try {
        const rorcaConfig = loadRorcaConfig(opts.workspacePath);
        customTemplate = rorcaConfig.github.prTemplate;
      } catch { /* fallback to default */ }

      // Diff stats
      let diffStats = 'Diff stats unavailable';
      try {
        const result = spawnSync('git', ['diff', '--stat', `${targetBranch}...${branchName}`], {
          cwd: opts.workspacePath, encoding: 'utf8', timeout: 10000,
        });
        if (result.status === 0 && result.stdout) diffStats = result.stdout.trim();
      } catch { /* non-fatal */ }

      const templateData: PrTemplateData = {
        spec: { title: specTitle, brief: specTitle },
        run: {
          id: runId,
          storiesPassed: progress.passed,
          storiesTotal: progress.total,
          storiesFailed: progress.failed,
          storiesSkipped: progress.skipped,
          tokensInput: inputTokens,
          tokensOutput: outputTokens,
          tokensTotal: inputTokens + outputTokens,
          costUsd: runMeta?.total_cost_usd != null ? `$${runMeta.total_cost_usd.toFixed(2)}` : 'N/A',
          duration: formatDuration(elapsedSeconds),
          agentType: runMeta?.agent_type ?? 'claude',
          model: runMeta?.agent_model ?? 'unknown',
          diffStats,
          diffSummary: diffStats,
        },
      };

      const finalBody = renderPrTemplate(customTemplate, templateData);
      const newTitle = `feat: ${specTitle}`;

      // Convert draft to ready-for-review + update title + body
      const patchRes = await githubRateLimiter.execute(() =>
        fetchGithubWithTimeout(fetch, githubRepoApiUrl(owner, repo, `/pulls/${prNumber}`), {
          method: 'PATCH',
          headers: buildGitHubHeaders(token),
          body: JSON.stringify({
            title: newTitle,
            body: finalBody,
            draft: false,
          }),
        }),
      );

      if (!patchRes.ok) throw githubProviderError(patchRes, 'GITHUB_DRAFT_PR_FINALIZE_FAILED');

      // Request reviewers if configured
      const reviewers = parseReviewers(config.auto_pr_reviewers);
      if (reviewers.length > 0) {
        try {
          const reviewerResponse = await githubRateLimiter.execute(() =>
            fetchGithubWithTimeout(fetch, githubRepoApiUrl(owner, repo, `/pulls/${prNumber}/requested_reviewers`), {
              method: 'POST',
              headers: buildGitHubHeaders(token),
              body: JSON.stringify({ reviewers }),
            }),
          );
          if (!reviewerResponse.ok) throw githubProviderError(reviewerResponse, 'GITHUB_PR_REVIEWERS_FAILED');
        } catch (reviewerErr) {
          const providerError = sanitizeGithubProviderException(reviewerErr, 'GITHUB_PR_REVIEWERS_FAILED');
          logger.warn({ providerError, runId, prNumber }, '[draft-pr] Failed to request reviewers (non-fatal)');
        }
      }

      await emitWalEvent('pr_ready', workspaceId, {
        run_id: runId,
        pr_number: prNumber,
        pr_url: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
      });

      logger.info({ runId, prNumber }, '[draft-pr] Draft PR converted to ready-for-review');
    } else {
      // Run failed — keep as draft, append failure summary
      const progress = await getStoryProgress(runId);
      const specSlug = runRow.spec_path.split('/').pop()?.replace(/\.json$/, '') ?? `run-${runId}`;
      const specTitle = specSlug.replace(/-/g, ' ');

      const failureSummary = [
        buildProgressBody(progress, specTitle),
        '',
        '## :warning: Run Failed',
        '',
        `Pipeline finished with status: **${status}**`,
        '',
      ];

      if (progress.failedStoryIds.length > 0) {
        failureSummary.push('Failed stories:');
        for (const id of progress.failedStoryIds) {
          failureSummary.push(`- \`${id}\``);
        }
      }

      failureSummary.push('');
      failureSummary.push('*This PR remains as a draft. Fix the failed stories and re-run the pipeline.*');

      const failurePatch = await githubRateLimiter.execute(() =>
        fetchGithubWithTimeout(fetch, githubRepoApiUrl(owner, repo, `/pulls/${prNumber}`), {
          method: 'PATCH',
          headers: buildGitHubHeaders(token),
          body: JSON.stringify({ body: failureSummary.join('\n') }),
        }),
      );
      if (!failurePatch.ok) throw githubProviderError(failurePatch, 'GITHUB_DRAFT_PR_FINALIZE_FAILED');

      await emitWalEvent('pr_updated', workspaceId, {
        run_id: runId,
        pr_number: prNumber,
        pr_url: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
        status: 'draft_failure',
      });

      logger.info({ runId, prNumber, status }, '[draft-pr] Draft PR updated with failure summary');
    }

    await insertAuditEntry({
      workspaceId: String(workspaceId),
      provider: 'github',
      action: 'api_call_made',
      actorType: 'system',
      details: { action: 'finalize_draft_pr', pr_number: prNumber, run_id: runId, status },
    });
  } catch (err: unknown) {
    const providerError = sanitizeGithubProviderException(err, 'GITHUB_DRAFT_PR_FINALIZE_FAILED');
    const errMsg = formatGithubProviderError(providerError);
    logger.error({ providerError, runId, prNumber }, '[draft-pr] finalizeDraftPr failed');

    await insertAuditEntry({
      workspaceId: String(workspaceId),
      provider: 'github',
      action: 'api_call_failed',
      actorType: 'system',
      details: { action: 'finalize_draft_pr', error: errMsg, run_id: runId },
    });
  }
}

function parseReviewers(raw: string): string[] {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((r): r is string => typeof r === 'string') : [];
  } catch {
    return [];
  }
}
