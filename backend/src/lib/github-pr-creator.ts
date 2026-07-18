/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * github-pr-creator.ts — Auto-PR creation after worktree pipeline runs.
 *
 * Called from worker.ts after a pipeline run completes with status='done'
 * on a worktree branch. Creates a GitHub PR via the REST API using the
 * workspace's stored GitHub token.
 *
 * Non-fatal: failures are logged to wal_events (pr_creation_failed) and
 * stored in pipeline_runs.pr_creation_error. They never fail the run itself.
 *
 * Flow:
 *   1. Resolve canonical workspace repository authority + neutral auto-PR config
 *   2. Resolve the exact-repository GitHub credential
 *   3. Query story_results + token_usage + pipeline_runs for PR body
 *   4. Check for existing open PR (GET /repos/:owner/:repo/pulls?head=branch)
 *   5. Create (POST) or update (PATCH) PR
 *   6. Store pr_number in pipeline_runs
 *   7. Emit pr_created / pr_updated / pr_creation_failed WAL events
 */

import { spawnSync } from 'child_process';
import { query, queryOne, execute } from '../db/index';
import { githubRateLimiter } from './github-rate-limiter';
import { logger } from './logger';
import { loadRorcaConfig } from './rorca-config';
import { renderPrTemplate, PrTemplateData } from './github/pr-template';
import { chatComplete } from './llm-client';
import { getGithubRepositoryAuthority, githubRepoApiUrl } from './github-repository-authority';
import { resolveWorkspaceGitHubToken } from './github-token-resolver';
import { fetchGithubWithTimeout } from './github-app-credential-provider';

// ─── Types ─────────────────────────────────────────────────────────────────

interface GithubWebhookConfig {
  repo_owner: string;
  repo_name: string;
  auto_pr_enabled: boolean;
  auto_pr_target_branch: string;
  auto_pr_reviewers: string; // JSON array string
}

interface RunSummary {
  specTitle: string;
  specBrief: string;
  passed: number;
  failed: number;
  skipped: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number | null;
  elapsedSeconds: number | null;
  agentType: string;
  agentModel: string;
}

interface ExistingPr {
  number: number;
  title: string;
}

// ─── Main entry point ───────────────────────────────────────────────────────

export interface AutoPrOptions {
  runId: number;
  workspaceId: number | string;
  branchName: string;
  workspacePath: string;
  /** When true, skips the auto_pr_enabled check — used when user explicitly chose 'pr' or 'draft-pr' merge strategy. */
  force?: boolean;
}

/**
 * Attempt to create or update a GitHub PR for a completed worktree run.
 * Never throws — all errors are caught, logged, and stored in the DB.
 */
export async function createOrUpdateAutoPr(opts: AutoPrOptions): Promise<void> {
  const { runId, workspaceId, branchName, force } = opts;

  // 1–2. Canonical authority makes App-only workspaces first-class and binds
  // every fallback token to this exact repository.
  let authority;
  try {
    authority = await getGithubRepositoryAuthority(String(workspaceId), { requireActive: true });
  } catch (err) {
    logger.warn({ err, runId, workspaceId }, '[auto-pr] Canonical GitHub authority is inactive');
    return;
  }
  if (!authority) {
    logger.info({ runId, workspaceId }, '[auto-pr] Skipping auto-PR: GitHub not connected');
    return;
  }
  const webhookConfig: GithubWebhookConfig = {
    repo_owner: authority.owner,
    repo_name: authority.name,
    auto_pr_enabled: authority.autoPrEnabled,
    auto_pr_target_branch: authority.autoPrTargetBranch,
    auto_pr_reviewers: JSON.stringify(authority.autoPrReviewers),
  };
  if (!force && !webhookConfig.auto_pr_enabled) {
    logger.info({ runId, workspaceId }, '[auto-pr] Skipping auto-PR: auto_pr_enabled is false');
    return;
  }
  const resolved = await resolveWorkspaceGitHubToken(String(workspaceId), {
    repository: { owner: authority.owner, name: authority.name }, purpose: 'pulls-write',
  }).catch((err) => {
    logger.warn({ err, runId }, '[auto-pr] Exact-repository GitHub credential unavailable');
    return null;
  });
  if (!resolved) return;
  const token = resolved.token;

  // 3. Mark pr_creating=true so the frontend shows a spinner
  try {
    await execute(
      'UPDATE pipeline_runs SET pr_creating = TRUE WHERE id = $1',
      [runId],
    );
    await emitWalEvent('pr_creating', workspaceId, { run_id: runId, branchName });
  } catch (err) {
    logger.warn({ err, runId }, '[auto-pr] Failed to set pr_creating=true');
  }

  const { repo_owner: owner, repo_name: repo } = webhookConfig;
  const targetBranch = webhookConfig.auto_pr_target_branch || 'main';

  try {
    // 4. Build run summary for PR body
    const summary = await buildRunSummary(runId);

    // 5. Build PR title and body
    const prTitle = summary.specTitle
      ? `feat: ${summary.specTitle}`
      : `feat: worktree run #${runId}`;

    // Load custom template from .rorca/config.json (github.prTemplate)
    let customTemplate: string | undefined;
    try {
      const rorcaConfig = loadRorcaConfig(opts.workspacePath);
      customTemplate = rorcaConfig.github.prTemplate;
    } catch {
      // Non-fatal — fall back to default template
    }

    // Get diff stats and synthesized diff summary from git
    const diffStats = getGitDiffStats(opts.workspacePath, branchName, targetBranch);
    const diffSummary = await synthesizeDiffSummary(
      opts.workspacePath, branchName, targetBranch, summary.specBrief,
    );

    const total = summary.passed + summary.failed + summary.skipped;
    const templateData: PrTemplateData = {
      spec: {
        title: summary.specTitle,
        brief: summary.specBrief,
      },
      run: {
        id: runId,
        storiesPassed: summary.passed,
        storiesTotal: total,
        storiesFailed: summary.failed,
        storiesSkipped: summary.skipped,
        tokensInput: summary.inputTokens,
        tokensOutput: summary.outputTokens,
        tokensTotal: summary.totalTokens,
        costUsd: summary.costUsd != null ? `$${summary.costUsd.toFixed(2)}` : 'N/A',
        duration: summary.elapsedSeconds != null ? formatDuration(summary.elapsedSeconds) : 'unknown',
        agentType: summary.agentType,
        model: summary.agentModel,
        diffStats,
        diffSummary: diffSummary || summary.specBrief,
      },
    };
    const prBody = renderPrTemplate(customTemplate, templateData);

    // 6. Check for existing open PR on this branch
    const existingPr = await findExistingPr(owner, repo, branchName, owner, token);

    let prNumber: number;

    if (existingPr) {
      // Update existing PR body
      const updateRes = await githubRateLimiter.execute(() =>
        fetchGithubWithTimeout(fetch, githubRepoApiUrl(owner, repo, `/pulls/${existingPr.number}`), {
          method: 'PATCH',
          headers: buildGitHubHeaders(token),
          body: JSON.stringify({ body: prBody }),
        }),
      );

      if (!updateRes.ok) {
        const errText = await updateRes.text();
        throw new Error(`GitHub PATCH /pulls/${existingPr.number} returned ${updateRes.status}: ${errText}`);
      }

      prNumber = existingPr.number;
      logger.info({ runId, prNumber, owner, repo }, '[auto-pr] PR body updated');

      await storeResult(runId, prNumber, null);
      await emitWalEvent('pr_updated', workspaceId, {
        run_id: runId,
        pr_number: prNumber,
        pr_url: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
        branch: branchName,
      });
    } else {
      // Create new PR
      const createRes = await githubRateLimiter.execute(() =>
        fetchGithubWithTimeout(fetch, githubRepoApiUrl(owner, repo, '/pulls'), {
          method: 'POST',
          headers: buildGitHubHeaders(token),
          body: JSON.stringify({
            title: prTitle,
            head: branchName,
            base: targetBranch,
            body: prBody,
          }),
        }),
      );

      if (!createRes.ok) {
        const errText = await createRes.text();
        throw new Error(`GitHub POST /pulls returned ${createRes.status}: ${errText}`);
      }

      const prData = await createRes.json() as { number: number; html_url: string };
      prNumber = prData.number;

      // Request reviewers if configured
      const reviewers = parseReviewers(webhookConfig.auto_pr_reviewers);
      if (reviewers.length > 0) {
        try {
          await githubRateLimiter.execute(() =>
            fetchGithubWithTimeout(fetch, githubRepoApiUrl(owner, repo, `/pulls/${prNumber}/requested_reviewers`), {
              method: 'POST',
              headers: buildGitHubHeaders(token),
              body: JSON.stringify({ reviewers }),
            }),
          );
        } catch (reviewerErr) {
          logger.warn({ reviewerErr, runId, prNumber }, '[auto-pr] Failed to request reviewers (non-fatal)');
        }
      }

      logger.info({ runId, prNumber, prUrl: prData.html_url, owner, repo }, '[auto-pr] PR created');

      await storeResult(runId, prNumber, null);
      await emitWalEvent('pr_created', workspaceId, {
        run_id: runId,
        pr_number: prNumber,
        pr_url: prData.html_url,
        branch: branchName,
        target_branch: targetBranch,
      });
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err, runId, owner, repo, branchName }, '[auto-pr] PR creation failed');

    await storeResult(runId, null, errMsg);
    await emitWalEvent('pr_creation_failed', workspaceId, {
      run_id: runId,
      branch: branchName,
      error: errMsg,
    });
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildGitHubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function parseReviewers(raw: string): string[] {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((r): r is string => typeof r === 'string') : [];
  } catch {
    return [];
  }
}

async function findExistingPr(
  owner: string,
  repo: string,
  branchName: string,
  repoOwner: string,
  token: string,
): Promise<ExistingPr | null> {
  const head = `${repoOwner}:${branchName}`;
  const url = githubRepoApiUrl(owner, repo, `/pulls?head=${encodeURIComponent(head)}&state=open&per_page=1`);

  const res = await githubRateLimiter.execute(() =>
    fetchGithubWithTimeout(fetch, url, { headers: buildGitHubHeaders(token) }),
  );

  if (!res.ok) {
    logger.warn({ status: res.status, url }, '[auto-pr] Could not check for existing PRs — proceeding with create');
    return null;
  }

  const prs = await res.json() as Array<{ number: number; title: string }>;
  return prs.length > 0 ? { number: prs[0].number, title: prs[0].title } : null;
}

async function buildRunSummary(runId: number): Promise<RunSummary> {
  // Run metadata
  const runRow = await queryOne<{
    spec_path: string;
    started_at: string | null;
    finished_at: string | null;
    total_input_tokens: number | null;
    total_output_tokens: number | null;
    total_cost_usd: number | null;
    agent_type: string | null;
    agent_model: string | null;
  }>(
    `SELECT spec_path, started_at, finished_at,
            total_input_tokens, total_output_tokens, total_cost_usd,
            agent_type, agent_model
     FROM pipeline_runs WHERE id = $1`,
    [runId],
  );

  const specSlug = runRow
    ? (runRow.spec_path.split('/').pop()?.replace(/\.json$/, '') ?? `run-${runId}`)
    : `run-${runId}`;

  const specTitle = specSlug.replace(/-/g, ' ');
  // Use the slug as the brief since we don't store a human brief in pipeline_runs
  const specBrief = specTitle;

  // Story outcome counts — use latest result per story_id
  type StoryRow = { story_id: string; status: string };
  const storyRows = await query<StoryRow>(
    `SELECT DISTINCT ON (story_id) story_id, status
     FROM story_results
     WHERE run_id = $1
     ORDER BY story_id, id DESC`,
    [runId],
  );

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const s of storyRows) {
    if (s.status === 'pass') passed++;
    else if (s.status === 'fail') failed++;
    else skipped++;
  }

  const inputTokens = runRow?.total_input_tokens ?? 0;
  const outputTokens = runRow?.total_output_tokens ?? 0;
  const totalTokens = inputTokens + outputTokens;
  const costUsd = runRow?.total_cost_usd ?? null;

  // Elapsed seconds
  let elapsedSeconds: number | null = null;
  if (runRow?.started_at && runRow?.finished_at) {
    const startMs = new Date(runRow.started_at).getTime();
    const endMs = new Date(runRow.finished_at).getTime();
    elapsedSeconds = Math.round((endMs - startMs) / 1000);
  }

  return {
    specTitle,
    specBrief,
    passed,
    failed,
    skipped,
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd,
    elapsedSeconds,
    agentType: runRow?.agent_type ?? 'claude',
    agentModel: runRow?.agent_model ?? 'unknown',
  };
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h ${remMins}m`;
}

/**
 * Run `git diff --stat <base>...<branch>` in the workspace and return the output.
 * Returns a placeholder string on any error.
 */
function getGitDiffStats(workspacePath: string, branchName: string, targetBranch: string): string {
  try {
    const result = spawnSync(
      'git',
      ['diff', '--stat', `${targetBranch}...${branchName}`],
      { cwd: workspacePath, encoding: 'utf8', timeout: 10000 },
    );
    if (result.status === 0 && result.stdout) {
      return result.stdout.trim();
    }
  } catch {
    // Non-fatal
  }
  return 'Diff stats unavailable';
}

/**
 * Synthesize a truthful PR summary from the actual git diff using an LLM.
 * Returns a concise markdown summary describing what was actually built,
 * not what the spec planned. Falls back to a generic message on failure.
 */
async function synthesizeDiffSummary(
  workspacePath: string,
  branchName: string,
  targetBranch: string,
  specBrief: string,
): Promise<string> {
  try {
    const result = spawnSync(
      'git',
      ['diff', `${targetBranch}...${branchName}`],
      { cwd: workspacePath, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 * 2 },
    );
    if (result.status !== 0 || !result.stdout?.trim()) {
      return '';
    }

    // Truncate large diffs to ~50k chars (~12k tokens) to stay within context limits
    const diff = result.stdout.length > 50_000
      ? result.stdout.slice(0, 50_000) + '\n\n... (diff truncated)'
      : result.stdout;

    const prompt = `You are a technical writer reviewing a completed code change. Below is the original spec brief and the actual git diff.

Your job: Write a concise summary (3-8 bullet points) of what was ACTUALLY implemented based on the diff. Focus on what changed, not what was planned. If the implementation deviates from the spec brief, note that as "Implementation note: ..."

Do NOT repeat the spec brief verbatim. Do NOT add test plans or action items. Just describe the reality of the code changes.

## Original Spec Brief
${specBrief || '(no brief provided)'}

## Git Diff
\`\`\`diff
${diff}
\`\`\`

Respond with ONLY the bullet-point summary in markdown. No preamble.`;

    const llmResult = await chatComplete([{ role: 'user', content: prompt }]);
    const summary = llmResult.text?.trim();
    if (summary && summary.length > 10) {
      return summary;
    }
  } catch (err) {
    logger.warn({ err }, '[auto-pr] Diff summary synthesis failed (non-fatal)');
  }
  return '';
}

async function storeResult(runId: number, prNumber: number | null, errorMsg: string | null): Promise<void> {
  try {
    await execute(
      `UPDATE pipeline_runs
       SET pr_number = $1, pr_creating = FALSE, pr_creation_error = $2
       WHERE id = $3`,
      [prNumber, errorMsg, runId],
    );
  } catch (err) {
    logger.warn({ err, runId }, '[auto-pr] Failed to store PR result in pipeline_runs');
  }
}

async function emitWalEvent(
  eventType: string,
  workspaceId: number | string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await execute(
      `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ($1, $2, $3)`,
      [eventType, String(workspaceId), JSON.stringify(payload)],
    );
  } catch (err) {
    logger.warn({ err, eventType }, '[auto-pr] Failed to emit WAL event');
  }
}
