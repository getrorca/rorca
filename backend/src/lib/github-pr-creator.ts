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
 *   6. Store pr_number in pipeline_runs
 *   7. Emit pr_created / pr_updated / pr_creation_failed WAL events
 */

import { query, queryOne, execute } from '../db/index';
import { decryptToken } from '../routes/auth';
import { githubRateLimiter } from './github-rate-limiter';
import { logger } from './logger';

// ─── Types ─────────────────────────────────────────────────────────────────

interface GithubWebhookConfig {
  repo_owner: string;
  repo_name: string;
  auto_pr_enabled: boolean;
  auto_pr_target_branch: string;
  auto_pr_reviewers: string; // JSON array string
}

interface GitHubConnection {
  encrypted_token: string;
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
    `SELECT repo_owner, repo_name, auto_pr_enabled, auto_pr_target_branch, auto_pr_reviewers
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

      // Request reviewers if configured
      const reviewers = parseReviewers(webhookConfig.auto_pr_reviewers);
      if (reviewers.length > 0) {
        try {
          await githubRateLimiter.execute(() =>
            fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/requested_reviewers`, {
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
