/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * run-failure-watchdog.ts — independent run-failure watchdog.
 *
 * Survives worker death by living in the API server process (the control
 * plane that outlives every worker). On an interval it:
 *
 *   1. Detects a stale or missing worker heartbeat and restarts the worker —
 *      only when the heartbeating pid is no longer alive, so a hung-but-live
 *      worker is never double-spawned.
 *   2. Re-drives runs that terminalized failed from worker-level interruption
 *      (engine_interrupted / worker_shutdown / engine_exit_incomplete without
 *      a closeout) through the exact two-phase governed retry API a human
 *      would use (preview → dispatch). The retry lineage contract bounds
 *      redrives: retry-of-retry is refused by the API itself.
 *   3. Escalates everything else with a WAL event and an exact operator
 *      action (governed approval required, dirty worktree, foreign failure).
 *
 * Deterministic, bounded, no LLM. Single-flight via a PostgreSQL advisory
 * lock so only one watchdog instance sweeps at a time across restarts.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';
import { query, queryOne } from '../db/index';
import { logger } from './logger';
import {
  getLatestWorkerHeartbeat,
  isWorkerHeartbeatStale,
} from './worker-heartbeat';

// ─── Constants ──────────────────────────────────────────────────────────────

const WATCHDOG_LOCK_KEY = 'rorca.run-failure-watchdog';

/** Minimum gap between watchdog-initiated worker restarts. */
const WORKER_RESTART_COOLDOWN_MS = 5 * 60_000;

/** Only re-drive runs that failed within this window (no archaeology). */
const REDRIVE_WINDOW_MS = 30 * 60_000;

/** Failure reasons attributable to worker/interruption, never to story work. */
const AUTO_REDRIVE_REASONS = new Set([
  'engine_interrupted',
  'worker_shutdown',
  'engine_exit_incomplete',
]);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RunFailureWatchdogOptions {
  /** Base URL of this API server (self-HTTP for governed retry calls). */
  apiBaseUrl: string;
  /** Backend root containing node_modules/.bin/tsx and src/worker.ts. */
  backendRoot: string;
  intervalMs?: number;
  /** Spawn a replacement worker on stale/missing heartbeat. Default true. */
  autoRestartWorker?: boolean;
  maxRedrivesPerSweep?: number;
  /** Log intended actions without mutating anything. */
  dryRun?: boolean;
  now?: () => number;
}

export interface RunFailureWatchdogHandle {
  stop(): void;
}

// ─── State ──────────────────────────────────────────────────────────────────

let lastWorkerRestartAt = 0;

// ─── Helpers ────────────────────────────────────────────────────────────────

function processIsAlive(pid: number | null | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function emitWatchdogWal(eventType: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await query(
      `INSERT INTO wal_events (event_type, workspace_id, spec_id, actor, payload)
       VALUES ($1, NULL, NULL, $2, $3)`,
      [eventType, 'run-failure-watchdog', JSON.stringify({ ...payload, watchedAt: new Date().toISOString() })],
    );
  } catch (error) {
    logger.error({ err: error, eventType }, '[watchdog] WAL emit failed');
  }
}

// ─── Worker heartbeat detection + restart ───────────────────────────────────

async function detectAndRestartWorker(opts: RunFailureWatchdogOptions): Promise<void> {
  if (!opts.autoRestartWorker) return;

  const heartbeat = await getLatestWorkerHeartbeat();
  if (heartbeat && !isWorkerHeartbeatStale(heartbeat.last_seen, opts.now?.() ?? Date.now())) {
    return; // healthy
  }

  if (heartbeat && processIsAlive(heartbeat.pid)) {
    logger.warn({ pid: heartbeat.pid }, '[watchdog] Worker heartbeat stale but pid alive — hung worker, not restarting');
    return;
  }

  const now = opts.now?.() ?? Date.now();
  if (now - lastWorkerRestartAt < WORKER_RESTART_COOLDOWN_MS) return;
  lastWorkerRestartAt = now;

  logger.warn(
    { previousPid: heartbeat?.pid ?? null, reason: heartbeat ? 'stale_heartbeat' : 'missing_heartbeat' },
    '[watchdog] Worker heartbeat is stale/missing — restarting worker',
  );

  if (opts.dryRun) {
    logger.info('[watchdog] [dry-run] would restart worker');
    await emitWatchdogWal('watchdog_worker_restarted', {
      workerPid: null,
      previousPid: heartbeat?.pid ?? null,
      reason: heartbeat ? 'stale_heartbeat' : 'missing_heartbeat',
      dryRun: true,
    });
    return;
  }

  // A source checkout restarts the worker through tsx. A packaged binary has no
  // node_modules or TypeScript sources, so it re-executes itself and uses the
  // `worker` subcommand instead of silently failing to spawn.
  const tsxBin = path.join(opts.backendRoot, 'node_modules', '.bin', 'tsx');
  const workerArgs = existsSync(tsxBin) ? [tsxBin, 'src/worker.ts'] : ['worker'];
  // In a packaged binary `backendRoot` is the build machine's source path, which
  // does not exist on the user's machine; spawning with that cwd fails ENOENT.
  const workerCwd = existsSync(opts.backendRoot) ? opts.backendRoot : process.cwd();
  const child = spawn(process.execPath, workerArgs, {
    cwd: workerCwd,
    env: process.env,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  await emitWatchdogWal('watchdog_worker_restarted', {
    workerPid: child.pid ?? null,
    previousPid: heartbeat?.pid ?? null,
    reason: heartbeat ? 'stale_heartbeat' : 'missing_heartbeat',
  });
  logger.info({ pid: child.pid }, '[watchdog] Restarted worker');
}

// ─── Failed-run re-drive ────────────────────────────────────────────────────

async function classifyRunFailure(runId: number): Promise<{ autoRedrive: boolean; reasons: string[] }> {
  const rows = await query<{ reason: string | null }>(
    `SELECT DISTINCT reason FROM story_results WHERE run_id = $1`,
    [runId],
  );
  const reasons = rows.map((row) => row.reason).filter((reason): reason is string => Boolean(reason));
  if (reasons.length === 0) return { autoRedrive: false, reasons: [] };
  return { autoRedrive: reasons.every((reason) => AUTO_REDRIVE_REASONS.has(reason)), reasons };
}

async function escalate(opts: RunFailureWatchdogOptions, runId: number, reasonCode: string, detail: string): Promise<void> {
  logger.warn({ runId, reasonCode, detail }, '[watchdog] Escalating run');
  await emitWatchdogWal('watchdog_escalated', { runId, reasonCode, detail });
}

async function attemptRedrive(opts: RunFailureWatchdogOptions, runId: number): Promise<boolean> {
  const base = opts.apiBaseUrl;
  const headers = { 'Content-Type': 'application/json' };
  try {
    // Phase 1: governed retry preview (read-only).
    const previewResponse = await fetch(`${base}/api/pipeline/runs/${runId}/retry`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    const preview = (await previewResponse.json().catch(() => null)) as {
      ok?: boolean;
      preview?: {
        requiresApproval?: boolean;
        previewHash?: string;
        [key: string]: unknown;
      } | null;
      worktreePreflight?: { ok?: boolean; classification?: string } | null;
      previewIdentity?: string;
      code?: string;
      error?: string;
    } | null;
    if (!preview?.ok || !preview.preview) {
      const code = preview?.code ?? preview?.error ?? `http_${previewResponse.status}`;
      logger.warn({ runId, code }, '[watchdog] Retry preview refused');
      await emitWatchdogWal('watchdog_redrive_denied', { runId, phase: 'preview', code });
      return false;
    }
    if (preview.preview.requiresApproval) {
      await escalate(opts, runId, 'governed_retry_requires_approval', 'Retry preview requires human approval; operator action needed');
      return false;
    }
    if (preview.worktreePreflight && preview.worktreePreflight.ok === false) {
      await escalate(opts, runId, 'dirty_worktree', `Worktree preflight requires operator action (${preview.worktreePreflight.classification})`);
      return false;
    }

    // Phase 2: dispatch the exact expiring packet (bounded by retry lineage).
    const dispatchResponse = await fetch(`${base}/api/pipeline/runs/${runId}/retry`, {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': `watchdog:${runId}:${opts.now?.() ?? Date.now()}` },
      body: JSON.stringify({
        previewHash: preview.preview.previewHash,
        approvedPreview: preview.preview,
        previewIdentity: preview.previewIdentity,
      }),
    });
    const outcome = (await dispatchResponse.json().catch(() => null)) as {
      ok?: boolean;
      code?: string;
      error?: string;
    } | null;
    if (!dispatchResponse.ok || !outcome?.ok) {
      const code = outcome?.code ?? outcome?.error ?? `http_${dispatchResponse.status}`;
      await escalate(opts, runId, 'redrive_dispatch_denied', String(code));
      return false;
    }
    logger.info({ runId }, '[watchdog] Re-drove interrupted run through governed retry');
    await emitWatchdogWal('watchdog_run_redriven', { runId });
    return true;
  } catch (error) {
    logger.error({ err: error, runId }, '[watchdog] Re-drive attempt failed');
    return false;
  }
}

async function redriveFailedRuns(opts: RunFailureWatchdogOptions): Promise<void> {
  const since = new Date((opts.now?.() ?? Date.now()) - REDRIVE_WINDOW_MS).toISOString();
  const failed = await query<{ id: number; spec_path: string }>(
    `SELECT id, spec_path FROM pipeline_runs
      WHERE status = 'failed' AND finished_at >= $1
      ORDER BY finished_at DESC LIMIT 50`,
    [since],
  );
  if (failed.length === 0) return;

  let redriven = 0;
  for (const run of failed) {
    if (redriven >= (opts.maxRedrivesPerSweep ?? 4)) break;
    const { autoRedrive, reasons } = await classifyRunFailure(run.id);
    if (!autoRedrive) {
      if (reasons.length > 0) {
        await escalate(opts, run.id, 'non_auto_redrive_failure', reasons.join(', '));
      }
      continue;
    }
    if (await attemptRedrive(opts, run.id)) redriven += 1;
  }
}

// ─── Sweep ──────────────────────────────────────────────────────────────────

async function sweepWatchdog(opts: RunFailureWatchdogOptions): Promise<void> {
  const lock = await queryOne<{ ok: boolean }>(
    `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok`,
    [WATCHDOG_LOCK_KEY],
  );
  if (!lock?.ok) {
    logger.debug('[watchdog] Advisory lock held by another instance — skipping sweep');
    return;
  }
  try {
    await detectAndRestartWorker(opts);
    await redriveFailedRuns(opts);
  } finally {
    await query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [WATCHDOG_LOCK_KEY]).catch(() => undefined);
  }
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

/**
 * Start the run-failure watchdog loop. The first sweep runs immediately;
 * the timer is unref'd so it never holds the process open.
 */
export function startRunFailureWatchdog(opts: RunFailureWatchdogOptions): RunFailureWatchdogHandle {
  const intervalMs = opts.intervalMs ?? 30_000;
  const timer = setInterval(() => {
    void sweepWatchdog(opts).catch((error) => logger.error({ err: error }, '[watchdog] Sweep failed'));
  }, intervalMs);
  timer.unref?.();

  void sweepWatchdog(opts).catch((error) => logger.error({ err: error }, '[watchdog] Initial sweep failed'));

  return { stop: () => clearInterval(timer) };
}

/**
 * Build watchdog options from the environment and start it. Returns null when
 * disabled (RORCA_RUN_WATCHDOG_DISABLED=1 or test env). Intended for the API
 * server boot path, where the watchdog outlives every worker.
 */
export function startRunFailureWatchdogFromEnv(apiPort: number, backendRoot?: string): RunFailureWatchdogHandle | null {
  if (process.env.RORCA_RUN_WATCHDOG_DISABLED === '1' || process.env.NODE_ENV === 'test') return null;

  const resolvedBackendRoot = backendRoot ?? path.resolve(__dirname, '..', '..');
  return startRunFailureWatchdog({
    apiBaseUrl: `http://127.0.0.1:${apiPort}`,
    backendRoot: resolvedBackendRoot,
    intervalMs: Number(process.env.RORCA_RUN_WATCHDOG_INTERVAL_MS ?? 30_000),
    autoRestartWorker: process.env.RORCA_WORKER_AUTO_RESTART !== '0',
    maxRedrivesPerSweep: Number(process.env.RORCA_WATCHDOG_MAX_REDRIVES_PER_SWEEP ?? 4),
    dryRun: process.env.RORCA_RUN_WATCHDOG_DRY_RUN === '1',
  });
}
