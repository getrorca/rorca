/**
 * worker.ts — Standalone pg-boss worker process for Rorca.
 *
 * This process is completely independent of the Express server. It connects
 * to the same DATABASE_URL and owns the execution-engine job lifecycle:
 *
 *   pipeline:run    — trigger a new pipeline run
 *   pipeline:retry  — retry failed stories in a completed run
 *   pipeline:cancel — cancel an active run
 *
 * Start: npm run worker
 * Stop:  SIGTERM (graceful) — drains in-flight jobs up to 30s, then exits
 */

import 'dotenv/config';
// Mark this process as 'worker' so db/index.ts doesn't register its own
// SIGTERM handler — the worker manages pool teardown in its shutdown() function.
process.env.RORCA_PROCESS_ROLE = 'worker';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { spawn, execSync, type ChildProcess } from 'child_process';
import { z } from 'zod';
import PgBoss from 'pg-boss';
import {
  PipelineRunJobPayload,
  type PipelineRunJobPayloadType,
  PipelineRetryJobPayload,
  type PipelineRetryJobPayloadType,
  PipelineCancelJobPayload,
  PipelineMergeJobPayload,
} from './lib/pg-boss-schemas';

import simpleGit from 'simple-git';
import { performMerge } from './lib/merge-handler';
import { initDb, query, queryOne, execute, closePool } from './db/index';
import { initBoss, getBoss } from './lib/pg-boss';
import { registerSchedulesWithBoss, triggerScheduledRun, checkAndFireDueSchedules } from './lib/scheduler';
import { logger } from './lib/logger';
import { broadcastAll } from './lib/sse-hub';
import { advanceQueue } from './lib/run-queue';
import { FlushBuffer } from './lib/flush-buffer';
import { createOrUpdateAutoPr } from './lib/github-pr-creator';
import { createDraftPr, finalizeDraftPr } from './lib/github-draft-pr';

// ── tsx binary resolution ─────────────────────────────────────────────────────

/**
 * Resolve the tsx binary used to spawn execution-engine subprocesses.
 * Primary: backend/node_modules/.bin/tsx (works after `npm install` in backend/).
 * Fallback: search PATH via `which tsx` (works when tsx is installed globally or via npx).
 * Throws if tsx cannot be found — a missing tsx binary means runs will always fail.
 */
function findTsxBin(): string {
  const local = path.join(__dirname, '..', 'node_modules', '.bin', 'tsx');
  if (fs.existsSync(local)) return local;
  // Fallback: search PATH
  try {
    const found = execSync('which tsx 2>/dev/null', { encoding: 'utf8' }).trim();
    if (found) return found;
  } catch { /* ignore */ }
  throw new Error(
    `tsx binary not found at ${local} and not in PATH. ` +
    `Run 'cd backend && npm install' to install devDependencies.`
  );
}

// ── Post-merge smoke test ─────────────────────────────────────────────────────

/**
 * Verify core API endpoints return 200 after a worktree merge.
 * Catches bugs introduced by merged code (e.g. search_path poisoning,
 * broken migrations) before the merge is marked as complete.
 */
async function runPostMergeSmokeTest(workspaceId: string | number): Promise<{ ok: boolean; failures: string[] }> {
  const port = process.env.PORT || 3030;
  const base = `http://localhost:${port}`;
  const endpoints = [
    `/api/workspaces/${workspaceId}`,
    `/api/workspaces/${workspaceId}/health`,
    `/api/workspaces/${workspaceId}/pipeline-config`,
    `/api/specs/kanban?workspaceId=${workspaceId}`,
  ];

  const failures: string[] = [];
  for (const ep of endpoints) {
    try {
      const res = await fetch(`${base}${ep}`);
      if (!res.ok) {
        failures.push(`${ep} → ${res.status}`);
      }
    } catch (err: any) {
      failures.push(`${ep} → ${err.message}`);
    }
  }

  return { ok: failures.length === 0, failures };
}

// ── GitHub Actions workflow dispatch on run completion (US-026) ───────────────

/**
 * Fire a GitHub Actions workflow_dispatch event if the workspace has a workflow
 * config stored in workspace_github_webhooks.workflow_config with enabled=true.
 * Non-fatal: any failure is logged to integration_audit_log and emitted as a WAL event.
 * Never throws — must not block run finalization.
 */
async function dispatchWorkflowIfConfigured(
  workspaceId: string | number,
  runId: number,
): Promise<void> {
  const port = process.env.PORT || 3030;
  const base = `http://localhost:${port}`;

  try {
    // Fetch workspace webhook row to get repo details + workflow config
    const row = await queryOne<{
      repo_owner: string;
      repo_name: string;
      workflow_config: string | Record<string, unknown> | null;
    }>(
      'SELECT repo_owner, repo_name, workflow_config FROM workspace_github_webhooks WHERE workspace_id = $1',
      [workspaceId]
    );

    if (!row || !row.workflow_config) return;

    const cfg = (typeof row.workflow_config === 'string'
      ? JSON.parse(row.workflow_config)
      : row.workflow_config) as {
        enabled?: boolean;
        workflow_id?: string;
        ref?: string;
        inputs?: Record<string, string>;
      };

    if (!cfg.enabled || !cfg.workflow_id || !cfg.ref) return;

    // Emit SSE: "Triggering workflow..."
    await execute(
      `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('workflow_dispatching', $1, $2)`,
      [String(workspaceId), JSON.stringify({ run_id: runId, workflow_id: cfg.workflow_id, ref: cfg.ref })]
    );

    // Proxy through our own API so the OAuth token lookup + audit log happens in one place
    const dispatchRes = await fetch(`${base}/api/workspaces/${workspaceId}/github/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        owner: row.repo_owner,
        repo: row.repo_name,
        workflow_id: cfg.workflow_id,
        ref: cfg.ref,
        inputs: cfg.inputs ?? {},
      }),
    });

    if (dispatchRes.ok || dispatchRes.status === 204) {
      await execute(
        `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('workflow_dispatched', $1, $2)`,
        [String(workspaceId), JSON.stringify({
          run_id: runId,
          workflow_id: cfg.workflow_id,
          ref: cfg.ref,
          owner: row.repo_owner,
          repo: row.repo_name,
        })]
      );
      logger.info({ runId, workflow_id: cfg.workflow_id }, '[worker] GitHub workflow dispatch succeeded');
    } else {
      const errText = await dispatchRes.text().catch(() => String(dispatchRes.status));
      await execute(
        `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('workflow_dispatch_failed', $1, $2)`,
        [String(workspaceId), JSON.stringify({
          run_id: runId,
          workflow_id: cfg.workflow_id,
          error: errText,
          status_code: dispatchRes.status,
        })]
      );
      // Also log to integration_audit_log for the Run View amber banner
      await execute(
        `INSERT INTO integration_audit_log (workspace_id, provider, action, actor_type, actor_id, details)
         VALUES ($1, 'github', 'api_call_failed', 'system', NULL, $2)`,
        [String(workspaceId), JSON.stringify({
          run_id: runId,
          workflow_id: cfg.workflow_id,
          status_code: dispatchRes.status,
          error: errText,
        })]
      ).catch(() => { /* non-fatal */ });
      logger.warn({ runId, workflow_id: cfg.workflow_id, status: dispatchRes.status, errText }, '[worker] GitHub workflow dispatch failed');
    }
  } catch (err: any) {
    logger.error({ err, runId }, '[worker] dispatchWorkflowIfConfigured threw unexpectedly');
    // Emit failure WAL event so the UI can show the amber banner
    try {
      await execute(
        `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('workflow_dispatch_failed', $1, $2)`,
        [String(workspaceId), JSON.stringify({ run_id: runId, error: err.message })]
      );
    } catch { /* double-fault, ignore */ }
  }
}

// ── Claude binary + env-var stripping for agentic conflict resolution ────────

const CLAUDE_BIN = process.env.CLAUDE_BIN ||
  (() => {
    try { return execSync('which claude', { encoding: 'utf8' }).trim(); } catch { return 'claude'; }
  })();

const CLAUDE_ENV_VARS_TO_REMOVE = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
];

function buildCleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !CLAUDE_ENV_VARS_TO_REMOVE.includes(k)) {
      env[k] = v;
    }
  }
  return env;
}

const AGENTIC_RESOLVE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const AGENTIC_RESOLVE_SIGKILL_DELAY_MS = 10_000;   // 10s after SIGTERM

// ── Worker identity (stable for the lifetime of this process) ────────────────

const WORKER_ID: string = crypto.randomUUID();
const WORKER_HOSTNAME: string = os.hostname();
const WORKER_STARTED_AT: Date = new Date();

const HEARTBEAT_INTERVAL_MS = 30_000; // 30 s

// ── Active process map (runId → ChildProcess) ────────────────────────────
// Declared early so writeHeartbeat() can read .size before activeProcesses
// is mutated by job handlers. Cleaned up when the process exits.

const activeProcesses = new Map<number, ChildProcess>();

// ── Cancelling runs set (runId) ───────────────────────────────────────────
// Tracks which runs are being intentionally cancelled so the exit handler
// writes status='cancelled' (not 'failed') and emits run_cancelled WAL event.

const cancellingRuns = new Set<number>();

// ── Reconciliation error counter (updated by reconcileState) ─────────────────
// Surfaced on the health endpoint as lastReconciliationErrors.

let lastReconciliationErrors = 0;

// ── pg-boss self-check (consecutive failure counter) ─────────────────────────
// If boss.getQueueSize throws 3 consecutive times the pg-boss connection is
// considered dead; we log FATAL and exit(1) so the supervisor restarts us.

let pgBossHealthFailures = 0;
const PG_BOSS_HEALTH_MAX_FAILURES = 3;

async function pgBossHealthCheck(): Promise<void> {
  try {
    const boss = getBoss();
    await boss.getQueueSize('pipeline:run');
    // Success — reset the counter
    pgBossHealthFailures = 0;
  } catch (err) {
    pgBossHealthFailures += 1;
    logger.warn(
      { err, consecutiveFailures: pgBossHealthFailures },
      '[worker] pg-boss getQueueSize failed',
    );
    if (pgBossHealthFailures >= PG_BOSS_HEALTH_MAX_FAILURES) {
      logger.fatal(
        { consecutiveFailures: pgBossHealthFailures },
        '[worker] FATAL — pg-boss connection dead (3 consecutive getQueueSize failures) — exiting for supervisor restart',
      );
      process.exit(1);
    }
  }
}

async function writeHeartbeat(): Promise<void> {
  try {
    await execute(
      `INSERT INTO worker_heartbeat (worker_id, pid, hostname, started_at, last_seen, active_jobs)
       VALUES ($1, $2, $3, $4, NOW(), $5)
       ON CONFLICT (worker_id) DO UPDATE SET last_seen = NOW(), pid = EXCLUDED.pid, active_jobs = EXCLUDED.active_jobs`,
      [WORKER_ID, process.pid, WORKER_HOSTNAME, WORKER_STARTED_AT, activeProcesses.size],
    );
  } catch (err) {
    logger.warn({ err }, '[worker] heartbeat write failed');
  }
}

// ── Validate environment ─────────────────────────────────────────────────

if (!process.env.DATABASE_URL) {
  logger.error('[worker] DATABASE_URL is not set — exiting');
  process.exit(1);
}

// ── Chunk size constant ───────────────────────────────────────────────────

const CHUNK_SIZE = 4 * 1024; // 4 KB

// ── Helper: write a single chunk to run_output_chunks ────────────────────

async function writeChunk(runId: number, sequence: number, data: Buffer): Promise<void> {
  try {
    await execute(
      `INSERT INTO run_output_chunks (run_id, chunk, sequence)
       VALUES ($1, $2, $3)
       ON CONFLICT (run_id, sequence) DO NOTHING`,
      [runId, data, sequence],
    );
  } catch (err) {
    logger.warn({ err, runId, sequence }, '[worker] Failed to write output chunk');
  }
}

// ── Helper: split a Buffer into ≤CHUNK_SIZE pieces and write them all ────

async function writeBufferAsChunks(
  runId: number,
  buf: Buffer,
  sequenceRef: { value: number },
): Promise<void> {
  let offset = 0;
  while (offset < buf.length) {
    const slice = buf.slice(offset, offset + CHUNK_SIZE);
    await writeChunk(runId, sequenceRef.value, slice);
    sequenceRef.value += 1;
    offset += CHUNK_SIZE;
  }
}

// ── Helper: emit a WAL event ──────────────────────────────────────────────

async function emitWalEvent(
  eventType: string,
  workspaceId: number | string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await execute(
      `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ($1, $2, $3)`,
      [eventType, workspaceId, JSON.stringify(payload)],
    );
  } catch (err) {
    logger.warn({ err, eventType }, '[worker] Failed to emit WAL event');
  }
}

// ── Agentic conflict resolution (US-005) ─────────────────────────────────
// Spawns claude --print to resolve git merge conflicts.
// Returns true if all conflicts were resolved and committed, false otherwise.

async function attemptAgenticConflictResolution(
  workspacePath: string,
  branchName: string,
  runId: number,
  appendLog: (msg: string) => void,
): Promise<boolean> {
  const git = simpleGit(workspacePath);

  // Enter conflicted merge state (--no-ff --no-commit)
  appendLog(`[auto-merge] Starting merge of ${branchName} for agentic resolution...`);
  try {
    await git.merge([branchName, '--no-ff', '--no-commit']);
    // Clean merge — commit directly
    await git.commit(`merge: ${branchName} (auto)`);
    appendLog('[auto-merge] Merged cleanly without conflicts.');
    return true;
  } catch (mergeErr: any) {
    const msg: string = mergeErr?.message ?? String(mergeErr);
    if (!msg.includes('CONFLICT') && !msg.includes('Automatic merge failed') && !msg.includes('fix conflicts')) {
      appendLog(`[auto-merge] Unexpected merge error: ${msg}`);
      try { await git.merge(['--abort']); } catch { /* best-effort */ }
      return false;
    }
    // We're in conflicted state — proceed with agentic resolution
  }

  // Capture conflict diff (working tree)
  let conflictDiff = '';
  try { conflictDiff = await git.raw(['diff']); } catch { /* non-fatal */ }
  if (conflictDiff.length > 50_000) {
    conflictDiff = conflictDiff.slice(0, 50_000) + '\n... (diff truncated at 50KB)';
  }

  const prompt = [
    `You are resolving git merge conflicts. The feature branch "${branchName}" is being merged into main for run #${runId}.`,
    '',
    'Here is the current conflict diff (conflict markers in working tree):',
    '```diff',
    conflictDiff || '(no diff output available)',
    '```',
    '',
    'Your task:',
    '1. Examine the conflicted files using the bash and read tools.',
    '2. Resolve each conflict intelligently — understand the intent of both sides. Do NOT blindly take one side.',
    '3. After resolving ALL conflicts, stage all files with: git add -A',
    '4. Commit the merge with: git commit --no-edit',
    '   (The merge commit message is already staged — --no-edit preserves it.)',
    '',
    `Working directory: ${workspacePath}`,
    '',
    'Critical: Do not exit until all conflict markers (<<<<<<<, =======, >>>>>>>) have been removed from ALL files and the merge has been committed.',
  ].join('\n');

  appendLog('[auto-merge] Spawning claude to resolve conflicts...');
  const env = buildCleanEnv();

  return new Promise<boolean>((resolve) => {
    const child = spawn(
      CLAUDE_BIN,
      ['--print', '--dangerously-skip-permissions', '--output-format', 'stream-json'],
      { cwd: workspacePath, env, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    child.stdin?.write(prompt);
    child.stdin?.end();

    let timedOut = false;
    let sigkillTimer: ReturnType<typeof setTimeout> | null = null;

    const sigtermTimer = setTimeout(() => {
      timedOut = true;
      appendLog('[auto-merge] Agentic resolution timed out (5 min) — sending SIGTERM');
      child.kill('SIGTERM');
      sigkillTimer = setTimeout(() => {
        appendLog('[auto-merge] Claude did not exit — sending SIGKILL');
        child.kill('SIGKILL');
      }, AGENTIC_RESOLVE_SIGKILL_DELAY_MS);
    }, AGENTIC_RESOLVE_TIMEOUT_MS);

    child.on('exit', async (code) => {
      clearTimeout(sigtermTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);

      if (timedOut) {
        appendLog('[auto-merge] Agentic resolution timed out — aborting merge');
        try { await git.merge(['--abort']); } catch { /* best-effort */ }
        resolve(false);
        return;
      }

      if (code !== 0) {
        appendLog(`[auto-merge] Claude exited with code ${code} — aborting merge`);
        try { await git.merge(['--abort']); } catch { /* best-effort */ }
        resolve(false);
        return;
      }

      // Verify no conflict markers remain
      try {
        await git.raw(['diff', '--check']);
        appendLog('[auto-merge] Agentic resolution succeeded — no conflict markers remain');
        resolve(true);
      } catch {
        appendLog('[auto-merge] Conflict markers still present after claude resolution — aborting');
        try { await git.merge(['--abort']); } catch { /* best-effort */ }
        resolve(false);
      }
    });

    child.on('error', async (err) => {
      clearTimeout(sigtermTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      appendLog(`[auto-merge] Claude spawn error: ${err.message} — aborting merge`);
      try { await git.merge(['--abort']); } catch { /* best-effort */ }
      resolve(false);
    });
  });
}

// ── Auto-merge worktree after run completion (US-004 + US-005) ───────────────
// Called from handlePipelineRun exit handler when worktreePath is set.
// Strategy: try ff-only → fall back to --no-ff → if conflicts: agentic resolution.

const TRACKING_PATTERNS = ['.rorca/run-state.json', 'progress.txt', '.rorca/memory/runs/'];

async function autoMergeAfterRun(
  workspacePath: string,
  worktreePath: string,
  branchName: string,
  workspaceId: number | string,
  runId: number,
  appendLog: (msg: string) => void,
): Promise<void> {
  if (!fs.existsSync(worktreePath)) {
    appendLog('[auto-merge] Worktree already removed — skipping auto-merge');
    return;
  }

  // Emit merge-started event + set merge_status
  await emitWalEvent('worktree_merge_started', workspaceId, { run_id: runId, branchName });
  try { await execute(`UPDATE pipeline_runs SET merge_status = 'merging' WHERE id = $1`, [runId]); } catch { /* non-fatal */ }

  const git = simpleGit(workspacePath);

  // Stash uncommitted changes
  let stashed = false;
  try {
    const status = await git.status();
    if (status.files.length > 0) {
      await git.stash(['push', '--include-untracked', '-m', `rorca-autostash-before-merge-${branchName}`]);
      stashed = true;
      appendLog('[auto-merge] Stashed uncommitted workspace changes');
    }
  } catch (err: any) {
    appendLog(`[auto-merge] Stash failed — proceeding without stash: ${err.message}`);
  }

  let mergeSuccess = false;
  let resolvedByAgentic = false;
  let conflictDiff = '';
  let conflictFiles: string[] = [];

  try {
    appendLog(`[auto-merge] Merging ${branchName} into workspace...`);

    // Try fast-forward first (cleanest)
    try {
      await git.merge([branchName, '--ff-only']);
      appendLog('[auto-merge] Merged via fast-forward — no conflicts');
      mergeSuccess = true;
    } catch {
      // ff-only failed — try no-ff
      try {
        await git.merge([branchName, '--no-ff', '--no-commit']);
        // Clean no-ff merge
        await git.commit(`merge: ${branchName} (auto)`);
        appendLog('[auto-merge] Merged (no-ff) — no conflicts');
        mergeSuccess = true;
      } catch (noFfErr: any) {
        const noFfMsg: string = noFfErr?.message ?? String(noFfErr);

        if (noFfMsg.includes('CONFLICT') || noFfMsg.includes('Automatic merge failed') || noFfMsg.includes('fix conflicts')) {
          // Collect conflicting files
          try {
            const diffOut = await git.raw(['diff', '--name-only', '--diff-filter=U']);
            conflictFiles = diffOut.trim().split('\n').filter(Boolean);
          } catch { /* continue */ }

          const realConflicts = conflictFiles.filter(f => !TRACKING_PATTERNS.some(tp => f.includes(tp)));

          if (realConflicts.length === 0) {
            // Only tracking files — auto-resolve with --theirs
            for (const file of conflictFiles) {
              try {
                await git.raw(['checkout', '--theirs', '--', file]);
                await git.add(file);
                appendLog(`[auto-merge] Auto-resolved tracking file: ${file}`);
              } catch { /* best-effort */ }
            }
            try {
              await git.commit(`merge: ${branchName} (auto)`);
              appendLog('[auto-merge] Merged with tracking-file auto-resolution');
              mergeSuccess = true;
            } catch (commitErr: any) {
              if (commitErr.message?.includes('nothing to commit') || commitErr.message?.includes('nothing added')) {
                mergeSuccess = true;
              } else {
                try { await git.merge(['--abort']); } catch { /* best-effort */ }
              }
            }
          } else {
            // Real code conflicts — abort and try agentic resolution
            try { await git.merge(['--abort']); } catch { /* best-effort */ }
            appendLog(`[auto-merge] Code conflicts in: ${realConflicts.join(', ')} — attempting agentic resolution`);

            const resolved = await attemptAgenticConflictResolution(workspacePath, branchName, runId, appendLog);
            if (resolved) {
              mergeSuccess = true;
              resolvedByAgentic = true;
            } else {
              // Capture conflict diff for WAL event payload
              try { conflictDiff = (await git.raw(['diff'])).slice(0, 2048); } catch { /* non-fatal */ }
            }
          }
        } else if (noFfMsg.includes('Already up to date')) {
          appendLog('[auto-merge] Already up to date — nothing to merge');
          mergeSuccess = true;
        } else {
          try { await git.merge(['--abort']); } catch { /* best-effort */ }
          appendLog(`[auto-merge] Unexpected merge error: ${noFfMsg}`);
        }
      }
    }
  } catch (unexpectedErr: any) {
    try { await git.merge(['--abort']); } catch { /* best-effort */ }
    appendLog(`[auto-merge] Unexpected error: ${unexpectedErr.message}`);
  } finally {
    if (stashed) {
      try {
        await git.stash(['pop']);
        appendLog('[auto-merge] Restored stashed workspace changes');
      } catch (popErr: any) {
        appendLog(`[auto-merge] Stash pop conflict — run 'git stash pop' manually: ${popErr.message}`);
      }
    }
  }

  if (mergeSuccess) {
    let sha = '';
    try { sha = (await git.raw(['rev-parse', 'HEAD'])).trim(); } catch { /* non-fatal */ }

    await emitWalEvent('worktree_merged', workspaceId, {
      run_id: runId,
      branchName,
      mergeCommitSha: sha,
      ...(resolvedByAgentic ? { resolvedBy: 'agentic' } : {}),
    });

    // Remove worktree directory
    try {
      await git.raw(['worktree', 'remove', '--force', worktreePath]);
      appendLog(`[auto-merge] Worktree removed: ${path.basename(worktreePath)}`);
    } catch (rmErr: any) {
      appendLog(`[auto-merge] Worktree removal skipped: ${rmErr.message}`);
    }

    // Update merge_status + clear worktree_path
    try { await execute(`UPDATE pipeline_runs SET worktree_path = NULL, merge_status = 'merged', merge_commit_sha = $2 WHERE id = $1`, [runId, sha]); } catch { /* non-fatal */ }

    // Post-merge smoke test — verify core endpoints still return 200
    const smoke = await runPostMergeSmokeTest(workspaceId);
    if (!smoke.ok) {
      appendLog(`[auto-merge] ⚠ Post-merge smoke test FAILED: ${smoke.failures.join(', ')}`);
      logger.warn({ runId, failures: smoke.failures }, '[auto-merge] Post-merge smoke test failed — merged code may have introduced regressions');
    } else {
      appendLog('[auto-merge] Post-merge smoke test passed — all core endpoints healthy');
    }
  } else {
    const mergeErrorMsg = conflictFiles.length > 0
      ? 'Agentic merge resolution failed — resolve conflicts manually via the Worktrees panel.'
      : 'Auto-merge failed — resolve manually via the Worktrees panel.';
    await emitWalEvent('worktree_merge_failed', workspaceId, {
      run_id: runId,
      branchName,
      worktreePath,
      conflictFiles,
      conflictSummary: conflictDiff,
      message: mergeErrorMsg,
    });
    try { await execute(`UPDATE pipeline_runs SET merge_status = 'failed', merge_error = $2 WHERE id = $1`, [runId, conflictDiff.slice(0, 2000) || mergeErrorMsg]); } catch { /* non-fatal */ }
    appendLog('[auto-merge] Auto-merge failed — worktree preserved for manual resolution');
  }
}

// ── Job handler: pipeline:run ─────────────────────────────────────────────

async function handlePipelineRun(jobs: PgBoss.Job<Record<string, unknown>>[]): Promise<void> {
  // Process all jobs concurrently — batchSize controls how many are fetched per poll,
  // but each spawns an independent child process that should run in parallel.
  await Promise.allSettled(jobs.map(async (job) => {
    const jobId = job.id;
    logger.info({ jobId, data: job.data }, '[worker] pipeline:run received');

    // 1. Validate payload via Zod
    const parsed = PipelineRunJobPayload.safeParse(job.data);
    if (!parsed.success) {
      logger.error({ jobId, errors: parsed.error.format() }, '[worker] pipeline:run invalid payload — failing job');
      throw new Error(`Invalid pipeline:run payload: ${parsed.error.message}`);
    }

    const payload: PipelineRunJobPayloadType = parsed.data;
    const { runId, specPath, workspacePath, agent, model, worktreePath, envOverrides, startFromStoryId, includeGraph, thinkingEnabled, thinkingBudget, effortLevel, reasoningEffort } = payload;

    // Determine effective working directory (worktree or main workspace)
    const cwd = worktreePath ?? workspacePath;

    // Look up workspaceId for WAL events
    const runRow = await queryOne<{ workspace_id: number; parallelism: number }>(
      'SELECT workspace_id, parallelism FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    if (!runRow) {
      logger.error({ jobId, runId }, '[worker] pipeline_runs row not found — skipping');
      return;
    }
    const { workspace_id: workspaceId, parallelism } = runRow;

    // 1b. Per-workspace concurrency lock (DB-based, survives restarts).
    // Task-Monitor pattern: pg-boss jobs complete immediately after spawn, so pg-boss
    // queue locks no longer enforce concurrency. We check pipeline_runs directly.
    // Worktree runs are git-isolated and safe to run in parallel; non-worktree runs
    // on the same workspace would cause git conflicts.
    const concurrentRow = await queryOne<{ count: string }>(
      `SELECT COUNT(*) AS count FROM pipeline_runs
       WHERE workspace_id = $1 AND status = 'running' AND id != $2`,
      [workspaceId, runId],
    );
    const activeForWorkspace = parseInt(concurrentRow?.count ?? '0', 10);
    const settings = await getConcurrencySettings();
    const maxConcurrent = settings.queueMaxConcurrent;

    if (activeForWorkspace >= maxConcurrent && !worktreePath) {
      // At capacity for this workspace — re-enqueue with delay.
      // Reset status back to 'queued' so the UI shows it correctly.
      logger.info(
        { runId, workspaceId, activeForWorkspace, maxConcurrent },
        '[worker] Per-workspace concurrency limit reached — re-enqueueing with 10s delay',
      );
      await execute(
        `UPDATE pipeline_runs SET status = 'queued' WHERE id = $1 AND status != 'running'`,
        [runId],
      );
      await getBoss().send('pipeline:run', job.data as Record<string, unknown>, {
        retryLimit: 0,
        expireInSeconds: 300,
        startAfter: 10,
      });
      return;
    }

    // 2. Mark run as running — set worker_id so orphan sweep knows this run belongs to us
    await execute(
      `UPDATE pipeline_runs SET status = 'running', started_at = NOW(), worker_id = $2 WHERE id = $1`,
      [runId, WORKER_ID],
    );

    await emitWalEvent('run_started', workspaceId, { run_id: runId, spec_path: specPath });

    // 2b. US-034: Create draft PR on GitHub if this is a worktree run
    if (payload.branchName) {
      let specTitle = 'Pipeline run';
      let totalStories = 0;
      try {
        const specFile = path.join(workspacePath, specPath);
        if (fs.existsSync(specFile)) {
          const specJson = JSON.parse(fs.readFileSync(specFile, 'utf-8'));
          totalStories = (specJson.userStories ?? []).length;
          const slug = path.basename(specPath, '.json');
          specTitle = specJson.title ?? slug.replace(/-/g, ' ');
        }
      } catch { /* non-fatal — use defaults */ }

      try {
        await createDraftPr({
          runId,
          workspaceId,
          branchName: payload.branchName,
          workspacePath,
          specTitle,
          totalStories,
        });
      } catch (draftErr: any) {
        logger.error({ err: draftErr, runId }, '[worker] createDraftPr threw unexpectedly');
      }
    }

    // 3. Build engine args
    const executionEngineTs = path.join(__dirname, 'lib', 'execution-engine.ts');
    const tsxBin = findTsxBin();
    const backendPort = process.env.PORT ?? '3030';

    const engineArgs = [
      executionEngineTs,
      '--json', path.join(workspacePath, specPath),
      '--cwd', cwd,
      '--run-id', String(runId),
      '--port', backendPort,
      '--parallelism', String(parallelism ?? 1),
      '--agent', agent,
    ];
    if (model) {
      engineArgs.push('--model', model);
    }
    if (startFromStoryId) {
      engineArgs.push('--start-from', startFromStoryId);
    }
    // US-004: Pass worktree context to execution-engine so it can log worktree info
    // and perform engine-side auto-merge as a fallback.
    if (worktreePath) {
      engineArgs.push('--worktree-path', worktreePath);
    }
    if (payload.branchName) {
      engineArgs.push('--branch-name', payload.branchName);
    }
    if (worktreePath) {
      engineArgs.push('--workspace-path', workspacePath);
    }
    if (includeGraph) {
      engineArgs.push('--include-graph');
    }
    // agentOverride is already incorporated into the `agent` field via pipeline.ts resolution;
    // the --agent flag above uses payload.agent which already reflects the override.
    if (thinkingEnabled !== undefined) {
      engineArgs.push('--thinking-enabled', String(thinkingEnabled));
    }
    if (thinkingBudget !== undefined) {
      engineArgs.push('--thinking-budget', String(thinkingBudget));
    }
    if (effortLevel) {
      engineArgs.push('--effort-level', effortLevel);
    }
    if (reasoningEffort) {
      engineArgs.push('--reasoning-effort', reasoningEffort);
    }

    // 4. Spawn execution-engine.ts with pipe stdio so we can capture chunks
    // Spread process.env first so child inherits PATH, HOME, DATABASE_URL, etc.
    // Then strip the 4 Claude vars that must not propagate to nested invocations.
    const { CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, CLAUDE_AGENT_SDK_VERSION, CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING, ...inheritedEnv } = process.env as Record<string, string>;
    const env: Record<string, string> = {
      ...inheritedEnv,
      ...envOverrides,
      RORCA_PROCESS_ROLE: 'engine',
    };

    logger.info({ runId, agent, model, cwd }, '[worker] Spawning execution-engine.ts');

    const child = spawn(tsxBin, engineArgs, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env,
    });

    // 5. Record PID (tsx wrapper PID — will be overwritten by IPC message with inner Node PID)
    if (child.pid) {
      await execute('UPDATE pipeline_runs SET pid = $1 WHERE id = $2', [child.pid, runId]);
    }

    // Register in active processes map for cancellation
    activeProcesses.set(runId, child);

    // Listen for IPC message from execution-engine reporting its own PID.
    // tsx compiles TypeScript and forks a Node.js child — the tsx wrapper PID
    // stored above dies within ~1-2s. The engine sends its actual PID so the
    // kill endpoint can SIGTERM the correct process.
    child.on('message', async (msg: unknown) => {
      if (typeof msg !== 'object' || msg === null) return;
      const m = msg as Record<string, unknown>;

      if (m.type === 'pid' && typeof m.pid === 'number') {
        const enginePid = m.pid;
        logger.info({ runId, enginePid }, '[worker] Received inner engine PID via IPC — updating pipeline_runs.pid');
        try {
          await execute('UPDATE pipeline_runs SET pid = $1 WHERE id = $2', [enginePid, runId]);
        } catch (err) {
          logger.warn({ err, runId, enginePid }, '[worker] Failed to update pipeline_runs.pid with inner engine PID');
        }
      } else if (m.type === 'heartbeat') {
        // Engine is alive — touch last_heartbeat so reconciliation doesn't kill us.
        try {
          await execute('UPDATE pipeline_runs SET last_heartbeat = NOW() WHERE id = $1', [runId]);
        } catch { /* non-fatal — next beat will retry */ }
      }
    });

    // 6. Pipe stdout/stderr to run_output_chunks — flush every data event immediately.
    // Large bursts are split into ≤4 KB slices; small events (single JSON lines,
    // ULTRATHINK marker, etc.) are written as-is without waiting for a full buffer.
    const sequenceRef = { value: 1 };
    let pending = Buffer.alloc(0);

    const flushPending = async (): Promise<void> => {
      if (pending.length === 0) return;
      await writeBufferAsChunks(runId, pending, sequenceRef);
      pending = Buffer.alloc(0);
    };

    const handleData = async (data: Buffer): Promise<void> => {
      await writeBufferAsChunks(runId, data, sequenceRef);
    };

    child.stdout?.on('data', (data: Buffer) => { void handleData(data); });
    child.stderr?.on('data', (data: Buffer) => { void handleData(data); });

    // 7. Task-Monitor pattern: fire-and-forget close/error handlers.
    //
    // The pg-boss job completes immediately after spawning the engine — no
    // long-lived job lock. The engine sends IPC heartbeats every 60s; the
    // worker writes them to pipeline_runs.last_heartbeat. reconcileState()
    // (running every 60s) acts as the watchdog: if last_heartbeat > 2 min
    // stale AND the PID is dead → mark the run failed.
    //
    // Root cause fix (US-007): 'close' fires after all stdio streams drain,
    // guaranteeing flushPending() sees every byte the engine wrote.
    let capturedCode: number | null = null;
    child.on('exit', (code) => { capturedCode = code; });

    child.on('close', async () => {
      try {
        await flushPending();

        const code = capturedCode;
        activeProcesses.delete(runId);


        const wasCancelled = cancellingRuns.delete(runId);
        let status = wasCancelled ? 'cancelled' : (code === 0 ? 'done' : 'failed');

        // A run where every story was skipped is not "done" — it failed
        if (status === 'done') {
          const storyCheck = await queryOne<{ total: string; skipped: string }>(
            `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'skip') AS skipped FROM story_results WHERE run_id = $1`,
            [runId],
          );
          if (storyCheck && parseInt(storyCheck.total) > 0 && storyCheck.total === storyCheck.skipped) {
            status = 'failed';
            logger.warn({ runId }, '[worker] All stories skipped — marking run as failed');
          }
        }

        logger.info({ runId, code, status, wasCancelled }, '[worker] execution-engine exited');

        await execute(
          `UPDATE pipeline_runs SET status = $1, finished_at = NOW() WHERE id = $2`,
          [status, runId],
        );

        if (wasCancelled) {
          await emitWalEvent('run_cancelled', workspaceId, {
            run_id: runId,
            cancelledAt: new Date().toISOString(),
            source: 'worker',
          });
        } else {
          await emitWalEvent('run_finished', workspaceId, {
            run_id: runId,
            status,
            exit_code: code,
            source: 'worker',
          });

          // ── Post-run merge strategy routing ─────────────────────────────────
          // Resolve effective merge strategy from payload (set by pipeline trigger).
          const effectiveMergeStrategy = payload.mergeStrategy ?? 'direct';
          let allSpecStoriesPassed = false;

          if (status === 'done' && worktreePath && payload.branchName) {
            try {
              const absSpecPath = path.join(workspacePath, specPath);
              const specJson = JSON.parse(fs.readFileSync(absSpecPath, 'utf-8'));
              const stories: Array<{ passes?: boolean; excluded?: boolean }> = specJson.userStories ?? [];
              allSpecStoriesPassed = stories.length > 0 && stories.every(s => s.passes === true || s.excluded === true);
              if (!allSpecStoriesPassed) {
                logger.info({ runId, specPath }, '[worker] Skipping post-run routing — spec not fully complete (not all stories passed)');
              }
            } catch (specErr: any) {
              logger.warn({ runId, err: specErr?.message }, '[worker] Could not read spec JSON for merge check — skipping');
            }
          }

          if (status === 'done' && worktreePath && payload.branchName && allSpecStoriesPassed) {
            const mergeLog = (msg: string) => logger.info({ runId }, msg);

            switch (effectiveMergeStrategy) {
              case 'direct': {
                // Merge worktree branch into main + push to remote
                try { await execute(`UPDATE pipeline_runs SET merge_status = 'pending' WHERE id = $1`, [runId]); } catch { /* non-fatal */ }
                try {
                  await autoMergeAfterRun(
                    workspacePath,
                    worktreePath,
                    payload.branchName,
                    workspaceId,
                    runId,
                    mergeLog,
                  );
                  // Push main to remote after successful merge
                  const mergeStatus = await queryOne<{ merge_status: string }>('SELECT merge_status FROM pipeline_runs WHERE id = $1', [runId]);
                  if (mergeStatus?.merge_status === 'merged') {
                    try {
                      const git = simpleGit(workspacePath);
                      await git.push('origin', 'HEAD');
                      mergeLog('[merge-strategy:direct] Pushed main to remote');
                    } catch (pushErr: any) {
                      mergeLog(`[merge-strategy:direct] Push failed (non-fatal): ${pushErr.message}`);
                    }
                  }
                } catch (mergeErr: any) {
                  logger.error({ err: mergeErr, runId }, '[worker] autoMergeAfterRun threw unexpectedly');
                }
                break;
              }

              case 'pr': {
                // Push branch (already pushed per-story, but ensure) + create PR
                try { await execute(`UPDATE pipeline_runs SET merge_status = 'pr_created' WHERE id = $1`, [runId]); } catch { /* non-fatal */ }
                try {
                  const git = simpleGit(worktreePath);
                  await git.push('origin', payload.branchName, ['--set-upstream']);
                  mergeLog(`[merge-strategy:pr] Branch pushed: ${payload.branchName}`);
                } catch (pushErr: any) {
                  mergeLog(`[merge-strategy:pr] Branch push failed: ${pushErr.message}`);
                }
                try {
                  await createOrUpdateAutoPr({
                    runId,
                    workspaceId,
                    branchName: payload.branchName,
                    workspacePath,
                  });
                  mergeLog('[merge-strategy:pr] PR created');
                } catch (prErr: any) {
                  // Fallback: try gh CLI if GitHub API integration isn't configured
                  try {
                    const specSlug = path.basename(specPath, '.json');
                    execSync(
                      `gh pr create --title "feat: ${specSlug}" --body "Automated spec execution via Rorca.\n\nRun #${runId} completed — all stories passed." --base main`,
                      { cwd: worktreePath, stdio: 'pipe', timeout: 30_000 },
                    );
                    mergeLog('[merge-strategy:pr] PR created via gh CLI fallback');
                  } catch (ghErr: any) {
                    mergeLog(`[merge-strategy:pr] PR creation failed (gh CLI fallback also failed): ${ghErr.message}`);
                    // Graceful degradation to branch-only
                    mergeLog('[merge-strategy:pr] Falling back to branch-only — branch is on remote for manual PR creation');
                  }
                }
                break;
              }

              case 'draft-pr': {
                // Push branch + create draft PR
                try { await execute(`UPDATE pipeline_runs SET merge_status = 'pr_created' WHERE id = $1`, [runId]); } catch { /* non-fatal */ }
                try {
                  const git = simpleGit(worktreePath);
                  await git.push('origin', payload.branchName, ['--set-upstream']);
                  mergeLog(`[merge-strategy:draft-pr] Branch pushed: ${payload.branchName}`);
                } catch (pushErr: any) {
                  mergeLog(`[merge-strategy:draft-pr] Branch push failed: ${pushErr.message}`);
                }
                try {
                  // Read spec for title and story count
                  let draftSpecTitle = path.basename(specPath, '.json');
                  let draftTotalStories = 0;
                  try {
                    const draftSpec = JSON.parse(fs.readFileSync(path.join(workspacePath, specPath), 'utf-8'));
                    draftSpecTitle = draftSpec.title ?? draftSpecTitle;
                    draftTotalStories = (draftSpec.userStories ?? []).length;
                  } catch { /* use defaults */ }
                  await createDraftPr({
                    runId,
                    workspaceId,
                    branchName: payload.branchName,
                    workspacePath,
                    specTitle: draftSpecTitle,
                    totalStories: draftTotalStories,
                  });
                  mergeLog('[merge-strategy:draft-pr] Draft PR created');
                } catch (prErr: any) {
                  // Fallback: try gh CLI
                  try {
                    const specSlug = path.basename(specPath, '.json');
                    execSync(
                      `gh pr create --draft --title "WIP: ${specSlug}" --body "Draft PR for review.\n\nRun #${runId} completed — all stories passed." --base main`,
                      { cwd: worktreePath, stdio: 'pipe', timeout: 30_000 },
                    );
                    mergeLog('[merge-strategy:draft-pr] Draft PR created via gh CLI fallback');
                  } catch (ghErr: any) {
                    mergeLog(`[merge-strategy:draft-pr] Draft PR creation failed: ${ghErr.message}`);
                    mergeLog('[merge-strategy:draft-pr] Falling back to branch-only — branch is on remote for manual PR creation');
                  }
                }
                break;
              }

              case 'branch-only': {
                // Just ensure branch is on remote — no PR, no merge
                try { await execute(`UPDATE pipeline_runs SET merge_status = 'branch_pushed' WHERE id = $1`, [runId]); } catch { /* non-fatal */ }
                try {
                  const git = simpleGit(worktreePath);
                  await git.push('origin', payload.branchName, ['--set-upstream']);
                  mergeLog(`[merge-strategy:branch-only] Branch pushed: ${payload.branchName}. No PR created — awaiting manual action.`);
                } catch (pushErr: any) {
                  mergeLog(`[merge-strategy:branch-only] Push failed: ${pushErr.message}`);
                }
                break;
              }
            }
          }

          // US-034: Finalize existing draft PR on run completion (for runs that started with a draft PR).
          if (payload.branchName && effectiveMergeStrategy === 'direct') {
            try {
              const prRow = await queryOne<{ pr_number: number | null }>(
                'SELECT pr_number FROM pipeline_runs WHERE id = $1',
                [runId],
              );
              if (prRow?.pr_number) {
                await finalizeDraftPr({
                  runId,
                  workspaceId,
                  branchName: payload.branchName,
                  workspacePath,
                  status,
                });
              }
            } catch (prErr: any) {
              logger.error({ err: prErr, runId }, '[worker] Draft PR finalization threw unexpectedly');
            }
          }

          // Workflow dispatch (US-026)
          if (status === 'done') {
            await dispatchWorkflowIfConfigured(workspaceId, runId);
          }
        }

        // Advance run queue — promote next queued run for this workspace
        advanceQueue(String(workspaceId)).catch(err =>
          logger.error({ err, runId, workspaceId }, '[worker] advanceQueue failed after run completion'),
        );
      } catch (err) {
        logger.error({ err, runId }, '[worker] close handler failed');
      }
    });

    child.on('error', async (err) => {
      try {
        logger.error({ err, runId }, '[worker] execution-engine spawn error');
        await flushPending();
        activeProcesses.delete(runId);

        cancellingRuns.delete(runId);

        await execute(
          `UPDATE pipeline_runs SET status = 'failed', finished_at = NOW() WHERE id = $1`,
          [runId],
        );
        await emitWalEvent('run_finished', workspaceId, {
          run_id: runId,
          status: 'failed',
          error: (err as Error).message,
          source: 'worker',
        });

        advanceQueue(String(workspaceId)).catch(qErr =>
          logger.error({ err: qErr, runId, workspaceId }, '[worker] advanceQueue failed after spawn error'),
        );
      } catch (dbErr) {
        logger.error({ dbErr, runId }, '[worker] error handler failed');
      }
    });

    logger.info({ runId, pid: child.pid }, '[worker] Engine spawned — releasing pg-boss job');
  }));
}

// ── Job handler: pipeline:retry ───────────────────────────────────────────

async function handlePipelineRetry(jobs: PgBoss.Job<Record<string, unknown>>[]): Promise<void> {
  await Promise.allSettled(jobs.map(async (job) => {
    const jobId = job.id;
    logger.info({ jobId, data: job.data }, '[worker] pipeline:retry received');

    // 1. Validate payload via Zod
    const parsed = PipelineRetryJobPayload.safeParse(job.data);
    if (!parsed.success) {
      logger.error({ jobId, errors: parsed.error.format() }, '[worker] pipeline:retry invalid payload — failing job');
      throw new Error(`Invalid pipeline:retry payload: ${parsed.error.message}`);
    }

    const payload: PipelineRetryJobPayloadType = parsed.data;
    const { runId, originalRunId, workspacePath, retrySpecPath, agent, model, worktreePath, sequenceOffset, envOverrides, includeGraph } = payload;

    // Effective working directory (worktree or main workspace)
    const cwd = worktreePath ?? workspacePath;

    // 2. Look up workspace_id and parallelism from the NEW run row (created by route handler)
    const runRow = await queryOne<{ workspace_id: string; parallelism: number }>(
      'SELECT workspace_id, parallelism FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    if (!runRow) {
      logger.error({ jobId, runId }, '[worker] pipeline:retry run row not found — skipping');
      return;
    }
    const { workspace_id: workspaceId, parallelism } = runRow;

    // 3. Mark the new run as running — set worker_id so orphan sweep knows this run belongs to us
    await execute(
      `UPDATE pipeline_runs SET status = 'running', started_at = NOW(), worker_id = $2 WHERE id = $1`,
      [runId, WORKER_ID],
    );

    await emitWalEvent('run_started', workspaceId, {
      run_id: runId,
      original_run_id: originalRunId,
      source: 'worker_retry',
    });

    // 4. Build execution-engine args with the temp retry spec
    const executionEngineTs = path.join(__dirname, 'lib', 'execution-engine.ts');
    const tsxBin = findTsxBin();
    const backendPort = process.env.PORT ?? '3030';

    // Verify the temp retry spec file still exists (route handler should have written it)
    if (!fs.existsSync(retrySpecPath)) {
      logger.error({ jobId, runId, retrySpecPath }, '[worker] retry spec file not found — failing run');
      await execute(
        `UPDATE pipeline_runs SET status = 'failed', finished_at = NOW() WHERE id = $1`,
        [runId],
      );
      await emitWalEvent('run_finished', workspaceId, { run_id: runId, status: 'failed', reason: 'retry_spec_missing' });
      return;
    }

    const engineArgs = [
      executionEngineTs,
      '--json', retrySpecPath,
      '--cwd', cwd,
      '--run-id', String(runId),
      '--port', backendPort,
      '--parallelism', String(parallelism ?? 1),
      '--agent', agent,
    ];
    if (model) {
      engineArgs.push('--model', model);
    }
    if (includeGraph) {
      engineArgs.push('--include-graph');
    }

    // 5. Spawn execution-engine with pipe stdio for chunk capture
    // Spread process.env first so child inherits PATH, HOME, DATABASE_URL, etc.
    // Strip the 4 Claude vars that must not propagate to nested invocations.
    const { CLAUDECODE: _a, CLAUDE_CODE_ENTRYPOINT: _b, CLAUDE_AGENT_SDK_VERSION: _c, CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: _d, ...inheritedEnvRetry } = process.env as Record<string, string>;
    const env = { ...inheritedEnvRetry, ...envOverrides, RORCA_PROCESS_ROLE: 'engine' };

    logger.info({ runId, agent, model, cwd }, '[worker] Spawning execution-engine.ts for retry');

    const child = spawn(tsxBin, engineArgs, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env,
    });

    if (child.pid) {
      await execute('UPDATE pipeline_runs SET pid = $1 WHERE id = $2', [child.pid, runId]);
    }

    activeProcesses.set(runId, child);

    // Listen for IPC message from execution-engine reporting its own PID (same as pipeline:run handler)
    child.on('message', async (msg: unknown) => {
      if (
        typeof msg === 'object' &&
        msg !== null &&
        (msg as Record<string, unknown>).type === 'pid' &&
        typeof (msg as Record<string, unknown>).pid === 'number'
      ) {
        const enginePid = (msg as Record<string, unknown>).pid as number;
        logger.info({ runId, enginePid }, '[worker] Received inner engine PID via IPC (retry) — updating pipeline_runs.pid');
        try {
          await execute('UPDATE pipeline_runs SET pid = $1 WHERE id = $2', [enginePid, runId]);
        } catch (err) {
          logger.warn({ err, runId, enginePid }, '[worker] Failed to update pipeline_runs.pid with inner engine PID (retry)');
        }
      }
    });

    // 6. Pipe stdout/stderr to run_output_chunks, continuing sequence from sequenceOffset
    const sequenceRef = { value: sequenceOffset + 1 };
    let pending = Buffer.alloc(0);

    const flushPending = async (): Promise<void> => {
      if (pending.length === 0) return;
      await writeBufferAsChunks(runId, pending, sequenceRef);
      pending = Buffer.alloc(0);
    };

    const handleData = async (data: Buffer): Promise<void> => {
      await writeBufferAsChunks(runId, data, sequenceRef);
    };

    child.stdout?.on('data', (data: Buffer) => { void handleData(data); });
    child.stderr?.on('data', (data: Buffer) => { void handleData(data); });

    // 7. Wait for close (not exit), flush remaining bytes, update run status.
    // Same fix as handlePipelineRun (US-007): use 'close' so all stdout/stderr
    // data events have been emitted before we flush the pending buffer.
    await new Promise<void>((resolve) => {
      let capturedCode: number | null = null;
      child.on('exit', (code) => { capturedCode = code; });

      child.on('close', async () => {
        // Flush bytes < CHUNK_SIZE remaining in the buffer before marking done
        await flushPending();

        const code = capturedCode;
        activeProcesses.delete(runId);


        const wasCancelled = cancellingRuns.delete(runId);

        // Derive final status
        let finalStatus: string;
        if (wasCancelled) {
          finalStatus = 'cancelled';
        } else {
          try {
            const currentStories = await query<{ story_id: string; status: string }>(
              'SELECT story_id, status FROM story_results WHERE run_id = $1 ORDER BY id ASC',
              [runId],
            );
            const latest = new Map<string, string>();
            for (const s of currentStories) latest.set(s.story_id, s.status);
            const hasFailures = Array.from(latest.values()).some(st => st === 'fail');
            finalStatus = hasFailures ? 'partial_failure' : (code === 0 ? 'done' : 'partial_failure');
          } catch {
            finalStatus = code === 0 ? 'done' : 'failed';
          }
        }

        logger.info({ runId, code, finalStatus, wasCancelled }, '[worker] retry execution-engine exited');

        try {
          await execute(
            `UPDATE pipeline_runs SET status = $1, finished_at = NOW() WHERE id = $2`,
            [finalStatus, runId],
          );

          if (wasCancelled) {
            await emitWalEvent('run_cancelled', workspaceId, {
              run_id: runId,
              cancelledAt: new Date().toISOString(),
              source: 'worker_retry',
            });
          } else {
            await emitWalEvent('run_finished', workspaceId, {
              run_id: runId,
              original_run_id: originalRunId,
              status: finalStatus,
              exit_code: code,
              source: 'worker_retry',
            });
          }
        } catch (err) {
          logger.error({ err, runId }, '[worker] Failed to update retry run status on exit');
        }

        advanceQueue(workspaceId).catch(qErr =>
          logger.error({ err: qErr, runId, workspaceId }, '[worker] advanceQueue failed after retry completion'),
        );

        // Clean up the temporary retry spec file
        try { fs.unlinkSync(retrySpecPath); } catch { /* best-effort */ }

        resolve();
      });

      child.on('error', async (err) => {
        logger.error({ err, runId }, '[worker] retry execution-engine spawn error');
        await flushPending();
        activeProcesses.delete(runId);

        cancellingRuns.delete(runId);

        try {
          await execute(
            `UPDATE pipeline_runs SET status = 'failed', finished_at = NOW() WHERE id = $1`,
            [runId],
          );
          await emitWalEvent('run_finished', workspaceId, {
            run_id: runId,
            original_run_id: originalRunId,
            status: 'failed',
            error: (err as Error).message,
            source: 'worker_retry',
          });
        } catch (dbErr) {
          logger.error({ dbErr, runId }, '[worker] Failed to update retry run status after spawn error');
        }

        advanceQueue(workspaceId).catch(qErr =>
          logger.error({ err: qErr, runId, workspaceId }, '[worker] advanceQueue failed after retry spawn error'),
        );

        try { fs.unlinkSync(retrySpecPath); } catch { /* best-effort */ }

        resolve();
      });
    });
  }));
}

// ── Job handler: pipeline:cron ────────────────────────────────────────────
// Handles two variants:
//
//  a) Meta-cron (queue: pipeline:cron, data: {}):
//     Fires every minute via pg-boss native schedule. Calls
//     checkAndFireDueSchedules() which checks all enabled pipeline_schedules
//     against their cron expressions and triggers due ones. pg-boss distributed
//     lock ensures exactly one fire per minute across all worker instances.
//
//  b) Per-schedule (queue: pipeline:cron:<id>, data: { scheduleId, specId, ... }):
//     Fires directly for a specific schedule. Delegates to triggerScheduledRun().
//     Per-schedule distributed lock ensures exactly one trigger per schedule interval.

const PipelineCronJobData = z.object({
  scheduleId: z.number().int().positive(),
  specId: z.string().min(1),
  workspaceId: z.string().min(1),
  agent: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
});

async function handlePipelineCron(jobs: PgBoss.Job<Record<string, unknown>>[]): Promise<void> {
  for (const job of jobs) {
    logger.info({ jobId: job.id, name: job.name, data: job.data }, '[worker] pipeline:cron received');

    // Detect variant: if data has scheduleId it's a per-schedule direct fire
    const parsed = PipelineCronJobData.safeParse(job.data);
    if (parsed.success) {
      // Per-schedule direct fire
      const { scheduleId, specId, workspaceId, agent, model } = parsed.data;
      await triggerScheduledRun({
        id: scheduleId,
        spec_id: specId,
        workspace_id: workspaceId,
        agent: agent ?? null,
        model: model ?? null,
      });
    } else {
      // Meta-cron: check all enabled schedules for due entries
      logger.info({ jobId: job.id }, '[worker] pipeline:cron meta-tick — checking all due schedules');
      await checkAndFireDueSchedules();
    }
  }
}

// ── Job handler: pipeline:cancel ──────────────────────────────────────────

async function handlePipelineCancel(jobs: PgBoss.Job<Record<string, unknown>>[]): Promise<void> {
  for (const job of jobs) {
    logger.info({ jobId: job.id, data: job.data }, '[worker] pipeline:cancel received');

    const parsed = PipelineCancelJobPayload.safeParse(job.data);
    if (!parsed.success) {
      logger.warn({ jobId: job.id, errors: parsed.error.format() }, '[worker] pipeline:cancel invalid payload — skipping');
      return;
    }

    const runId = parsed.data.runId;
    const child = activeProcesses.get(runId);
    if (child) {
      // Mark as intentionally cancelled so the exit handler sets status='cancelled'
      cancellingRuns.add(runId);
      child.kill('SIGTERM');
      setTimeout(() => {
        // Only SIGKILL if the process is still in the active map (not yet exited)
        if (activeProcesses.has(runId)) child.kill('SIGKILL');
      }, 10_000);
    } else {
      logger.warn({ jobId: job.id, runId }, '[worker] pipeline:cancel — no active process found for runId');
    }
  }
}

// ── Job handler: pipeline:merge ──────────────────────────────────────────

async function handlePipelineMerge(jobs: PgBoss.Job<Record<string, unknown>>[]): Promise<void> {
  for (const job of jobs) {
    logger.info({ jobId: job.id, data: job.data }, '[worker] pipeline:merge received');

    const parsed = PipelineMergeJobPayload.safeParse(job.data);
    if (!parsed.success) {
      logger.error({ jobId: job.id, errors: parsed.error.format() }, '[worker] pipeline:merge invalid payload — failing job');
      throw new Error(`Invalid pipeline:merge payload: ${parsed.error.message}`);
    }

    const { runId, branch, workspaceId } = parsed.data;

    // Look up workspace path
    const workspace = await queryOne<{ path: string }>(
      'SELECT path FROM workspaces WHERE id = $1',
      [workspaceId],
    );
    if (!workspace) {
      logger.error({ jobId: job.id, workspaceId }, '[worker] pipeline:merge workspace not found — skipping');
      await execute(
        `UPDATE pipeline_runs SET merge_status = 'failed' WHERE id = $1`,
        [runId],
      );
      return;
    }

    logger.info({ runId, branch, workspacePath: workspace.path }, '[worker] Executing performMerge');

    const result = await performMerge(runId, branch, workspace.path);

    if (result.success) {
      logger.info({ runId, mergeCommitSha: result.mergeCommitSha }, '[worker] pipeline:merge completed successfully');
    } else {
      logger.warn({ runId, error: result.error, conflictFiles: result.conflictFiles }, '[worker] pipeline:merge failed');
    }
  }
}

// ── Stale job recovery ───────────────────────────────────────────────────
// Called once at startup, before boss.work() registers handlers.
// Finds any pgboss.job rows that were left in state='active' by a previous
// worker that crashed (or was SIGKILL'd before draining). These jobs will
// never be retried because pg-boss only expires them after expireInSeconds
// (set to 7200s / 2hr by WR-003), meaning new jobs would be blocked by the
// occupied teamSize slots until expiry.
//
// Safe cutoff: we use WORKER_STARTED_AT as the boundary. Any job whose
// startedon < WORKER_STARTED_AT could not have been started by this process
// instance, so it is definitively orphaned.
//
// We do NOT re-queue — a partially-executed run may have committed code;
// re-running it would create duplicate commits.

export async function recoverStaleJobs(): Promise<void> {
  type StaleJobRow = {
    id: string;
    name: string;
    data: Record<string, unknown>;
  };

  let staleJobs: StaleJobRow[];
  try {
    // Only recover jobs started before THIS worker AND whose owning worker
    // has no fresh heartbeat. Without the heartbeat check, a second worker
    // would mark a first worker's legitimate active jobs as stale.
    staleJobs = await query<StaleJobRow>(
      `SELECT j.id, j.name, j.data
       FROM pgboss.job j
       WHERE j.name IN ('pipeline:run', 'pipeline:retry')
         AND j.state = 'active'
         AND j.started_on < $1
         AND NOT EXISTS (
           SELECT 1 FROM worker_heartbeat wh
           WHERE wh.last_seen > NOW() - INTERVAL '90 seconds'
             AND wh.worker_id != $2
             AND wh.started_at <= j.started_on
         )`,
      [WORKER_STARTED_AT, WORKER_ID],
    );
  } catch (err) {
    // pgboss schema may not exist yet on a completely fresh DB — safe to skip
    logger.warn({ err }, '[worker] recoverStaleJobs — pgboss.job query failed, skipping');
    return;
  }

  if (staleJobs.length === 0) {
    logger.info('[worker] recoverStaleJobs — no stale active jobs found');
    return;
  }

  logger.warn({ count: staleJobs.length }, '[worker] recoverStaleJobs — found stale active jobs from crashed worker');

  for (const job of staleJobs) {
    const runId = typeof job.data?.runId === 'number' ? job.data.runId : undefined;

    // 1. Fail the pg-boss job so the slot is freed
    try {
      await execute(
        `UPDATE pgboss.job
         SET state = 'failed', completed_on = NOW()
         WHERE id = $1 AND state = 'active'`,
        [job.id],
      );
    } catch (err) {
      logger.warn({ err, jobId: job.id }, '[worker] recoverStaleJobs — failed to update pgboss.job state');
      continue;
    }

    if (!runId) {
      logger.warn({ jobId: job.id, jobName: job.name }, '[worker] recoverStaleJobs — job has no runId in data, skipping pipeline_runs update');
      continue;
    }

    // 2. Look up workspaceId before updating the run
    const runRow = await queryOne<{ workspace_id: number | string }>(
      `SELECT workspace_id FROM pipeline_runs WHERE id = $1`,
      [runId],
    ).catch(() => undefined);

    // 3. Mark pipeline_runs as failed
    try {
      await execute(
        `UPDATE pipeline_runs SET status = 'failed', finished_at = NOW() WHERE id = $1 AND status = 'running'`,
        [runId],
      );
    } catch (err) {
      logger.warn({ err, runId }, '[worker] recoverStaleJobs — failed to update pipeline_runs');
    }

    // 4. Emit WAL event for UI notification
    if (runRow) {
      await emitWalEvent('run_finished', runRow.workspace_id, {
        run_id: runId,
        status: 'failed',
        reason: 'worker_crash_recovery',
        pgboss_job_id: job.id,
        recovered_at: new Date().toISOString(),
      });
    }

    // Advance queue — a queued run may have been waiting behind this stale one
    if (runRow) {
      advanceQueue(String(runRow.workspace_id)).catch(qErr =>
        logger.error({ err: qErr, runId }, '[worker] advanceQueue failed after stale job recovery'),
      );
    }

    logger.warn(
      { pgbossJobId: job.id, jobName: job.name, runId },
      '[worker] recoverStaleJobs — stale job failed, pipeline_runs updated',
    );
  }

  logger.info({ recovered: staleJobs.length }, '[worker] recoverStaleJobs — recovery complete');
}

// ── Orphan process sweep ─────────────────────────────────────────────────
// Finds pipeline_runs in status='running' that belong to a different worker
// (or have no worker_id at all) — i.e., they were started by a worker that
// has since crashed without cleaning up its processes. For each such run:
//
//   1. Check whether pipeline_runs.pid is still alive via process.kill(pid, 0).
//   2. If alive: SIGTERM → wait 5s → SIGKILL (if still alive).
//   3. Mark the run status='failed', finished_at=NOW().
//   4. Emit run_finished WAL event with reason:'orphan_sweep'.
//   5. For each story in the run that hasn't passed, emit story_failed WAL event.
//
// Safety: skips any runId currently tracked in activeProcesses (belt-and-suspenders
// guard — this worker owns that run and its child is still alive by design).
//
// Error isolation: each run is wrapped in its own try/catch; a failure on one
// run does not abort the sweep of the remaining runs.
//
// Returns: array of { runId, pid, killed } summary objects (never throws).

export type OrphanSweepResult = {
  runId: number;
  pid: number;
  killed: boolean;
};

export async function sweepOrphanProcesses(): Promise<OrphanSweepResult[]> {
  const results: OrphanSweepResult[] = [];

  type OrphanRunRow = {
    id: number;
    pid: number | null;
    workspace_id: number | string;
  };

  let orphanRuns: OrphanRunRow[];
  try {
    // Only find runs whose owning worker has NO fresh heartbeat.
    // Without this check, Worker B would kill Worker A's legitimate runs
    // just because worker_id != B. The LEFT JOIN ensures runs with a
    // live owning worker are excluded; only truly orphaned runs remain.
    orphanRuns = await query<OrphanRunRow>(
      `SELECT pr.id, pr.pid, pr.workspace_id
       FROM pipeline_runs pr
       LEFT JOIN worker_heartbeat wh
         ON pr.worker_id = wh.worker_id
         AND wh.last_seen > NOW() - INTERVAL '90 seconds'
       WHERE pr.status = 'running'
         AND (pr.worker_id IS NULL OR (pr.worker_id != $1 AND wh.worker_id IS NULL))`,
      [WORKER_ID],
    );
  } catch (err) {
    logger.warn({ err }, '[worker] sweepOrphanProcesses — query failed, skipping');
    return results;
  }

  if (orphanRuns.length === 0) {
    logger.info('[worker] sweepOrphanProcesses — no orphan runs found');
    return results;
  }

  logger.warn({ count: orphanRuns.length }, '[worker] sweepOrphanProcesses — found orphan runs');

  for (const run of orphanRuns) {
    // pg driver returns BIGINT as string — coerce to number for activeProcesses Map lookup
    const runId = Number(run.id);
    const { pid, workspace_id: workspaceId } = run;

    // Belt-and-suspenders: skip runs this worker actively owns in memory
    if (activeProcesses.has(runId)) {
      logger.info({ runId }, '[worker] sweepOrphanProcesses — run is in activeProcesses, skipping');
      continue;
    }

    let killed = false;

    try {
      // ── 1. Check PID liveness ──────────────────────────────────────────
      if (pid !== null && pid !== undefined) {
        let isAlive = false;
        try {
          process.kill(pid, 0); // throws if PID is dead (ESRCH) or not ours (EPERM)
          isAlive = true;
        } catch (killErr: any) {
          // ESRCH = no such process (dead), EPERM = not ours (treat as dead)
          isAlive = false;
        }

        if (isAlive) {
          // ── 2a. SIGTERM ────────────────────────────────────────────────
          try {
            process.kill(pid, 'SIGTERM');
            logger.info({ runId, pid }, '[worker] sweepOrphanProcesses — sent SIGTERM');
          } catch {
            // process may have died between the liveness check and SIGTERM — fine
          }

          // ── 2b. Wait 5s then SIGKILL if still alive ────────────────────
          await new Promise<void>((resolve) => setTimeout(resolve, 5_000));

          let stillAlive = false;
          try {
            process.kill(pid, 0);
            stillAlive = true;
          } catch {
            stillAlive = false;
          }

          if (stillAlive) {
            try {
              process.kill(pid, 'SIGKILL');
              killed = true;
              logger.info({ runId, pid }, '[worker] sweepOrphanProcesses — sent SIGKILL (SIGTERM ignored)');
            } catch {
              // PID recycled between liveness check and SIGKILL — harmless
            }
          } else {
            killed = true; // SIGTERM was sufficient
          }
        }
      }

      // ── 3. Mark pipeline run as failed ────────────────────────────────
      await execute(
        `UPDATE pipeline_runs
         SET status = 'failed', finished_at = NOW()
         WHERE id = $1 AND status = 'running'`,
        [runId],
      );

      // ── 4. Emit run_finished WAL event ────────────────────────────────
      await emitWalEvent('run_finished', workspaceId, {
        run_id: runId,
        status: 'failed',
        reason: 'orphan_sweep',
        swept_pid: pid,
        swept_at: new Date().toISOString(),
      });

      // ── 5. Emit story_failed for each incomplete story ─────────────────
      let incompleteStories: { story_id: string }[] = [];
      try {
        incompleteStories = await query<{ story_id: string }>(
          `SELECT story_id FROM story_results
           WHERE run_id = $1 AND status != 'pass'`,
          [runId],
        );
      } catch (storyErr) {
        logger.warn({ storyErr, runId }, '[worker] sweepOrphanProcesses — could not query story_results');
      }

      for (const story of incompleteStories) {
        await emitWalEvent('story_failed', workspaceId, {
          run_id: runId,
          story_id: story.story_id,
          reason: 'orphan_sweep',
        });
      }

      logger.warn(
        { runId, pid, killed, incompleteStories: incompleteStories.length },
        '[worker] sweepOrphanProcesses — orphan run swept',
      );

      // Advance queue — a queued run may have been blocked behind this orphan
      advanceQueue(String(workspaceId)).catch(qErr =>
        logger.error({ err: qErr, runId }, '[worker] advanceQueue failed after orphan sweep'),
      );

      results.push({ runId, pid: pid ?? 0, killed });
    } catch (err) {
      logger.error({ err, runId, pid }, '[worker] sweepOrphanProcesses — error processing orphan run, continuing');
    }
  }

  logger.info({ swept: results.length }, '[worker] sweepOrphanProcesses — sweep complete');
  return results;
}

// ── State reconciliation ─────────────────────────────────────────────────
// Detects and repairs mismatches between pipeline_runs and pgboss.job.
//
// Case A: pipeline_runs.status IN ('running', 'queued') but no matching
//   pgboss.job in state ('created', 'active', 'retry'). The job is gone
//   (completed, failed, or manually deleted) but the run row is stuck.
//   Fix: mark the run 'failed', emit WAL.
//
// Case B: pgboss.job state='active' for pipeline:run/pipeline:retry but
//   pipeline_runs.status is NOT 'running'. The run row was already resolved
//   (e.g. manually via SQL) but the job is still consuming a worker slot.
//   Fix: fail the pgboss job so the slot is freed.
//
// Runs at startup (after recoverStaleJobs) and every 60s.

const RECONCILE_INTERVAL_MS = 60_000;

async function reconcileState(): Promise<void> {
  logger.info('[worker] reconcileState — starting check');

  // ── Case A: pipeline_runs stuck in 'running' with no live pgboss job ──
  // NOTE: 'queued' runs are excluded — they intentionally have no pg-boss job.
  // Queued runs are promoted via advanceQueue() when the active run completes.
  //
  // Heartbeat-aware: if the engine sent a heartbeat within the last 2 minutes,
  // the subprocess is still alive even if the pg-boss job expired. Don't kill it.

  type StuckRunRow = {
    id: number;
    pid: number | null;
    workspace_id: number | string;
    last_heartbeat: string | null;
  };

  let stuckRuns: StuckRunRow[];
  try {
    stuckRuns = await query<StuckRunRow>(
      `SELECT pr.id, pr.pid, pr.workspace_id, pr.last_heartbeat
       FROM pipeline_runs pr
       WHERE pr.status = 'running'
         AND NOT EXISTS (
           SELECT 1 FROM pgboss.job j
           WHERE j.name IN ('pipeline:run', 'pipeline:retry')
             AND j.state IN ('created', 'active', 'retry')
             AND (j.data->>'runId')::bigint = pr.id
         )
         AND (pr.last_heartbeat IS NULL OR pr.last_heartbeat < NOW() - INTERVAL '2 minutes')`,
    );
  } catch (err) {
    logger.warn({ err }, '[worker] reconcileState — Case A query failed, skipping');
    stuckRuns = [];
  }

  for (const run of stuckRuns) {
    // Final safety: if the PID is still alive, the engine is running — skip.
    if (run.pid) {
      try {
        process.kill(run.pid, 0); // signal 0 = liveness check, doesn't kill
        logger.info(
          { runId: run.id, pid: run.pid },
          '[worker] reconcileState — Case A: pg-boss job gone but PID still alive, skipping',
        );
        continue;
      } catch {
        // PID not found — process is dead, proceed with reconciliation
      }
    }

    logger.warn(
      { runId: run.id, currentStatus: 'running', lastHeartbeat: run.last_heartbeat },
      '[worker] reconcileState — Case A: no live pgboss job, no recent heartbeat, PID dead — marking failed',
    );

    try {
      await execute(
        `UPDATE pipeline_runs
         SET status = 'failed', finished_at = NOW()
         WHERE id = $1 AND status = 'running'`,
        [run.id],
      );

      await emitWalEvent('run_finished', run.workspace_id, {
        run_id: run.id,
        status: 'failed',
        reason: 'state_reconciliation',
        reconciled_at: new Date().toISOString(),
      });

      logger.warn(
        { runId: run.id, workspaceId: run.workspace_id },
        '[worker] reconcileState — Case A: run marked failed, WAL emitted',
      );

      advanceQueue(String(run.workspace_id)).catch(qErr =>
        logger.error({ err: qErr, runId: run.id }, '[worker] advanceQueue failed after state reconciliation'),
      );
    } catch (err) {
      logger.warn({ err, runId: run.id }, '[worker] reconcileState — Case A: failed to update run');
    }
  }

  // ── Case B: pgboss.job active but pipeline_run already resolved ──

  type OrphanJobRow = {
    id: string;
    name: string;
    run_id: number | null;
  };

  let orphanJobs: OrphanJobRow[];
  try {
    orphanJobs = await query<OrphanJobRow>(
      `SELECT j.id, j.name, (j.data->>'runId')::bigint AS run_id
       FROM pgboss.job j
       WHERE j.name IN ('pipeline:run', 'pipeline:retry')
         AND j.state = 'active'
         AND (j.data->>'runId') IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM pipeline_runs pr
           WHERE pr.id = (j.data->>'runId')::bigint
             AND pr.status = 'running'
         )`,
    );
  } catch (err) {
    logger.warn({ err }, '[worker] reconcileState — Case B query failed, skipping');
    orphanJobs = [];
  }

  for (const job of orphanJobs) {
    logger.warn(
      { jobId: job.id, jobName: job.name, runId: job.run_id },
      '[worker] reconcileState — Case B: active pgboss job has no running pipeline_run, failing job',
    );

    try {
      await execute(
        `UPDATE pgboss.job
         SET state = 'failed', completed_on = NOW()
         WHERE id = $1 AND state = 'active'`,
        [job.id],
      );

      logger.warn(
        { jobId: job.id, jobName: job.name, runId: job.run_id },
        '[worker] reconcileState — Case B: pgboss job failed to free slot',
      );
    } catch (err) {
      logger.warn({ err, jobId: job.id }, '[worker] reconcileState — Case B: failed to update pgboss.job');
    }
  }

  const totalFixed = stuckRuns.length + orphanJobs.length;
  lastReconciliationErrors = totalFixed;

  if (totalFixed > 0) {
    logger.warn({ caseA: stuckRuns.length, caseB: orphanJobs.length }, '[worker] reconcileState — mismatches resolved');
  } else {
    logger.info('[worker] reconcileState — no mismatches found');
  }
}

// ── Worker settings (split concurrency) ─────────────────────────────────

const DEFAULT_QUEUE_MAX_CONCURRENT = 1;
const DEFAULT_RUN_NOW_MAX_CONCURRENT = 3;

interface ConcurrencySettings {
  queueMaxConcurrent: number;
  runNowMaxConcurrent: number;
}

/**
 * Fetch queue_max_concurrent and run_now_max_concurrent from worker_settings table.
 * Falls back to legacy max_concurrent_runs, then env var, then defaults.
 */
async function getConcurrencySettings(): Promise<ConcurrencySettings> {
  try {
    const rows = await query<{ key: string; value: string }>(
      `SELECT key, value FROM worker_settings WHERE key IN ('queue_max_concurrent', 'run_now_max_concurrent', 'max_concurrent_runs')`,
    );
    const settings = Object.fromEntries(rows.map(r => [r.key, r.value]));

    const parsePositiveInt = (val: string | undefined, fallback: number): number => {
      if (!val) return fallback;
      const parsed = parseInt(val, 10);
      return !isNaN(parsed) && parsed > 0 ? parsed : fallback;
    };

    // Use new split settings if present, otherwise fall back to legacy max_concurrent_runs
    const legacyMax = parsePositiveInt(settings['max_concurrent_runs'], 0);
    const queueMaxConcurrent = parsePositiveInt(
      settings['queue_max_concurrent'],
      legacyMax > 0 ? legacyMax : DEFAULT_QUEUE_MAX_CONCURRENT,
    );
    const runNowMaxConcurrent = parsePositiveInt(
      settings['run_now_max_concurrent'],
      legacyMax > 0 ? legacyMax : DEFAULT_RUN_NOW_MAX_CONCURRENT,
    );

    return { queueMaxConcurrent, runNowMaxConcurrent };
  } catch (err) {
    logger.warn({ err }, '[worker] getConcurrencySettings — DB query failed, using defaults');
  }
  return {
    queueMaxConcurrent: DEFAULT_QUEUE_MAX_CONCURRENT,
    runNowMaxConcurrent: DEFAULT_RUN_NOW_MAX_CONCURRENT,
  };
}

// ── Graceful shutdown ────────────────────────────────────────────────────

let stopping = false;
let reconcileIntervalHandle: ReturnType<typeof setInterval> | undefined;
let sweepIntervalId: ReturnType<typeof setInterval> | undefined;
let settingsPollIntervalId: ReturnType<typeof setInterval> | undefined;

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;

  if (sweepIntervalId !== undefined) {
    clearInterval(sweepIntervalId);
    sweepIntervalId = undefined;
  }

  if (reconcileIntervalHandle !== undefined) {
    clearInterval(reconcileIntervalHandle);
    reconcileIntervalHandle = undefined;
  }

  if (settingsPollIntervalId !== undefined) {
    clearInterval(settingsPollIntervalId);
    settingsPollIntervalId = undefined;
  }

  logger.info(`[worker] received ${signal} — starting graceful shutdown`);

  // 1. SIGTERM all active child processes
  const activeRunIds = Array.from(activeProcesses.keys());
  if (activeRunIds.length > 0) {
    logger.info({ count: activeRunIds.length, runIds: activeRunIds }, '[worker] shutdown — sending SIGTERM to active child processes');
    for (const [, child] of activeProcesses) {
      try { child.kill('SIGTERM'); } catch { /* best-effort */ }
    }
  }

  // 2. Wait up to 15s for child processes to exit (poll every 500ms)
  const DRAIN_TIMEOUT_MS = 15_000;
  const DRAIN_POLL_MS = 500;
  const drainDeadline = Date.now() + DRAIN_TIMEOUT_MS;

  while (activeProcesses.size > 0 && Date.now() < drainDeadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
  }

  // 3. SIGKILL any remaining child processes that did not exit in time
  if (activeProcesses.size > 0) {
    const remaining = Array.from(activeProcesses.keys());
    logger.warn({ remaining }, '[worker] shutdown — children did not exit in 15s, sending SIGKILL');
    for (const [, child] of activeProcesses) {
      try { child.kill('SIGKILL'); } catch { /* best-effort */ }
    }
    // Give SIGKILL a moment to land before we proceed
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }

  // 4. Mark any still-running pipeline_runs as failed
  const inflightRunIds = Array.from(activeProcesses.keys());
  if (inflightRunIds.length > 0) {
    logger.warn({ runIds: inflightRunIds }, '[worker] shutdown — marking in-flight runs as failed');
    for (const runId of inflightRunIds) {
      try {
        await execute(
          `UPDATE pipeline_runs SET status = 'failed', finished_at = NOW() WHERE id = $1 AND status = 'running'`,
          [runId],
        );
      } catch (err) {
        logger.warn({ err, runId }, '[worker] shutdown — failed to update pipeline_run status');
      }
    }
  }

  // 5. Delete this worker's heartbeat row so the health endpoint shows no stale data
  try {
    await execute('DELETE FROM worker_heartbeat WHERE worker_id = $1', [WORKER_ID]);
    logger.info('[worker] shutdown — heartbeat row deleted');
  } catch (err) {
    logger.warn({ err }, '[worker] shutdown — failed to delete heartbeat row');
  }

  // 6. Stop pg-boss (drains any remaining queued work up to 15s)
  logger.info('[worker] shutdown — stopping pg-boss (timeout: 15s)');
  try {
    await getBoss().stop({ timeout: 15_000 });
    logger.info('[worker] pg-boss stopped cleanly');
  } catch (err) {
    logger.error({ err }, '[worker] error stopping pg-boss');
  }

  // 7. Close DB pool LAST — all DB work must be done before this point
  try {
    await closePool();
    logger.info('[worker] DB pool closed — exiting');
  } catch {
    // best-effort
  }
  process.exit(0);
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('uncaughtException', (err) => {
  logger.error({ err }, '[worker] uncaughtException — triggering shutdown');
  void shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  // AppError subclasses (ValidationError, NotFoundError, etc.) are expected
  // business-logic errors from Express routes — NOT fatal.  Log and move on.
  const isAppError = reason instanceof Error && 'statusCode' in reason && (reason as any).statusCode < 500;
  if (isAppError) {
    logger.warn({ reason }, '[worker] unhandledRejection (non-fatal AppError) — process kept alive');
    return;
  }

  // PostgreSQL errors (missing column, missing table, constraint violations, etc.)
  // are non-fatal — a bad INSERT from one story should never kill the whole worker.
  // pg errors have a 'code' field (e.g. '42703' = undefined_column, '42P01' = undefined_table).
  const isPgError = reason instanceof Error && 'code' in reason && typeof (reason as any).code === 'string';
  if (isPgError) {
    logger.error({ reason }, '[worker] unhandledRejection (pg DatabaseError) — process kept alive');
    return;
  }

  logger.error({ reason }, '[worker] unhandledRejection — triggering shutdown');
  void shutdown('unhandledRejection');
});

// ── Singleton guard ──────────────────────────────────────────────────────
// Prevents duplicate workers from competing for the same pg-boss queue,
// which causes orphan sweep / stale-job recovery to kill each other's
// engine processes (the root cause of runs dying mid-story).

export async function checkSingletonGuard(): Promise<void> {
  try {
    type LiveWorkerRow = { worker_id: string; pid: number; last_seen: string };
    const liveWorkers = await query<LiveWorkerRow>(
      `SELECT worker_id, pid, last_seen
       FROM worker_heartbeat
       WHERE worker_id != $1
         AND last_seen > NOW() - INTERVAL '90 seconds'`,
      [WORKER_ID],
    );

    if (liveWorkers.length > 0) {
      for (const w of liveWorkers) {
        try {
          process.kill(w.pid, 0); // throws ESRCH if dead
          logger.error(
            { existingWorkerId: w.worker_id, existingPid: w.pid, lastSeen: w.last_seen },
            '[worker] SINGLETON GUARD — another worker is alive. Exiting to prevent duplicate workers.',
          );
          process.exit(0);
        } catch {
          logger.info({ stalePid: w.pid }, '[worker] Cleaning stale heartbeat from dead worker');
          await execute(
            `DELETE FROM worker_heartbeat WHERE worker_id = $1`,
            [w.worker_id],
          ).catch(() => {});
        }
      }
    }
  } catch {
    // worker_heartbeat table might not exist yet — continue startup
  }
}

// ── Integration health checks ────────────────────────────────────────────
// Pings each connected integration's API endpoint every 5 minutes (via pg-boss cron).
// Stores health snapshots in integration_health table for trend display.

interface IntegrationTokenRow {
  workspace_id: string;
  provider: string;
  encrypted_token: string;
}

/**
 * Compute health status based on thresholds from AC:
 * - healthy: error_rate < 0.05 AND rate_limit_remaining >= 500 AND consecutive_failures <= 3
 * - degraded: error_rate 0.05-0.20 OR rate_limit_remaining < 500
 * - disconnected: consecutive_failures > 3 OR rate_limit_remaining = 0
 */
function computeHealthStatus(
  errorRate: number,
  rateLimitRemaining: number | null,
  consecutiveFailures: number,
): 'healthy' | 'degraded' | 'disconnected' {
  if (consecutiveFailures > 3 || rateLimitRemaining === 0) return 'disconnected';
  if (errorRate >= 0.05 || (rateLimitRemaining !== null && rateLimitRemaining < 500)) return 'degraded';
  return 'healthy';
}

async function runIntegrationHealthChecks(): Promise<void> {
  logger.info('[worker] integration:health-check — starting');

  // Find all workspaces with connected integrations.
  // Check github_connections (legacy) and integration_tokens (new).
  // For GitHub: use github_connections.encrypted_token (existing pattern).

  // 1. GitHub health checks via github_connections
  try {
    const { decryptToken } = await import('./routes/auth');

    type GithubConnRow = { user_id: string; encrypted_token: string; github_username: string | null };
    const ghConns = await query<GithubConnRow>(
      `SELECT gc.user_id, gc.encrypted_token, gc.github_username
       FROM github_connections gc
       WHERE gc.encrypted_token IS NOT NULL`,
    );

    // For each GitHub connection, find associated workspaces
    for (const conn of ghConns) {
      let token: string;
      try {
        token = decryptToken(conn.encrypted_token);
      } catch {
        logger.warn({ userId: conn.user_id }, '[worker] integration:health-check — failed to decrypt GitHub token, skipping');
        continue;
      }

      // Find workspaces with GitHub webhooks configured
      type WsRow = { workspace_id: string };
      const wsRows = await query<WsRow>(
        `SELECT DISTINCT workspace_id FROM workspace_github_webhooks`,
      );

      for (const ws of wsRows) {
        await checkGitHubHealth(ws.workspace_id, token);
      }
    }

    // If no github_connections, check integration_tokens table
    if (ghConns.length === 0) {
      const tokenRows = await query<IntegrationTokenRow>(
        `SELECT workspace_id, provider, encrypted_token
         FROM integration_tokens
         WHERE provider = 'github' AND token_type = 'oauth_access' AND revoked_at IS NULL`,
      );

      for (const row of tokenRows) {
        try {
          const { getOAuthToken } = await import('./lib/integration-vault');
          const result = await getOAuthToken(row.workspace_id, 'github');
          if (result) {
            await checkGitHubHealth(row.workspace_id, result.token);
          }
        } catch (err) {
          logger.warn({ err, workspaceId: row.workspace_id }, '[worker] integration:health-check — vault token check failed');
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, '[worker] integration:health-check — GitHub checks failed (preserving last-known-good state)');
  }

  logger.info('[worker] integration:health-check — complete');
}

async function checkGitHubHealth(workspaceId: string, token: string): Promise<void> {
  // Get previous health snapshot for this workspace+provider
  type PrevHealthRow = { consecutive_failures: number; last_success: string | null };
  const prev = await queryOne<PrevHealthRow>(
    `SELECT consecutive_failures, last_success FROM integration_health
     WHERE workspace_id = $1 AND provider = 'github'
     ORDER BY checked_at DESC LIMIT 1`,
    [workspaceId],
  );

  let rateLimitRemaining: number | null = null;
  let rateLimitMax: number | null = null;
  let consecutiveFailures = prev?.consecutive_failures ?? 0;
  let lastSuccess = prev?.last_success ?? null;
  let lastError: string | null = null;
  let errorRate = 0;

  try {
    const response = await fetch('https://api.github.com/rate_limit', {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Rorca/1.0',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (response.ok) {
      const data = await response.json() as { rate: { remaining: number; limit: number; reset: number } };
      rateLimitRemaining = data.rate.remaining;
      rateLimitMax = data.rate.limit;
      consecutiveFailures = 0;
      lastSuccess = new Date().toISOString();
    } else {
      consecutiveFailures += 1;
      lastError = `GitHub API returned ${response.status}: ${response.statusText}`;
    }
  } catch (err: any) {
    consecutiveFailures += 1;
    lastError = err.message ?? String(err);
  }

  // Calculate error rate from last 24h snapshots
  try {
    type ErrorRateRow = { total: string; failures: string };
    const rateRow = await queryOne<ErrorRateRow>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE consecutive_failures > 0)::text AS failures
       FROM integration_health
       WHERE workspace_id = $1 AND provider = 'github'
         AND checked_at > NOW() - INTERVAL '24 hours'`,
      [workspaceId],
    );
    if (rateRow) {
      const total = parseInt(rateRow.total, 10);
      const failures = parseInt(rateRow.failures, 10);
      errorRate = total > 0 ? failures / total : 0;
    }
  } catch {
    // Non-fatal — use 0
  }

  // Compute webhook success rate from recent webhook deliveries
  let webhookSuccessRate = 1.0;
  try {
    type WebhookRateRow = { total: string; successes: string };
    const whRow = await queryOne<WebhookRateRow>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE status_code >= 200 AND status_code < 300)::text AS successes
       FROM webhook_deliveries
       WHERE workspace_id = $1 AND provider = 'github'
         AND delivered_at > NOW() - INTERVAL '24 hours'`,
      [workspaceId],
    );
    if (whRow) {
      const total = parseInt(whRow.total, 10);
      const successes = parseInt(whRow.successes, 10);
      webhookSuccessRate = total > 0 ? successes / total : 1.0;
    }
  } catch {
    // webhook_deliveries table may not exist — use default 1.0
  }

  const status = computeHealthStatus(errorRate, rateLimitRemaining, consecutiveFailures);

  // Insert health snapshot (never delete previous rows — preserve history)
  try {
    await execute(
      `INSERT INTO integration_health
         (workspace_id, provider, status, error_rate, rate_limit_remaining, rate_limit_max,
          consecutive_failures, last_success, webhook_success_rate, last_error, checked_at)
       VALUES ($1, 'github', $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
      [workspaceId, status, errorRate, rateLimitRemaining, rateLimitMax,
       consecutiveFailures, lastSuccess, webhookSuccessRate, lastError],
    );
  } catch (err) {
    logger.warn({ err, workspaceId }, '[worker] integration:health-check — failed to write health snapshot');
  }
}

// ── Startup ──────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  // 1. Run pending SQL migrations (001–NNN) against the main public schema
  try {
    await initDb();
  } catch (err) {
    logger.error({ err }, '[worker] database initialisation failed');
    process.exit(1);
  }

  // 1b. Singleton guard — exit if another worker has a fresh heartbeat.
  await checkSingletonGuard();

  // 2. Start pg-boss — creates/upgrades pgboss.* schema automatically
  try {
    await initBoss();
  } catch (err) {
    logger.error({ err }, '[worker] pg-boss initialisation failed');
    process.exit(1);
  }

  // 3. Recover stale jobs left by a previously crashed worker instance.
  // Must run after initBoss() (pg-boss schema exists) but before boss.work()
  // (so freed slots are available when handlers start polling).
  await recoverStaleJobs();

  // 3a. Sweep orphan processes — execution-engine subprocesses left running
  // by a previous worker that crashed without a graceful shutdown.
  // Must complete before boss.work() — do not race sweep against new job pickup.
  // Error-isolated: a sweep failure must NOT prevent job handler registration.
  try {
    const sweepResults = await sweepOrphanProcesses();
    if (sweepResults.length === 0) {
      logger.info('[worker] Startup orphan sweep: no orphans found');
    } else {
      for (const r of sweepResults) {
        logger.info({ pid: r.pid, runId: r.runId }, `[worker] Startup orphan sweep: killed PID ${r.pid} for run ${r.runId}`);
      }
      logger.info(
        { found: sweepResults.length, killed: sweepResults.filter(r => r.killed).length, runIds: sweepResults.map(r => r.runId) },
        `[worker] Startup orphan sweep: ${sweepResults.length} orphan(s) found, ${sweepResults.filter(r => r.killed).length} killed`,
      );
    }
  } catch (err) {
    logger.error({ err }, '[worker] Startup orphan sweep failed — continuing with worker startup');
  }

  // 3b. Reconcile state between pipeline_runs and pgboss.job.
  // Runs once at startup, then every 60s during normal operation.
  await reconcileState();
  reconcileIntervalHandle = setInterval(() => { void reconcileState(); }, RECONCILE_INTERVAL_MS);

  // 4. Register job queue handlers.
  // Queues are already created by ensureQueues() inside initBoss() — just register handlers.
  const boss = getBoss();

  // Fetch initial concurrency from DB (falls back to env var / default).
  let currentSettings = await getConcurrencySettings();
  logger.info(
    { queueMax: currentSettings.queueMaxConcurrent, runNowMax: currentSettings.runNowMaxConcurrent },
    '[worker] initial concurrency settings (queue_max_concurrent / run_now_max_concurrent)',
  );

  // batchSize = sum of both limits so the handler can pick up both job types.
  const computeBatchSize = (s: ConcurrencySettings) => s.queueMaxConcurrent + s.runNowMaxConcurrent;

  await boss.work('pipeline:run', { batchSize: computeBatchSize(currentSettings) }, handlePipelineRun);
  await boss.work('pipeline:retry', { batchSize: computeBatchSize(currentSettings) }, handlePipelineRetry);
  await boss.work('pipeline:cancel', { batchSize: 10 }, handlePipelineCancel);
  await boss.work('pipeline:merge', { batchSize: 1 }, handlePipelineMerge);

  // Poll worker_settings every WORKER_SETTINGS_POLL_MS (default 30s).
  // If concurrency settings changed, hot-reload the pipeline:run and pipeline:retry subscriptions.
  const WORKER_SETTINGS_POLL_MS = parseInt(process.env.WORKER_SETTINGS_POLL_MS ?? '30000', 10);

  settingsPollIntervalId = setInterval(() => {
    void (async () => {
      if (stopping) return;
      try {
        const newSettings = await getConcurrencySettings();
        if (
          newSettings.queueMaxConcurrent !== currentSettings.queueMaxConcurrent ||
          newSettings.runNowMaxConcurrent !== currentSettings.runNowMaxConcurrent
        ) {
          logger.info(
            {
              queueFrom: currentSettings.queueMaxConcurrent, queueTo: newSettings.queueMaxConcurrent,
              runNowFrom: currentSettings.runNowMaxConcurrent, runNowTo: newSettings.runNowMaxConcurrent,
            },
            '[worker] concurrency settings changed, reloading work subscription',
          );

          // Stop current subscriptions gracefully (pg-boss drains in-flight batch
          // before removing the subscription — in-flight jobs are NOT interrupted).
          await boss.offWork('pipeline:run');
          await boss.offWork('pipeline:retry');

          currentSettings = newSettings;

          // Re-register with updated batchSize.
          await boss.work('pipeline:run', { batchSize: computeBatchSize(currentSettings) }, handlePipelineRun);
          await boss.work('pipeline:retry', { batchSize: computeBatchSize(currentSettings) }, handlePipelineRetry);

          logger.info(
            { queueMax: currentSettings.queueMaxConcurrent, runNowMax: currentSettings.runNowMaxConcurrent, batchSize: computeBatchSize(currentSettings) },
            '[worker] work subscription reloaded successfully',
          );
        }
      } catch (err) {
        logger.warn({ err }, '[worker] settings poll: failed to check/reload concurrency settings');
      }
    })();
  }, WORKER_SETTINGS_POLL_MS);

  // 4b-monitor. Capture pg-boss monitor-states snapshots to queue_health_snapshots table.
  // pg-boss emits 'monitor-states' every monitorStateIntervalSeconds (60s, set in US-001).
  // Shape: { [queueName]: { created, retry, active, completed, cancelled, failed } }
  // pg-boss emits 'monitor-states' but the TypeScript types only declare 'stopped'.
  // Cast to EventEmitter to attach the listener without type errors.
  type MonitorStatesPayload = Record<string, { created: number; retry: number; active: number; completed: number; cancelled: number; failed: number }>;
  (boss as unknown as { on(event: string, listener: (states: MonitorStatesPayload) => void): void })
    .on('monitor-states', (states: MonitorStatesPayload) => {
    void (async () => {
      try {
        const totals = Object.values(states).reduce(
          (acc, q) => {
            acc.pending += (q.created ?? 0) + (q.retry ?? 0);
            acc.active += q.active ?? 0;
            acc.failed += q.failed ?? 0;
            acc.completed += q.completed ?? 0;
            return acc;
          },
          { pending: 0, active: 0, failed: 0, completed: 0 },
        );

        const breakdown = Object.entries(states).map(([name, counts]) => ({ name, ...counts }));

        // ── Pickup latency (24-hour rolling window, pipeline queues only) ─────
        interface LatencyResult {
          avg_pickup_seconds: number | null;
          p95_pickup_seconds: number | null;
          sample_count: string;
        }
        const latencyRow = await queryOne<LatencyResult>(
          `SELECT
             AVG(EXTRACT(EPOCH FROM (started_on - created_on)))                                                         AS avg_pickup_seconds,
             PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (started_on - created_on)))               AS p95_pickup_seconds,
             COUNT(*)::text                                                                                              AS sample_count
           FROM pgboss.archive
           WHERE started_on IS NOT NULL
             AND created_on IS NOT NULL
             AND archived_on > NOW() - INTERVAL '24 hours'
             AND name IN ('pipeline:run', 'pipeline:retry')`,
        ).catch(() => null);

        const avgPickupSeconds = latencyRow?.avg_pickup_seconds ?? null;
        const p95PickupSeconds = latencyRow?.p95_pickup_seconds ?? null;
        const latencySampleCount = parseInt(latencyRow?.sample_count ?? '0', 10);

        // Classify latency health
        let latencyStatus: 'healthy' | 'degraded' | 'critical' = 'healthy';
        if (p95PickupSeconds === null) {
          latencyStatus = totals.pending > 0 ? 'critical' : 'healthy';
        } else if (p95PickupSeconds > 10) {
          latencyStatus = 'critical';
        } else if (p95PickupSeconds > 2) {
          latencyStatus = 'degraded';
        }
        const latencyAlert = latencyStatus === 'degraded' || latencyStatus === 'critical';

        await execute(
          `INSERT INTO queue_health_snapshots
             (total_pending, total_active, total_failed, total_completed, queue_breakdown, worker_id, avg_pickup_seconds, p95_pickup_seconds)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [totals.pending, totals.active, totals.failed, totals.completed, JSON.stringify(breakdown), WORKER_ID, avgPickupSeconds, p95PickupSeconds],
        );

        logger.debug(
          { pending: totals.pending, active: totals.active, failed: totals.failed, p95PickupSeconds, latencyStatus },
          '[worker] queue_health_snapshot written',
        );

        // Alert: if any jobs are in failed state OR latency is degraded/critical, broadcast.
        if (totals.failed > 0 || latencyAlert) {
          broadcastAll({
            id: 0,
            ts: new Date().toISOString(),
            event_type: 'queue_failed_jobs_detected',
            workspace_id: null,
            spec_id: null,
            story_id: null,
            actor: 'worker',
            payload: JSON.stringify({ count: totals.failed, breakdown, latencyAlert, latencyStatus, p95PickupSeconds, sampleCount: latencySampleCount }),
          });
        }
      } catch (err) {
        logger.warn({ err }, '[worker] monitor-states snapshot write failed');
      }
    })();
  });

  // 4c. Periodic orphan sweep — runs every 5 minutes after job handlers are registered.
  // Handles the case where a sibling worker crashes mid-run AFTER our startup sweep —
  // those orphans would be missed by recoverStaleJobs/sweepOrphanProcesses at startup.
  const SWEEP_INTERVAL_MS = 300_000; // 5 minutes
  sweepIntervalId = setInterval(() => {
    void (async () => {
      try {
        const results = await sweepOrphanProcesses();
        if (results.length === 0) {
          logger.debug('[worker] Periodic orphan sweep: no orphans found');
        } else {
          logger.warn(
            { found: results.length, killed: results.filter(r => r.killed).length, runIds: results.map(r => r.runId) },
            '[worker] Periodic orphan sweep: orphans found and killed',
          );
        }
      } catch (err) {
        logger.error({ err }, '[worker] Periodic orphan sweep: unexpected error');
      }
    })();
  }, SWEEP_INTERVAL_MS);

  // 4b. DLQ polling — pg-boss does not emit a 'failed' event for job exhaustion.
  // Instead, poll pgboss.archive every 60 s for newly-failed pipeline jobs and emit
  // run_dlq WAL events. Seen job IDs are tracked in a Set to avoid duplicate events.
  const seenDlqJobIds = new Set<string>();

  async function pollDlq(): Promise<void> {
    try {
      type DlqRow = { id: string; name: string; output: unknown; retry_count: number; archived_on: string; data: Record<string, unknown> };
      const rows = await query<DlqRow>(
        `SELECT id, name, output, retry_count, archived_on, data
         FROM pgboss.archive
         WHERE name IN ('pipeline:run', 'pipeline:retry')
           AND state = 'failed'
           AND archived_on > NOW() - INTERVAL '1 day'
         ORDER BY archived_on DESC`,
      ).catch(() => [] as DlqRow[]);

      for (const row of rows) {
        if (seenDlqJobIds.has(row.id)) continue;
        seenDlqJobIds.add(row.id);

        const runId = typeof row.data?.runId === 'number' ? row.data.runId : undefined;
        if (!runId) continue;

        const run = await queryOne<{ workspace_id: string }>(
          `SELECT workspace_id FROM pipeline_runs WHERE id = $1`,
          [runId],
        ).catch(() => undefined);
        if (!run) continue;

        const lastError = typeof row.output === 'string'
          ? row.output
          : (row.output != null ? JSON.stringify(row.output) : null);

        logger.warn({ jobId: row.id, name: row.name, runId }, '[worker] DLQ poll — emitting run_dlq WAL event');

        await emitWalEvent('run_dlq', run.workspace_id, {
          runId,
          jobId: row.id,
          jobName: row.name,
          lastError,
          attempts: (row.retry_count ?? 0) + 1,
        });
      }
    } catch (err) {
      logger.warn({ err }, '[worker] DLQ poll error');
    }
  }

  void pollDlq();
  setInterval(() => { void pollDlq(); }, 60_000);

  // 4d. Auto-prune queue_health_snapshots — delete rows older than 30 days.
  // Runs nightly at 03:00 via pg-boss native cron scheduling.
  try {
    await boss.schedule('queue-snapshot-prune', '0 3 * * *', {});
    await boss.work('queue-snapshot-prune', async () => {
      try {
        const result = await execute(
          `DELETE FROM queue_health_snapshots WHERE captured_at < NOW() - INTERVAL '30 days'`,
        );
        logger.info({ rowCount: result.rowCount }, '[worker] queue_health_snapshots pruned');
      } catch (err) {
        logger.warn({ err }, '[worker] queue_health_snapshots prune failed');
      }
    });
  } catch (err) {
    logger.warn({ err }, '[worker] queue-snapshot-prune schedule registration failed (non-fatal)');
  }

  // 4e. Integration health check cron — pings connected integrations every 5 minutes.
  try {
    await boss.schedule('integration:health-check', '*/5 * * * *', {});
    await boss.work('integration:health-check', async () => {
      await runIntegrationHealthChecks();
    });
    logger.info('[worker] integration:health-check cron registered (every 5 min)');
  } catch (err) {
    logger.warn({ err }, '[worker] integration:health-check schedule registration failed (non-fatal)');
  }

  // 4. Bulk-register all enabled pipeline_schedules with pg-boss native scheduling.
  // Also registers the meta-cron (pipeline:cron, every minute) and per-schedule
  // boss.work() subscriptions (pipeline:cron:<id>). Re-registration is idempotent.
  await registerSchedulesWithBoss(boss, handlePipelineCron);

  // 5. Start heartbeat — write immediately, then every 30 s.
  // Also runs pg-boss connection self-check on each tick; exits on 3 consecutive failures.
  await writeHeartbeat();
  setInterval(() => {
    void writeHeartbeat();
    void pgBossHealthCheck();
  }, HEARTBEAT_INTERVAL_MS);

  logger.info('[worker] ready — listening for pipeline:run, pipeline:retry, pipeline:cancel, pipeline:cron, pipeline:merge');
}

// Only auto-start when this file is run directly (not imported by tests or other modules).
// require.main === module is true when invoked via `node worker.js` / `tsx worker.ts`.
// When Jest imports worker.ts to test sweepOrphanProcesses(), require.main !== module
// so start() is NOT called and no DB connections / pg-boss setup are attempted.
if (require.main === module) {
  start().catch((err) => {
    logger.error({ err }, '[worker] startup failed');
    process.exit(1);
  });
}
