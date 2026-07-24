/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

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
import { applySelectedDbModeEnvironment, formatDbModeBootstrapLog } from './lib/db-strategy';

const workerDbModeBootstrap = applySelectedDbModeEnvironment();
if (workerDbModeBootstrap.changed) {
  console.info(formatDbModeBootstrapLog(workerDbModeBootstrap));
}

// Mark this process as 'worker' so db/index.ts doesn't register its own
// SIGTERM handler — the worker manages pool teardown in its shutdown() function.
process.env.RORCA_PROCESS_ROLE = 'worker';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { spawn, execFileSync, execSync, type ChildProcess } from 'child_process';
import { advanceClaimedWaveDispatch, auditWaveProductionDecision, claimWaveProductionDispatch, revalidatePersistedWavePolicy } from './lib/wave-production-governance';
import PgBoss from 'pg-boss';
import {
  PipelineRunJobPayload,
  type PipelineRunJobPayloadType,
  PipelineRetryJobPayload,
  type PipelineRetryJobPayloadType,
  PipelineCancelJobPayload,
  PipelineMergeJobPayload,
} from './lib/pg-boss-schemas';

// Worker DB access intentionally uses the shared service-role pool helpers, not
// withUserClient(). This process runs with RORCA_PROCESS_ROLE=worker and spawns
// RORCA_PROCESS_ROLE=engine children to perform system-owned orchestration jobs,
// so it must bypass per-request JWT RLS scoping.
import { initDb, query, queryOne, execute, transaction, closePool } from './db/index';
import { initBoss, getBoss } from './lib/pg-boss';
import { getPgBossSchemaSql } from './lib/pg-boss-schema';
import { claimDispatchForWorker, recoverPendingDispatchPublications } from './lib/dispatch-publication';
import {
  quiesceCancellationProcesses,
  reconcilePendingCancellationRequests,
  releaseLaunchGateWithCancellationFence,
  terminalizeCanonicalCancellation,
  type CancellationProcessSnapshot,
} from './lib/pipeline-cancellation';
import { registerSchedulesWithBoss, checkAndFireDueSchedules } from './lib/scheduler';
import { registerSpecJobHandlers } from './lib/spec-job-worker';
import { registerHydrationWorker } from './lib/hydration-worker';
import { registerContextCaptureHandlers } from './lib/context-distillation';
import { logger } from './lib/logger';
import { broadcastAll } from './lib/sse-hub';
import {
  GITHUB_GOVERNING_WAL_EVENTS,
  persistTrustedWalEvent,
  relayTrustedWalEvent,
  relayUnacknowledgedTrustedRunEvents,
} from './lib/trusted-wal';
import { advanceQueue } from './lib/run-queue';
import { terminalizeFreshRunPreflightFailure } from './lib/worker-preflight-terminalization';
import { validateReusableWorktree } from './lib/worktree-freshness';
import { resolveExecutionEngineEntrypoint } from './lib/execution-engine-entrypoint';
import {
  fallbackReplayBlocksCompletion,
  replayFallbackResults,
  replayRetainedRunJournals,
} from './lib/fallback-replay';
import {
  assertRunSpecAuthorityProjection,
  deriveRunSpecPath,
} from './lib/run-spec-snapshot';
import {
  persistCanonicalStoryResult,
  recoverIntegratedValidatedStoryFinalizations,
  WORKER_RESULT_AUTHORITY,
} from './lib/story-result-persistence';
import {
  passRecoveryBlocksCompletion,
  recoverUnreleasedIntegratedPasses,
  type PassRecoveryResult,
} from './lib/story-pass-recovery';
import { compareRetryPlanToPreview, retryHash, verifyRetryPreview, type RetryPreviewPacket } from './lib/retry-governance';
import { deriveStoryContractRevision } from './lib/story-execution-packet';
import {
  governedRetryQueuePayloadHash,
  verifyGovernedRetryDispatchIdentity,
  type GovernedRetryDispatchIdentity,
} from './lib/governed-story-retry';
import {
  publishGovernedRetryDispatch,
  readGovernedRetryPublication,
  refusePublishedGovernedRetryBeforeClaim,
  terminalizeGovernedRetryRun,
  waitForGovernedRetryPublication,
} from './lib/governed-retry-publication';
import { tryGenerateLearnCloseoutCandidates } from './lib/learn-closeout';
import { resolveWorkspaceGitHubToken } from './lib/github-token-resolver';
import { isPtyTerminalMode } from './lib/terminal-mode';
import { finalizeActiveRunPtyAfterEngineExit } from './lib/run-pty-store';
import { transitionRunLifecycle } from './lib/run-lifecycle';
import { redactExecutionJobPayload, resolveExecutionSecrets } from './lib/execution-secret-references';
import { reconcilePendingCheckRunProjections } from './lib/check-run-poster';
import { inspectRunHostAuthority, type RunHostAuthority } from './lib/run-host-authority';
import { persistHostRunCloseout } from './lib/run-closeout-authority';
import { assertFrozenRunExecutionIdentity } from './lib/run-git-authority';
import { loadAndVerifyTaskManifestRunLineage } from './lib/task-manifest-run-lineage';
import {
  assertTaskManifestWorkerPayloadAuthority,
  taskManifestCommandGuardEnv,
} from './lib/task-manifest-worker-authority';
import { assertAutonomousExecutionBoundary } from './lib/autonomous-sandbox';
import { ensureAutonomousModelEgress } from './lib/autonomous-model-egress';
import {
  drainPendingRunReleases,
  prepareRunReleaseIntent,
  reconcilePendingRunReleases,
  reconcileRunReleaseIntent,
} from './lib/release-authority';
import {
  reconcilePendingAutonomousPrDeliveryMerges,
  registerAutonomousPrDeliveryWorker,
} from './lib/autonomous-pr-delivery';
import {
  currentWaveParallelPolicyEnvironment,
  enforceWaveDispatchConsistency,
  WaveParallelPolicyError,
  type WaveExecutionMode,
} from './lib/wave-parallel-policy';

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

function resolveExecutionEngineLauncher(entrypoint: { path: string; extension: '.js' | '.ts' }): { bin: string; args: string[] } {
  if (entrypoint.extension === '.js') {
    return { bin: process.execPath, args: [entrypoint.path] };
  }
  return { bin: findTsxBin(), args: [entrypoint.path] };
}

// Workflow/deployment dispatch is intentionally disabled for autonomous runs.

// ── Worker identity (stable for the lifetime of this process) ────────────────

const WORKER_ID: string = crypto.randomUUID();
const WORKER_HOSTNAME: string = os.hostname();
const WORKER_STARTED_AT: Date = new Date();

const HEARTBEAT_INTERVAL_MS = 30_000; // 30 s
const OPTIONAL_WORKER_MODE = process.env.RORCA_OPTIONAL_WORKER === 'true';

// ── Active process map (runId → ChildProcess) ────────────────────────────
// Declared early so writeHeartbeat() can read .size before activeProcesses
// is mutated by job handlers. Cleaned up when the process exits.

const activeProcesses = new Map<number, ChildProcess>();

// ── Cancelling runs set (runId) ───────────────────────────────────────────
// Tracks which runs are being intentionally cancelled so the exit handler
// writes status='cancelled' (not 'failed') and emits run_cancelled WAL event.

const cancellingRuns = new Set<number>();

/** Worker-only recovery seam: DB authority re-finalizes first; fallback bytes
 * remain proposals and can only recognize the resulting immutable duplicate. */
async function replayWorkerFallbackResults(cwd: string, workspaceId: string, runId: number) {
  await recoverIntegratedValidatedStoryFinalizations({ runId });
  return replayFallbackResults(cwd, workspaceId);
}

// ── Reconciliation error counter (updated by reconcileState) ─────────────────
// Reserved for worker health diagnostics.

let _lastReconciliationErrors = 0;

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
  storyId?: string | null,
): Promise<void> {
  try {
    const runId = Number(payload.run_id);
    if (GITHUB_GOVERNING_WAL_EVENTS.has(eventType)
      && Number.isSafeInteger(runId) && runId > 0) {
      const trusted = await persistTrustedWalEvent({
        eventType,
        workspaceId: String(workspaceId),
        runId,
        storyId: storyId ?? null,
        source: 'worker',
        payload,
      });
      await relayTrustedWalEvent(trusted.reference);
      return;
    }

    const walEvent = await queryOne<{
      id: number;
      ts: string;
      event_type: string;
      workspace_id: string | null;
      spec_id: string | null;
      story_id: string | null;
      actor: string | null;
      payload: string | Record<string, unknown> | null;
    }>(
      `INSERT INTO wal_events (event_type, workspace_id, story_id, payload) VALUES ($1, $2, $3, $4) RETURNING *`,
      [eventType, workspaceId, storyId ?? null, JSON.stringify(payload)],
    );

    if (walEvent) {
      broadcastAll({
        id: walEvent.id,
        ts: walEvent.ts,
        event_type: walEvent.event_type,
        workspace_id: walEvent.workspace_id,
        spec_id: walEvent.spec_id,
        story_id: walEvent.story_id,
        actor: walEvent.actor ?? '',
        payload: typeof walEvent.payload === 'string'
          ? walEvent.payload
          : walEvent.payload == null
            ? null
            : JSON.stringify(walEvent.payload),
      });
    }
  } catch (err) {
    logger.warn({ err, eventType }, '[worker] Failed to emit WAL event through /api/wal');
    if (GITHUB_GOVERNING_WAL_EVENTS.has(eventType)) throw err;
  }
}

async function enforceWorkerWavePolicy(input: {
  runId: number;
  workspaceId: string;
  rowParallelism: number | null;
  payloadMode: WaveExecutionMode;
  payloadParallelism: number;
  triggerOptions?: Record<string, unknown>;
  source: 'worker-run' | 'worker-retry';
  terminalizeRun?: boolean;
}): Promise<boolean> {
  try {
    enforceWaveDispatchConsistency({
      source: input.source,
      payloadMode: input.payloadMode,
      payloadParallelism: input.payloadParallelism,
      rowParallelism: input.rowParallelism,
      triggerOptions: input.triggerOptions,
      environment: currentWaveParallelPolicyEnvironment(),
    });
    return true;
  } catch (error) {
    if (!(error instanceof WaveParallelPolicyError)) throw error;
    logger.error({ runId: input.runId, policy: error.toJSON() }, '[worker] wave-parallel dispatch refused');
    if (input.terminalizeRun === false) return false;
    await execute(
      `UPDATE pipeline_runs SET status = 'failed', finished_at = NOW(), summary = 'wave_parallel_policy_denied' WHERE id = $1`,
      [input.runId],
    );
    await transitionRunLifecycle(input.runId, 'failed', {
      owner: input.source,
      process: 'wave_parallel_policy',
      reason: error.code,
    });
    await emitWalEvent('run_finished', input.workspaceId, {
      run_id: input.runId,
      status: 'failed',
      reason: 'wave_parallel_policy_denied',
      policy: error.toJSON(),
    });
    return false;
  }
}

async function synthesizeInterruptedStoryFailure(params: {
  runId: number;
  workspaceId: string | number;
  status: string;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  source: 'worker' | 'worker_retry';
}): Promise<void> {
  if (params.status === 'done' || params.status === 'cancelled') return;

  try {
    const active = await queryOne<{
      story_id: string | null;
      payload: Record<string, unknown> | string | null;
    }>(
      `SELECT story_id, payload
         FROM wal_events
        WHERE event_type = 'story_started'
          AND payload->>'run_id' = $1
        ORDER BY id DESC
        LIMIT 1`,
      [String(params.runId)],
    );
    const payload = typeof active?.payload === 'string'
      ? JSON.parse(active.payload) as Record<string, unknown>
      : active?.payload ?? {};
    let storyId = active?.story_id ?? (typeof payload.story_id === 'string' ? payload.story_id : null);
    if (!storyId) {
      // A child can fail after the launch gate but before emitting story_started.
      // Bind that transport failure to the first unresolved frozen story rather
      // than leaving the run unable to obtain exact host closeout authority.
      const unresolved = await queryOne<{ story_id: string }>(
        `SELECT candidate.story_id
           FROM pipeline_runs run
           CROSS JOIN LATERAL unnest(run.expected_story_ids) WITH ORDINALITY
             AS candidate(story_id, ordinal)
          WHERE run.id = $1
            AND NOT (candidate.story_id = ANY(COALESCE(run.excluded_story_ids, '{}'::text[])))
            AND NOT EXISTS (
              SELECT 1 FROM story_results result
               WHERE result.run_id = run.id AND result.story_id = candidate.story_id
                 AND result.result_provenance = 'host'
                 AND result.status IN ('pass', 'fail', 'timeout', 'skip')
            )
          ORDER BY candidate.ordinal
          LIMIT 1`,
        [params.runId],
      );
      storyId = unresolved?.story_id ?? null;
    }
    if (!storyId) return;

    const existing = await queryOne<{ id: number; status: string; result_provenance: string }>(
      `SELECT id, status, result_provenance
         FROM story_results
        WHERE run_id = $1 AND story_id = $2
        ORDER BY id DESC LIMIT 1`,
      [params.runId, storyId],
    );
    if (existing?.result_provenance === 'host' && existing.status !== 'retry') return;

    const reason = params.exitSignal === 'SIGTERM' || params.exitCode === 143
      ? 'engine_interrupted_sigterm'
      : 'engine_interrupted';
    const logPath = typeof payload.log_file === 'string' ? payload.log_file : null;

    await persistCanonicalStoryResult({
      runId: params.runId,
      storyId,
      status: 'fail',
      reason,
      logPath: logPath ?? undefined,
      idempotencyKey: `story-result:worker-interrupted:v1:${params.runId}:${storyId}:${reason}`,
      expectedWorkspaceId: String(params.workspaceId),
    }, WORKER_RESULT_AUTHORITY);

    await emitWalEvent('story_failed', params.workspaceId, {
      run_id: params.runId,
      story_id: storyId,
      reason,
      error_message: `Execution engine exited before posting a terminal story result (exitCode=${params.exitCode ?? 'null'}, signal=${params.exitSignal ?? 'null'}).`,
      infra_error: true,
      retry_consumed: false,
      source: params.source,
      ...(logPath ? { log_file: logPath } : {}),
    }, storyId);
  } catch (err) {
    logger.warn({ err, runId: params.runId }, '[worker] Failed to synthesize interrupted story failure');
    throw err;
  }
}

// Remote PR discovery/creation is release-authority owned; no gh CLI fallback.

// Final base integration is delegated to merge-handler.performMerge.

// ── Job handler: pipeline:run ─────────────────────────────────────────────

async function assertCurrentWaveRunDispatch(input: {
  runId: number;
  parallelism: number;
  payload: PipelineRunJobPayloadType;
}): Promise<import('./lib/wave-production-policy').WavePolicyEnvelope> {
  const currentWavePolicy = await revalidatePersistedWavePolicy({
    runId: input.runId,
    queueEnvelope: input.payload.wavePolicy,
  });
  if (currentWavePolicy.effective.parallelism !== Number(input.parallelism ?? 1)
    || input.payload.parallelism !== Number(input.parallelism ?? 1)
    || currentWavePolicy.effective.orchestrationMode !== (Number(input.parallelism ?? 1) > 1 ? 'wave-parallel' : 'sequential')) {
    throw new Error('[wave-production-policy] worker mode/parallelism differs from governed run evidence');
  }
  return currentWavePolicy;
}

async function cancellationProcessSnapshot(runId: number): Promise<CancellationProcessSnapshot> {
  const durable = await queryOne<{
    pid: number | null;
    pty_child_pid: number | null;
    pty_status: string | null;
  }>(
    `SELECT run.pid, pty.child_pid AS pty_child_pid, pty.status AS pty_status
       FROM pipeline_runs run
       LEFT JOIN LATERAL (
         SELECT child_pid, status FROM run_pty_sessions
          WHERE run_id = run.id ORDER BY updated_at DESC LIMIT 1
       ) pty ON TRUE
      WHERE run.id = $1`,
    [runId],
  );
  const activeChild = activeProcesses.get(runId);
  const child = activeChild && activeChild.exitCode === null && activeChild.signalCode === null
    ? activeChild
    : null;
  return {
    child,
    enginePid: durable?.pid ?? null,
    ptyPid: durable?.pty_status && ['starting', 'active'].includes(durable.pty_status)
      ? durable.pty_child_pid
      : null,
  };
}

async function finalizeFreshRunCancellation(runId: number, source: string): Promise<{
  outcome: string;
  quiescent: boolean;
}> {
  const run = await queryOne<{ status: string; workspace_id: string }>(
    'SELECT status, workspace_id FROM pipeline_runs WHERE id = $1', [runId],
  );
  if (!run) return { outcome: 'run_missing', quiescent: true };
  if (run.status === 'queued') {
    const terminal = await terminalizeCanonicalCancellation({ runId, source, processQuiescent: true });
    return { outcome: terminal.outcome, quiescent: true };
  }

  cancellingRuns.add(runId);
  const quiescence = await quiesceCancellationProcesses({
    read: () => cancellationProcessSnapshot(runId),
    signalPid: (pid, signal) => { try { process.kill(pid, signal); } catch { /* already exited */ } },
    signalPty: (pid, signal) => signalPtyProcessGroup(pid, signal),
    isPidAlive: (pid) => isProcessAlive(pid),
  });
  if (!quiescence.quiescent) {
    return { outcome: 'process_still_active', quiescent: false };
  }

  await synthesizeAllMissingFrozenStoryFailures(runId, run.workspace_id, 'operator_cancelled_before_or_during_launch');
  try {
    await persistHostRunCloseout({ runId, status: 'cancelled', terminalizeRun: true });
  } catch (error) {
    const current = await queryOne<{ status: string }>('SELECT status FROM pipeline_runs WHERE id = $1', [runId]);
    if (current?.status !== 'cancelled') throw error;
  }
  const terminal = await terminalizeCanonicalCancellation({ runId, source, processQuiescent: true });
  cancellingRuns.delete(runId);
  return { outcome: terminal.outcome, quiescent: true };
}

async function reconcilePendingFreshRunCancellations(limit = 100): Promise<{ scanned: number; pending: number }> {
  return reconcilePendingCancellationRequests({
    limit,
    reconcile: (runId) => finalizeFreshRunCancellation(runId, 'worker_cancellation_reconcile'),
  });
}

export async function handlePipelineRun(jobs: PgBoss.Job<Record<string, unknown>>[]): Promise<void> {
  // Process all jobs concurrently — batchSize controls how many are fetched per poll,
  // but each spawns an independent child process that should run in parallel.
  const outcomes = await Promise.allSettled(jobs.map(async (job) => {
    const jobId = job.id;
    logger.info({ jobId, data: redactExecutionJobPayload(job.data) }, '[worker] pipeline:run received');

    // 1. Validate payload via Zod
    const parsed = PipelineRunJobPayload.safeParse(job.data);
    if (!parsed.success) {
      logger.error({ jobId, errors: parsed.error.format() }, '[worker] pipeline:run invalid payload — failing job');
      throw new Error(`Invalid pipeline:run payload: ${parsed.error.message}`);
    }

    const payload: PipelineRunJobPayloadType = parsed.data;
    const {
      runId, specPath, runSpecPath, workspacePath, agent, model, worktreePath,
      executionManifestPath, envOverrides, secretReferences, startFromStoryId,
      specificStory, includeGraph, terminalMode, executionEnvironment,
      orchestrationMode, parallelism: payloadParallelism, triggerOptions,
      thinkingEnabled, thinkingBudget, effortLevel, reasoningEffort, commandDenylist,
    } = payload;

    // Application outbox authority is claimed before any workspace, policy,
    // filesystem, lifecycle, or process side effect. Duplicate/stale transport
    // deliveries are acknowledgements only and cannot terminalize a live owner.
    const publicationClaim = await claimDispatchForWorker({
      runId,
      bossJobId: jobId,
      payload: job.data,
      workerId: WORKER_ID,
    });
    if (!publicationClaim.claimed) {
      logger.info({ runId, jobId, reason: publicationClaim.reason }, '[worker] pipeline:run delivery did not acquire application publication authority');
      return;
    }

    // Local-user jobs belong to the signed local runner, never this remote worker.
    if (executionEnvironment !== 'remote-rorca') {
      logger.error({ jobId, runId, executionEnvironment }, '[worker] unsupported execution environment reached remote worker');
      await execute(
        `UPDATE pipeline_runs SET status = 'failed', finished_at = NOW(), summary = $2 WHERE id = $1`,
        [runId, `unsupported_execution_environment:${executionEnvironment}`],
      );
      return;
    }

    // Look up host-frozen execution identity before deriving a cwd or spawning.
    const runRow = await queryOne<{
      workspace_id: string;
      parallelism: number;
      branch_name: string | null;
      worktree_path: string | null;
      execution_workspace_path: string | null;
      execution_worktree_path: string | null;
      task_manifest_id: string | null;
      effective_options: unknown;
    }>(
      `SELECT workspace_id, parallelism, branch_name, worktree_path,
              execution_workspace_path, execution_worktree_path, task_manifest_id,
              effective_options
         FROM pipeline_runs WHERE id = $1`,
      [runId],
    );
    if (!runRow) {
      logger.error({ jobId, runId }, '[worker] pipeline_runs row not found — skipping');
      return;
    }
    const { workspace_id: workspaceId, parallelism } = runRow;
    if (!runRow.branch_name) throw new Error('Pipeline run has no frozen canonical branch');
    const cancellationRequested = await queryOne<{ run_id: number }>(
      'SELECT run_id FROM pipeline_run_cancellation_requests WHERE run_id = $1', [runId],
    );
    if (cancellationRequested) {
      logger.info({ runId }, '[worker] cancellation intent fenced dispatch before engine launch');
      await finalizeFreshRunCancellation(runId, 'worker_before_wave_claim');
      return;
    }
    if ((worktreePath ?? null) !== (runRow.worktree_path ?? null)) {
      throw new Error('Queue payload worktreePath differs from pipeline_runs.worktree_path');
    }
    const frozenExecution = assertFrozenRunExecutionIdentity({
      payloadWorkspacePath: workspacePath,
      payloadWorktreePath: worktreePath,
      frozenWorkspacePath: runRow.execution_workspace_path,
      frozenWorktreePath: runRow.execution_worktree_path,
    });
    const cwd = frozenExecution.worktreePath;
    if (runRow.task_manifest_id) {
      const lineage = await loadAndVerifyTaskManifestRunLineage(runId, frozenExecution.workspacePath);
      assertTaskManifestWorkerPayloadAuthority({
        payload: {
          manifestId: payload.manifestId,
          commandDenylist,
          safetyOptions: payload.safetyOptions,
          mergeStrategy: payload.mergeStrategy,
          autoMerge: payload.autoMerge,
        },
        lineage: {
          manifestId: lineage.lineage.manifestId,
          commandDenylist: lineage.manifest.policy.commandDenylist,
        },
        effectiveOptions: runRow.effective_options,
      });
    }
    if (!await enforceWorkerWavePolicy({
      runId,
      workspaceId,
      rowParallelism: parallelism,
      payloadMode: orchestrationMode,
      payloadParallelism,
      triggerOptions,
      source: 'worker-run',
    })) return;

    if (worktreePath) {
      const worktreeValidation = validateReusableWorktree({
        workspacePath,
        worktreePath,
        expectedBranchName: payload.branchName ?? null,
        expectedDirtyPaths: ['.gitignore'],
        allowRorcaRuntimeMetadata: true,
      });
      if (!worktreeValidation.ok) {
        logger.error(
          { runId, workspacePath, worktreePath, worktreeValidation },
          '[worker] refusing to execute run in stale or invalid reusable worktree',
        );
        // Throw into the shared fresh-run preflight terminalizer. Returning after
        // a direct status update would skip trusted closeout/outbox authority.
        throw new Error(`worktree_guard:${worktreeValidation.reason}`);
      }
    }

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

    // Fence before lifecycle, PR, hooks, sandbox, or process side effects. A
    // replayed queue payload cannot start under stale production authority.
    let claimedWavePolicy: import('./lib/wave-production-policy').WavePolicyEnvelope;
    try {
      claimedWavePolicy = await assertCurrentWaveRunDispatch({ runId, parallelism: Number(parallelism ?? 1), payload });
      const claim = await claimWaveProductionDispatch({ runId, owner: WORKER_ID, envelope: claimedWavePolicy });
      if (!claim.claimed) {
        if (claim.reason === 'cancellation_requested' || claim.reason === 'run_not_queued') {
          logger.info({ runId, reason: claim.reason }, '[worker] dispatch claim superseded without failure terminalization');
          return;
        }
        throw new Error(`[wave-production-policy] atomic dispatch claim denied: ${claim.reason}`);
      }
    } catch (error) {
      if (payload.wavePolicy) {
        await auditWaveProductionDecision({
          envelope: payload.wavePolicy,
          actor: WORKER_ID,
          rationale: `Worker dispatch denial: ${error instanceof Error ? error.message : 'policy_revalidation_failed'}`,
          eventType: 'deny',
          outcome: 'denied',
        }).catch(() => undefined);
      }
      // Throw into the shared fresh-run preflight terminalizer, which binds the
      // failure, transitions lifecycle, emits closeout/finished, and advances.
      throw error;
    }

    // Prove the mandatory process/filesystem/network boundary after policy
    // claim and before the run can become running.
    assertAutonomousExecutionBoundary({
      cwd,
      providerCapable: payload.safetyOptions.externalSend,
    });
    await ensureAutonomousModelEgress();

    // The atomic claim already moved queued -> starting and persisted owner,
    // fence and lease. Do not overwrite it with an unfenced lifecycle write.
    await emitWalEvent('run_starting', workspaceId, { run_id: runId, spec_path: specPath });

    // Pull requests are release projections, not progress indicators. The
    // worker creates/finalizes them only after frozen host release authority is
    // complete in the post-run routing block below.

    // 3. Build engine args
    const executionEngineEntrypoint = resolveExecutionEngineEntrypoint(__dirname);
    if (!executionEngineEntrypoint.exists) {
      throw new Error('No execution engine found — expected execution-engine.js or execution-engine.ts');
    }
    const engineLauncher = resolveExecutionEngineLauncher(executionEngineEntrypoint);
    const backendPort = process.env.PORT ?? '3030';
    // A worktree run owns its lifecycle state in the deterministic ignored
    // snapshot. Direct non-retry runs alone may use the canonical approved spec.
    const expectedRunSpecPath = deriveRunSpecPath({
      runId,
      sourceSpecPath: path.join(workspacePath, specPath),
      workspacePath,
      worktreePath,
    });
    if (path.resolve(runSpecPath) !== expectedRunSpecPath || !fs.existsSync(expectedRunSpecPath)) {
      throw new Error('Run spec path does not match the deterministic host-owned snapshot');
    }
    const engineSpecPath = expectedRunSpecPath;

    const engineArgs = [
      ...engineLauncher.args,
      '--json', engineSpecPath,
      '--cwd', cwd,
      '--run-id', String(runId),
      '--workspace-id', workspaceId,
      '--port', backendPort,
      '--parallelism', String(payloadParallelism),
      '--agent', agent,
      '--terminal-mode', terminalMode,
    ];
    if (model) {
      engineArgs.push('--model', model);
    }
    if (specificStory) {
      engineArgs.push('--story', specificStory);
    } else if (startFromStoryId) {
      engineArgs.push('--start-from', startFromStoryId);
    }
    // US-004: Pass worktree context to execution-engine so it can log worktree info
    // and perform engine-side auto-merge as a fallback.
    if (worktreePath) {
      engineArgs.push('--worktree-path', worktreePath);
    }
    engineArgs.push('--branch-name', runRow.branch_name);
    engineArgs.push('--workspace-path', workspacePath);
    if (includeGraph) {
      engineArgs.push('--include-graph');
    }
    if (executionManifestPath) {
      engineArgs.push('--execution-manifests', executionManifestPath);
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

    // 4. Spawn the trusted execution engine with host DB/result authority. It
    // inherits service credentials by design; model/tool subprocesses never do
    // and must cross autonomous-sandbox.ts's PID/mount/network boundary.
    // Strip the 4 Claude vars that must not propagate to nested invocations.
    const resolvedSecrets = await resolveExecutionSecrets(secretReferences);
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...resolvedSecrets,
      ...envOverrides,
      RORCA_PROCESS_ROLE: 'engine',
      RORCA_WORKSPACE_ID: workspaceId,
      RORCA_TERMINAL_MODE: terminalMode,
      RORCA_GOVERNED_WAVE_POLICY: JSON.stringify(claimedWavePolicy),
      ...taskManifestCommandGuardEnv(commandDenylist),
    };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.CLAUDE_AGENT_SDK_VERSION;
    delete env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING;
    delete env.RORCA_QUALIFICATION_TRUSTED_ISSUERS_JSON;
    delete env.RORCA_WAVE_PRODUCTION_ACTIVATION_KEY;

    logger.info({ runId, agent, model, cwd, executionEngine: executionEngineEntrypoint.path, executionEngineBin: engineLauncher.bin }, '[worker] Revalidating governed mode immediately before spawn');
    const cancellationImmediatelyBeforeSpawn = await queryOne<{ run_id: number }>(
      'SELECT run_id FROM pipeline_run_cancellation_requests WHERE run_id = $1', [runId],
    );
    if (cancellationImmediatelyBeforeSpawn) {
      logger.info({ runId }, '[worker] cancellation intent fenced the immediate pre-spawn barrier');
      await finalizeFreshRunCancellation(runId, 'worker_immediately_before_spawn');
      return;
    }
    try {
      const preSpawnWavePolicy = await assertCurrentWaveRunDispatch({ runId, parallelism: Number(parallelism ?? 1), payload });
      env.RORCA_GOVERNED_WAVE_POLICY = JSON.stringify(preSpawnWavePolicy);
    } catch (error) {
      if (payload.wavePolicy) {
        await auditWaveProductionDecision({
          envelope: payload.wavePolicy,
          actor: WORKER_ID,
          rationale: `Worker pre-spawn denial: ${error instanceof Error ? error.message : 'policy_revalidation_failed'}`,
          eventType: 'deny',
          outcome: 'denied',
        }).catch(() => undefined);
      }
      logger.error({ runId, error }, '[worker] governed pre-spawn policy denied execution');
      // Reject into the shared fresh-run terminalizer. It binds interrupted
      // story evidence, lifecycle, immutable closeout/outbox, and queue advance.
      throw new Error(`wave_policy_revalidation_denied:${error instanceof Error ? error.message : 'unknown'}`);
    }

    const launchGateToken = crypto.randomUUID();
    env.RORCA_ENGINE_START_GATE_TOKEN = launchGateToken;
    const child = spawn(engineLauncher.bin, engineArgs, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env,
    });

    // Persist a fenced launch generation before allowing the child to execute
    // agent work. A worker crash before release leaves only a bounded waiting
    // child, which exits without touching the repository.
    if (child.pid) {
      const pidPersisted = await execute(
        `UPDATE pipeline_runs SET pid = $1
          WHERE id = $2 AND dispatch_owner = $3 AND dispatch_fence = $4 AND status = 'starting'`,
        [child.pid, runId, WORKER_ID, claimedWavePolicy.fence],
      );
      if (pidPersisted.rowCount !== 1) {
        child.kill('SIGTERM');
        throw new Error('[wave-production-policy] launch PID lost its dispatch fence');
      }
    }
    activeProcesses.set(runId, child);

    // Install IPC ownership handlers before releasing the launch gate.
    child.on('message', async (msg: unknown) => {
      if (typeof msg !== 'object' || msg === null) return;
      const m = msg as Record<string, unknown>;

      if (m.type === 'pid' && typeof m.pid === 'number') {
        const enginePid = m.pid;
        logger.info({ runId, enginePid }, '[worker] Received inner engine PID via IPC — updating pipeline_runs.pid');
        try {
          await execute(
            `UPDATE pipeline_runs SET pid = $1
              WHERE id = $2 AND dispatch_owner = $3 AND dispatch_fence = $4
                AND status IN ('starting', 'running')`,
            [enginePid, runId, WORKER_ID, claimedWavePolicy.fence],
          );
        } catch (err) {
          logger.warn({ err, runId, enginePid }, '[worker] Failed to update pipeline_runs.pid with inner engine PID');
        }
      } else if (m.type === 'heartbeat') {
        try {
          await execute(
            `UPDATE pipeline_runs SET last_heartbeat = NOW()
              WHERE id = $1 AND dispatch_owner = $2 AND dispatch_fence = $3 AND status = 'running'`,
            [runId, WORKER_ID, claimedWavePolicy.fence],
          );
        } catch { /* non-fatal — next beat will retry */ }
      }
    });

    const advanced = await advanceClaimedWaveDispatch({
      runId,
      owner: WORKER_ID,
      fence: claimedWavePolicy.fence,
      lifecycle: isPtyTerminalMode(terminalMode) ? 'starting' : 'running',
    });
    if (!advanced) {
      child.kill('SIGTERM');
      const cancellation = await queryOne<{ run_id: number }>(
        'SELECT run_id FROM pipeline_run_cancellation_requests WHERE run_id = $1', [runId],
      );
      if (cancellation) {
        cancellingRuns.add(runId);
        logger.info({ runId }, '[worker] cancellation won before launch lifecycle advance');
        return;
      }
      throw new Error('[wave-production-policy] stale dispatch owner cannot advance lifecycle');
    }
    const launchRelease = await releaseLaunchGateWithCancellationFence({
      runId,
      owner: WORKER_ID,
      fence: claimedWavePolicy.fence,
      release: () => Boolean(child.send({ type: 'launch_start', token: launchGateToken })),
    });
    if (launchRelease !== 'released') {
      cancellingRuns.add(runId);
      child.kill('SIGTERM');
      if (launchRelease === 'cancellation_requested') {
        logger.info({ runId }, '[worker] cancellation won after spawn registration and before launch-gate release');
        return;
      }
      throw new Error(`[wave-production-policy] engine launch gate ${launchRelease}`);
    }

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
    let capturedSignal: NodeJS.Signals | null = null;
    child.on('exit', (code, signal) => {
      capturedCode = code;
      capturedSignal = signal;
    });

    child.on('close', async () => {
      let semanticCloseoutCompleted = false;
      try {
        await flushPending();
        // The engine flushes its bounded telemetry queue before process close.
        // Cross host-attested result->file->ready crash boundaries around the
        // proposal-only fallback replay. Replay cannot mint host authority.
        let passRecovery: PassRecoveryResult | undefined;
        let passRecoveryError: unknown;
        try {
          passRecovery = await recoverUnreleasedIntegratedPasses({ runId });
        } catch (error) {
          passRecoveryError = error;
          logger.error({ error, runId }, '[worker] Integrated pass refinalization failed before fallback replay');
        }
        const fallbackReplay = await replayWorkerFallbackResults(cwd, String(workspaceId), runId);
        try {
          passRecovery = await recoverUnreleasedIntegratedPasses({ runId });
          passRecoveryError = undefined;
        } catch (error) {
          passRecoveryError = error;
          logger.error({ error, runId }, '[worker] Integrated pass refinalization failed after fallback replay');
        }
        let trustedRelayError: unknown;
        try {
          await relayUnacknowledgedTrustedRunEvents(String(workspaceId), runId);
        } catch (error) {
          trustedRelayError = error;
          logger.error({ error, runId }, '[worker] Trusted WAL recovery failed — blocking terminal success');
        }

        const code = capturedCode;
        const signal = capturedSignal;
        activeProcesses.delete(runId);


        const wasCancelled = cancellingRuns.delete(runId);
        let hostAuthority: RunHostAuthority | null = null;
        let hostAuthorityError: unknown;
        try {
          hostAuthority = await inspectRunHostAuthority(runId);
          if (!hostAuthority) throw new Error('Frozen host run authority is unavailable');
          assertRunSpecAuthorityProjection({
            specPath: engineSpecPath,
            expectedStoryIds: hostAuthority.expectedStoryIds,
            excludedStoryIds: hostAuthority.excludedStoryIds,
            authoritativePassedStoryIds: hostAuthority.authoritativePassedStoryIds,
          });
          if (hostAuthority.invalidReason) throw new Error(hostAuthority.invalidReason);
        } catch (error) {
          hostAuthorityError = error;
          logger.error({ error, runId }, '[worker] Host result/spec/branch authority validation failed');
        }
        const criticalRecoveryBlocked = fallbackReplayBlocksCompletion(fallbackReplay)
          || Boolean(passRecoveryError)
          || (passRecovery ? passRecoveryBlocksCompletion(passRecovery) : false)
          || Boolean(trustedRelayError)
          || Boolean(hostAuthorityError);
        const hostSuccess = hostAuthority?.releaseEligible === true;
        let status = wasCancelled
          ? 'cancelled'
          : (code === 0 && !signal && !criticalRecoveryBlocked && hostSuccess ? 'done' : 'failed');
        if (!wasCancelled && (criticalRecoveryBlocked || !hostSuccess)) {
          logger.error({ runId, passRecovery, passRecoveryError, fallbackReplay, trustedRelayError, hostAuthority, hostAuthorityError }, '[worker] Frozen host authority incomplete — blocking terminal success and release');
        }
        if (status === 'done') {
          const storyCheck = await queryOne<{ total: string; skipped: string }>(
            `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'skip') AS skipped FROM story_results WHERE run_id = $1`,
            [runId],
          );
          if (storyCheck && Number(storyCheck.total) > 0 && storyCheck.total === storyCheck.skipped) {
            status = 'failed';
            logger.warn({ runId }, '[worker] All stories skipped — refusing successful closeout');
          }
        }

        logger.info({ runId, code, signal, status, wasCancelled }, '[worker] execution-engine exited');
        await finalizeActiveRunPtyAfterEngineExit(
          runId,
          wasCancelled ? 'killed' : status === 'done' ? 'exited' : 'failed',
          code,
          signal,
        );
        await transitionRunLifecycle(runId, wasCancelled ? 'cancelled' : 'validating', {
          owner: 'worker', process: 'exited', exitCode: code, exitSignal: signal,
          semantic: 'engine_exit_observed',
        });

        await synthesizeInterruptedStoryFailure({
          runId,
          workspaceId,
          status,
          exitCode: code,
          exitSignal: signal,
          source: 'worker',
        });

        // Process exit is transport evidence only. Completion subscribers must
        // wait for the durable release/semantic-closeout seam below.
        await emitWalEvent('run_process_finished', workspaceId, {
          run_id: runId,
          status,
          exit_code: code,
          exit_signal: signal,
          source: 'worker',
        });

        // Successful runs cross one durable host release/terminal intent before
        // any public done state or external effect. Failures/cancellation retain
        // the semantic closeout path below and never prepare release authority.
        const hostReleaseOwned = status === 'done' && hostAuthority?.releaseEligible === true;
        if (hostReleaseOwned) {
          await persistHostRunCloseout({
            runId,
            status: 'done',
            terminalizeRun: false,
          });
          await prepareRunReleaseIntent({
            hostAuthority: hostAuthority!,
            mergeStrategy: payload.mergeStrategy ?? 'direct',
            autoMerge: payload.autoMerge === true,
            externalSend: payload.safetyOptions.externalSend === true,
          });
          const release = await reconcileRunReleaseIntent(runId, {
            agent: payload.agent,
            model: payload.model,
            thinkingEnabled: payload.thinkingEnabled,
            thinkingBudget: payload.thinkingBudget,
            effortLevel: payload.effortLevel,
            source: 'run',
          }, { ...resolvedSecrets, ...payload.envOverrides });
          status = release.status === 'completed' ? 'done' : 'release_pending';
        } else {
          await persistHostRunCloseout({
            runId,
            status: wasCancelled ? 'cancelled' : status === 'partial_failure' ? 'partial_failure' : 'failed',
            terminalizeRun: true,
          });
          semanticCloseoutCompleted = true;
        }

        const effectiveMergeStrategy = payload.mergeStrategy ?? 'direct';

        if (wasCancelled) {
          const cancellationTerminal = await terminalizeCanonicalCancellation({
            runId,
            source: 'worker_engine_close',
            processQuiescent: true,
          });
          if (!['terminalized', 'already_terminal'].includes(cancellationTerminal.outcome)) {
            throw new Error(`Cancellation closeout did not converge: ${cancellationTerminal.outcome}`);
          }
        } else {
          // External release routing is reachable only from frozen host result,
          // closeout, commit, attestation, accounting, released-outbox, branch,
          // terminal-HEAD, and exact file-projection authority. Spec flags are
          // presentation state and can never promote a rejected wave.
          if (status !== 'done' && hostAuthority?.releaseEligible === true) {
            logger.error(
              { runId, specPath, status, code, signal },
              '[worker] Refusing to promote non-zero engine closeout despite complete-looking host authority',
            );
          }
          if (!hostReleaseOwned) {
            logger.info({ runId, specPath, hostAuthority }, '[worker] Skipping release routing — frozen host release authority is incomplete');
          }
        }

        // release-authority owns successful exact-SHA closeout and its trusted
        // terminal outbox. Failure/cancellation still cross the same event order:
        // durable terminal row -> run_closeout -> trusted run_finished.
        if (!hostReleaseOwned) {
          // persistHostRunCloseout already committed the terminal run, canonical
          // closeout, and trusted run_finished outbox in one transaction.
          semanticCloseoutCompleted = true;
        } else if (status === 'done') {
          // reconcileRunReleaseIntent atomically committed public done with the
          // exact trusted terminal event ready, after durable run_closeout.
          semanticCloseoutCompleted = true;
        }

        if (status === 'done') {
          // Learn closeout is non-authoritative and cannot regress an already
          // durable release/terminal decision.
          try {
            const learnCloseout = await tryGenerateLearnCloseoutCandidates({
              workspaceId: String(workspaceId),
              runId,
              specId: path.basename(specPath, '.json'),
            });
            await emitWalEvent('lifecycle_changed', workspaceId, {
              workspaceId: String(workspaceId),
              specId: path.basename(specPath, '.json'),
              phaseId: 'learn',
              runId,
              changeKind: 'evidence_persisted',
              learnCloseoutStatus: learnCloseout?.status ?? 'blocked',
            });
          } catch (learnError) {
            logger.warn({ learnError, runId }, '[worker] non-authoritative learn closeout failed after terminal release');
          }
        }

        if (status !== 'release_pending') {
          await transitionRunLifecycle(runId, wasCancelled ? 'cancelled' : (status === 'done' ? 'finished' : 'failed'), {
            owner: 'worker', outcome: status, mergeGate: effectiveMergeStrategy,
          });
        }

        // Advance run queue — promote next queued run for this workspace
        advanceQueue(String(workspaceId)).catch(err =>
          logger.error({ err, runId, workspaceId }, '[worker] advanceQueue failed after run completion'),
        );
      } catch (err) {
        logger.error({ err, runId }, '[worker] close handler failed');
        if (!semanticCloseoutCompleted) {
          try {
            await execute(
              `UPDATE pipeline_runs SET status = 'failed', finished_at = NOW(), summary = 'worker_closeout_failed' WHERE id = $1`,
              [runId],
            );
            await transitionRunLifecycle(runId, 'failed', {
              owner: 'worker',
              outcome: 'failed',
              reason: 'worker_closeout_failed',
            });
            await persistHostRunCloseout({
              runId,
              status: 'failed',
              terminalizeRun: true,
            });
            semanticCloseoutCompleted = true;
          } catch (closeoutErr) {
            logger.error({ err: closeoutErr, runId }, '[worker] failed to persist fail-closed semantic closeout');
          }
          advanceQueue(String(workspaceId)).catch(queueErr =>
            logger.error({ err: queueErr, runId, workspaceId }, '[worker] advanceQueue failed after closeout failure'),
          );
        }
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
        await transitionRunLifecycle(runId, 'failed', {
          owner: 'worker', process: 'spawn_failed', error: (err as Error).message,
        });
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

  const unboundFailures: unknown[] = [];
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.status !== 'rejected') continue;
    const parsed = PipelineRunJobPayload.safeParse(jobs[index]?.data);
    if (!parsed.success) {
      unboundFailures.push(outcome.reason);
      continue;
    }
    const runId = parsed.data.runId;
    const reasonText = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
    logger.error({ runId, error: outcome.reason, reasonText }, '[worker] Fresh pipeline run rejected before spawn');
    const reason = /sandbox|isolation|bubblewrap/i.test(reasonText)
      ? 'autonomous_sandbox_preflight_failed'
      : /egress|broker/i.test(reasonText)
        ? 'autonomous_model_egress_preflight_failed'
        : 'worker_preflight_failed';
    await terminalizeFreshRunPreflightFailure(runId, reason, {
      bindFailure: (id, failureReason) => queryOne<{ workspace_id: string }>(`
        UPDATE pipeline_runs run
           SET status = 'failed', finished_at = NOW(), summary = $2
          FROM pipeline_dispatch_publications publication
         WHERE run.id = $1 AND publication.run_id = run.id
           AND (
             (run.status = 'queued' AND publication.state = 'claimed' AND publication.lease_owner = $3)
             OR (run.status = 'starting' AND run.dispatch_owner = $3)
           )
         RETURNING run.workspace_id
      `, [id, failureReason, WORKER_ID]),
      recordFailureAuthority: async (id, failureWorkspaceId, _failureReason) => {
        await synthesizeInterruptedStoryFailure({
          runId: id,
          workspaceId: failureWorkspaceId,
          status: 'failed',
          exitCode: null,
          exitSignal: null,
          source: 'worker',
        });
      },
      transition: transitionRunLifecycle,
      persistCloseout: (id) => persistHostRunCloseout({
        runId: id,
        status: 'failed',
        terminalizeRun: true,
      }),
      advance: advanceQueue,
    });
    logger.error({ runId, reason }, '[worker] Fresh pipeline run rejected before spawn and was terminalized');
  }
  if (unboundFailures.length > 0) {
    throw new AggregateError(unboundFailures, 'One or more pipeline:run jobs had invalid unbound payloads');
  }
}

// ── Job handler: pipeline:retry ───────────────────────────────────────────


export async function handlePipelineRetry(jobs: PgBoss.Job<Record<string, unknown>>[]): Promise<void> {
  const outcomes = await Promise.allSettled(jobs.map(async (job) => {
    const jobId = job.id;
    logger.info({ jobId, data: redactExecutionJobPayload(job.data) }, '[worker] pipeline:retry received');

    // 1. Validate payload via Zod
    const parsed = PipelineRetryJobPayload.safeParse(job.data);
    if (!parsed.success) {
      logger.error({ jobId, errors: parsed.error.format() }, '[worker] pipeline:retry invalid payload — failing job');
      throw new Error(`Invalid pipeline:retry payload: ${parsed.error.message}`);
    }

    const payload: PipelineRetryJobPayloadType = parsed.data;
    const {
      runId,
      originalRunId,
      storyIds: _storyIds,
      workspacePath,
      specPath,
      retrySpecPath,
      runSpecPath,
      agent,
      model,
      worktreePath,
      sequenceOffset,
      executionManifestPath,
      envOverrides,
      secretReferences,
      includeGraph,
      terminalMode: payloadTerminalMode,
      orchestrationMode,
      parallelism: payloadParallelism,
      triggerOptions,
      thinkingEnabled,
      thinkingBudget,
      effortLevel,
      reasoningEffort,
      previewHash,
      approvedPreview: approvedPreviewRaw,
      generatedPlanHash,
      taskManifestLineageHash,
      dispatchIdentity: dispatchIdentityRaw,
    } = payload;
    const approvedPreview = approvedPreviewRaw as unknown as RetryPreviewPacket;
    const dispatchIdentity = dispatchIdentityRaw as unknown as GovernedRetryDispatchIdentity;
    if (
      !verifyGovernedRetryDispatchIdentity(dispatchIdentity)
      || governedRetryQueuePayloadHash(payload as unknown as Record<string, unknown>) !== dispatchIdentity.queuePayloadHash
      || dispatchIdentity.queueName !== 'pipeline:retry'
      || dispatchIdentity.retryRunId !== runId
      || dispatchIdentity.originalRunId !== originalRunId
      || dispatchIdentity.approvedPreviewHash !== previewHash
      || dispatchIdentity.scopeHash !== payload.scopeHash
      || dispatchIdentity.taskManifestLineageHash !== taskManifestLineageHash
    ) {
      throw new Error('[governed-retry] queue payload identity is invalid or stale');
    }

    // 2. Load the complete DB-frozen workspace/worktree and governed retry identity before deriving cwd.
    const runRow = await queryOne<{
      workspace_id: string; parallelism: number; terminal_mode: string | null;
      branch_name: string | null; status: string; spec_path: string;
      worktree_path: string | null; execution_workspace_path: string | null;
      execution_worktree_path: string | null; retried_from_run_id: number | null; pid: number | null;
      task_manifest_id: string | null;
    }>(
      `SELECT workspace_id, parallelism, terminal_mode, branch_name, status, spec_path,
              worktree_path, execution_workspace_path, execution_worktree_path,
              retried_from_run_id, pid, task_manifest_id FROM pipeline_runs WHERE id = $1`,
      [runId],
    );
    if (!runRow) {
      logger.error({ jobId, runId }, '[worker] pipeline:retry run row not found — skipping');
      return;
    }
    const { workspace_id: workspaceId, parallelism, terminal_mode: terminalMode, branch_name: branchName } = runRow;
    if (!verifyRetryPreview(approvedPreview)) {
      throw new Error('[governed-retry] approved preview payload is invalid');
    }
    if ((worktreePath ?? null) !== (runRow.worktree_path ?? null)) {
      throw new Error('Retry payload worktreePath differs from pipeline_runs.worktree_path');
    }
    const frozenRetryExecution = assertFrozenRunExecutionIdentity({
      payloadWorkspacePath: workspacePath,
      payloadWorktreePath: worktreePath,
      frozenWorkspacePath: runRow.execution_workspace_path,
      frozenWorktreePath: runRow.execution_worktree_path,
    });
    const cwd = frozenRetryExecution.worktreePath;
    if (runRow.task_manifest_id) {
      const lineage = await loadAndVerifyTaskManifestRunLineage(runId, frozenRetryExecution.workspacePath);
      if (taskManifestLineageHash !== lineage.lineage.lineageIdentityHash) {
        throw new Error('[governed-retry] TaskManifest lineage changed before worker claim');
      }
      if (approvedPreview.options.safety.deploy !== false) {
        throw new Error('[governed-retry] TaskManifest retry cannot carry deploy authority');
      }
    } else if (taskManifestLineageHash !== null) {
      throw new Error('[governed-retry] non-TaskManifest retry cannot carry synthetic lineage authority');
    }
    const effectiveTerminalMode = terminalMode ?? payloadTerminalMode ?? 'ansi-html';
    if (runRow.status === 'release_pending') {
      await reconcileRunReleaseIntent(runId, {
        agent: approvedPreview.options.agent,
        model: approvedPreview.options.model,
        effortLevel: approvedPreview.options.effort && ['low', 'medium', 'high', 'max', 'xhigh'].includes(approvedPreview.options.effort)
          ? approvedPreview.options.effort as 'low' | 'medium' | 'high' | 'max' | 'xhigh'
          : undefined,
        source: 'manual-retry',
      });
      await advanceQueue(workspaceId);
      return;
    }
    if (['done', 'failed', 'partial_failure'].includes(runRow.status)) {
      // A batch-level pg-boss retry after terminal event persistence failed must
      // never execute the implementation engine again. Re-release terminal
      // intent from the durable run state instead.
      await emitWalEvent('run_finished', workspaceId, {
        run_id: runId,
        original_run_id: originalRunId,
        status: runRow.status,
        source: 'worker_retry_terminal_recovery',
      });
      await advanceQueue(workspaceId);
      return;
    }
    if (runRow.status === 'cancelled') {
      logger.info({ runId, previewHash }, '[worker] retry cancelled before dispatch start');
      return;
    }
    // pg-boss may deliver immediately after send, before the API request has
    // published its Rorca outbox. The exact worker delivery can complete that
    // publication transaction itself. If preparation is not yet recoverable,
    // wait briefly and let pg-boss retry without mutating the queued run.
    let publication = await publishGovernedRetryDispatch({
      previewHash,
      dispatchIdentityHash: dispatchIdentity.identityHash,
      retryRunId: runId,
      queuePayloadHash: dispatchIdentity.queuePayloadHash,
      bossJobId: jobId,
    });
    if (publication.outcome === 'pending') {
      const waited = await waitForGovernedRetryPublication({
        read: () => readGovernedRetryPublication({
          previewHash,
          dispatchIdentityHash: dispatchIdentity.identityHash,
          retryRunId: runId,
        }),
        attempts: 5,
        delayMs: 50,
      });
      publication = { outcome: waited.outcome, snapshot: waited.snapshot };
    }
    if (publication.outcome === 'cancelled' || publication.outcome === 'refused') {
      logger.info({ runId, previewHash, outcome: publication.outcome }, '[worker] retry publication terminalized before agent start');
      return;
    }
    if (publication.outcome !== 'published') {
      throw new Error('[governed-retry] durable publication is inconsistent; exact delivery will retry without failing the run');
    }
    const refuseBeforeClaim = async (reason: string): Promise<void> => {
      const refused = await refusePublishedGovernedRetryBeforeClaim({
        previewHash,
        dispatchIdentityHash: dispatchIdentity.identityHash,
        retryRunId: runId,
        workspaceId,
        reason,
      });
      logger.warn({ runId, previewHash, reason, refused }, '[worker] governed retry refused before agent claim');
    };

    if (Number(parallelism ?? 1) !== 1) {
      await refuseBeforeClaim('retry_wave_policy_not_explicitly_authorized');
      return;
    }
    if (
      workspaceId !== dispatchIdentity.workspaceId
      || path.basename(runRow.spec_path, '.json') !== dispatchIdentity.specId
      || Number(runRow.retried_from_run_id) !== originalRunId
      || workspacePath !== path.resolve(workspacePath)
      || specPath !== runRow.spec_path
    ) {
      await refuseBeforeClaim('retry_workspace_spec_run_lineage_changed');
      return;
    }
    const recoveryRevision = execFileSync('git', ['rev-parse', dispatchIdentity.recoveryRef], { cwd, encoding: 'utf8' }).trim();
    const currentRevision = execSync('git rev-parse HEAD', { cwd, encoding: 'utf8' }).trim();
    if (
      recoveryRevision !== dispatchIdentity.recoveryRefRevision
      || currentRevision !== dispatchIdentity.integratedRevision
      || currentRevision !== dispatchIdentity.baseRevision
    ) {
      await refuseBeforeClaim('retry_revision_changed_after_dispatch');
      return;
    }
    if (!await enforceWorkerWavePolicy({
      runId,
      workspaceId,
      rowParallelism: parallelism,
      payloadMode: orchestrationMode,
      payloadParallelism,
      triggerOptions,
      source: 'worker-retry',
      terminalizeRun: false,
    })) {
      await refuseBeforeClaim('retry_worker_wave_policy_denied');
      return;
    }
    const durableReplayState = await queryOne<{ state: string }>(
      `SELECT state FROM governed_retry_dispatches WHERE identity_hash = $1`,
      [dispatchIdentity.identityHash],
    );
    if (durableReplayState && ['committed', 'integrating', 'integrated_validated', 'finalized', 'failed', 'manual_review_required', 'cancelled'].includes(durableReplayState.state)) {
      logger.info({ jobId, runId, state: durableReplayState.state }, '[worker] retry delivery already crossed the agent boundary; replay is a no-op');
      return;
    }

    if (worktreePath) {
      const worktreeValidation = validateReusableWorktree({
        workspacePath,
        worktreePath,
        expectedBranchName: branchName,
        expectedDirtyPaths: [
          '.gitignore', '.rorca/progress', '.rorca/run-state.json', 'progress.txt',
        ],
        allowRorcaRuntimeMetadata: true,
      });
      if (!worktreeValidation.ok) {
        logger.error(
          { runId, originalRunId, workspacePath, worktreePath, worktreeValidation },
          '[worker] refusing to execute retry in stale or invalid reusable worktree',
        );
        await refuseBeforeClaim(`worktree_guard:${worktreeValidation.reason}`);
        return;
      }
    }

    // Re-read only the deterministic host-owned retry snapshot after queue
    // handoff and compare its executable plan before marking the run started.
    const expectedRetrySpecPath = deriveRunSpecPath({
      runId,
      sourceSpecPath: path.join(workspacePath, specPath),
      workspacePath,
      worktreePath,
      retry: true,
    });
    if (path.resolve(runSpecPath) !== expectedRetrySpecPath
      || path.resolve(retrySpecPath) !== expectedRetrySpecPath
      || !fs.existsSync(expectedRetrySpecPath)) {
      await refuseBeforeClaim('retry_spec_missing_or_path_authority_mismatch');
      return;
    }
    const actualRetrySpec = JSON.parse(fs.readFileSync(expectedRetrySpecPath, 'utf8')) as Record<string, unknown>;
    const sourceSpecAbsolutePath = path.join(workspacePath, specPath);
    if (!fs.existsSync(sourceSpecAbsolutePath)) {
      await refuseBeforeClaim('retry_approved_source_spec_missing');
      return;
    }
    const currentSourceSpec = JSON.parse(fs.readFileSync(sourceSpecAbsolutePath, 'utf8')) as Record<string, unknown>;
    if (deriveStoryContractRevision(currentSourceSpec) !== dispatchIdentity.specRevision) {
      await refuseBeforeClaim('retry_source_spec_revision_changed');
      return;
    }
    const planComparison = compareRetryPlanToPreview(actualRetrySpec, approvedPreview);
    if (!planComparison.matches || planComparison.scopeHash !== generatedPlanHash || retryHash(approvedPreview.scope.executable.map((entry) => entry.storyId)) !== payload.scopeHash) {
      const refusalEvidence = JSON.stringify({
        reason: 'worker_scope_mismatch', approvedScope: planComparison.approved,
        actualScope: planComparison.actual,
      });
      const refused = await transaction(async (client) => {
        const previewLock = await client.query<{ status: string }>(
          'SELECT status FROM pipeline_retry_previews WHERE preview_hash = $1 FOR UPDATE',
          [previewHash],
        );
        const dispatchLock = await client.query<{ state: string }>(
          'SELECT state FROM governed_retry_dispatches WHERE identity_hash = $1 FOR UPDATE',
          [dispatchIdentity.identityHash],
        );
        const runLock = await client.query<{ status: string }>(
          'SELECT status FROM pipeline_runs WHERE id = $1 FOR UPDATE',
          [runId],
        );
        if (
          previewLock.rows[0]?.status === 'cancelled'
          || dispatchLock.rows[0]?.state === 'cancelled'
          || runLock.rows[0]?.status === 'cancelled'
        ) return false;
        await client.query(
          `UPDATE governed_retry_story_attempts SET state = 'failed', failure_evidence = $2::jsonb
           WHERE dispatch_identity_hash = $1 AND state = 'pending'`,
          [dispatchIdentity.identityHash, refusalEvidence],
        );
        await client.query(
          `UPDATE governed_retry_dispatches SET state = 'failed', failure_evidence = $2::jsonb
           WHERE identity_hash = $1 AND state = 'dispatched'`,
          [dispatchIdentity.identityHash, refusalEvidence],
        );
        await client.query(
          `UPDATE pipeline_retry_previews
           SET status = 'refused', preparation_state = 'refused', refusal_reason = 'worker_scope_mismatch',
               preparation_owner = NULL, preparation_lease_expires_at = NULL
           WHERE preview_hash = $1 AND status = 'dispatched'`,
          [previewHash],
        );
        await client.query(
          `UPDATE pipeline_runs
           SET status = 'failed', finished_at = NOW(), summary = 'retry_scope_mismatch',
               lifecycle_status = 'failed', lifecycle_updated_at = NOW()
           WHERE id = $1 AND status = 'queued'`,
          [runId],
        );
        return true;
      });
      if (refused) {
        await emitWalEvent('retry_scope_mismatch', workspaceId, {
          run_id: runId,
          original_run_id: originalRunId,
          preview_hash: previewHash,
          approved_scope: planComparison.approved,
          actual_scope: planComparison.actual,
          reason: 'worker_scope_mismatch',
        });
      }
      return;
    }
    if (!executionManifestPath || !fs.existsSync(executionManifestPath)) {
      await refuseBeforeClaim('retry_execution_manifest_missing');
      return;
    }
    const manifestBundle = JSON.parse(fs.readFileSync(executionManifestPath, 'utf8')) as Array<{ manifestHash?: string }>;
    const manifestHash = retryHash(manifestBundle.map((manifest) => manifest.manifestHash).sort());
    if (manifestHash !== dispatchIdentity.executionManifestHash) {
      await refuseBeforeClaim('retry_execution_manifest_changed');
      return;
    }
    const persistedDispatch = await queryOne<{
      identity_hash: string; workspace_id: string; spec_id: string; spec_revision: string;
      retry_run_id: number; original_run_id: number; state: string; queue_payload_hash: string;
    }>(
      `SELECT identity_hash, workspace_id, spec_id, spec_revision, retry_run_id,
              original_run_id, state, queue_payload_hash
       FROM governed_retry_dispatches WHERE identity_hash = $1`,
      [dispatchIdentity.identityHash],
    );
    if (
      !persistedDispatch
      || persistedDispatch.workspace_id !== workspaceId
      || Number(persistedDispatch.retry_run_id) !== runId
      || Number(persistedDispatch.original_run_id) !== originalRunId
      || persistedDispatch.spec_id !== dispatchIdentity.specId
      || persistedDispatch.spec_revision !== dispatchIdentity.specRevision
      || persistedDispatch.queue_payload_hash !== dispatchIdentity.queuePayloadHash
    ) {
      await refuseBeforeClaim('retry_durable_dispatch_identity_inconsistent');
      return;
    }

    // One Rorca-owned lease linearizes duplicate pg-boss deliveries. A crashed
    // worker may be fenced only after expiry; a concurrent duplicate receives no
    // row and must not start an agent or clean resources.
    const leaseOwner = `${WORKER_ID}:${jobId}`;
    const claimed = await transaction(async (client) => {
      // Keep the same preview -> dispatch -> run lock order as cancellation.
      // Exactly one side can cross the queued cancellation/agent boundary.
      const previewLock = await client.query<{ status: string; preparation_state: string }>(
        `SELECT status, preparation_state FROM pipeline_retry_previews
         WHERE preview_hash = $1 FOR UPDATE`,
        [previewHash],
      );
      const dispatchLock = await client.query<{ state: string }>(
        `SELECT state FROM governed_retry_dispatches
         WHERE identity_hash = $1 FOR UPDATE`,
        [dispatchIdentity.identityHash],
      );
      const runLock = await client.query<{ status: string }>(
        `SELECT status FROM pipeline_runs WHERE id = $1 FOR UPDATE`,
        [runId],
      );
      if (
        previewLock.rows[0]?.status !== 'dispatched'
        || previewLock.rows[0]?.preparation_state !== 'published'
        || dispatchLock.rows[0]?.state === 'cancelled'
        || runLock.rows[0]?.status === 'cancelled'
      ) return undefined;
      const result = await client.query<{ fencing_token: string; state: string }>(
        `UPDATE governed_retry_dispatches
         SET state = CASE WHEN state = 'dispatched' THEN 'claimed' ELSE state END,
             fencing_token = CASE WHEN state = 'dispatched' THEN fencing_token ELSE fencing_token + 1 END,
             lease_owner = $2,
             lease_expires_at = NOW() + INTERVAL '5 minutes'
         WHERE identity_hash = $1
           AND (
             state = 'dispatched'
             OR (state IN ('claimed', 'executing') AND lease_expires_at <= NOW())
           )
         RETURNING fencing_token::text, state`,
        [dispatchIdentity.identityHash, leaseOwner],
      );
      return result.rows[0];
    });
    if (!claimed) {
      logger.info({ jobId, runId, identityHash: dispatchIdentity.identityHash }, '[worker] duplicate retry delivery fenced before agent start');
      return;
    }
    const fencingToken = Number(claimed.fencing_token);
    const executing = await execute(
      `UPDATE governed_retry_dispatches
       SET state = 'executing'
       WHERE identity_hash = $1 AND fencing_token = $2 AND lease_owner = $3
         AND state IN ('claimed', 'executing') AND cancellation_requested_at IS NULL`,
      [dispatchIdentity.identityHash, fencingToken, leaseOwner],
    );
    if (executing.rowCount !== 1) {
      await synthesizeAllMissingFrozenStoryFailures(runId, workspaceId, 'cancelled_before_engine_launch');
      const terminalized = await terminalizeGovernedRetryRun({
        runId,
        workspaceId,
        requestedTerminal: 'auto',
        reason: 'cancelled_before_engine_launch',
        source: 'worker_retry_prelaunch',
      });
      if (terminalized.outcome === 'terminalized' || terminalized.outcome === 'already_terminal') {
        await advanceQueue(workspaceId);
        return;
      }
      throw new Error(`[governed-retry] lease fence was lost before execution (${terminalized.outcome})`);
    }
    await execute(
      `UPDATE governed_retry_story_attempts SET state = 'executing'
       WHERE dispatch_identity_hash = $1 AND state = 'pending'`,
      [dispatchIdentity.identityHash],
    );

    if (runRow.status === 'running' && isProcessAlive(runRow.pid)) {
      // A worker restart loses its ChildProcess map, not ownership evidence. The
      // durable PID wins; hold the new fence and let the surviving engine finish.
      throw new Error('[governed-retry] prior fenced engine process is still alive; duplicate start refused');
    }
    const recoveredAttempts = await query<{
      story_id: string; attempt: number; result_status: string | null;
      integration_state: string | null; source_commit: string | null; resulting_head: string | null;
    }>(
      `SELECT attempt.story_id, attempt.attempt,
              (SELECT result.status FROM story_results result
               WHERE result.run_id = attempt.retry_run_id AND result.story_id = attempt.story_id
               ORDER BY result.id DESC LIMIT 1) AS result_status,
              ledger.state AS integration_state, ledger.source_commit, ledger.resulting_head
       FROM governed_retry_story_attempts attempt
       LEFT JOIN story_integration_ledger ledger
         ON ledger.run_id = attempt.retry_run_id
        AND ledger.story_id = attempt.story_id
        AND ledger.attempt = attempt.attempt
       WHERE attempt.dispatch_identity_hash = $1
       ORDER BY attempt.story_id`,
      [dispatchIdentity.identityHash],
    );
    const hasDurablePostAgentEvidence = recoveredAttempts.some((attempt) =>
      ['pass', 'fail', 'timeout'].includes(attempt.result_status ?? '') || attempt.integration_state !== null,
    );
    if (hasDurablePostAgentEvidence) {
      const allPastAgent = recoveredAttempts.length > 0 && recoveredAttempts.every((attempt) =>
        ['pass', 'fail', 'timeout'].includes(attempt.result_status ?? '') || attempt.integration_state !== null,
      );
      if (!allPastAgent) {
        throw new Error('[governed-retry] partial post-agent evidence requires manual review; duplicate agent start refused');
      }
      const allFinalized = recoveredAttempts.every((attempt) => attempt.integration_state === 'finalized');
      const anyFailed = recoveredAttempts.some((attempt) => ['fail', 'timeout'].includes(attempt.result_status ?? ''));
      await transaction(async (client) => {
        if (anyFailed) {
          const evidence = JSON.stringify({ reason: 'reconciled_terminal_failure', recoveredAttempts, fencingToken });
          await client.query(
            `UPDATE governed_retry_story_attempts SET state = 'failed', failure_evidence = $2::jsonb
             WHERE dispatch_identity_hash = $1 AND state = 'executing'`,
            [dispatchIdentity.identityHash, evidence],
          );
          await client.query(
            `UPDATE governed_retry_dispatches
             SET state = 'failed', failure_evidence = $4::jsonb, lease_owner = NULL, lease_expires_at = NULL
             WHERE identity_hash = $1 AND state = 'executing' AND fencing_token = $2 AND lease_owner = $3`,
            [dispatchIdentity.identityHash, fencingToken, leaseOwner, evidence],
          );
          return;
        }
        await client.query(
          `UPDATE governed_retry_story_attempts SET state = 'committed'
           WHERE dispatch_identity_hash = $1 AND state = 'executing'`,
          [dispatchIdentity.identityHash],
        );
        await client.query(
          `UPDATE governed_retry_dispatches
           SET state = 'committed', lease_owner = NULL, lease_expires_at = NULL
           WHERE identity_hash = $1 AND state = 'executing' AND fencing_token = $2 AND lease_owner = $3`,
          [dispatchIdentity.identityHash, fencingToken, leaseOwner],
        );
        if (!allFinalized) {
          const interruptedIntegration = recoveredAttempts.some((attempt) => attempt.integration_state !== null);
          if (interruptedIntegration) {
            const evidence = JSON.stringify({
              reason: 'post_git_evidence_not_finalized', recoveredAttempts, fencingToken,
              action: 'manual_review_required', patch_reapplied: false,
            });
            await client.query(
              `UPDATE governed_retry_story_attempts SET state = 'integrating'
               WHERE dispatch_identity_hash = $1 AND state = 'committed'`,
              [dispatchIdentity.identityHash],
            );
            await client.query(
              `UPDATE governed_retry_story_attempts SET state = 'manual_review_required', failure_evidence = $2::jsonb
               WHERE dispatch_identity_hash = $1 AND state = 'integrating'`,
              [dispatchIdentity.identityHash, evidence],
            );
            await client.query(
              `UPDATE governed_retry_dispatches SET state = 'integrating'
               WHERE identity_hash = $1 AND state = 'committed'`,
              [dispatchIdentity.identityHash],
            );
            await client.query(
              `UPDATE governed_retry_dispatches
               SET state = 'manual_review_required', failure_evidence = $2::jsonb
               WHERE identity_hash = $1 AND state = 'integrating'`,
              [dispatchIdentity.identityHash, evidence],
            );
          }
          return;
        }
        for (const attempt of recoveredAttempts) {
          const finalizationIdentity = retryHash({
            dispatchIdentity: dispatchIdentity.identityHash, storyId: attempt.story_id,
            attempt: attempt.attempt, resultingHead: attempt.resulting_head,
          });
          await client.query(
            `UPDATE governed_retry_story_attempts SET state = 'integrating'
             WHERE dispatch_identity_hash = $1 AND story_id = $2 AND state = 'committed'`,
            [dispatchIdentity.identityHash, attempt.story_id],
          );
          await client.query(
            `UPDATE governed_retry_story_attempts
             SET state = 'finalized', source_commit = $3, finalization_identity = $4
             WHERE dispatch_identity_hash = $1 AND story_id = $2 AND state = 'integrating'`,
            [dispatchIdentity.identityHash, attempt.story_id, attempt.source_commit, finalizationIdentity],
          );
        }
        await client.query(`UPDATE governed_retry_dispatches SET state = 'integrating' WHERE identity_hash = $1 AND state = 'committed'`, [dispatchIdentity.identityHash]);
        await client.query(`UPDATE governed_retry_dispatches SET state = 'integrated_validated' WHERE identity_hash = $1 AND state = 'integrating'`, [dispatchIdentity.identityHash]);
        await client.query(
          `UPDATE governed_retry_dispatches SET state = 'finalized', finalization_identity = $2
           WHERE identity_hash = $1 AND state = 'integrated_validated'`,
          [dispatchIdentity.identityHash, retryHash({ dispatchIdentity: dispatchIdentity.identityHash, recovered: true })],
        );
      });
      const recoveredStatus = anyFailed ? 'partial_failure' : allFinalized ? 'done' : 'partial_failure';
      const recoveredAuthority = await inspectRunHostAuthority(runId);
      if (recoveredStatus === 'done' && recoveredAuthority?.releaseEligible) {
        await persistHostRunCloseout({
          runId,
          status: 'done',
          governedRetryDispatchIdentity: dispatchIdentity.identityHash,
          terminalizeRun: false,
        });
        await prepareRunReleaseIntent({
          hostAuthority: recoveredAuthority,
          mergeStrategy: approvedPreview.options.merge.strategy,
          autoMerge: approvedPreview.options.merge.autoMerge,
          externalSend: approvedPreview.options.safety.externalSend,
        });
        await reconcileRunReleaseIntent(runId, {
          agent: approvedPreview.options.agent,
          model: approvedPreview.options.model,
          effortLevel: approvedPreview.options.effort && ['low', 'medium', 'high', 'max', 'xhigh'].includes(approvedPreview.options.effort)
            ? approvedPreview.options.effort as 'low' | 'medium' | 'high' | 'max' | 'xhigh'
            : undefined,
          source: 'manual-retry',
        }, { ...envOverrides });
      } else {
        await persistHostRunCloseout({
          runId,
          status: 'partial_failure',
          governedRetryDispatchIdentity: dispatchIdentity.identityHash,
          terminalizeRun: true,
        });
      }
      await execute(
        `UPDATE pipeline_runs SET summary = COALESCE(summary, 'retry_reconciled_without_duplicate_agent')
         WHERE id = $1`,
        [runId],
      );
      return;
    }

    // Retry runs use the same authoritative lifecycle as fresh runs.
    assertAutonomousExecutionBoundary({
      cwd,
      providerCapable: approvedPreview.options.safety.externalSend,
    });
    await ensureAutonomousModelEgress();

    await transitionRunLifecycle(runId, 'starting', {
      owner: 'worker_retry',
      transport: isPtyTerminalMode(effectiveTerminalMode) ? 'pty_pending' : 'pipe',
      process: 'launching',
    });

    // The run remains queued until the fenced child PID/token ownership is
    // durable. Publishing running state before that boundary would make the
    // launch gate impossible to claim and could strand the retry.

    // 4. Build execution-engine args with the temp retry spec
    const executionEngineEntrypoint = resolveExecutionEngineEntrypoint(__dirname);
    if (!executionEngineEntrypoint.exists) {
      throw new Error('No execution engine found — expected execution-engine.js or execution-engine.ts');
    }
    const engineLauncher = resolveExecutionEngineLauncher(executionEngineEntrypoint);
    const backendPort = process.env.PORT ?? '3030';

    // Recheck the snapshot immediately before spawn.
    if (!fs.existsSync(expectedRetrySpecPath)) {
      logger.error({ jobId, runId, retrySpecPath, runSpecPath }, '[worker] retry spec path is missing or not host-owned');
      await execute(
        `UPDATE pipeline_runs SET status = 'failed', finished_at = NOW() WHERE id = $1`,
        [runId],
      );
      await transitionRunLifecycle(runId, 'failed', {
        owner: 'worker_retry', process: 'retry_spec_missing', reason: 'retry_spec_missing',
      });
      await emitWalEvent('run_finished', workspaceId, { run_id: runId, status: 'failed', reason: 'retry_spec_missing' });
      return;
    }

    const engineArgs = [
      ...engineLauncher.args,
      '--json', expectedRetrySpecPath,
      '--cwd', cwd,
      '--run-id', String(runId),
      '--workspace-id', workspaceId,
      '--port', backendPort,
      '--parallelism', String(payloadParallelism),
      '--agent', agent,
      '--terminal-mode', effectiveTerminalMode,
    ];
    if (model) {
      engineArgs.push('--model', model);
    }
    if (includeGraph) {
      engineArgs.push('--include-graph');
    }
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
    if (executionManifestPath) {
      engineArgs.push('--execution-manifests', executionManifestPath);
    }
    if (!branchName) throw new Error('Retry run has no frozen canonical branch');
    engineArgs.push('--branch-name', branchName);
    engineArgs.push('--workspace-path', workspacePath);
    if (worktreePath) engineArgs.push('--worktree-path', worktreePath);

    // 5. Spawn the trusted execution engine with host DB/result authority. The
    // nested model/tool subprocess is separately namespace-contained. Strip
    // nested-Claude and production wave activation issuer secrets.
    const {
      CLAUDECODE: _a,
      CLAUDE_CODE_ENTRYPOINT: _b,
      CLAUDE_AGENT_SDK_VERSION: _c,
      CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: _d,
      RORCA_QUALIFICATION_TRUSTED_ISSUERS_JSON: _qualificationTrust,
      RORCA_WAVE_PRODUCTION_ACTIVATION_KEY: _activationKey,
      ...inheritedEnvRetry
    } = process.env as Record<string, string>;
    const resolvedSecrets = await resolveExecutionSecrets(secretReferences);
    const retryLaunchGateToken = crypto.randomUUID();
    const retryLaunchTokenHash = `sha256:${crypto.createHash('sha256').update(retryLaunchGateToken).digest('hex')}`;
    const env: Record<string, string> = {
      ...inheritedEnvRetry,
      ...resolvedSecrets,
      ...envOverrides,
      RORCA_PROCESS_ROLE: 'engine',
      RORCA_WORKSPACE_ID: workspaceId,
      RORCA_TERMINAL_MODE: effectiveTerminalMode,
      RORCA_ENGINE_START_GATE_TOKEN: retryLaunchGateToken,
    };
    delete env.RORCA_QUALIFICATION_TRUSTED_ISSUERS_JSON;
    delete env.RORCA_WAVE_PRODUCTION_ACTIVATION_KEY;

    logger.info({ runId, agent, model, cwd, executionEngine: executionEngineEntrypoint.path, executionEngineBin: engineLauncher.bin }, '[worker] Spawning execution-engine for retry');

    const child = spawn(engineLauncher.bin, engineArgs, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env,
    });
    activeProcesses.set(runId, child);

    // Install the fenced PID listener before releasing the child launch gate.
    child.on('message', async (msg: unknown) => {
      if (
        typeof msg === 'object' &&
        msg !== null &&
        (msg as Record<string, unknown>).type === 'pid' &&
        typeof (msg as Record<string, unknown>).pid === 'number'
      ) {
        const enginePid = (msg as Record<string, unknown>).pid as number;
        logger.info({ runId, enginePid }, '[worker] Received inner engine PID via IPC (retry) — updating fenced launch PID');
        try {
          await transaction(async client => {
            const dispatchUpdate = await client.query(
              `UPDATE governed_retry_dispatches SET launch_pid = $4
                WHERE identity_hash = $1 AND fencing_token = $2 AND lease_owner = $3
                  AND state = 'executing' AND launch_token_hash = $5`,
              [dispatchIdentity.identityHash, fencingToken, leaseOwner, enginePid, retryLaunchTokenHash],
            );
            if (dispatchUpdate.rowCount !== 1) throw new Error('retry launch fence was lost');
            await client.query(
              `UPDATE pipeline_runs SET pid = $1
                WHERE id = $2 AND status IN ('queued', 'running')`,
              [enginePid, runId],
            );
          });
        } catch (err) {
          logger.warn({ err, runId, enginePid }, '[worker] Failed to update fenced inner engine PID (retry)');
          try { child.kill('SIGTERM'); } catch { /* process already exited */ }
        }
      }
    });

    const launchPersisted = await transaction(async client => {
      const dispatchUpdate = await client.query(
        `UPDATE governed_retry_dispatches
            SET launch_token_hash = $4, launch_pid = $5
          WHERE identity_hash = $1 AND fencing_token = $2 AND lease_owner = $3
            AND state = 'executing'`,
        [dispatchIdentity.identityHash, fencingToken, leaseOwner, retryLaunchTokenHash, child.pid ?? null],
      );
      if (dispatchUpdate.rowCount !== 1) return false;
      const runUpdate = await client.query(
        `UPDATE pipeline_runs
            SET pid = $1, status = 'running', started_at = COALESCE(started_at, NOW()), worker_id = $3
          WHERE id = $2 AND status = 'queued'`,
        [child.pid ?? null, runId, WORKER_ID],
      );
      return runUpdate.rowCount === 1;
    });
    if (!launchPersisted) {
      child.kill('SIGTERM');
      throw new Error('[governed-retry] launch generation lost its fence before release');
    }
    if (!child.send({ type: 'launch_start', token: retryLaunchGateToken })) {
      child.kill('SIGTERM');
      throw new Error('[governed-retry] retry engine launch gate could not be released');
    }
    if (!isPtyTerminalMode(effectiveTerminalMode)) {
      await transitionRunLifecycle(runId, 'running', {
        owner: 'worker_retry', transport: 'pipe', process: 'spawned', semantic: 'engine_started',
      }).catch(err => logger.warn({ err, runId }, '[worker] retry lifecycle running projection failed after fenced launch'));
    }
    await emitWalEvent('run_started', workspaceId, {
      run_id: runId,
      original_run_id: originalRunId,
      source: 'worker_retry',
    });

    const leaseRenewal = setInterval(() => {
      void execute(
        `UPDATE governed_retry_dispatches
         SET lease_expires_at = NOW() + INTERVAL '5 minutes'
         WHERE identity_hash = $1 AND fencing_token = $2 AND lease_owner = $3 AND state = 'executing'`,
        [dispatchIdentity.identityHash, fencingToken, leaseOwner],
      ).then((result) => {
        if (result.rowCount !== 1) {
          logger.error({ runId, fencingToken }, '[worker] governed retry lease renewal lost its fence; terminating agent');
          try { child.kill('SIGTERM'); } catch { /* process already exited */ }
        }
      }).catch((error) => logger.error({ error, runId }, '[worker] governed retry lease renewal failed'));
    }, 60_000);
    leaseRenewal.unref?.();

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
    await new Promise<void>((resolve, reject) => {
      let capturedCode: number | null = null;
      child.on('exit', (code) => { capturedCode = code; });

      child.on('close', async () => {
        // Flush bytes < CHUNK_SIZE remaining in the buffer before marking done.
        await flushPending();
        let passRecovery: PassRecoveryResult | undefined;
        let passRecoveryError: unknown;
        try {
          passRecovery = await recoverUnreleasedIntegratedPasses({ runId });
        } catch (error) {
          passRecoveryError = error;
          logger.error({ error, runId }, '[worker] Integrated retry pass refinalization failed before fallback replay');
        }
        const fallbackReplay = await replayWorkerFallbackResults(cwd, String(workspaceId), runId);
        try {
          passRecovery = await recoverUnreleasedIntegratedPasses({ runId });
          passRecoveryError = undefined;
        } catch (error) {
          passRecoveryError = error;
          logger.error({ error, runId }, '[worker] Integrated retry pass refinalization failed after fallback replay');
        }
        let trustedRelayError: unknown;
        try {
          await relayUnacknowledgedTrustedRunEvents(String(workspaceId), runId);
        } catch (error) {
          trustedRelayError = error;
          logger.error({ error, runId }, '[worker] Trusted retry WAL recovery failed — blocking terminal success');
        }

        const code = capturedCode;
        activeProcesses.delete(runId);
        clearInterval(leaseRenewal);

        const wasCancelled = cancellingRuns.delete(runId);

        // Derive the retry run's terminal status from durable story results.
        // The temporary retry spec is run-owned; never mutate the approved source spec.
        let finalStatus: string;
        let remainingStoryIds: string[] = [];
        let retrySpecSyncSucceeded = false;
        let retryHostAuthority: RunHostAuthority | null = null;
        let retryHostAuthorityError: unknown;
        try {
          retryHostAuthority = await inspectRunHostAuthority(runId);
          if (!retryHostAuthority) throw new Error('Frozen retry host authority is unavailable');
          assertRunSpecAuthorityProjection({
            specPath: expectedRetrySpecPath,
            expectedStoryIds: retryHostAuthority.expectedStoryIds,
            excludedStoryIds: retryHostAuthority.excludedStoryIds,
            authoritativePassedStoryIds: retryHostAuthority.authoritativePassedStoryIds,
          });
          if (retryHostAuthority.invalidReason) throw new Error(retryHostAuthority.invalidReason);
        } catch (error) {
          retryHostAuthorityError = error;
          logger.error({ error, runId }, '[worker] Retry host result/spec/branch authority validation failed');
        }
        const retryRecoveryBlocked = fallbackReplayBlocksCompletion(fallbackReplay)
          || Boolean(passRecoveryError)
          || Boolean(passRecovery && passRecoveryBlocksCompletion(passRecovery))
          || Boolean(trustedRelayError)
          || Boolean(retryHostAuthorityError);
        if (wasCancelled) {
          finalStatus = 'cancelled';
        } else if (retryRecoveryBlocked) {
          finalStatus = 'failed';
          logger.error({ runId, passRecovery, passRecoveryError, fallbackReplay, trustedRelayError }, '[worker] Critical retry recovery incomplete — blocking terminal success');
        } else {
          try {
            const currentStories = await query<{ story_id: string; status: string }>(
              'SELECT story_id, status FROM story_results WHERE run_id = $1 ORDER BY id ASC',
              [runId],
            );
            const latest = new Map<string, string>();
            for (const s of currentStories) latest.set(s.story_id, s.status);
            const hasFailures = Array.from(latest.values()).some(st => st === 'fail');
            const expectedRetryStoryIds = dispatchIdentity.storyAttempts.map(attempt => attempt.storyId).sort();
            const actualRetryStoryIds = [...latest.keys()].sort();
            const atomicallyRecovered = fallbackReplay.atomicFinalizations > 0
              && JSON.stringify(actualRetryStoryIds) === JSON.stringify(expectedRetryStoryIds)
              && expectedRetryStoryIds.every(storyId => latest.get(storyId) === 'pass');
            finalStatus = !hasFailures
              && (code === 0 || atomicallyRecovered)
              && retryHostAuthority?.releaseEligible === true
              ? 'done'
              : 'partial_failure';
          } catch (error) {
            finalStatus = 'failed';
            logger.error({ error, runId }, '[worker] Retry durable result classification failed closed');
          }

          if (finalStatus === 'done') {
            // Approved source and prior pass evidence remain immutable here.
            remainingStoryIds = approvedPreview.scope.remaining.map((story) => story.storyId);
            retrySpecSyncSucceeded = true;
          }
        }

        let retryScopeComplete = !wasCancelled && finalStatus === 'done';
        let fullSpecComplete = retryScopeComplete && retrySpecSyncSucceeded && remainingStoryIds.length === 0;
        let retrySummary = retryScopeComplete && !fullSpecComplete
          ? `retry_scope_passed_remaining_stories:${remainingStoryIds.join(',')}`
          : null;

        logger.info({ runId, code, finalStatus, wasCancelled, retryScopeComplete, fullSpecComplete, remainingStoryIds }, '[worker] retry execution-engine exited');
        await finalizeActiveRunPtyAfterEngineExit(
          runId,
          wasCancelled ? 'killed' : finalStatus === 'done' ? 'exited' : 'failed',
          code,
          null,
        );
        if (!wasCancelled) {
          await transitionRunLifecycle(runId, 'validating', {
            owner: 'worker_retry', process: 'exited', exitCode: code, semantic: 'engine_exit_observed',
          });
        }

        await synthesizeInterruptedStoryFailure({
          runId,
          workspaceId,
          status: finalStatus,
          exitCode: code,
          exitSignal: null,
          source: 'worker_retry',
        });

        if (wasCancelled) {
          await synthesizeAllMissingFrozenStoryFailures(runId, workspaceId, 'operator_cancelled_running_retry');
          const terminalized = await terminalizeGovernedRetryRun({
            runId,
            workspaceId,
            requestedTerminal: 'cancelled',
            reason: 'operator_cancelled_running_retry',
            source: 'worker_retry_child_close',
          });
          if (terminalized.outcome !== 'terminalized' && terminalized.outcome !== 'already_terminal') {
            reject(new Error(`[governed-retry] cancellation closeout did not converge (${terminalized.outcome})`));
            return;
          }
          await advanceQueue(workspaceId).catch(qErr =>
            logger.error({ err: qErr, runId, workspaceId }, '[worker] advanceQueue failed after retry cancellation'));
          try { fs.unlinkSync(expectedRetrySpecPath); } catch { /* best-effort */ }
          resolve();
          return;
        }

        const governedFinalizedStoryIds: string[] = [];
        try {
          await transaction(async (client) => {
            const terminalFailure = wasCancelled || finalStatus !== 'done';
            if (terminalFailure) {
              const failureEvidence = JSON.stringify({
                schemaVersion: wasCancelled ? 'rorca.governed-retry-cancellation.v1' : 'rorca.governed-retry-failure.v1',
                finalStatus, exitCode: code, wasCancelled, fencingToken,
              });
              if (wasCancelled) {
                await client.query(
                  `UPDATE governed_retry_story_attempts
                   SET state = 'cancelled', cancellation_evidence = $2::jsonb, cancelled_at = NOW()
                   WHERE dispatch_identity_hash = $1 AND state = 'executing'`,
                  [dispatchIdentity.identityHash, failureEvidence],
                );
                const cancelled = await client.query(
                  `UPDATE governed_retry_dispatches
                   SET state = 'cancelled', cancellation_evidence = $4::jsonb, cancelled_at = NOW(),
                       lease_owner = NULL, lease_expires_at = NULL
                   WHERE identity_hash = $1 AND state = 'executing'
                     AND fencing_token = $2 AND lease_owner = $3
                   RETURNING identity_hash`,
                  [dispatchIdentity.identityHash, fencingToken, leaseOwner, failureEvidence],
                );
                if (cancelled.rowCount !== 1) throw new Error('[governed-retry] cancellation finalization lost its fence');
                await client.query(
                  `UPDATE pipeline_retry_previews
                   SET status = 'cancelled', preparation_state = 'cancelled', cancelled_at = NOW(),
                       cancellation_evidence = $2::jsonb
                   WHERE preview_hash = $1 AND status = 'dispatched'`,
                  [previewHash, failureEvidence],
                );
              } else {
                await client.query(
                  `UPDATE governed_retry_story_attempts
                   SET state = 'failed', failure_evidence = $2::jsonb
                   WHERE dispatch_identity_hash = $1 AND state = 'executing'`,
                  [dispatchIdentity.identityHash, failureEvidence],
                );
                const failed = await client.query(
                  `UPDATE governed_retry_dispatches
                   SET state = 'failed', failure_evidence = $4::jsonb,
                       lease_owner = NULL, lease_expires_at = NULL
                   WHERE identity_hash = $1 AND state = 'executing'
                     AND fencing_token = $2 AND lease_owner = $3
                   RETURNING identity_hash`,
                  [dispatchIdentity.identityHash, fencingToken, leaseOwner, failureEvidence],
                );
                if (failed.rowCount !== 1) throw new Error('[governed-retry] failure finalization lost its fence');
              }
              return;
            }

            const committedAttempts = await client.query<{ story_id: string; attempt: number }>(
              `UPDATE governed_retry_story_attempts SET state = 'committed'
               WHERE dispatch_identity_hash = $1 AND state = 'executing'
               RETURNING story_id, attempt`,
              [dispatchIdentity.identityHash],
            );
            const committedDispatch = await client.query(
              `UPDATE governed_retry_dispatches
               SET state = 'committed', lease_owner = NULL, lease_expires_at = NULL
               WHERE identity_hash = $1 AND state = 'executing'
                 AND fencing_token = $2 AND lease_owner = $3
               RETURNING identity_hash`,
              [dispatchIdentity.identityHash, fencingToken, leaseOwner],
            );
            if (committedDispatch.rowCount !== 1) throw new Error('[governed-retry] commit finalization lost its fence');

            for (const attempt of committedAttempts.rows) {
              const ledger = await client.query<{ source_commit: string; resulting_head: string; finalization_identity: Record<string, unknown> }>(
                `SELECT source_commit, resulting_head, finalization_identity
                 FROM story_integration_ledger
                 WHERE run_id = $1 AND story_id = $2 AND attempt = $3 AND state = 'finalized'`,
                [runId, attempt.story_id, attempt.attempt],
              );
              if (ledger.rowCount !== 1 || !ledger.rows[0].resulting_head) continue;
              const finalizationIdentity = retryHash({
                dispatchIdentity: dispatchIdentity.identityHash,
                storyId: attempt.story_id,
                attempt: attempt.attempt,
                resultingHead: ledger.rows[0].resulting_head,
                ledgerFinalization: ledger.rows[0].finalization_identity,
              });
              await client.query(
                `UPDATE governed_retry_story_attempts SET state = 'integrating'
                 WHERE dispatch_identity_hash = $1 AND story_id = $2 AND state = 'committed'`,
                [dispatchIdentity.identityHash, attempt.story_id],
              );
              const finalized = await client.query(
                `UPDATE governed_retry_story_attempts
                 SET state = 'finalized', source_commit = $3, finalization_identity = $4
                 WHERE dispatch_identity_hash = $1 AND story_id = $2 AND state = 'integrating'
                 RETURNING story_id`,
                [dispatchIdentity.identityHash, attempt.story_id, ledger.rows[0].source_commit, finalizationIdentity],
              );
              if (finalized.rowCount === 1) governedFinalizedStoryIds.push(attempt.story_id);
            }
            if (governedFinalizedStoryIds.length === committedAttempts.rows.length && committedAttempts.rows.length > 0) {
              const finalizationIdentity = retryHash({
                dispatchIdentity: dispatchIdentity.identityHash,
                stories: governedFinalizedStoryIds.sort(),
                revision: execSync('git rev-parse HEAD', { cwd, encoding: 'utf8' }).trim(),
              });
              await client.query(`UPDATE governed_retry_dispatches SET state = 'integrating' WHERE identity_hash = $1 AND state = 'committed'`, [dispatchIdentity.identityHash]);
              await client.query(`UPDATE governed_retry_dispatches SET state = 'integrated_validated' WHERE identity_hash = $1 AND state = 'integrating'`, [dispatchIdentity.identityHash]);
              const finalized = await client.query(
                `UPDATE governed_retry_dispatches
                 SET state = 'finalized', finalization_identity = $2
                 WHERE identity_hash = $1 AND state = 'integrated_validated'
                 RETURNING identity_hash`,
                [dispatchIdentity.identityHash, finalizationIdentity],
              );
              if (finalized.rowCount !== 1) throw new Error('[governed-retry] dispatch finalization lost optimistic concurrency');
            }
          });
        } catch (governanceError) {
          logger.error({ governanceError, runId }, '[worker] governed retry closeout failed closed');
          finalStatus = 'failed';
        }
        if (finalStatus === 'done' && governedFinalizedStoryIds.length !== dispatchIdentity.storyAttempts.length) {
          const finalized = new Set(governedFinalizedStoryIds);
          remainingStoryIds = [...new Set([
            ...remainingStoryIds,
            ...dispatchIdentity.storyAttempts.filter((attempt) => !finalized.has(attempt.storyId)).map((attempt) => attempt.storyId),
          ])].sort();
          finalStatus = 'partial_failure';
          retrySummary = `retry_integration_pending:${remainingStoryIds.join(',')}`;
        }
        retryScopeComplete = !wasCancelled && finalStatus === 'done';
        fullSpecComplete = retryScopeComplete && retrySpecSyncSucceeded && remainingStoryIds.length === 0;
        const retryReleaseOwned = finalStatus === 'done' && retryHostAuthority?.releaseEligible === true;
        let terminalUpdateError: unknown;

        try {
          if (retryReleaseOwned) {
            await persistHostRunCloseout({
              runId,
              status: 'done',
              governedRetryDispatchIdentity: dispatchIdentity.identityHash,
              terminalizeRun: false,
            });
            await prepareRunReleaseIntent({
              hostAuthority: retryHostAuthority!,
              mergeStrategy: approvedPreview.options.merge.strategy,
              autoMerge: approvedPreview.options.merge.autoMerge,
              externalSend: approvedPreview.options.safety.externalSend,
            });
            const release = await reconcileRunReleaseIntent(runId, {
              agent: approvedPreview.options.agent,
              model: approvedPreview.options.model,
              effortLevel: approvedPreview.options.effort && ['low', 'medium', 'high', 'max', 'xhigh'].includes(approvedPreview.options.effort)
                ? approvedPreview.options.effort as 'low' | 'medium' | 'high' | 'max' | 'xhigh'
                : undefined,
              source: 'manual-retry',
            }, { ...resolvedSecrets, ...envOverrides });
            finalStatus = release.status === 'completed' ? 'done' : 'release_pending';
          } else {
            await persistHostRunCloseout({
              runId,
              status: wasCancelled ? 'cancelled' : finalStatus === 'partial_failure' ? 'partial_failure' : 'failed',
              governedRetryDispatchIdentity: dispatchIdentity.identityHash,
              terminalizeRun: true,
            });
            if (retrySummary) {
              await execute('UPDATE pipeline_runs SET summary = $2 WHERE id = $1', [runId, retrySummary]);
            }
            await transitionRunLifecycle(runId, wasCancelled ? 'cancelled' : 'failed', {
              owner: 'worker_retry', outcome: finalStatus,
            });
            if (wasCancelled) {
              await emitWalEvent('run_cancelled', workspaceId, {
                run_id: runId, cancelledAt: new Date().toISOString(), source: 'worker_retry',
              });
            }
          }
          if (finalStatus === 'done') {
            const learnCloseout = await tryGenerateLearnCloseoutCandidates({
              workspaceId, runId, specId: path.basename(runRow.spec_path, '.json'),
            });
            await emitWalEvent('lifecycle_changed', workspaceId, {
              workspaceId, specId: path.basename(runRow.spec_path, '.json'), phaseId: 'learn',
              runId, changeKind: 'evidence_persisted', learnCloseoutStatus: learnCloseout?.status ?? 'blocked',
            });
            await emitWalEvent('governed_retry_finalized', workspaceId, {
              run_id: runId,
              original_run_id: originalRunId,
              original_run_lineage: dispatchIdentity.originalRunLineage,
              integrated_revision: execSync('git rev-parse HEAD', { cwd, encoding: 'utf8' }).trim(),
              integration_ancestry: dispatchIdentity.priorIntegrationAncestry,
              accepted_story_ids: [
                ...dispatchIdentity.carriedForward.map((story) => story.storyId),
                ...governedFinalizedStoryIds,
              ].sort(),
              dispatch_identity: dispatchIdentity.identityHash,
              fencing_token: fencingToken,
            });
          }
        } catch (err) {
          terminalUpdateError = err;
          logger.error({ err, runId }, '[worker] Failed to close retry through durable release seam');
        }

        if (terminalUpdateError) {
          logger.warn({ runId, retrySpecPath: expectedRetrySpecPath }, '[worker] Preserving retry snapshot after terminal persistence failure');
          reject(terminalUpdateError);
          return;
        }

        advanceQueue(workspaceId).catch(qErr =>
          logger.error({ err: qErr, runId, workspaceId }, '[worker] advanceQueue failed after retry completion'),
        );

        // Preserve a blocked snapshot for deterministic later refinalization.
        if (!retryRecoveryBlocked && finalStatus !== 'release_pending') {
          try { fs.unlinkSync(expectedRetrySpecPath); } catch { /* best-effort */ }
        } else {
          logger.warn({ runId, retrySpecPath: expectedRetrySpecPath }, '[worker] Preserving blocked retry snapshot for recovery');
        }

        resolve();
      });

      child.on('error', async (err) => {
        logger.error({ err, runId }, '[worker] retry execution-engine spawn error');
        await flushPending();
        activeProcesses.delete(runId);
        clearInterval(leaseRenewal);

        cancellingRuns.delete(runId);

        let terminalUpdateError: unknown;
        try {
          await synthesizeAllMissingFrozenStoryFailures(runId, workspaceId, 'retry_engine_spawn_failed');
          const terminalized = await terminalizeGovernedRetryRun({
            runId,
            workspaceId,
            requestedTerminal: 'failed',
            reason: `retry_engine_spawn_failed:${(err as Error).message}`,
            source: 'worker_retry_spawn_error',
          });
          if (terminalized.outcome !== 'terminalized' && terminalized.outcome !== 'already_terminal') {
            throw new Error(`[governed-retry] spawn failure did not converge (${terminalized.outcome})`);
          }
        } catch (dbErr) {
          terminalUpdateError = dbErr;
          logger.error({ dbErr, runId }, '[worker] Failed to terminalize retry after spawn error');
        }

        if (terminalUpdateError) {
          logger.warn({ runId, retrySpecPath: expectedRetrySpecPath }, '[worker] Preserving retry snapshot after spawn terminal persistence failure');
          reject(terminalUpdateError);
          return;
        }

        advanceQueue(workspaceId).catch(qErr =>
          logger.error({ err: qErr, runId, workspaceId }, '[worker] advanceQueue failed after retry spawn error'),
        );

        try { fs.unlinkSync(retrySpecPath); } catch { /* best-effort */ }

        resolve();
      });
    });
  }));
  const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
  if (failures.length > 0) {
    throw new AggregateError(failures.map(failure => failure.reason), 'One or more retry jobs failed before durable terminal completion');
  }
}

// ── Job handler: pipeline:cron ────────────────────────────────────────────
// One meta-cron tick checks application-owned schedule occurrence claims. There
// are deliberately no dynamic per-schedule pg-boss queues or firing paths.
async function handlePipelineCron(jobs: PgBoss.Job<Record<string, unknown>>[]): Promise<void> {
  for (const job of jobs) {
    logger.info({ jobId: job.id, name: job.name }, '[worker] pipeline:cron meta-tick');
    await checkAndFireDueSchedules();
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
    const run = await queryOne<{
      status: string;
      pid: number | null;
      workspace_id: string;
      pty_child_pid: number | null;
      pty_status: string | null;
    }>(
      `SELECT pr.status, pr.pid, pr.workspace_id,
              rps.child_pid AS pty_child_pid, rps.status AS pty_status
       FROM pipeline_runs pr
       LEFT JOIN run_pty_sessions rps ON rps.run_id = pr.id
       WHERE pr.id = $1`,
      [runId],
    );
    if (!run) {
      logger.info({ jobId: job.id, runId }, '[worker] pipeline:cancel — run missing');
      continue;
    }
    const governedState = await queryOne<{ state: string }>(
      'SELECT state FROM governed_retry_dispatches WHERE retry_run_id = $1',
      [runId],
    );
    const governedNeedsTerminalization = governedState
      && !['finalized', 'failed', 'manual_review_required', 'cancelled'].includes(governedState.state);
    if (!['queued', 'starting', 'running', 'paused'].includes(run.status) && !governedNeedsTerminalization) {
      logger.info({ jobId: job.id, runId, status: run.status }, '[worker] pipeline:cancel — run already terminal');
      await terminalizeCanonicalCancellation({
        runId,
        source: 'worker_cancel_terminal_replay',
        processQuiescent: true,
      });
      continue;
    }
    if (!governedState) {
      const cancellation = await finalizeFreshRunCancellation(runId, 'worker_cancel_notification');
      logger.info({ runId, cancellation }, '[worker] fresh-run cancellation reconciliation completed');
      if (cancellation.quiescent) await advanceQueue(run.workspace_id);
      continue;
    }

    const child = activeProcesses.get(runId);
    const ptyPid = run.pty_status && ['starting', 'active'].includes(run.pty_status) ? run.pty_child_pid : null;
    cancellingRuns.add(runId);

    if (child) {
      // Signal both the engine and independently tracked forkpty process. The
      // latter prevents a provider CLI from surviving if engine cleanup races
      // the worker's force-kill deadline.
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      signalPtyProcessGroup(ptyPid, 'SIGTERM');
      const forceKill = setTimeout(() => {
        if (activeProcesses.has(runId)) {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }
        signalPtyProcessGroup(ptyPid, 'SIGKILL');
      }, 10_000);
      forceKill.unref?.();
      continue;
    }

    // Crash/restart recovery: the new worker has no ChildProcess handle, so use
    // durable engine/PTY PIDs, terminate both trees, and finalize authority here.
    logger.warn({ jobId: job.id, runId, enginePid: run.pid, ptyPid }, '[worker] pipeline:cancel — recovering untracked process tree');
    if (isProcessAlive(run.pid)) {
      try { process.kill(run.pid!, 'SIGTERM'); } catch { /* already gone */ }
    }
    signalPtyProcessGroup(ptyPid, 'SIGTERM');
    await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
    if (isProcessAlive(run.pid)) {
      try { process.kill(run.pid!, 'SIGKILL'); } catch { /* already gone */ }
    }
    if (isProcessAlive(ptyPid)) signalPtyProcessGroup(ptyPid, 'SIGKILL');

    cancellingRuns.delete(runId);
    const governedRetry = await queryOne<{ identity_hash: string }>(
      'SELECT identity_hash FROM governed_retry_dispatches WHERE retry_run_id = $1',
      [runId],
    );
    if (governedRetry) {
      await synthesizeAllMissingFrozenStoryFailures(runId, run.workspace_id, 'worker_cancel_crash_recovery');
      const governedTerminal = await terminalizeGovernedRetryRun({
        runId,
        workspaceId: run.workspace_id,
        requestedTerminal: 'auto',
        reason: 'worker_cancel_crash_recovery',
        source: 'worker_cancel_untracked',
      });
      if (governedTerminal.outcome === 'terminalized'
        || governedTerminal.outcome === 'already_terminal'
        || governedTerminal.outcome === 'manual_review_required') {
        if (governedTerminal.bossJobId) {
          await getBoss().cancel('pipeline:retry', governedTerminal.bossJobId).catch((error) =>
            logger.warn({ error, runId, bossJobId: governedTerminal.bossJobId }, '[worker] governed retry terminalized but pg-boss cancellation notification was deferred'));
        }
        await advanceQueue(run.workspace_id);
        continue;
      }
      throw new Error('Governed retry cancellation lost its application authority');
    }

    await execute(
      `UPDATE run_pty_sessions
       SET status = 'killed', exit_signal = COALESCE(exit_signal, 'SIGTERM'),
           exited_at = COALESCE(exited_at, NOW()), updated_at = NOW()
       WHERE run_id = $1 AND status IN ('starting', 'active')`,
      [runId],
    );
    await synthesizeAllMissingFrozenStoryFailures(runId, run.workspace_id, 'worker_cancel_crash_recovery');
    await persistHostRunCloseout({ runId, status: 'cancelled', terminalizeRun: true });
    await execute(
      `UPDATE pipeline_run_cancellation_requests
       SET terminalized_at = COALESCE(terminalized_at, NOW()) WHERE run_id = $1`,
      [runId],
    );
    await transitionRunLifecycle(runId, 'cancelled', { owner: 'worker_cancel', process: 'crash_recovery_terminalized' });
    await emitWalEvent('run_cancelled', run.workspace_id, {
      run_id: runId,
      cancelledAt: new Date().toISOString(),
      source: 'worker_crash_recovery',
    });
    await advanceQueue(run.workspace_id);
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

    const persisted = await queryOne<{ auto_merge: boolean | null; merge_strategy: string | null; agent_type: string | null; agent_model: string | null }>(
      'SELECT auto_merge, merge_strategy, agent_type, agent_model FROM pipeline_runs WHERE id = $1', [runId],
    );
    const manualPosture = parsed.data.posture;
    if (
      !persisted || persisted.auto_merge !== true || persisted.merge_strategy !== 'direct' ||
      !manualPosture || persisted.agent_type !== manualPosture.agent || persisted.agent_model !== manualPosture.model
    ) {
      logger.warn({ runId }, '[worker] pipeline:merge refused: persisted direct-merge posture is unavailable or changed');
      await execute(`UPDATE pipeline_runs SET merge_status = 'failed' WHERE id = $1`, [runId]);
      return;
    }

    logger.info({ runId, branch, workspacePath: workspace.path, agent: manualPosture.agent, source: manualPosture.source }, '[worker] Reconciling host-owned direct release');
    const release = await reconcileRunReleaseIntent(runId, {
      agent: manualPosture.agent,
      model: manualPosture.model,
      source: 'manual-retry',
    });
    if (release.status === 'completed') {
      logger.info({ runId }, '[worker] pipeline:merge release completed successfully');
    } else {
      logger.warn({ runId, error: release.error }, '[worker] pipeline:merge release remains blocked');
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

async function synthesizeAllMissingFrozenStoryFailures(
  runId: number,
  workspaceId: string,
  reason: string,
): Promise<void> {
  const run = await queryOne<{ expected_story_ids: string[] | null }>(
    'SELECT expected_story_ids FROM pipeline_runs WHERE id = $1 AND workspace_id = $2',
    [runId, workspaceId],
  );
  for (const storyId of run?.expected_story_ids ?? []) {
    const existing = await queryOne<{ id: number }>(
      `SELECT id FROM story_results
       WHERE run_id = $1 AND story_id = $2 AND result_provenance = 'host'
       ORDER BY id DESC LIMIT 1`,
      [runId, storyId],
    );
    if (existing) continue;
    await persistCanonicalStoryResult({
      runId,
      storyId,
      status: 'fail',
      reason,
      idempotencyKey: `story-result:worker-stale:v1:${runId}:${storyId}:${reason}`,
      expectedWorkspaceId: workspaceId,
    }, WORKER_RESULT_AUTHORITY);
  }
}

async function reconcileStaleGovernedRetry(runId: number): Promise<'not-governed' | 'active' | 'reconciled'> {
  const row = await queryOne<{
    workspace_id: string; status: string; pid: number | null;
    dispatch_state: string; dispatch_identity: string; packet: RetryPreviewPacket;
    preview_hash: string; pty_child_pid: number | null; pty_status: string | null;
  }>(
    `SELECT run.workspace_id, run.status, run.pid, dispatch.state AS dispatch_state,
            dispatch.identity_hash AS dispatch_identity, preview.packet, preview.preview_hash,
            pty.child_pid AS pty_child_pid, pty.status AS pty_status
     FROM governed_retry_dispatches dispatch
     JOIN pipeline_retry_previews preview ON preview.preview_hash = dispatch.preview_hash
     JOIN pipeline_runs run ON run.id = dispatch.retry_run_id
     LEFT JOIN run_pty_sessions pty ON pty.run_id = run.id
     WHERE dispatch.retry_run_id = $1`,
    [runId],
  );
  if (!row) return 'not-governed';
  if (activeProcesses.has(runId)) return 'active';

  // A stale governed delivery has no live worker owner. Terminate both durable
  // process trees before application terminalization; a surviving PID must not
  // keep an orphaned retry outside the governed ledger indefinitely.
  const engineAlive = isProcessAlive(row.pid);
  const ptyPid = row.pty_status && ['starting', 'active'].includes(row.pty_status) ? row.pty_child_pid : null;
  const ptyAlive = isProcessAlive(ptyPid);
  if (engineAlive) {
    try { process.kill(row.pid!, 'SIGTERM'); } catch { /* raced exit */ }
  }
  if (ptyAlive) signalPtyProcessGroup(ptyPid, 'SIGTERM');
  if (engineAlive || ptyAlive) await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
  if (isProcessAlive(row.pid)) {
    try { process.kill(row.pid!, 'SIGKILL'); } catch { /* raced exit */ }
  }
  if (isProcessAlive(ptyPid)) signalPtyProcessGroup(ptyPid, 'SIGKILL');

  await recoverIntegratedValidatedStoryFinalizations({ runId });
  await recoverUnreleasedIntegratedPasses({ runId });
  const authority = await inspectRunHostAuthority(runId);
  if (row.dispatch_state === 'finalized' && authority?.releaseEligible) {
    await persistHostRunCloseout({
      runId,
      status: 'done',
      governedRetryDispatchIdentity: row.dispatch_identity,
      terminalizeRun: false,
    });
    await prepareRunReleaseIntent({
      hostAuthority: authority,
      mergeStrategy: row.packet.options.merge.strategy,
      autoMerge: row.packet.options.merge.autoMerge,
      externalSend: row.packet.options.safety.externalSend,
    });
    await reconcileRunReleaseIntent(runId, {
      agent: row.packet.options.agent,
      model: row.packet.options.model,
      effortLevel: row.packet.options.effort && ['low', 'medium', 'high', 'max', 'xhigh'].includes(row.packet.options.effort)
        ? row.packet.options.effort as 'low' | 'medium' | 'high' | 'max' | 'xhigh'
        : undefined,
      source: 'manual-retry',
    });
    return 'reconciled';
  }
  if (['committed', 'integrating', 'integrated_validated'].includes(row.dispatch_state)) {
    const terminalized = await terminalizeGovernedRetryRun({
      runId,
      workspaceId: row.workspace_id,
      requestedTerminal: 'auto',
      reason: 'stale_post_git_authority_incomplete',
      source: 'worker_stale_reconciliation',
    });
    if (terminalized.outcome !== 'manual_review_required') {
      throw new Error(`[governed-retry] post-Git reconciliation did not preserve manual review (${terminalized.outcome})`);
    }
    return 'reconciled';
  }

  await synthesizeAllMissingFrozenStoryFailures(runId, row.workspace_id, 'worker_crash_recovery');
  const terminalized = await terminalizeGovernedRetryRun({
    runId,
    workspaceId: row.workspace_id,
    requestedTerminal: 'auto',
    reason: 'stale_pre_git_worker_exit',
    source: 'worker_stale_reconciliation',
  });
  if (terminalized.outcome !== 'terminalized' && terminalized.outcome !== 'already_terminal') {
    throw new Error(`[governed-retry] stale pre-Git terminalization did not converge (${terminalized.outcome})`);
  }
  return 'reconciled';
}

export async function recoverStaleJobs(): Promise<void> {
  const pgBossSchema = getPgBossSchemaSql();
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
       FROM ${pgBossSchema}.job j
       WHERE j.name IN ('pipeline:run', 'pipeline:retry')
         AND j.state = 'active'
         AND j.started_on < $1
         AND NOT EXISTS (
           SELECT 1 FROM pipeline_run_release_intents ri
           WHERE ri.run_id = (j.data->>'runId')::bigint
         )
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
    if (!runId) {
      logger.warn({ jobId: job.id, jobName: job.name }, '[worker] stale dispatch has no canonical application run');
      await getBoss().fail(job.name, job.id, { reason: 'missing_canonical_run_id' }).catch(() => undefined);
      continue;
    }

    const runRow = await queryOne<{ workspace_id: string }>(
      'SELECT workspace_id FROM pipeline_runs WHERE id = $1', [runId],
    ).catch(() => undefined);
    if (!runRow) {
      await getBoss().fail(job.name, job.id, { reason: 'canonical_run_missing' }).catch(() => undefined);
      continue;
    }

    try {
      if (job.name === 'pipeline:retry') {
        const outcome = await reconcileStaleGovernedRetry(runId);
        if (outcome === 'active') continue;
        if (outcome === 'not-governed') throw new Error('pipeline:retry lacks governed application state');
      } else {
        await synthesizeAllMissingFrozenStoryFailures(runId, runRow.workspace_id, 'worker_crash_recovery');
        await persistHostRunCloseout({ runId, status: 'failed', terminalizeRun: true });
        await transitionRunLifecycle(runId, 'failed', {
          owner: 'worker_crash_recovery', process: 'stale_pgboss_job', pgbossJobId: job.id,
        });
      }
      // Application tables reached an authoritative terminal/reconciliation
      // state first. pg-boss is notified only to release dispatch capacity.
      await getBoss().fail(job.name, job.id, { reason: 'application_state_reconciled' });
      advanceQueue(runRow.workspace_id).catch(qErr =>
        logger.error({ err: qErr, runId }, '[worker] advanceQueue failed after stale job recovery'));
      logger.warn({ pgbossJobId: job.id, jobName: job.name, runId }, '[worker] stale dispatch reconciled from application authority');
    } catch (error) {
      logger.error({ error, pgbossJobId: job.id, jobName: job.name, runId }, '[worker] stale dispatch remains blocked; pg-boss slot not mutated');
    }
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
  ptyPid?: number;
  ptyKilled?: boolean;
};

function isProcessAlive(pid: number | null | undefined): boolean {
  if (pid === null || pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalPtyProcessGroup(pid: number | null | undefined, signal: NodeJS.Signals): void {
  if (!pid || pid <= 0) return;
  if (process.platform !== 'win32') {
    try { process.kill(-pid, signal); } catch { /* fall through to direct PID signal */ }
  }
  try { process.kill(pid, signal); } catch { /* already gone */ }
}

async function signalDurableRunPty(runId: number, signal: NodeJS.Signals): Promise<void> {
  const session = await queryOne<{ child_pid: number | null; status: string }>(
    'SELECT child_pid, status FROM run_pty_sessions WHERE run_id = $1',
    [runId],
  );
  if (session?.status === 'active') signalPtyProcessGroup(session.child_pid, signal);
}

export async function sweepOrphanProcesses(): Promise<OrphanSweepResult[]> {
  const results: OrphanSweepResult[] = [];

  type OrphanRunRow = {
    id: number;
    pid: number | null;
    workspace_id: number | string;
    pty_child_pid: number | null;
    pty_status: string | null;
  };

  let orphanRuns: OrphanRunRow[];
  try {
    // Only find runs whose owning worker has NO fresh heartbeat.
    // Without this check, Worker B would kill Worker A's legitimate runs
    // just because worker_id != B. The LEFT JOIN ensures runs with a
    // live owning worker are excluded; only truly orphaned runs remain.
    orphanRuns = await query<OrphanRunRow>(
      `SELECT pr.id,
              pr.pid,
              pr.workspace_id,
              rps.child_pid AS pty_child_pid,
              rps.status AS pty_status
       FROM pipeline_runs pr
       LEFT JOIN worker_heartbeat wh
         ON pr.worker_id = wh.worker_id
         AND wh.last_seen > NOW() - INTERVAL '90 seconds'
       LEFT JOIN run_pty_sessions rps
         ON rps.run_id = pr.id
       WHERE pr.status = 'running'
         AND NOT EXISTS (SELECT 1 FROM pipeline_run_release_intents ri WHERE ri.run_id = pr.id)
         AND NOT EXISTS (
           SELECT 1 FROM governed_retry_dispatches retry
           WHERE retry.retry_run_id = pr.id
         )
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
    const { pid, workspace_id: workspaceId, pty_child_pid: ptyChildPid, pty_status: ptyStatus } = run;

    // Belt-and-suspenders: skip runs this worker actively owns in memory
    if (activeProcesses.has(runId)) {
      logger.info({ runId }, '[worker] sweepOrphanProcesses — run is in activeProcesses, skipping');
      continue;
    }

    let killed = false;
    let ptyKilled = false;

    try {
      // ── 1. Check engine/PTY liveness and terminate both trees ─────────
      const engineAlive = isProcessAlive(pid);
      const ptyAlive = ptyStatus === 'active' && isProcessAlive(ptyChildPid);

      if (engineAlive) {
        try {
          process.kill(pid!, 'SIGTERM');
          logger.info({ runId, pid }, '[worker] sweepOrphanProcesses — sent SIGTERM to engine PID');
        } catch {
          // process may have died between probe and signal
        }
      }

      if (ptyAlive) {
        signalPtyProcessGroup(ptyChildPid, 'SIGTERM');
        logger.info({ runId, ptyChildPid }, '[worker] sweepOrphanProcesses — sent SIGTERM to PTY process group');
      }

      if (engineAlive || ptyAlive) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
      }

      if (engineAlive) {
        if (isProcessAlive(pid)) {
          try {
            process.kill(pid!, 'SIGKILL');
            killed = true;
            logger.info({ runId, pid }, '[worker] sweepOrphanProcesses — sent SIGKILL to engine PID (SIGTERM ignored)');
          } catch {
            // PID recycled between probe and SIGKILL — harmless
          }
        } else {
          killed = true;
        }
      }

      if (ptyAlive) {
        if (isProcessAlive(ptyChildPid)) {
          signalPtyProcessGroup(ptyChildPid, 'SIGKILL');
          ptyKilled = true;
          logger.info({ runId, ptyChildPid }, '[worker] sweepOrphanProcesses — sent SIGKILL to PTY process group (SIGTERM ignored)');
        } else {
          ptyKilled = true;
        }
      }

      // ── 3. Mark pipeline run as failed ────────────────────────────────
      await execute(
        `UPDATE pipeline_runs
         SET status = 'failed', finished_at = NOW()
         WHERE id = $1 AND status = 'running'`,
        [runId],
      );
      await transitionRunLifecycle(runId, 'failed', {
        owner: 'worker_orphan_sweep', process: 'orphan_swept',
        enginePid: pid, ptyPid: ptyChildPid, ptyKilled,
      });

      if (ptyStatus === 'active') {
        const ptyExitSignal = ptyKilled ? 'SIGKILL' : ptyAlive ? 'SIGTERM' : null;
        await execute(
          `UPDATE run_pty_sessions
           SET status = 'killed',
               exit_signal = COALESCE($2, exit_signal),
               exited_at = COALESCE(exited_at, NOW()),
               updated_at = NOW()
           WHERE run_id = $1 AND status = 'active'`,
          [runId, ptyExitSignal],
        );
      }

      // ── 4. Persist then release story failures ─────────────────────────
      let incompleteStories: { story_id: string }[] = [];
      try {
        incompleteStories = await query<{ story_id: string }>(
          `SELECT DISTINCT story_id FROM story_results
           WHERE run_id = $1 AND status != 'pass'`,
          [runId],
        );
      } catch (storyErr) {
        logger.warn({ storyErr, runId }, '[worker] sweepOrphanProcesses — could not query story_results');
      }

      for (const story of incompleteStories) {
        await persistCanonicalStoryResult({
          runId,
          storyId: story.story_id,
          status: 'fail',
          reason: 'orphan_sweep',
          idempotencyKey: `story-result:worker-orphan-sweep:v1:${runId}:${story.story_id}`,
          expectedWorkspaceId: String(workspaceId),
        }, WORKER_RESULT_AUTHORITY);
        await emitWalEvent('story_failed', workspaceId, {
          run_id: runId,
          story_id: story.story_id,
          reason: 'orphan_sweep',
        });
      }

      // Capture an active story that had not inserted any result before the
      // crash; known non-pass rows above are already host-finalized.
      await synthesizeInterruptedStoryFailure({
        runId,
        workspaceId,
        status: 'failed',
        exitCode: null,
        exitSignal: null,
        source: 'worker',
      });

      // ── 5. Terminal run event follows all durable failure results ──────
      await emitWalEvent('run_finished', workspaceId, {
        run_id: runId,
        status: 'failed',
        reason: 'orphan_sweep',
        swept_pid: pid,
        swept_pty_pid: ptyChildPid,
        swept_at: new Date().toISOString(),
      });

      logger.warn(
        { runId, pid, killed, ptyChildPid, ptyKilled, incompleteStories: incompleteStories.length },
        '[worker] sweepOrphanProcesses — orphan run swept',
      );

      // Advance queue — a queued run may have been blocked behind this orphan
      advanceQueue(String(workspaceId)).catch(qErr =>
        logger.error({ err: qErr, runId }, '[worker] advanceQueue failed after orphan sweep'),
      );

      results.push({ runId, pid: pid ?? 0, killed, ptyPid: ptyChildPid ?? 0, ptyKilled });
    } catch (err) {
      logger.error({ err, runId, pid, ptyChildPid }, '[worker] sweepOrphanProcesses — error processing orphan run, continuing');
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
  const pgBossSchema = getPgBossSchemaSql();

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
         AND NOT EXISTS (SELECT 1 FROM pipeline_run_release_intents ri WHERE ri.run_id = pr.id)
         AND NOT EXISTS (
           SELECT 1 FROM ${pgBossSchema}.job j
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
    try {
      // Governed retries delegate process termination and terminal state to the
      // application terminalizer before the generic live-PID shortcut.
      const governed = await reconcileStaleGovernedRetry(run.id);
      if (governed === 'active') continue;
      if (governed === 'reconciled') {
        await advanceQueue(String(run.workspace_id));
        continue;
      }

      // Final safety for ordinary runs: a live engine still owns its closeout.
      if (run.pid) {
        try {
          process.kill(run.pid, 0); // signal 0 = liveness check, doesn't kill
          logger.info(
            { runId: run.id, pid: run.pid },
            '[worker] reconcileState — Case A: pg-boss job gone but PID still alive, skipping',
          );
          continue;
        } catch {
          // PID not found — process is dead, proceed with generic reconciliation
        }
      }

      logger.warn(
        { runId: run.id, currentStatus: 'running', lastHeartbeat: run.last_heartbeat },
        '[worker] reconcileState — Case A: no live pgboss job, no recent heartbeat, PID dead — reconciling pass boundaries before failure',
      );
      const passRecovery = await recoverUnreleasedIntegratedPasses({ runId: run.id });
      if (passRecoveryBlocksCompletion(passRecovery)) {
        logger.error({ runId: run.id, passRecovery }, '[worker] startup pass refinalization remains blocked');
      }
      await synthesizeAllMissingFrozenStoryFailures(run.id, String(run.workspace_id), 'state_reconciliation');
      await persistHostRunCloseout({ runId: run.id, status: 'failed', terminalizeRun: true });
      await transitionRunLifecycle(run.id, 'failed', {
        owner: 'worker_reconciliation', process: 'heartbeat_stale_or_pid_dead',
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
       FROM ${pgBossSchema}.job j
       WHERE j.name IN ('pipeline:run', 'pipeline:retry')
         AND j.state = 'active'
         AND (j.data->>'runId') IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM pipeline_run_release_intents ri
           WHERE ri.run_id = (j.data->>'runId')::bigint
         )
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
      if (job.name === 'pipeline:retry' && job.run_id) {
        const outcome = await reconcileStaleGovernedRetry(Number(job.run_id));
        if (outcome === 'active') continue;
      }
      await getBoss().fail(job.name, job.id, { reason: 'application_state_already_resolved' });

      logger.warn(
        { jobId: job.id, jobName: job.name, runId: job.run_id },
        '[worker] reconcileState — Case B: pgboss job failed to free slot',
      );
    } catch (err) {
      logger.warn({ err, jobId: job.id }, '[worker] reconcileState — Case B: failed to update pgboss.job');
    }
  }

  try {
    await reconcilePendingCheckRunProjections();
  } catch (error) {
    logger.warn({ error }, '[worker] Check Run projection reconciliation deferred');
  }

  const totalFixed = stuckRuns.length + orphanJobs.length;
  _lastReconciliationErrors = totalFixed;

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
    for (const [runId, child] of activeProcesses) {
      try { child.kill('SIGTERM'); } catch { /* best-effort */ }
      try { await signalDurableRunPty(runId, 'SIGTERM'); } catch { /* best-effort */ }
    }
  }

  // 2. Wait up to 30s for child processes to flush closeout state and exit (poll every 500ms)
  const DRAIN_TIMEOUT_MS = 30_000;
  const DRAIN_POLL_MS = 500;
  const drainDeadline = Date.now() + DRAIN_TIMEOUT_MS;

  while (activeProcesses.size > 0 && Date.now() < drainDeadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
  }

  // 3. SIGKILL any remaining child processes that did not exit in time
  if (activeProcesses.size > 0) {
    const remaining = Array.from(activeProcesses.keys());
    logger.warn({ remaining }, '[worker] shutdown — children did not exit in 30s, sending SIGKILL');
    for (const [runId, child] of activeProcesses) {
      try { child.kill('SIGKILL'); } catch { /* best-effort */ }
      try { await signalDurableRunPty(runId, 'SIGKILL'); } catch { /* best-effort */ }
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
        await transitionRunLifecycle(runId, 'failed', {
          owner: 'worker_shutdown', process: 'shutdown_timeout', signal,
        });
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

export async function checkSingletonGuard(): Promise<boolean> {
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
          if (OPTIONAL_WORKER_MODE) {
            logger.info(
              { existingWorkerId: w.worker_id, existingPid: w.pid, lastSeen: w.last_seen },
              '[worker] Optional worker start skipped — another worker is already alive.',
            );
            return false;
          }
          logger.error(
            { existingWorkerId: w.worker_id, existingPid: w.pid, lastSeen: w.last_seen },
            '[worker] SINGLETON GUARD — another worker is alive. Exiting to prevent duplicate workers.',
          );
          return false;
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
  return true;
}

// ── Integration health checks ────────────────────────────────────────────
// Pings each connected integration's API endpoint every 5 minutes (via pg-boss cron).
// Stores health snapshots in integration_health table for trend display.

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

  // Resolve each workspace through the same canonical authority/token path used
  // by runtime operations. This covers App-only workspaces and never fans one
  // ambient user token across unrelated repositories.
  try {
    const workspaces = await query<{ workspace_id: string; repo_owner: string; repo_name: string }>(
      `SELECT workspace_id, repo_owner, repo_name
         FROM github_workspace_repository_authority
        WHERE authority_status = 'active'`,
    );
    for (const workspace of workspaces) {
      try {
        const resolved = await resolveWorkspaceGitHubToken(workspace.workspace_id, {
          repository: { owner: workspace.repo_owner, name: workspace.repo_name }, purpose: 'repository-read',
        });
        if (resolved) await checkGitHubHealth(workspace.workspace_id, resolved.token);
      } catch (err) {
        logger.warn({ err, workspaceId: workspace.workspace_id }, '[worker] integration:health-check — canonical GitHub resolution failed');
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

  // 1b. Singleton guard — skip startup if another worker has a fresh heartbeat.
  if (!(await checkSingletonGuard())) {
    return;
  }

  // 2. Start pg-boss — creates/upgrades pgboss.* schema automatically
  try {
    await initBoss();
  } catch (err) {
    logger.error({ err }, '[worker] pg-boss initialisation failed');
    process.exit(1);
  }

  // 2b. Re-publish expired/stale application-owned dispatch payloads before
  // handlers poll pg-boss. Unknown recovery state fails startup closed rather
  // than acknowledging canonical queued rows that transport no longer retains.
  try {
    const dispatchRecovery = await recoverPendingDispatchPublications();
    if (dispatchRecovery.scanned > 0) {
      logger.info({ dispatchRecovery }, '[worker] startup pipeline dispatch publication recovery complete');
    }
    const cancellationRecovery = await reconcilePendingFreshRunCancellations();
    if (cancellationRecovery.scanned > 0) {
      logger.info({ cancellationRecovery }, '[worker] startup fresh-run cancellation recovery complete');
    }
  } catch (error) {
    logger.error({ error }, '[worker] pipeline dispatch publication recovery failed closed');
    process.exit(1);
    return;
  }

  // 3. Reconcile committed pass authority, consume retained exact relay
  // references, then re-scan. Recovery proves ordered descendants before an
  // earlier pass can be released after a later story advanced canonical HEAD.
  try {
    const integratedValidatedRecovery = await recoverIntegratedValidatedStoryFinalizations({ limit: 100 });
    const firstPassRecovery = await recoverUnreleasedIntegratedPasses();
    const journalRecovery = await replayRetainedRunJournals();
    const secondPassRecovery = await recoverUnreleasedIntegratedPasses();
    if (integratedValidatedRecovery.scanned > 0
      || firstPassRecovery.scanned > 0 || firstPassRecovery.blocked.length > 0
      || journalRecovery.scannedRoots > 0 || secondPassRecovery.scanned > 0
      || secondPassRecovery.blocked.length > 0) {
      logger.info({ integratedValidatedRecovery, firstPassRecovery, journalRecovery, secondPassRecovery }, '[worker] startup integrated pass/journal refinalization complete');
    }
  } catch (error) {
    logger.error({ error }, '[worker] startup integrated pass/journal refinalization deferred');
  }

  // 3a. Resume durable exact-SHA release/terminal intents before stale-run
  // classification. This uses the existing worker boundary; no second
  // orchestrator or queue is introduced.
  try {
    const releaseDrain = await drainPendingRunReleases(100, 1000);
    if (releaseDrain.scanned > 0) {
      logger.info({ releaseDrain }, '[worker] startup release/terminal reconciliation drain complete');
    }
  } catch (error) {
    // Never classify stale work while an unbounded release backlog is unknown.
    logger.error({ error }, '[worker] startup release drain failed closed');
    process.exit(1);
    return;
  }

  // 3b. Recover stale jobs left by a previously crashed worker instance.
  // Must run after initBoss() (pg-boss schema exists) but before boss.work()
  // (so freed slots are available when handlers start polling).
  await recoverStaleJobs();

  // 3c. Sweep orphan processes — execution-engine subprocesses left running
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

  // Reconcile state between pipeline_runs and pgboss.job.
  // Runs once at startup, then every 60s during normal operation.
  await reconcileState();
  try {
    const reconciledMerges = await reconcilePendingAutonomousPrDeliveryMerges();
    if (reconciledMerges > 0) logger.info({ reconciledMerges }, '[worker] reconciled autonomous PR merges after restart');
  } catch (error) {
    logger.warn({ err: error }, '[worker] autonomous PR merge reconciliation deferred');
  }
  reconcileIntervalHandle = setInterval(() => {
    void (async () => {
      await reconcilePendingRunReleases(100).catch((error) =>
        logger.warn({ error }, '[worker] periodic exact release reconciliation deferred'));
      await recoverPendingDispatchPublications().catch((error) =>
        logger.error({ error }, '[worker] periodic pipeline dispatch publication recovery deferred'));
      await reconcilePendingFreshRunCancellations().catch((error) =>
        logger.error({ error }, '[worker] periodic fresh-run cancellation recovery deferred'));
      await reconcileState();
    })();
  }, RECONCILE_INTERVAL_MS);

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
  await registerAutonomousPrDeliveryWorker(boss);
  await registerSpecJobHandlers(boss);
  await registerHydrationWorker(boss);
  await registerContextCaptureHandlers(boss);

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

  const pgBossSchema = getPgBossSchemaSql();

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
           FROM ${pgBossSchema}.archive
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
         FROM ${pgBossSchema}.archive
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

  logger.info('[worker] ready — listening for pipeline and spec job queues');
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
