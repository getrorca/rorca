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
import { initDb, query, queryOne, execute } from './db/index';
import { initBoss, getBoss } from './lib/pg-boss';
import { registerSchedulesWithBoss, triggerScheduledRun, checkAndFireDueSchedules } from './lib/scheduler';
import { logger } from './lib/logger';
import { broadcastAll } from './lib/sse-hub';
import { FlushBuffer } from './lib/flush-buffer';

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
  for (const job of jobs) {
    const jobId = job.id;
    logger.info({ jobId, data: job.data }, '[worker] pipeline:run received');

    // 1. Validate payload via Zod
    const parsed = PipelineRunJobPayload.safeParse(job.data);
    if (!parsed.success) {
      logger.error({ jobId, errors: parsed.error.format() }, '[worker] pipeline:run invalid payload — failing job');
      throw new Error(`Invalid pipeline:run payload: ${parsed.error.message}`);
    }

    const payload: PipelineRunJobPayloadType = parsed.data;
    const { runId, specPath, workspacePath, agent, model, worktreePath, envOverrides, startFromStoryId } = payload;

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

    // 2. Mark run as running
    await execute(
      `UPDATE pipeline_runs SET status = 'running', started_at = NOW() WHERE id = $1`,
      [runId],
    );

    await emitWalEvent('run_started', workspaceId, { run_id: runId, spec_path: specPath });

    // 3. Build engine args
    const executionEngineTs = path.join(__dirname, 'lib', 'execution-engine.ts');
    const tsxBin = path.join(__dirname, '..', 'node_modules', '.bin', 'tsx');
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
      if (
        typeof msg === 'object' &&
        msg !== null &&
        (msg as Record<string, unknown>).type === 'pid' &&
        typeof (msg as Record<string, unknown>).pid === 'number'
      ) {
        const enginePid = (msg as Record<string, unknown>).pid as number;
        logger.info({ runId, enginePid }, '[worker] Received inner engine PID via IPC — updating pipeline_runs.pid');
        try {
          await execute('UPDATE pipeline_runs SET pid = $1 WHERE id = $2', [enginePid, runId]);
        } catch (err) {
          logger.warn({ err, runId, enginePid }, '[worker] Failed to update pipeline_runs.pid with inner engine PID');
        }
      }
    });

    // 6. Pipe stdout/stderr to run_output_chunks in ≤4 KB chunks
    const sequenceRef = { value: 1 };
    const outputBuffer = new FlushBuffer({
      chunkSize: CHUNK_SIZE,
      flushInterval: 500,
      onFlush: async (data) => {
        await writeChunk(runId, sequenceRef.value, data);
        sequenceRef.value += 1;
      },
    });

    child.stdout?.on('data', (data: Buffer) => { void outputBuffer.write(data); });
    child.stderr?.on('data', (data: Buffer) => { void outputBuffer.write(data); });

    // 7. Wait for close (not exit), flush remaining bytes, update run status.
    //
    // Root cause fix (US-007): Node.js does NOT guarantee that all stdout/stderr
    // data events have been emitted when the 'exit' event fires. The pipe buffer
    // may still contain unread bytes (e.g. pino's sonic-boom flush, final log lines
    // produced just before the child exits). Using 'exit' for flushPending() caused
    // run_output_chunks to receive 0 rows for worktree runs where the engine emits
    // a burst of output right before exit (merge logs, summary lines).
    //
    // The 'close' event fires after BOTH:
    //   (a) the child process has exited, AND
    //   (b) all stdio streams have been fully drained (all data events emitted).
    // This guarantees flushPending() sees every byte the engine wrote to stdout/stderr.
    await new Promise<void>((resolve) => {
      // Capture exit code from 'exit' event; cleanup runs on 'close'.
      let capturedCode: number | null = null;
      child.on('exit', (code) => { capturedCode = code; });

      child.on('close', async () => {
        // All stdout/stderr data has been received — safe to flush the tail.
        await outputBuffer.close();

        const code = capturedCode;
        activeProcesses.delete(runId);

        const wasCancelled = cancellingRuns.delete(runId);
        const status = wasCancelled ? 'cancelled' : (code === 0 ? 'done' : 'failed');
        logger.info({ runId, code, status, wasCancelled }, '[worker] execution-engine exited');

        try {
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

            // Auto-merge worktree into main after run completes (US-004 + US-005)
            // Only attempt if the run succeeded (status='done') and a worktree was created
            if (status === 'done' && payload.autoMerge && worktreePath && payload.branchName) {
              try { await execute(`UPDATE pipeline_runs SET merge_status = 'pending' WHERE id = $1`, [runId]); } catch { /* non-fatal */ }
              const mergeLog = (msg: string) => logger.info({ runId }, msg);
              try {
                await autoMergeAfterRun(
                  workspacePath,
                  worktreePath,
                  payload.branchName,
                  workspaceId,
                  runId,
                  mergeLog,
                );
              } catch (mergeErr: any) {
                logger.error({ err: mergeErr, runId }, '[worker] autoMergeAfterRun threw unexpectedly');
              }
            }
          }
        } catch (err) {
          logger.error({ err, runId }, '[worker] Failed to update run status on exit');
        }

        resolve();
      });

      child.on('error', async (err) => {
        logger.error({ err, runId }, '[worker] execution-engine spawn error');
        await outputBuffer.close();
        activeProcesses.delete(runId);
        cancellingRuns.delete(runId);

        try {
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
        } catch (dbErr) {
          logger.error({ dbErr, runId }, '[worker] Failed to update run status after spawn error');
        }

        resolve();
      });
    });
  }
}

// ── Job handler: pipeline:retry ───────────────────────────────────────────

async function handlePipelineRetry(jobs: PgBoss.Job<Record<string, unknown>>[]): Promise<void> {
  for (const job of jobs) {
    const jobId = job.id;
    logger.info({ jobId, data: job.data }, '[worker] pipeline:retry received');

    // 1. Validate payload via Zod
    const parsed = PipelineRetryJobPayload.safeParse(job.data);
    if (!parsed.success) {
      logger.error({ jobId, errors: parsed.error.format() }, '[worker] pipeline:retry invalid payload — failing job');
      throw new Error(`Invalid pipeline:retry payload: ${parsed.error.message}`);
    }

    const payload: PipelineRetryJobPayloadType = parsed.data;
    const { runId, originalRunId, workspacePath, retrySpecPath, agent, model, worktreePath, sequenceOffset, envOverrides } = payload;

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

    // 3. Mark the new run as running (route handler set status='running' but worker confirms)
    await execute(
      `UPDATE pipeline_runs SET status = 'running', started_at = NOW() WHERE id = $1`,
      [runId],
    );

    await emitWalEvent('run_started', workspaceId, {
      run_id: runId,
      original_run_id: originalRunId,
      source: 'worker_retry',
    });

    // 4. Build execution-engine args with the temp retry spec
    const executionEngineTs = path.join(__dirname, 'lib', 'execution-engine.ts');
    const tsxBin = path.join(__dirname, '..', 'node_modules', '.bin', 'tsx');
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
    const outputBuffer = new FlushBuffer({
      chunkSize: CHUNK_SIZE,
      flushInterval: 500,
      onFlush: async (data) => {
        await writeChunk(runId, sequenceRef.value, data);
        sequenceRef.value += 1;
      },
    });

    child.stdout?.on('data', (data: Buffer) => { void outputBuffer.write(data); });
    child.stderr?.on('data', (data: Buffer) => { void outputBuffer.write(data); });

    // 7. Wait for close (not exit), flush remaining bytes, update run status.
    // Same fix as handlePipelineRun (US-007): use 'close' so all stdout/stderr
    // data events have been emitted before we flush the pending buffer.
    await new Promise<void>((resolve) => {
      let capturedCode: number | null = null;
      child.on('exit', (code) => { capturedCode = code; });

      child.on('close', async () => {
        // Flush bytes < CHUNK_SIZE remaining in the buffer before marking done
        await outputBuffer.close();

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

        // Clean up the temporary retry spec file
        try { fs.unlinkSync(retrySpecPath); } catch { /* best-effort */ }

        resolve();
      });

      child.on('error', async (err) => {
        logger.error({ err, runId }, '[worker] retry execution-engine spawn error');
        await outputBuffer.close();
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

        try { fs.unlinkSync(retrySpecPath); } catch { /* best-effort */ }

        resolve();
      });
    });
  }
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
    const { id: runId, pid, workspace_id: workspaceId } = run;

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

  // ── Case A: pipeline_runs stuck in running/queued with no live pgboss job ──

  type StuckRunRow = {
    id: number;
    workspace_id: number | string;
  };

  let stuckRuns: StuckRunRow[];
  try {
    stuckRuns = await query<StuckRunRow>(
      `SELECT pr.id, pr.workspace_id
       FROM pipeline_runs pr
       WHERE pr.status IN ('running', 'queued')
         AND NOT EXISTS (
           SELECT 1 FROM pgboss.job j
           WHERE j.name IN ('pipeline:run', 'pipeline:retry')
             AND j.state IN ('created', 'active', 'retry')
             AND (j.data->>'runId')::int = pr.id
         )`,
    );
  } catch (err) {
    logger.warn({ err }, '[worker] reconcileState — Case A query failed, skipping');
    stuckRuns = [];
  }

  for (const run of stuckRuns) {
    logger.warn(
      { runId: run.id, currentStatus: 'running/queued' },
      '[worker] reconcileState — Case A: pipeline_run has no live pgboss job, marking failed',
    );

    try {
      await execute(
        `UPDATE pipeline_runs
         SET status = 'failed', finished_at = NOW()
         WHERE id = $1 AND status IN ('running', 'queued')`,
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
      `SELECT j.id, j.name, (j.data->>'runId')::int AS run_id
       FROM pgboss.job j
       WHERE j.name IN ('pipeline:run', 'pipeline:retry')
         AND j.state = 'active'
         AND (j.data->>'runId') IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM pipeline_runs pr
           WHERE pr.id = (j.data->>'runId')::int
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

// ── Worker settings (max_concurrent_runs) ───────────────────────────────

const DEFAULT_MAX_CONCURRENT_RUNS = 5;

/**
 * Fetch max_concurrent_runs from worker_settings table.
 * Falls back to RORCA_MAX_CONCURRENT_RUNS env var, then DEFAULT_MAX_CONCURRENT_RUNS.
 */
async function getMaxConcurrentRuns(): Promise<number> {
  try {
    const row = await queryOne<{ value: string }>(
      `SELECT value FROM worker_settings WHERE key = 'max_concurrent_runs'`,
    );
    if (row) {
      const parsed = parseInt(row.value, 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
  } catch (err) {
    logger.warn({ err }, '[worker] getMaxConcurrentRuns — DB query failed, using env/default');
  }
  return parseInt(process.env.RORCA_MAX_CONCURRENT_RUNS ?? String(DEFAULT_MAX_CONCURRENT_RUNS), 10);
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
    logger.info('[worker] pg-boss stopped cleanly — exiting');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, '[worker] error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('uncaughtException', (err) => {
  logger.error({ err }, '[worker] uncaughtException — triggering shutdown');
  void shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, '[worker] unhandledRejection — triggering shutdown');
  void shutdown('unhandledRejection');
});

// ── Singleton guard ──────────────────────────────────────────────────────
// Exported for testing. Prevents duplicate workers from competing for the
// same pg-boss queue, which causes orphan sweep / stale-job recovery to
// kill each other's engine processes (the root cause of runs dying mid-story).

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
      // Check if any of them are actually alive (PID check)
      for (const w of liveWorkers) {
        try {
          process.kill(w.pid, 0); // throws ESRCH if dead
          logger.error(
            { existingWorkerId: w.worker_id, existingPid: w.pid, lastSeen: w.last_seen },
            '[worker] SINGLETON GUARD — another worker is alive. Exiting to prevent duplicate workers.',
          );
          process.exit(0);
        } catch {
          // PID is dead — stale heartbeat. Clean it up and continue.
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
  let currentMaxConcurrent = await getMaxConcurrentRuns();
  logger.info({ maxConcurrent: currentMaxConcurrent }, '[worker] initial max_concurrent_runs');

  await boss.work('pipeline:run', { batchSize: currentMaxConcurrent }, handlePipelineRun);
  await boss.work('pipeline:retry', { batchSize: currentMaxConcurrent }, handlePipelineRetry);
  await boss.work('pipeline:cancel', { batchSize: 10 }, handlePipelineCancel);
  await boss.work('pipeline:merge', { batchSize: 1 }, handlePipelineMerge);

  // Poll worker_settings every WORKER_SETTINGS_POLL_MS (default 30s).
  // If max_concurrent_runs changed, hot-reload the pipeline:run and pipeline:retry subscriptions.
  const WORKER_SETTINGS_POLL_MS = parseInt(process.env.WORKER_SETTINGS_POLL_MS ?? '30000', 10);

  settingsPollIntervalId = setInterval(() => {
    void (async () => {
      if (stopping) return;
      try {
        const newMax = await getMaxConcurrentRuns();
        if (newMax !== currentMaxConcurrent) {
          logger.info(
            { from: currentMaxConcurrent, to: newMax },
            `[worker] max_concurrent_runs changed ${currentMaxConcurrent} → ${newMax}, reloading work subscription`,
          );

          // Stop current subscriptions gracefully (pg-boss drains in-flight batch
          // before removing the subscription — in-flight jobs are NOT interrupted).
          await boss.offWork('pipeline:run');
          await boss.offWork('pipeline:retry');

          currentMaxConcurrent = newMax;

          // Re-register with updated batchSize.
          await boss.work('pipeline:run', { batchSize: currentMaxConcurrent }, handlePipelineRun);
          await boss.work('pipeline:retry', { batchSize: currentMaxConcurrent }, handlePipelineRetry);

          logger.info({ maxConcurrent: currentMaxConcurrent }, '[worker] work subscription reloaded successfully');
        }
      } catch (err) {
        logger.warn({ err }, '[worker] settings poll: failed to check/reload max_concurrent_runs');
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
