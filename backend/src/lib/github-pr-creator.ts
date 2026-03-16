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
 *   1. Look up workspace_github_webhooks → get repo_owner, repo_name, auto_pr config
 *   2. Look up github_connections → decrypt OAuth token
 *   3. Query story_results + token_usage + pipeline_runs for PR body
 *   4. Check for existing open PR (GET /repos/:owner/:repo/pulls?head=branch)
 *   5. Create (POST) or update (PATCH) PR
 *   6. Request reviewers (default + conditional rules + CODEOWNERS path matching)
 *   7. Store pr_number in pipeline_runs
 *   8. Emit pr_created / pr_updated / pr_creation_failed WAL events
 */

import { query, queryOne, execute } from '../db/index';
import { decryptToken } from '../routes/auth';
import { githubRateLimiter } from './github-rate-limiter';
import { logger } from './logger';
import micromatch from 'micromatch';

// ─── Types ─────────────────────────────────────────────────────────────────

interface GithubWebhookConfig {
  repo_owner: string;
  repo_name: string;
  auto_pr_enabled: boolean;
  auto_pr_target_branch: string;
  auto_pr_reviewers: string; // JSON array string (legacy)
  review_config: string | ReviewConfig | null; // JSONB — may be string or parsed object
}

interface GitHubConnection {
  encrypted_token: string;
}

/** Stored in workspace_github_webhooks.review_config JSONB */
export interface ReviewConfig {
  defaultReviewers?: string[];
  teamReviewers?: string[];
  rules?: ConditionalRule[];
  pathRules?: PathRule[];
}

export interface ConditionalRule {
  condition: {
    field: 'tag' | 'persona';
    matches: string;
  };
  reviewers?: string[];
  teamReviewers?: string[];
}

export interface PathRule {
  pattern: string; // glob pattern (micromatch)
  reviewers?: string[];
  teamReviewers?: string[];
}

export interface ReviewRequestResult {
  requestedReviewers: string[];
  requestedTeams: string[];
  failedReviewers: string[];
  failedTeams: string[];
}

interface RunSummary {
  specTitle: string;
  passed: number;
  failed: number;
  skipped: number;
  totalTokens: number;
  elapsedSeconds: number | null;
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
}

/**
 * Attempt to create or update a GitHub PR for a completed worktree run.
 * Never throws — all errors are caught, logged, and stored in the DB.
 */
export async function createOrUpdateAutoPr(opts: AutoPrOptions): Promise<void> {
  const { runId, workspaceId, branchName } = opts;

  // 1. Look up GitHub webhook config for this workspace
  const webhookConfig = await queryOne<GithubWebhookConfig>(
    `SELECT repo_owner, repo_name, auto_pr_enabled, auto_pr_target_branch, auto_pr_reviewers, review_config
     FROM workspace_github_webhooks WHERE workspace_id = $1`,
    [String(workspaceId)],
  );

  if (!webhookConfig) {
    logger.info({ runId, workspaceId }, '[auto-pr] Skipping auto-PR: GitHub not connected');
    return;
  }

  if (!webhookConfig.auto_pr_enabled) {
    logger.info({ runId, workspaceId }, '[auto-pr] Skipping auto-PR: auto_pr_enabled is false');
    return;
  }

  // 2. Look up GitHub OAuth token (first user — single-user local tool)
  const userRow = await queryOne<{ id: string }>('SELECT id FROM users LIMIT 1');
  if (!userRow) {
    logger.info({ runId }, '[auto-pr] Skipping auto-PR: no users configured');
    return;
  }

  const ghConn = await queryOne<GitHubConnection>(
    'SELECT encrypted_token FROM github_connections WHERE user_id = $1',
    [userRow.id],
  );

  if (!ghConn) {
    logger.info({ runId }, '[auto-pr] Skipping auto-PR: no GitHub OAuth token found');
    return;
  }

  let token: string;
  try {
    token = decryptToken(ghConn.encrypted_token);
  } catch (err) {
    logger.warn({ err, runId }, '[auto-pr] Failed to decrypt GitHub token — skipping');
    return;
  }

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
    const prBody = buildPrBody(summary, runId, branchName);

    // 6. Check for existing open PR on this branch
    const existingPr = await findExistingPr(owner, repo, branchName, owner, token);

    let prNumber: number;

    if (existingPr) {
      // Update existing PR body
      const updateRes = await githubRateLimiter.execute(() =>
        fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${existingPr.number}`, {
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
        fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
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

      // Request reviewers — merge legacy auto_pr_reviewers + review_config
      const reviewResult = await requestReviewers({
        owner,
        repo,
        prNumber,
        token,
        legacyReviewers: webhookConfig.auto_pr_reviewers,
        reviewConfig: webhookConfig.review_config,
        runId,
        workspaceId,
      });

      logger.info({ runId, prNumber, prUrl: prData.html_url, owner, repo, reviewResult }, '[auto-pr] PR created');

      await storeResult(runId, prNumber, null);
      await emitWalEvent('pr_created', workspaceId, {
        run_id: runId,
        pr_number: prNumber,
        pr_url: prData.html_url,
        branch: branchName,
        target_branch: targetBranch,
        reviewers_requested: reviewResult.requestedReviewers,
        teams_requested: reviewResult.requestedTeams,
        reviewers_failed: reviewResult.failedReviewers,
        teams_failed: reviewResult.failedTeams,
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

export function parseReviewConfig(raw: string | ReviewConfig | null | undefined): ReviewConfig {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Resolve all reviewers for a PR based on config layers:
 * 1. Legacy auto_pr_reviewers (backward compat)
 * 2. review_config.defaultReviewers / teamReviewers
 * 3. Conditional rules (tag/persona matching)
 * 4. CODEOWNERS-style path rules
 */
export function resolveReviewers(opts: {
  legacyReviewers: string;
  reviewConfig: string | ReviewConfig | null;
  specTags?: string[];
  storyPersonas?: string[];
  changedFiles?: string[];
}): { reviewers: string[]; teamReviewers: string[] } {
  const config = parseReviewConfig(opts.reviewConfig);
  const reviewerSet = new Set<string>();
  const teamSet = new Set<string>();

  // Layer 1: Legacy auto_pr_reviewers
  for (const r of parseReviewers(opts.legacyReviewers)) {
    reviewerSet.add(r);
  }

  // Layer 2: Default reviewers from review_config
  if (config.defaultReviewers) {
    for (const r of config.defaultReviewers) {
      reviewerSet.add(r);
    }
  }
  if (config.teamReviewers) {
    for (const t of config.teamReviewers) {
      teamSet.add(t);
    }
  }

  // Layer 3: Conditional rules
  if (config.rules) {
    const specTags = opts.specTags ?? [];
    const storyPersonas = opts.storyPersonas ?? [];

    for (const rule of config.rules) {
      let matched = false;
      if (rule.condition.field === 'tag') {
        matched = specTags.some(t => t.toLowerCase() === rule.condition.matches.toLowerCase());
      } else if (rule.condition.field === 'persona') {
        matched = storyPersonas.some(p => p.toLowerCase() === rule.condition.matches.toLowerCase());
      }

      if (matched) {
        if (rule.reviewers) {
          for (const r of rule.reviewers) reviewerSet.add(r);
        }
        if (rule.teamReviewers) {
          for (const t of rule.teamReviewers) teamSet.add(t);
        }
      }
    }
  }

  // Layer 4: CODEOWNERS-style path rules
  if (config.pathRules && opts.changedFiles && opts.changedFiles.length > 0) {
    for (const pathRule of config.pathRules) {
      const matched = micromatch(opts.changedFiles, pathRule.pattern).length > 0;
      if (matched) {
        if (pathRule.reviewers) {
          for (const r of pathRule.reviewers) reviewerSet.add(r);
        }
        if (pathRule.teamReviewers) {
          for (const t of pathRule.teamReviewers) teamSet.add(t);
        }
      }
    }
  }

  return {
    reviewers: [...reviewerSet],
    teamReviewers: [...teamSet],
  };
}

/**
 * Request reviewers on a GitHub PR. Handles partial failures gracefully.
 * Never throws — returns a result with success/failure counts.
 */
async function requestReviewers(opts: {
  owner: string;
  repo: string;
  prNumber: number;
  token: string;
  legacyReviewers: string;
  reviewConfig: string | ReviewConfig | null;
  runId: number;
  workspaceId: number | string;
}): Promise<ReviewRequestResult> {
  const result: ReviewRequestResult = {
    requestedReviewers: [],
    requestedTeams: [],
    failedReviewers: [],
    failedTeams: [],
  };

  // Gather spec tags and story personas for conditional rules
  let specTags: string[] = [];
  let storyPersonas: string[] = [];
  let changedFiles: string[] = [];

  try {
    // Fetch spec tags from the run's spec
    const tagRows = await query<{ tag_name: string }>(
      `SELECT DISTINCT t.name AS tag_name
       FROM spec_tag_assignments sta
       JOIN spec_tags t ON t.id = sta.tag_id
       JOIN pipeline_runs pr ON pr.spec_path LIKE '%' || sta.spec_id || '%'
       WHERE pr.id = $1`,
      [opts.runId],
    );
    specTags = tagRows.map(r => r.tag_name);
  } catch {
    // Tags are optional — continue without them
  }

  try {
    // Fetch story personas from story_results
    const personaRows = await query<{ persona: string }>(
      `SELECT DISTINCT sr.persona FROM story_results sr WHERE sr.run_id = $1 AND sr.persona IS NOT NULL`,
      [opts.runId],
    );
    storyPersonas = personaRows.map(r => r.persona);
  } catch {
    // Personas are optional — continue without them
  }

  try {
    // Fetch changed files from GitHub PR files API
    const filesRes = await githubRateLimiter.execute(() =>
      fetch(
        `https://api.github.com/repos/${opts.owner}/${opts.repo}/pulls/${opts.prNumber}/files?per_page=100`,
        { headers: buildGitHubHeaders(opts.token) },
      ),
    );
    if (filesRes.ok) {
      const files = await filesRes.json() as Array<{ filename: string }>;
      changedFiles = files.map(f => f.filename);
    }
  } catch {
    // Changed files are optional — continue without them
  }

  const { reviewers, teamReviewers } = resolveReviewers({
    legacyReviewers: opts.legacyReviewers,
    reviewConfig: opts.reviewConfig,
    specTags,
    storyPersonas,
    changedFiles,
  });

  if (reviewers.length === 0 && teamReviewers.length === 0) {
    return result;
  }

  // Emit "requesting reviewers" status
  try {
    await emitWalEvent('pr_requesting_reviewers', opts.workspaceId, {
      run_id: opts.runId,
      pr_number: opts.prNumber,
      reviewers,
      team_reviewers: teamReviewers,
    });
  } catch {
    // Non-fatal
  }

  // Send single request with all reviewers + teams
  try {
    const reqBody: { reviewers?: string[]; team_reviewers?: string[] } = {};
    if (reviewers.length > 0) reqBody.reviewers = reviewers;
    if (teamReviewers.length > 0) reqBody.team_reviewers = teamReviewers;

    const res = await githubRateLimiter.execute(() =>
      fetch(
        `https://api.github.com/repos/${opts.owner}/${opts.repo}/pulls/${opts.prNumber}/requested_reviewers`,
        {
          method: 'POST',
          headers: buildGitHubHeaders(opts.token),
          body: JSON.stringify(reqBody),
        },
      ),
    );

    if (res.ok) {
      result.requestedReviewers = reviewers;
      result.requestedTeams = teamReviewers;
    } else {
      // GitHub returns 422 with details about which reviewers failed
      const errBody = await res.text();
      logger.warn(
        { status: res.status, body: errBody, runId: opts.runId, prNumber: opts.prNumber },
        '[auto-pr] Reviewer request returned non-200 — falling back to individual requests',
      );

      // Fall back: try each reviewer individually
      for (const r of reviewers) {
        try {
          const individualRes = await githubRateLimiter.execute(() =>
            fetch(
              `https://api.github.com/repos/${opts.owner}/${opts.repo}/pulls/${opts.prNumber}/requested_reviewers`,
              {
                method: 'POST',
                headers: buildGitHubHeaders(opts.token),
                body: JSON.stringify({ reviewers: [r] }),
              },
            ),
          );
          if (individualRes.ok) {
            result.requestedReviewers.push(r);
          } else {
            result.failedReviewers.push(r);
            logger.warn({ reviewer: r, status: individualRes.status, runId: opts.runId }, '[auto-pr] Individual reviewer request failed');
          }
        } catch {
          result.failedReviewers.push(r);
        }
      }

      for (const t of teamReviewers) {
        try {
          const individualRes = await githubRateLimiter.execute(() =>
            fetch(
              `https://api.github.com/repos/${opts.owner}/${opts.repo}/pulls/${opts.prNumber}/requested_reviewers`,
              {
                method: 'POST',
                headers: buildGitHubHeaders(opts.token),
                body: JSON.stringify({ team_reviewers: [t] }),
              },
            ),
          );
          if (individualRes.ok) {
            result.requestedTeams.push(t);
          } else {
            result.failedTeams.push(t);
            logger.warn({ team: t, status: individualRes.status, runId: opts.runId }, '[auto-pr] Team reviewer request failed');
          }
        } catch {
          result.failedTeams.push(t);
        }
      }
    }
  } catch (err) {
    // Total failure — all become failed
    result.failedReviewers = reviewers;
    result.failedTeams = teamReviewers;
    logger.warn({ err, runId: opts.runId }, '[auto-pr] All reviewer requests failed');
  }

  // If ALL reviewers failed, emit a warning WAL event
  const totalRequested = result.requestedReviewers.length + result.requestedTeams.length;
  const totalFailed = result.failedReviewers.length + result.failedTeams.length;
  if (totalFailed > 0 && totalRequested === 0) {
    try {
      await emitWalEvent('pr_review_warning', opts.workspaceId, {
        run_id: opts.runId,
        pr_number: opts.prNumber,
        message: 'Could not add reviewers — check configuration',
        failed_reviewers: result.failedReviewers,
        failed_teams: result.failedTeams,
      });
    } catch {
      // Non-fatal
    }
  }

  return result;
}

async function findExistingPr(
  owner: string,
  repo: string,
  branchName: string,
  repoOwner: string,
  token: string,
): Promise<ExistingPr | null> {
  const head = `${repoOwner}:${branchName}`;
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(head)}&state=open&per_page=1`;

  const res = await githubRateLimiter.execute(() =>
    fetch(url, { headers: buildGitHubHeaders(token) }),
  );

  if (!res.ok) {
    logger.warn({ status: res.status, url }, '[auto-pr] Could not check for existing PRs — proceeding with create');
    return null;
  }

  const prs = await res.json() as Array<{ number: number; title: string }>;
  return prs.length > 0 ? { number: prs[0].number, title: prs[0].title } : null;
}

async function buildRunSummary(runId: number): Promise<RunSummary> {
  // Spec title from spec_path
  const runRow = await queryOne<{
    spec_path: string;
    started_at: string | null;
    finished_at: string | null;
    total_input_tokens: number | null;
    total_output_tokens: number | null;
  }>(
    'SELECT spec_path, started_at, finished_at, total_input_tokens, total_output_tokens FROM pipeline_runs WHERE id = $1',
    [runId],
  );

  const specTitle = runRow
    ? runRow.spec_path
        .split('/')
        .pop()
        ?.replace(/\.json$/, '')
        .replace(/-/g, ' ') ?? `run #${runId}`
    : `run #${runId}`;

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

  // Token total
  const totalTokens = (runRow?.total_input_tokens ?? 0) + (runRow?.total_output_tokens ?? 0);

  // Elapsed seconds
  let elapsedSeconds: number | null = null;
  if (runRow?.started_at && runRow?.finished_at) {
    const startMs = new Date(runRow.started_at).getTime();
    const endMs = new Date(runRow.finished_at).getTime();
    elapsedSeconds = Math.round((endMs - startMs) / 1000);
  }

  return { specTitle, passed, failed, skipped, totalTokens, elapsedSeconds };
}

function buildPrBody(summary: RunSummary, runId: number, branchName: string): string {
  const total = summary.passed + summary.failed + summary.skipped;
  const elapsedStr = summary.elapsedSeconds != null
    ? formatDuration(summary.elapsedSeconds)
    : 'unknown';

  const lines = [
    `## Rorca Pipeline Run #${runId}`,
    '',
    `**Branch**: \`${branchName}\``,
    `**Spec**: ${summary.specTitle}`,
    '',
    '### Story Results',
    '',
    `| Outcome | Count |`,
    `|---------|-------|`,
    `| ✅ Passed | ${summary.passed} |`,
    `| ❌ Failed | ${summary.failed} |`,
    `| ⏭ Skipped | ${summary.skipped} |`,
    `| **Total** | **${total}** |`,
    '',
    '### Run Metrics',
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Elapsed | ${elapsedStr} |`,
    `| Tokens | ${summary.totalTokens.toLocaleString()} |`,
    '',
    '---',
    '*Generated automatically by [Rorca](https://rorca.app)*',
  ];

  return lines.join('\n');
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
