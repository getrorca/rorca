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
 *   pipeline:run        — trigger a worktree-isolated pipeline run
 *   pipeline:run:direct — trigger a serialized direct-workspace pipeline run
 *   pipeline:retry      — retry failed stories in a completed run
 *   pipeline:cancel — cancel an active run
 *   pipeline:closeout-reconcile — closeout-only exact historical correction
 *
 * Start: npm run worker
 * Stop:  SIGTERM (graceful) — drains in-flight jobs up to 30s, then exits
 */

import 'dotenv/config';
import { applySelectedDbModeEnvironment, formatDbModeBootstrapLog } from './lib/db-strategy';
import { initializeWorkerIdleCostController, type WorkerIdleCostController } from './lib/worker-idle-cost-controller';

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
import type { WavePolicyEnvelope } from './lib/wave-production-policy';
import PgBoss from 'pg-boss';
import {
  PipelineRunJobPayload,
  type PipelineRunJobPayloadType,
  PipelineRetryJobPayload,
  type PipelineRetryJobPayloadType,
  PipelineCancelJobPayload,
} from './lib/pg-boss-schemas';

// Worker DB access intentionally uses the shared service-role pool helpers, not
// withUserClient(). This process runs with RORCA_PROCESS_ROLE=worker and spawns
// RORCA_PROCESS_ROLE=engine children to perform system-owned orchestration jobs,
// so it must bypass per-request JWT RLS scoping.
import { initDb, query, queryOne, execute, transaction, closePool } from './db/index';
import { initBoss, getBoss } from './lib/pg-boss';
import { getPgBossSchemaSql } from './lib/pg-boss-schema';
import {
  claimDispatchForWorker,
  PIPELINE_DIRECT_RUN_QUEUE,
  PIPELINE_RUN_QUEUE,
  recoverPendingDispatchPublications,
  releaseDispatchWorkerClaim,
} from './lib/dispatch-publication';
import { recoverRecentLifecycleAssurancePublications } from './lib/ssdlc-lifecycle-orchestrator';
import { parseLifecycleDispatchClaim } from './lib/lifecycle-dispatch-claim';
import { executeEcoManagedWorker } from './lib/eco-managed-runtime';
import './lib/eco-structured-bootstrap';
import {
  quiesceCancellationProcesses,
  reconcilePendingCancellationRequests,
  releaseLaunchGateWithCancellationFence,
  terminalizeCanonicalCancellation,
  type CancellationProcessSnapshot,
} from './lib/pipeline-cancellation';
import { registerSchedulesWithBoss, checkAndFireDueSchedules } from './lib/scheduler';
import { registerSpecJobHandlers } from './lib/spec-job-worker';
import { recoverBoundPostSaveWorkflowPublications } from './lib/spec-post-save-workflow';
import { registerHydrationWorker } from './lib/hydration-worker';
import { registerContextCaptureHandlers } from './lib/context-distillation';
import { registerPreStagingQualificationWorker } from './lib/pre-staging-qualification';
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
import { CurrentEngineManagedBridge } from './lib/current-engine-managed-bridge';
import { RorcaManagedExecutor } from './lib/rorca-managed-executor';
import { PostgresManagedExecutorStore } from './lib/rorca-managed-executor-store';
import { loadCanonicalWave3AImplementationGate } from './lib/wave3a-managed-executor-gate';
import {
  createOmpManagedContinuationStack,
  reconcileOmpManagedDispatches,
  type OmpManagedContinuationStack,
} from './lib/omp-continuation-lane';
import { ManagedAdmissionError } from './lib/rorca-managed-executor';
import { evaluatePiStoryCloseoutEvidence } from './lib/pi-story-closeout-evidence';
import {
  fallbackReplayBlocksCompletion,
  replayFallbackResults,
  replayRetainedRunJournals,
} from './lib/fallback-replay';
import {
  assertRunSpecAuthorityProjection,
  deriveRunSpecPath,
  deriveStoryExecutionManifestPath,
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
import {
  readExactFinalizedStoryIntegration,
  reconcileFinalizedSequentialIntegrations,
} from './lib/wave-integration-store';
import { compareRetryPlanToPreview, retryHash, verifyRetryPreview, type RetryPreviewPacket } from './lib/retry-governance';
import { deriveStoryContractRevision } from './lib/story-execution-packet';
import { finalizeUnfinishedHostAttemptGeneration } from './lib/host-story-attempt-envelope';
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
import {
  bindGovernedRetryProcessLaunch,
  claimGovernedRetryExecutionLease,
  markGovernedRetryLeaseExecuting,
  renewGovernedRetryExecutionLease,
} from './lib/governed-retry-execution-lease';
import { tryGenerateLearnCloseoutCandidates } from './lib/learn-closeout';
import { buildMaintenanceLifecycleInvalidation } from './lib/ssdlc-contracts';
import { tryDeriveAndPersistRunFindings } from './lib/run-findings';
import { resolveWorkspaceGitHubToken } from './lib/github-token-resolver';
import { isPtyTerminalMode } from './lib/terminal-mode';
import { OrderedOutputDrain } from './lib/ordered-output-drain';
import { finalizeActiveRunPtyAfterEngineExit } from './lib/run-pty-store';
import { transitionRunLifecycle } from './lib/run-lifecycle';
import {
  WorkerRunResourceOwner,
  includesWorkerChildQuiescenceError,
  includesWorkerResourceCleanupError,
} from './lib/worker-run-resource-owner';
import {
  assertExecutionJobPayloadRedacted,
  redactExecutionJobPayload,
  resolveExecutionSecrets,
} from './lib/execution-secret-references';
import { reconcilePendingCheckRunProjections } from './lib/check-run-poster';
import { inspectRunHostAuthority, type RunHostAuthority } from './lib/run-host-authority';
import {
  reconcilePendingForgejoStatusProjections,
} from './lib/forgejo-check-poster';
import { persistHostRunCloseout } from './lib/run-closeout-authority';
import { recoverBranchOnlyWorkerCloseouts } from './lib/worker-closeout-recovery';
import {
  assertNotProtectedWave1Run,
  WAVE_1_PROTECTED_GENESIS_RUN_ID,
} from './lib/wave-1-stabilization';
import { assertFrozenRunExecutionIdentity } from './lib/run-git-authority';
import { loadAndVerifyTaskManifestRunLineage } from './lib/task-manifest-run-lineage';
import {
  assertTaskManifestWorkerPayloadAuthority,
  taskManifestCommandGuardEnv,
} from './lib/task-manifest-worker-authority';
import {
  AUTONOMOUS_GIT_STATE_ROOT_ENV,
  createAutonomousGitState,
  removeAutonomousGitState,
  sweepStaleAutonomousGitState,
} from './lib/autonomous-git-state';
import {
  assertAutonomousExecutionBoundary,
  createOrdinaryLocalPiRuntimeState,
  removeOrdinaryLocalPiRuntimeState,
  sweepStaleOrdinaryLocalPiRuntimeState,
} from './lib/autonomous-sandbox';
import {
  ORDINARY_LOCAL_PI_PROFILE_ENV,
  ORDINARY_LOCAL_PI_PROFILE_VERSION,
  RorcaExecutionSandboxError,
  revalidateFrozenPiExecutableIdentity,
  resolveRorcaExecutionSandboxProfile,
  serializeOrdinaryLocalPiRuntimeProfile,
  type FrozenPiExecutableIdentity,
  type OrdinaryLocalPiRuntimeProfile,
} from './lib/ordinary-local-pi-profile';
import {
  AUTONOMOUS_EGRESS_AUTHORITY_HASH_ENV,
  AUTONOMOUS_EGRESS_IDENTITY_HASH_ENV,
  AUTONOMOUS_EGRESS_RUN_ID_ENV,
  closeAutonomousModelEgress,
  ensureAutonomousModelEgress,
  resolveModelEgressHosts,
  sweepStaleAutonomousModelEgressState,
  type AutonomousModelEgressRunIdentity,
} from './lib/autonomous-model-egress';
import {
  drainPendingRunReleases,
  prepareRunReleaseIntent,
  reconcilePendingRunReleases,
  reconcileRunReleaseIntent,
} from './lib/release-authority';
import { drainForgejoPendingRunReleases } from './lib/forgejo-release-authority';
import { reconcilePendingForgejoFederationProjections } from './lib/forgejo-federation-bridge';
import {
  CLOSEOUT_RECONCILIATION_QUEUE,
  processCloseoutReconciliationJob,
  recoverPendingCloseoutReconciliationPublications,
} from './lib/run-closeout-reconciliation';
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
import {
  executeWithPipelineBudget,
  getWorkerConcurrencySettings,
  PipelineExecutionBudget,
  pipelineWorkerSubscriptionPlan,
  type WorkerConcurrencySettings,
} from './lib/worker-concurrency';
import {
  wardenSweep,
  wardenEscalateStalledRuns,
} from './lib/failure-warden';

class WorkerTerminalPersistenceError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'WorkerTerminalPersistenceError';
  }
}

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

// W5-008: one omp managed stack per workspace, constructed lazily on first
// dispatch/recovery and reused for the worker's lifetime. Failures are cached
// so a broken probe fails closed instead of probing on every run.
let implementationGatePromise: ReturnType<typeof loadCanonicalWave3AImplementationGate> | null = null;
function ensureImplementationGate(): ReturnType<typeof loadCanonicalWave3AImplementationGate> {
  if (!implementationGatePromise) implementationGatePromise = loadCanonicalWave3AImplementationGate();
  return implementationGatePromise;
}
const ompManagedStacks = new Map<string, Promise<OmpManagedContinuationStack>>();

function getOmpManagedStack(workspaceId: string): Promise<OmpManagedContinuationStack> {
  const existing = ompManagedStacks.get(workspaceId);
  if (existing) return existing;
  const stack = (async () => {
    const implementationGate = await ensureImplementationGate();
    return createOmpManagedContinuationStack({
      workspaceId,
      runtimeId: `runtime:worker:${WORKER_ID}`,
      store: new PostgresManagedExecutorStore(workspaceId),
      implementationGate,
      trustedEnvironment: process.env,
    });
  })().catch((error) => {
    ompManagedStacks.delete(workspaceId);
    throw error;
  });
  ompManagedStacks.set(workspaceId, stack);
  return stack;
}

// Workflow/deployment dispatch is intentionally disabled for autonomous runs.

// ── Worker identity (stable for the lifetime of this process) ────────────────

const WORKER_ID: string = crypto.randomUUID();
const WORKER_HOSTNAME: string = os.hostname();
const WORKER_STARTED_AT: Date = new Date();

const HEARTBEAT_INTERVAL_MS = 30_000; // 30 s
const OPTIONAL_WORKER_MODE = process.env.RORCA_OPTIONAL_WORKER === 'true';

function parseWorkerJsonRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function ordinaryLocalPiRequested(effectiveOptions: unknown): boolean {
  const options = parseWorkerJsonRecord(effectiveOptions);
  const safety = parseWorkerJsonRecord(options?.safety);
  return safety?.ordinaryLocalPi === true;
}

function frozenPiExecutableFromOptions(effectiveOptions: unknown): FrozenPiExecutableIdentity | null {
  const options = parseWorkerJsonRecord(effectiveOptions);
  const runtime = parseWorkerJsonRecord(options?.runtime);
  const executable = parseWorkerJsonRecord(runtime?.piExecutable);
  if (!executable
    || typeof executable.piBinPath !== 'string'
    || typeof executable.piRealPath !== 'string') return null;
  return {
    piBinPath: executable.piBinPath,
    piRealPath: executable.piRealPath,
  };
}

function readinessOverrideWasRequested(triggerOptions: unknown): boolean {
  const options = parseWorkerJsonRecord(triggerOptions);
  return options?.readinessOverride === true
    || options?.runAnywayOverride === true
    || options?.overrideReadinessGate === true;
}

function canonicalWorkerDirectory(value: unknown): string | null {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return null;
  try {
    return fs.statSync(value).isDirectory() ? fs.realpathSync(value) : null;
  } catch {
    return null;
  }
}

function frozenExecutionManifestAgents(executionManifestPath: string | undefined): string[] | null {
  if (!executionManifestPath || !fs.existsSync(executionManifestPath)) return null;
  try {
    const manifests = JSON.parse(fs.readFileSync(executionManifestPath, 'utf8')) as unknown;
    if (!Array.isArray(manifests) || manifests.length === 0) return null;
    const agents = manifests.map((candidate) => {
      const execution = parseWorkerJsonRecord(parseWorkerJsonRecord(candidate)?.execution);
      return typeof execution?.agent === 'string' ? execution.agent : null;
    });
    return agents.every((candidate): candidate is string => candidate !== null) ? agents : null;
  } catch {
    return null;
  }
}

function frozenExecutionManifestModels(executionManifestPath: string | undefined): string[] {
  if (!executionManifestPath || !fs.existsSync(executionManifestPath)) return [];
  try {
    const manifests = JSON.parse(fs.readFileSync(executionManifestPath, 'utf8')) as unknown;
    if (!Array.isArray(manifests)) return [];
    return manifests.flatMap((candidate) => {
      const execution = parseWorkerJsonRecord(parseWorkerJsonRecord(candidate)?.execution);
      return typeof execution?.model === 'string' ? [execution.model] : [];
    });
  } catch {
    return [];
  }
}

function frozenExecutionManifestIsOrdinaryLocalOnly(executionManifestPath: string | undefined): boolean {
  const agents = frozenExecutionManifestAgents(executionManifestPath);
  return agents !== null && agents.every(agent => agent === 'pi' || agent === 'omp');
}

function frozenExecutionManifestIsOmpOnly(executionManifestPath: string | undefined): boolean {
  const agents = frozenExecutionManifestAgents(executionManifestPath);
  return agents !== null && agents.every(agent => agent === 'omp');
}

function frozenExecutionManifestHasPi(executionManifestPath: string | undefined): boolean {
  return frozenExecutionManifestAgents(executionManifestPath)?.includes('pi') === true;
}

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
  return replayFallbackResults(cwd, workspaceId, runId);
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

async function validatePiStoryCloseoutEvidence(runId: number): Promise<Array<{ storyId: string; reason: string }>> {
  const results = await query<{ story_id: string; status: string; log_path: string | null }>(
    'SELECT story_id, status, log_path FROM story_results WHERE run_id = $1 ORDER BY id ASC',
    [runId],
  );
  const latestByStory = new Map<string, { status: string; logPath: string | null }>();
  for (const result of results) {
    latestByStory.set(result.story_id, { status: result.status, logPath: result.log_path });
  }

  const failures: Array<{ storyId: string; reason: string }> = [];
  for (const [storyId, result] of latestByStory) {
    if (result.status !== 'pass') continue;
    if (!result.logPath || !fs.existsSync(result.logPath)) {
      failures.push({ storyId, reason: 'pi_log_missing' });
      continue;
    }
    try {
      const evidence = evaluatePiStoryCloseoutEvidence(fs.readFileSync(result.logPath, 'utf8'));
      if (!evidence.ok) failures.push({ storyId, reason: evidence.reason! });
    } catch {
      failures.push({ storyId, reason: 'pi_log_unreadable' });
    }
  }
  return failures;
}
// Remote PR discovery/creation is release-authority owned; no gh CLI fallback.

// Final base integration is delegated to merge-handler.performMerge.

// ── Job handler: pipeline:run ─────────────────────────────────────────────

async function assertCurrentWaveRunDispatch(input: {
  runId: number;
  parallelism: number;
  payload: PipelineRunJobPayloadType;
}): Promise<WavePolicyEnvelope> {
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
  assertNotProtectedWave1Run(runId);
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
  assertNotProtectedWave1Run(runId);
  const run = await queryOne<{ status: string; workspace_id: string }>(
    'SELECT status, workspace_id FROM pipeline_runs WHERE id = $1', [runId],
  );
  if (!run) return { outcome: 'run_missing', quiescent: true };
  if (run.status === 'queued') {
    const terminal = await terminalizeCanonicalCancellation({ runId, source, processQuiescent: true });
    return { outcome: terminal.outcome, quiescent: true };
  }
  if (['done', 'failed', 'partial_failure', 'cancelled'].includes(run.status)) {
    // Already terminal: no contradictory closeout is possible (the run-status
    // guard would reject it). The pending cancellation request is satisfied by
    // the canonical terminalizer, which clears the request row.
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
function freshRunPreflightFailureDeps(_runId: number): Parameters<typeof terminalizeFreshRunPreflightFailure>[2] {
  return {
    bindFailure: (id, failureReason) => queryOne<{ workspace_id: string }>(`
      UPDATE pipeline_runs run
         SET status = 'failed', finished_at = NOW(), summary = $2
        FROM pipeline_dispatch_publications publication
       WHERE run.id = $1 AND publication.run_id = run.id
         AND (
           (run.status = 'queued' AND publication.state = 'claimed' AND publication.lease_owner = $3)
           OR (run.status IN ('starting', 'running') AND run.dispatch_owner = $3)
         )
       RETURNING run.workspace_id
    `, [id, failureReason, WORKER_ID]),
    recordFailureAuthority: async (id, failureWorkspaceId, failureReason) => {
      await synthesizeAllMissingFrozenStoryFailures(id, failureWorkspaceId, failureReason);
    },
    transition: transitionRunLifecycle,
    persistCloseout: (id) => persistHostRunCloseout({
      runId: id,
      status: 'failed',
      terminalizeRun: true,
    }),
    advance: advanceQueue,
  };
}

export async function handlePipelineRun(
  jobs: PgBoss.Job<Record<string, unknown>>[],
  queueName?: typeof PIPELINE_RUN_QUEUE | typeof PIPELINE_DIRECT_RUN_QUEUE,
  executionBudget?: PipelineExecutionBudget,
): Promise<void> {
  // Batch preflight is deliberately outside Promise.allSettled: a protected
  // identity must escape before the generic pre-spawn terminalizer can turn the
  // denial into a pipeline_runs read or mutation.
  for (const job of jobs) {
    const parsed = PipelineRunJobPayload.safeParse(job.data);
    if (parsed.success) assertNotProtectedWave1Run(parsed.data.runId);
  }
  // Batch jobs remain concurrent, but each job retains lexical ownership until
  // its child and semantic closeout are terminal. No detached child can outlive
  // the exact broker/runtime/Git identities acquired by this callback.
  const outcomes = await Promise.allSettled(jobs.map(async (job) => {
    const resources = new WorkerRunResourceOwner({
      onChildActive: (id, child) => activeProcesses.set(id, child),
      onChildInactive: (id, child) => {
        if (activeProcesses.get(id) === child) activeProcesses.delete(id);
      },
    });
    try {
    const jobId = job.id;
    assertExecutionJobPayloadRedacted(job.data);
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


    // Local-user jobs belong to the signed local runner, never this remote worker.
    if (executionEnvironment !== 'remote-rorca') {
      logger.error({ jobId, runId, executionEnvironment }, '[worker] unsupported execution environment reached remote worker');
      throw new Error(`unsupported_execution_environment:${executionEnvironment}`);
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
      trigger_options: unknown;
      execution_environment: string | null;
      agent_type: string | null;
      orchestration_mode: string | null;
      dispatch_effective_options_hash: string | null;
    }>(
      `SELECT workspace_id, parallelism, branch_name, worktree_path,
              execution_workspace_path, execution_worktree_path, task_manifest_id,
              effective_options, trigger_options, execution_environment, agent_type,
              orchestration_mode, dispatch_effective_options_hash
         FROM pipeline_runs WHERE id = $1`,
      [runId],
    );


    if (!runRow) {
      logger.error({ jobId, runId }, '[worker] pipeline_runs row disappeared before budget admission');
      throw new Error('pipeline_run_missing_before_budget_admission');
    }
    const { workspace_id: workspaceId, parallelism } = runRow;
    const frozenBranchName = runRow.branch_name;
    if (!frozenBranchName) throw new Error('Pipeline run has no frozen canonical branch');
    // 1b. Capacity and the queued -> starting ownership transition share the
    // same workspace-serialized transaction in claimWaveProductionDispatch.
    // A standalone COUNT here would let concurrent non-worktree deliveries
    // both observe one free checkout and oversubscribe it.
    const { queueMaxConcurrent } = await getWorkerConcurrencySettings();

    // Keep the exact application publication and pg-boss callback while direct
    // workspace capacity is occupied. Re-sending would create a transport UUID
    // that cannot match the immutable publication identity.
    let claimedWavePolicy!: WavePolicyEnvelope;
    const acquireDispatchAuthority = async (): Promise<'claimed' | 'capacity_exhausted' | 'terminal'> => {
      try {
        // Publication and queued -> starting authority are acquired only after
        // process-budget admission. A callback waiting behind long retry work
        // therefore remains restartable as its exact published transport.
        const publicationClaim = await claimDispatchForWorker({
          runId,
          bossJobId: jobId,
          payload: job.data,
          workerId: WORKER_ID,
          queueName,
        });
        if (!publicationClaim.claimed) {
          logger.info(
            { runId, jobId, reason: publicationClaim.reason },
            '[worker] pipeline:run delivery did not acquire application publication authority',
          );
          return 'terminal';
        }
        claimedWavePolicy = await assertCurrentWaveRunDispatch({
          runId,
          parallelism: Number(parallelism ?? 1),
          payload,
        });
        const claim = await claimWaveProductionDispatch({
          runId,
          owner: WORKER_ID,
          envelope: claimedWavePolicy,
          nonWorktreeWorkspaceCapacity: queueMaxConcurrent,
        });
        if (claim.claimed) return 'claimed';
        if (claim.reason === 'cancellation_requested') {
          await finalizeFreshRunCancellation(runId, 'worker_workspace_capacity_wait');
          return 'terminal';
        }
        if (claim.reason === 'run_not_queued') {
          logger.info({ runId, reason: claim.reason }, '[worker] dispatch claim superseded without failure terminalization');
          return 'terminal';
        }
        if (claim.reason === 'workspace_capacity_exhausted') {
          logger.info(
            { runId, workspaceId, queueMaxConcurrent },
            '[worker] Direct-workspace capacity occupied — retaining exact callback ownership',
          );
          await releaseDispatchWorkerClaim({
            runId,
            bossJobId: jobId,
            workerId: WORKER_ID,
            reason: 'workspace_capacity_exhausted_before_start',
          });
          return 'capacity_exhausted';
        }
        throw new Error(`[wave-production-policy] atomic dispatch claim denied: ${claim.reason}`);
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
        // Throw into the shared fresh-run preflight terminalizer, which binds
        // the failure, lifecycle, closeout/finished, and queue advancement.
        throw error;
      }
    };
    const waitForWorkspaceCapacity = async (): Promise<void> => {
      const { promise: capacityRetryDelay, resolve: resumeCapacityClaim } = Promise.withResolvers<void>();
      setTimeout(resumeCapacityClaim, 10_000);
      await capacityRetryDelay;
    };
    const executeClaimedRun = async (): Promise<void> => {
    // Managed work can never fall through to an unmetered generic engine.
    // No production bounded adapter is qualified/installed in this build.
    if (await executeEcoManagedWorker({ runId, payload: job.data, transaction,worker:{ownerId:WORKER_ID},
      closeout: async () => { await persistHostRunCloseout({runId,status:'done',terminalizeRun:true}); },
    })) return;
    // W5-008: omp lane dispatch handling. A worker crash after a same-session
    // continuation prompt must settle/fence the durable dispatch exactly once
    // before a fresh engine launch can observe the same scope. omp runs
    // reconcile here; missing omp stays fail-closed (the engine requires it).
    if ((runRow.agent_type ?? null) === 'omp' && workspaceId) {
      try {
        const ompStack = await getOmpManagedStack(workspaceId);
        const reconciled = await reconcileOmpManagedDispatches(ompStack.lane, workspaceId, runId);
        if (reconciled.length > 0) {
          logger.info({ runId, workspaceId, reconciled: reconciled.map((entry) => entry.outcome) }, '[worker] omp lane dispatch reconciliation complete');
        }
      } catch (error) {
        // A continuation fence that cannot be proven (unproved prior process
        // group death) aborts the engine launch — never launch over a possibly
        // live writer.
        if (error instanceof ManagedAdmissionError && error.reason === 'fence_lost') {
          // Fail closed but terminal: never launch over a possibly-live omp
          // writer, and never wedge the queue with an infinitely retried job.
          // The run closes as failed with the fence reason; the operator can
          // retry after the orphaned writer exits.
          await terminalizeFreshRunPreflightFailure(runId, 'omp_dispatch_fence_lost', freshRunPreflightFailureDeps(runId));
          logger.error({ err: error, runId, workspaceId }, '[worker] omp lane dispatch fence lost; run terminalized as failed');
          return;
        }
        logger.error({ err: error, runId, workspaceId }, '[worker] omp lane dispatch reconciliation unavailable; engine fails closed on missing omp');
      }
    }
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
      if (readinessOverrideWasRequested(runRow.trigger_options)) {
        throw new RorcaExecutionSandboxError(
          'linux_bwrap_required_for_requested_mode',
          'linux_bwrap_required_for_requested_mode: TaskManifest run authority contains a forbidden readiness override',
        );
      }
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

    const jobExecutionDeadlineAt = Date.now() + payload.executionTimeoutSeconds * 1_000;

    // Re-derive the sandbox posture from immutable run state. The narrow
    // Darwin exception exists only for a worker-issued ordinary branch or
    // bounded TaskManifest Pi PR profile; a queue payload can never broaden it.
    const effectiveOptions = parseWorkerJsonRecord(runRow.effective_options);
    const effectiveWorktree = parseWorkerJsonRecord(effectiveOptions?.worktree);
    const effectiveMerge = parseWorkerJsonRecord(effectiveOptions?.merge);
    const effectiveSafety = parseWorkerJsonRecord(effectiveOptions?.safety);
    const effectiveTerminal = effectiveOptions?.terminal;
    const effectiveWorktreePath = canonicalWorkerDirectory(effectiveWorktree?.path);
    const localPiRequested = ordinaryLocalPiRequested(runRow.effective_options);
    const frozenPiExecutable = frozenPiExecutableFromOptions(runRow.effective_options);
    const piExecutionRequired = frozenExecutionManifestHasPi(executionManifestPath);
    const frozenPiExecutableRequired = piExecutionRequired || (localPiRequested && process.platform === 'darwin');
    if (frozenPiExecutableRequired && !frozenPiExecutable) {
      throw new RorcaExecutionSandboxError(
        'pi_not_installed',
        'pi_not_installed: immutable run authority lacks its frozen Pi executable identity',
      );
    }
    const revalidatedPiExecutable = frozenPiExecutable
      ? revalidateFrozenPiExecutableIdentity(frozenPiExecutable)
      : null;
    if (localPiRequested && (
      agent !== runRow.agent_type
      || !['pi', 'omp'].includes(agent)
      || payload.autoWorktree !== true
      || payload.autoMerge !== false
      || payloadParallelism !== 1
      || orchestrationMode !== 'sequential'
      || executionEnvironment !== 'remote-rorca'
      || effectiveWorktree?.enabled !== true
      || effectiveWorktreePath !== cwd
      || effectiveWorktree?.branch !== frozenBranchName
      || effectiveMerge?.strategy !== payload.mergeStrategy
      || effectiveMerge?.autoMerge !== payload.autoMerge
      || effectiveSafety?.deploy !== payload.safetyOptions.deploy
      || effectiveSafety?.externalSend !== payload.safetyOptions.externalSend
      || effectiveSafety?.policyLocked !== payload.safetyOptions.policyLocked
      || effectiveTerminal !== terminalMode
      || runRow.execution_environment !== 'remote-rorca'
      || runRow.orchestration_mode !== 'sequential'
    )) {
      throw new RorcaExecutionSandboxError(
        'linux_bwrap_required_for_requested_mode',
        'linux_bwrap_required_for_requested_mode: immutable run options no longer satisfy the ordinary local Pi profile',
      );
    }
    const executionSandbox = resolveRorcaExecutionSandboxProfile({
      ordinaryLocalPiProfileRequested: localPiRequested,
      agent: runRow.agent_type ?? agent,
      allRequiredAgentsOrdinaryLocal: frozenExecutionManifestIsOrdinaryLocalOnly(executionManifestPath),
      allRequiredAgentsOmp: frozenExecutionManifestIsOmpOnly(executionManifestPath),
      allStoriesSelected: !specificStory && !startFromStoryId,
      autoWorktree: effectiveWorktree?.enabled === true,
      workspacePath: frozenExecution.workspacePath,
      worktreePath: cwd,
      branchName: frozenBranchName,
      autoMerge: effectiveMerge?.autoMerge === true,
      mergeStrategy: typeof effectiveMerge?.strategy === 'string' ? effectiveMerge.strategy : '',
      deploy: effectiveSafety?.deploy === true,
      externalSend: effectiveSafety?.externalSend === true,
      policyLocked: effectiveSafety?.policyLocked === true,
      parallelism: Number(parallelism ?? 1),
      orchestrationMode: runRow.orchestration_mode ?? orchestrationMode,
      terminalMode: typeof effectiveTerminal === 'string' ? effectiveTerminal : terminalMode,
      executionEnvironment: runRow.execution_environment ?? executionEnvironment,
      taskManifestAuthority: Boolean(runRow.task_manifest_id),
      readinessOverride: false,
      requireConcreteWorktree: localPiRequested,
      ...(revalidatedPiExecutable ? { frozenPiExecutable: revalidatedPiExecutable } : {}),
      requireFrozenPiExecutable: frozenPiExecutableRequired,
    });
    const autonomousGitRoot = createAutonomousGitState(runId, cwd, frozenBranchName);
    resources.own('run-private Git state', () => removeAutonomousGitState(autonomousGitRoot));
    const ordinaryLocalPiRuntimeProfile: OrdinaryLocalPiRuntimeProfile | null = executionSandbox.mode === 'darwin-local-pi'
      ? (() => {
        const runtimeRoot = createOrdinaryLocalPiRuntimeState(runId);
        resources.own('ordinary-local Pi runtime', () => removeOrdinaryLocalPiRuntimeState(runtimeRoot));
        return {
          schemaVersion: ORDINARY_LOCAL_PI_PROFILE_VERSION,
          runId,
          workspacePath: frozenExecution.workspacePath,
          worktreePath: cwd,
          branchName: frozenBranchName,
          piBinPath: executionSandbox.piBinPath!,
          piRealPath: executionSandbox.piRealPath!,
          runtimeRoot,
          posture: executionSandbox.posture!,
        };
      })()
      : null;

    // Strict Linux bwrap remains unchanged. Every mode gets a distinct broker
    // bound to the immutable persisted dispatch identity; replay can observe but
    // cannot reconfigure that exact run-owned endpoint.
    if (!runRow.dispatch_effective_options_hash) {
      throw new Error('Autonomous model egress requires frozen dispatch effective-options identity');
    }
    const egressIdentity: AutonomousModelEgressRunIdentity = {
      runId,
      authorityHash: runRow.dispatch_effective_options_hash,
    };
    const runEgressEnv: NodeJS.ProcessEnv = { ...process.env };
    delete runEgressEnv.RORCA_AUTONOMOUS_EGRESS_SOCKET;
    delete runEgressEnv[AUTONOMOUS_EGRESS_RUN_ID_ENV];
    delete runEgressEnv[AUTONOMOUS_EGRESS_AUTHORITY_HASH_ENV];
    delete runEgressEnv[AUTONOMOUS_EGRESS_IDENTITY_HASH_ENV];
    runEgressEnv.RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS = resolveModelEgressHosts(
      [model, ...frozenExecutionManifestModels(executionManifestPath)],
      process.env.RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS,
    ).join(',');
    // Register the exact idempotent closer before acquisition so a partial
    // broker start is still owned by this job's finally.
    resources.own('model egress broker', () => closeAutonomousModelEgress(egressIdentity));
    if (executionSandbox.mode === 'linux-bwrap') {
      assertAutonomousExecutionBoundary({
        cwd,
        providerCapable: payload.safetyOptions.externalSend,
      });
      await ensureAutonomousModelEgress(runEgressEnv, 'linux-bwrap', egressIdentity);
    } else {
      await ensureAutonomousModelEgress(runEgressEnv, 'darwin-local-pi', egressIdentity);
    }

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
    // Every new run owns lifecycle state in a deterministic ignored snapshot.
    // Canonical source bytes remain immutable execution authority, including
    // for direct runs without a separate Git worktree.
    const expectedRunSpecPath = deriveRunSpecPath({
      runId,
      sourceSpecPath: path.join(workspacePath, specPath),
      workspacePath,
      worktreePath,
      retry: true,
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
    engineArgs.push('--branch-name', frozenBranchName);
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
      [AUTONOMOUS_GIT_STATE_ROOT_ENV]: autonomousGitRoot,
      ...taskManifestCommandGuardEnv(commandDenylist),
      RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS: runEgressEnv.RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS!,
      RORCA_AUTONOMOUS_EGRESS_SOCKET: runEgressEnv.RORCA_AUTONOMOUS_EGRESS_SOCKET!,
      [AUTONOMOUS_EGRESS_RUN_ID_ENV]: runEgressEnv[AUTONOMOUS_EGRESS_RUN_ID_ENV]!,
      [AUTONOMOUS_EGRESS_AUTHORITY_HASH_ENV]: runEgressEnv[AUTONOMOUS_EGRESS_AUTHORITY_HASH_ENV]!,
      [AUTONOMOUS_EGRESS_IDENTITY_HASH_ENV]: runEgressEnv[AUTONOMOUS_EGRESS_IDENTITY_HASH_ENV]!,
    };
    if (revalidatedPiExecutable) {
      // The engine and every nested Pi launch execute the exact route-admitted
      // launcher identity, never the worker process's current PI_BIN.
      env.PI_BIN = revalidatedPiExecutable.piBinPath;
    }
    if (ordinaryLocalPiRuntimeProfile) {
      env[ORDINARY_LOCAL_PI_PROFILE_ENV] = serializeOrdinaryLocalPiRuntimeProfile(ordinaryLocalPiRuntimeProfile);
    }
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
    if (executionManifestPath) {
      // The trusted engine issues one fresh generation per actual provider
      // subprocess and persists it while that child is stop/exec-gated.
      env.RORCA_HOST_ATTEMPT_CANCELLATION_FENCE = claimedWavePolicy.fence;
      env.RORCA_HOST_ATTEMPT_CANONICAL_SPEC_PATH = specPath;
      env.RORCA_HOST_ATTEMPT_RUN_SPEC_PATH = runSpecPath;
      env.RORCA_HOST_ATTEMPT_REPOSITORY_PATH = frozenExecution.workspacePath;
      env.RORCA_HOST_ATTEMPT_WORKER_ID = WORKER_ID;
    }

    const child = spawn(engineLauncher.bin, engineArgs, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env,
    });
    // Close/error/exit observation and active-map ownership are installed in
    // this same synchronous turn, before the first PID/fence await. The awaited
    // terminal races the whole-run deadline's bounded close-proof operation.
    resources.ownChild(child, runId);
    const childTerminal = resources.ownChildDeadline(Math.max(1, jobExecutionDeadlineAt - Date.now()));

    // The engine is held before parsing policy/spec/repository inputs. Each
    // actual provider subprocess is separately stop/exec-gated and persisted by
    // the trusted engine at the story-attempt boundary.

    // The engine stays at the start gate until its ownership is fenced. Each
    // provider is separately persisted and released by the engine itself.

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
        // Do not await an unbounded terminal promise here. The owner performs
        // SIGTERM/SIGKILL escalation and removes the active identity only once
        // the child is quiescent, before durable cancellation terminalization.
        await resources.dispose();
        await finalizeFreshRunCancellation(runId, 'worker_before_launch_lifecycle_advance');
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
        // The lexical owner supplies the bounded quiescence proof; never leave
        // a cancellation branch waiting indefinitely for a misbehaving child.
        await resources.dispose();
        await finalizeFreshRunCancellation(runId, 'worker_before_launch_gate_release');
        return;
      }
      throw new Error(`[wave-production-policy] engine launch gate ${launchRelease}`);
    }

    // 6. Persist stdout/stderr in observed order. ChildProcess `close` only
    // proves its streams ended; it does not await database writes begun by data
    // handlers. The closeout barrier below drains these writes first.
    const sequenceRef = { value: 1 };
    const outputDrain = new OrderedOutputDrain(
      async (data) => writeBufferAsChunks(runId, data, sequenceRef),
    );

    child.stdout?.on('data', (data: Buffer) => { outputDrain.append(data); });
    child.stderr?.on('data', (data: Buffer) => { outputDrain.append(data); });

    // 7. The lexical job now awaits the immediate terminal observer. `close`
    // remains the successful transport boundary because stdio is fully drained;
    // spawn `error` is a distinct fail-closed path. Both converge before the
    // owner finally releases any broker/runtime/control state.
    const handleChildClose = async (capturedCode: number | null, capturedSignal: NodeJS.Signals | null): Promise<void> => {
      let semanticCloseoutCompleted = false;
      try {
        await outputDrain.drain();
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
        const wasCancelled = cancellingRuns.delete(runId);
        if (executionManifestPath) {
          const unfinishedOutcome = wasCancelled
            ? 'cancelled' as const
            : code !== null && code !== 0
              ? 'nonzero_exit' as const
              : 'crash' as const;
          await finalizeUnfinishedHostAttemptGeneration({
            workspaceId: String(workspaceId),
            runId,
            cancellationFence: claimedWavePolicy.fence,
            outcome: unfinishedOutcome,
            provenance: wasCancelled ? 'host_cancellation' : code !== null ? 'host_process' : 'host_recovery',
            exitCode: code,
            exitSignal: signal,
          });
        }
        let hostAuthority: RunHostAuthority | null = null;
        let hostAuthorityError: unknown;
        try {
          // Multi-run finalization spikes can transiently exhaust the pool;
          // the closeout inspection is read-only and idempotent, so retry a
          // bounded number of times before treating the run as failed.
          let authorityAttempt = 0;
          let authorityRetryError: unknown;
          while (authorityAttempt < 3) {
            authorityAttempt++;
            try {
              hostAuthority = await inspectRunHostAuthority(runId);
              break;
            } catch (error) {
              authorityRetryError = error;
              if (authorityAttempt < 3) {
                await new Promise(resolve => setTimeout(resolve, 1_500 * authorityAttempt));
              }
            }
          }
          if (hostAuthority) {
            authorityRetryError = undefined;
          }
          if (!hostAuthority && authorityRetryError) {
            throw authorityRetryError;
          }
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

        if (status === 'done' && agent === 'pi') {
          const closeoutFailures = await validatePiStoryCloseoutEvidence(runId);
          if (closeoutFailures.length > 0) {
            status = 'failed';
            logger.error(
              { runId, closeoutFailures },
              '[worker] Pi terminal evidence incomplete — refusing successful closeout',
            );
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
        // A non-successful engine exit can leave later frozen stories without
        // a result. Close every remaining frozen slot before host closeout so
        // the terminal revision can anchor an exact, retryable failure scope.
        if (status !== 'done') {
          await synthesizeAllMissingFrozenStoryFailures(runId, String(workspaceId), 'engine_exit_incomplete');
        }

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
        const reconcileSequentialCloseout = async (): Promise<void> => {
          if (
            claimedWavePolicy.effective.orchestrationMode !== 'sequential'
            || !hostAuthority?.terminalRevision
          ) return;
          const acceptedIds = new Set(hostAuthority.acceptedStoryIds);
          const acceptedByCommit = new Map(
            hostAuthority.stories
              .filter((story) => story.status === 'pass' && story.commitSha && acceptedIds.has(story.storyId))
              .map((story) => [story.commitSha!.toLowerCase(), story] as const),
          );
          if (acceptedByCommit.size === 0) return;
          const ordered = hostAuthority.integrationAncestry
            .map((revision) => acceptedByCommit.get(revision.toLowerCase()))
            .filter((story): story is NonNullable<typeof story> => Boolean(story));
          if (ordered.length !== acceptedByCommit.size) {
            throw new Error('Sequential host closeout ancestry does not cover every accepted story');
          }
          const firstCommit = ordered[0].commitSha!;
          const baseRevision = execFileSync('git', ['rev-parse', `${firstCommit}^`], {
            cwd: hostAuthority.checkoutPath,
            encoding: 'utf8',
          }).trim().toLowerCase();
          const reconciliation = await reconcileFinalizedSequentialIntegrations({
            integrationAncestry: hostAuthority.integrationAncestry,
            runId,
            baseRevision,
            terminalRevision: hostAuthority.terminalRevision,
            stories: ordered.map((story) => ({
              storyId: story.storyId,
              resultId: story.resultId,
              commitSha: story.commitSha!,
            })),
          });
          logger.info({ runId, ...reconciliation }, '[worker] Sequential integration ledger reconciled from host closeout');
        };

        const hostReleaseOwned = status === 'done' && hostAuthority?.releaseEligible === true;
        if (hostReleaseOwned) {
          await persistHostRunCloseout({
            runId,
            status: 'done',
            terminalizeRun: false,
            expectedDispatchFence: claimedWavePolicy.fence,
          });
          await reconcileSequentialCloseout();
          await prepareRunReleaseIntent({
            hostAuthority: hostAuthority!,
            mergeStrategy: payload.mergeStrategy ?? 'direct',
            autoMerge: payload.autoMerge === true,
            externalSend: payload.safetyOptions.externalSend === true,
            expectedDispatchFence: claimedWavePolicy.fence,
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
            expectedDispatchFence: claimedWavePolicy.fence,
          });
          await reconcileSequentialCloseout();
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
              ...buildMaintenanceLifecycleInvalidation({
                workspaceId: String(workspaceId),
                specId: path.basename(specPath, '.json'),
                runId,
                changeKind: 'evidence_persisted',
              }),
              learnCloseoutStatus: learnCloseout?.status ?? 'blocked',
            });
          } catch (learnError) {
            logger.warn({ learnError, runId }, '[worker] non-authoritative learn closeout failed after terminal release');
          }
        }

        // US-009: Run findings feed-forward is non-authoritative and cannot
        // regress an already durable release/terminal decision. Findings are
        // persisted as capture candidates only — nothing here promotes them.
        if (status === 'done' || status === 'failed' || status === 'partial_failure') {
          try {
            const findings = await tryDeriveAndPersistRunFindings(runId, String(workspaceId));
            if (findings.ok && findings.inserted > 0) {
              logger.info(
                { runId, inserted: findings.inserted, total: findings.findings.length },
                '[worker] persisted run findings as capture candidates',
              );
            }
          } catch (findingsError) {
            logger.warn({ findingsError, runId }, '[worker] non-authoritative run findings derivation failed after terminal closeout');
          }
        }

        if (status !== 'release_pending') {
          await transitionRunLifecycle(runId, wasCancelled ? 'cancelled' : (status === 'done' ? 'finished' : 'failed'), {
            owner: 'worker', outcome: status, mergeGate: effectiveMergeStrategy,
          });
        }

        // Queue advancement is durable closeout work. A failure must reject the
        // callback rather than acknowledge a semantically incomplete terminal.
        await advanceQueue(String(workspaceId));
      } catch (err) {
        // The outer batch terminalizer runs only after this callback's finally
        // has proved child quiescence and disposed every exact resource. Never
        // acknowledge a persistence failure or publish an ad hoc terminal row.
        logger.error({ err, runId, semanticCloseoutCompleted }, '[worker] close handler failed');
        throw new WorkerTerminalPersistenceError('Fresh run terminal persistence did not complete', err);
      }
    };

    const handleChildError = async (err: Error): Promise<never> => {
      logger.error({ err, runId }, '[worker] execution-engine spawn error');
      // `error` can precede `close` while the child still owns a live PID.
      // Dispose first so TERM/KILL plus close proof precede every durable
      // terminal row, trusted event, and queue advancement.
      await resources.dispose();
      await outputDrain.drain();
      cancellingRuns.delete(runId);
      throw new Error(`execution_engine_child_error:${err.message}`, { cause: err });
    };

    const terminal = await childTerminal;
    if (terminal.kind === 'error') await handleChildError(terminal.error ?? new Error('execution-engine spawn error'));
    else await handleChildClose(terminal.code, terminal.signal);
    logger.info({ runId, pid: child.pid, terminal: terminal.kind }, '[worker] Engine ownership reached terminal closeout');
    };
    if (executionBudget) {
      return await executeWithPipelineBudget(
        executionBudget,
        acquireDispatchAuthority,
        executeClaimedRun,
        waitForWorkspaceCapacity,
      );
    }
    while (true) {
      const admission = await acquireDispatchAuthority();
      if (admission === 'claimed') return executeClaimedRun();
      if (admission === 'terminal') return;
      await waitForWorkspaceCapacity();
    }
    } finally {
      await resources.dispose();
    }
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
    if (includesWorkerChildQuiescenceError(outcome.reason)) {
      // No close/TERM/KILL proof means durable terminalization would lie about
      // process ownership. Preserve application state for exact recovery.
      unboundFailures.push(outcome.reason);
      continue;
    }
    const reasonText = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
    logger.error({ runId, error: outcome.reason, reasonText }, '[worker] Fresh pipeline run rejected before spawn');
    const reason = outcome.reason instanceof RorcaExecutionSandboxError
      ? outcome.reason.code
      : /sandbox|isolation|bubblewrap/i.test(reasonText)
        ? 'autonomous_sandbox_preflight_failed'
        : /egress|broker/i.test(reasonText)
          ? 'autonomous_model_egress_preflight_failed'
          : 'worker_preflight_failed';
    await terminalizeFreshRunPreflightFailure(runId, reason, freshRunPreflightFailureDeps(runId));
    logger.error({ runId, reason }, '[worker] Fresh pipeline run rejected before spawn and was terminalized');
    if (outcome.reason instanceof WorkerTerminalPersistenceError
      || includesWorkerResourceCleanupError(outcome.reason)) {
      unboundFailures.push(outcome.reason);
    }
  }
  if (unboundFailures.length > 0) {
    throw new AggregateError(unboundFailures, 'One or more pipeline:run jobs failed before acknowledged terminal reconciliation');
  }
}

// ── Job handler: pipeline:retry ───────────────────────────────────────────


export async function handlePipelineRetry(jobs: PgBoss.Job<Record<string, unknown>>[]): Promise<void> {
  for (const job of jobs) {
    const parsed = PipelineRetryJobPayload.safeParse(job.data);
    if (parsed.success) {
      assertNotProtectedWave1Run(parsed.data.runId);
      assertNotProtectedWave1Run(parsed.data.originalRunId);
    }
  }
  const outcomes = await Promise.allSettled(jobs.map(async (job) => {
    const resources = new WorkerRunResourceOwner({
      onChildActive: (id, child) => activeProcesses.set(id, child),
      onChildInactive: (id, child) => {
        if (activeProcesses.get(id) === child) activeProcesses.delete(id);
      },
    });
    let executionClaim: { runId: number; workspaceId: string } | null = null;
    try {
    const jobId = job.id;
    assertExecutionJobPayloadRedacted(job.data);
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
    const lifecycleDispatchClaim = parseLifecycleDispatchClaim(triggerOptions?.lifecycleDispatchClaim);
    if (!lifecycleDispatchClaim) {
      throw new Error('[governed-retry] queue payload lacks an immutable lifecycle dispatch claim');
    }
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
      task_manifest_id: string | null; effective_options: unknown;
      agent_type: string | null; execution_environment: string | null; orchestration_mode: string | null;
    }>(
      `SELECT workspace_id, parallelism, terminal_mode, branch_name, status, spec_path,
              worktree_path, execution_workspace_path, execution_worktree_path,
              retried_from_run_id, pid, task_manifest_id, effective_options,
              agent_type, execution_environment, orchestration_mode FROM pipeline_runs WHERE id = $1`,
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
      lifecycleDispatchClaim,
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
    const expectedExecutionManifestPath = deriveStoryExecutionManifestPath({
      runId,
      executionRoot: cwd,
    });
    if (executionManifestPath !== expectedExecutionManifestPath) {
      await refuseBeforeClaim('retry_execution_manifest_path_authority_mismatch');
      return;
    }
    if (!fs.existsSync(expectedExecutionManifestPath)) {
      await refuseBeforeClaim('retry_execution_manifest_missing');
      return;
    }
    const manifestBundle = JSON.parse(fs.readFileSync(expectedExecutionManifestPath, 'utf8')) as Array<{ manifestHash?: string }>;
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
    const claimed = await claimGovernedRetryExecutionLease({
      runId,
      previewHash,
      dispatchIdentityHash: dispatchIdentity.identityHash,
      leaseOwner,
    });
    if (!claimed) {
      logger.info({ jobId, runId, identityHash: dispatchIdentity.identityHash }, '[worker] duplicate retry delivery fenced before agent start');
      return;
    }
    const jobExecutionDeadlineAt = Date.now() + payload.executionTimeoutSeconds * 1_000;
    const fencingToken = claimed.fencingToken;
    if (await executeEcoManagedWorker({runId,payload:job.data,transaction,
      worker:{ownerId:leaseOwner,retryIdentityHash:dispatchIdentity.identityHash,fence:fencingToken},
      closeout:async()=>{await persistHostRunCloseout({runId,status:'done',terminalizeRun:true,expectedDispatchFence:claimed.hostAttemptFence});},
    })) return;
    const executing = await markGovernedRetryLeaseExecuting({
      runId,
      dispatchIdentityHash: dispatchIdentity.identityHash,
      fencingToken,
      leaseOwner,
    });
    if (!executing) {
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

    // From this point every throw is a partial-start failure owned by this
    // exact dispatch. The outer catch quiesces resources before idempotent
    // durable terminalization and queue convergence.
    executionClaim = { runId, workspaceId };
    if (!branchName) throw new Error('Retry run has no frozen canonical branch');
    const autonomousGitRoot = createAutonomousGitState(runId, cwd, branchName);
    resources.own('run-private Git state', () => removeAutonomousGitState(autonomousGitRoot));
    // Re-derive the sandbox posture from immutable retry-run state, exactly as
    // the fresh path does. The narrow Darwin exception exists only for the
    // worker-issued ordinary branch or bounded TaskManifest Pi PR profile; a
    // queue payload can never broaden it. Linux retries keep bwrap.
    const retryEffectiveOptions = parseWorkerJsonRecord(runRow.effective_options);
    const retryEffectiveWorktree = parseWorkerJsonRecord(retryEffectiveOptions?.worktree);
    const retryEffectiveMerge = parseWorkerJsonRecord(retryEffectiveOptions?.merge);
    const retryEffectiveSafety = parseWorkerJsonRecord(retryEffectiveOptions?.safety);
    const retryEffectiveTerminal = retryEffectiveOptions?.terminal;
    const localPiRequested = retryEffectiveSafety?.ordinaryLocalPi === true;
    const frozenPiExecutable = frozenPiExecutableFromOptions(runRow.effective_options);
    const piExecutionRequired = frozenExecutionManifestHasPi(executionManifestPath);
    const frozenPiExecutableRequired = piExecutionRequired || (localPiRequested && process.platform === 'darwin');
    if (frozenPiExecutableRequired && !frozenPiExecutable) {
      throw new RorcaExecutionSandboxError(
        'pi_not_installed',
        'pi_not_installed: immutable retry authority lacks its frozen Pi executable identity',
      );
    }
    const revalidatedPiExecutable = frozenPiExecutable
      ? revalidateFrozenPiExecutableIdentity(frozenPiExecutable)
      : null;
    if (localPiRequested && (
      agent !== runRow.agent_type
      || !['pi', 'omp'].includes(agent)
    )) {
      throw new RorcaExecutionSandboxError(
        'linux_bwrap_required_for_requested_mode',
        'linux_bwrap_required_for_requested_mode: immutable retry options no longer satisfy the ordinary local Pi profile',
      );
    }
    const retryExecutionSandbox = resolveRorcaExecutionSandboxProfile({
      ordinaryLocalPiProfileRequested: localPiRequested,
      agent: runRow.agent_type ?? agent,
      allRequiredAgentsOrdinaryLocal: frozenExecutionManifestIsOrdinaryLocalOnly(executionManifestPath),
      allRequiredAgentsOmp: frozenExecutionManifestIsOmpOnly(executionManifestPath),
      allStoriesSelected: true,
      autoWorktree: retryEffectiveWorktree?.enabled === true,
      workspacePath: frozenRetryExecution.workspacePath,
      worktreePath: cwd,
      branchName: runRow.branch_name,
      autoMerge: retryEffectiveMerge?.autoMerge === true,
      mergeStrategy: typeof retryEffectiveMerge?.strategy === 'string' ? retryEffectiveMerge.strategy : '',
      deploy: retryEffectiveSafety?.deploy === true,
      externalSend: retryEffectiveSafety?.externalSend === true,
      policyLocked: retryEffectiveSafety?.policyLocked === true,
      parallelism: Number(parallelism ?? 1),
      orchestrationMode: runRow.orchestration_mode ?? orchestrationMode,
      terminalMode: typeof retryEffectiveTerminal === 'string' ? retryEffectiveTerminal : effectiveTerminalMode,
      executionEnvironment: runRow.execution_environment ?? 'remote-rorca',
      taskManifestAuthority: Boolean(runRow.task_manifest_id),
      readinessOverride: false,
      requireConcreteWorktree: localPiRequested,
      ...(revalidatedPiExecutable ? { frozenPiExecutable: revalidatedPiExecutable } : {}),
      requireFrozenPiExecutable: frozenPiExecutableRequired,
    });
    const retryOrdinaryLocalPiRuntimeProfile: OrdinaryLocalPiRuntimeProfile | null = retryExecutionSandbox.mode === 'darwin-local-pi'
      ? (() => {
        const runtimeRoot = createOrdinaryLocalPiRuntimeState(runId);
        resources.own('ordinary-local Pi runtime', () => removeOrdinaryLocalPiRuntimeState(runtimeRoot));
        return {
          schemaVersion: ORDINARY_LOCAL_PI_PROFILE_VERSION,
          runId,
          workspacePath: frozenRetryExecution.workspacePath,
          worktreePath: cwd,
          branchName: runRow.branch_name ?? '',
          piBinPath: retryExecutionSandbox.piBinPath!,
          piRealPath: retryExecutionSandbox.piRealPath!,
          runtimeRoot,
          posture: retryExecutionSandbox.posture!,
        };
      })()
      : null;
    const egressIdentity: AutonomousModelEgressRunIdentity = {
      runId,
      authorityHash: dispatchIdentity.identityHash,
    };
    const runEgressEnv: NodeJS.ProcessEnv = { ...process.env };
    delete runEgressEnv.RORCA_AUTONOMOUS_EGRESS_SOCKET;
    delete runEgressEnv[AUTONOMOUS_EGRESS_RUN_ID_ENV];
    delete runEgressEnv[AUTONOMOUS_EGRESS_AUTHORITY_HASH_ENV];
    delete runEgressEnv[AUTONOMOUS_EGRESS_IDENTITY_HASH_ENV];
    runEgressEnv.RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS = resolveModelEgressHosts(
      [approvedPreview.options.model],
      process.env.RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS,
    ).join(',');
    resources.own('model egress broker', () => closeAutonomousModelEgress(egressIdentity));
    if (retryExecutionSandbox.mode === 'linux-bwrap') {
      assertAutonomousExecutionBoundary({
        cwd,
        providerCapable: approvedPreview.options.safety.externalSend,
      });
      await ensureAutonomousModelEgress(runEgressEnv, 'linux-bwrap', egressIdentity);
    } else {
      await ensureAutonomousModelEgress(runEgressEnv, 'darwin-local-pi', egressIdentity);
    }

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
      logger.error({ jobId, runId, retrySpecPath, runSpecPath }, '[worker] retry spec path disappeared after the governed execution claim');
      // Throw through the exact-owner catch. It disposes broker/Git/lease state,
      // synthesizes missing frozen-story evidence, invokes the one governed
      // terminalizer, clears the lease, and advances the application queue.
      throw new Error('retry_spec_missing');
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
    const retryHostAttemptFence = claimed.hostAttemptFence;
    const retryLaunchTokenHash = `sha256:${crypto.createHash('sha256').update(retryLaunchGateToken).digest('hex')}`;
    const env: Record<string, string> = {
      ...inheritedEnvRetry,
      ...resolvedSecrets,
      ...envOverrides,
      RORCA_PROCESS_ROLE: 'engine',
      RORCA_WORKSPACE_ID: workspaceId,
      RORCA_TERMINAL_MODE: effectiveTerminalMode,
      RORCA_ENGINE_START_GATE_TOKEN: retryLaunchGateToken,
      RORCA_HOST_ATTEMPT_CANCELLATION_FENCE: retryHostAttemptFence,
      RORCA_HOST_ATTEMPT_CANONICAL_SPEC_PATH: specPath,
      RORCA_HOST_ATTEMPT_RUN_SPEC_PATH: expectedRetrySpecPath,
      RORCA_HOST_ATTEMPT_REPOSITORY_PATH: workspacePath,
      RORCA_HOST_ATTEMPT_WORKER_ID: WORKER_ID,
      [AUTONOMOUS_GIT_STATE_ROOT_ENV]: autonomousGitRoot,
      RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS: runEgressEnv.RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS!,
      RORCA_AUTONOMOUS_EGRESS_SOCKET: runEgressEnv.RORCA_AUTONOMOUS_EGRESS_SOCKET!,
      [AUTONOMOUS_EGRESS_RUN_ID_ENV]: runEgressEnv[AUTONOMOUS_EGRESS_RUN_ID_ENV]!,
      [AUTONOMOUS_EGRESS_AUTHORITY_HASH_ENV]: runEgressEnv[AUTONOMOUS_EGRESS_AUTHORITY_HASH_ENV]!,
      [AUTONOMOUS_EGRESS_IDENTITY_HASH_ENV]: runEgressEnv[AUTONOMOUS_EGRESS_IDENTITY_HASH_ENV]!,
    };
    if (revalidatedPiExecutable) {
      // The engine and every nested Pi launch execute the exact route-admitted
      // launcher identity, never the worker process's current PI_BIN.
      env.PI_BIN = revalidatedPiExecutable.piBinPath;
    }
    if (retryOrdinaryLocalPiRuntimeProfile) {
      env[ORDINARY_LOCAL_PI_PROFILE_ENV] = serializeOrdinaryLocalPiRuntimeProfile(retryOrdinaryLocalPiRuntimeProfile);
    }
    delete env.RORCA_QUALIFICATION_TRUSTED_ISSUERS_JSON;
    delete env.RORCA_WAVE_PRODUCTION_ACTIVATION_KEY;

    const retryFencePersisted = await execute(`
      UPDATE pipeline_runs SET dispatch_fence = $2
       WHERE id = $1 AND status IN ('queued', 'running')
         AND dispatch_fence = $2
         AND NOT EXISTS (
           SELECT 1 FROM pipeline_run_cancellation_requests cancellation
            WHERE cancellation.run_id = pipeline_runs.id
         )
    `, [runId, retryHostAttemptFence]);
    if (retryFencePersisted.rowCount !== 1) {
      throw new Error('[governed-retry] host attempt cancellation fence could not be persisted');
    }
    logger.info({ runId, agent, model, cwd, executionEngine: executionEngineEntrypoint.path, executionEngineBin: engineLauncher.bin }, '[worker] Spawning execution-engine for retry');

    const child = spawn(engineLauncher.bin, engineArgs, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env,
    });
    // Immediate terminal observation precedes every launch-fence await. The
    // awaited terminal races bounded deadline quiescence rather than relying
    // on transport expiration to abandon a still-running callback.
    resources.ownChild(child, runId);
    const childTerminal = resources.ownChildDeadline(Math.max(1, jobExecutionDeadlineAt - Date.now()));
    if (!child.pid) {
      resources.signalChild('SIGTERM');
      throw new Error('[governed-retry] host attempt authority could not observe the engine process identity');
    }
    // The retry engine remains launch-gated; each actual provider child owns a
    // fresh immutable generation persisted from inside the trusted engine.

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
          const rebound = await bindGovernedRetryProcessLaunch({
            runId,
            dispatchIdentityHash: dispatchIdentity.identityHash,
            fencingToken,
            leaseOwner,
            launchTokenHash: retryLaunchTokenHash,
            pid: enginePid,
            workerId: WORKER_ID,
            expectedPriorPid: child.pid,
          });
          if (!rebound) throw new Error('retry launch fence or canonical PID was lost');
        } catch (err) {
          logger.warn({ err, runId, enginePid }, '[worker] Failed to update fenced inner engine PID (retry)');
          try { child.kill('SIGTERM'); } catch { /* process already exited */ }
        }
      }
    });

    const launchPersisted = await bindGovernedRetryProcessLaunch({
      runId,
      dispatchIdentityHash: dispatchIdentity.identityHash,
      fencingToken,
      leaseOwner,
      launchTokenHash: retryLaunchTokenHash,
      pid: child.pid,
      workerId: WORKER_ID,
      expectedPriorPid: runRow.pid,
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

    const leaseRenewalMs = process.env.NODE_ENV === 'test'
      ? Math.max(10, Number(process.env.RORCA_TEST_RETRY_LEASE_RENEWAL_MS ?? 60_000))
      : 60_000;
    const leaseRenewal = setInterval(() => {
      void renewGovernedRetryExecutionLease({
        runId,
        dispatchIdentityHash: dispatchIdentity.identityHash,
        fencingToken,
        leaseOwner,
      }).then((renewed) => {
        if (!renewed) {
          logger.error({ runId, fencingToken }, '[worker] governed retry lease renewal lost its fence; terminating agent');
          try { child.kill('SIGTERM'); } catch { /* process already exited */ }
        }
      }).catch((error) => logger.error({ error, runId }, '[worker] governed retry lease renewal failed'));
    }, leaseRenewalMs);
    leaseRenewal.unref?.();
    resources.ownTimer(leaseRenewal);

    // 6. Persist retry stdout/stderr in observed order before retry closeout.
    const sequenceRef = { value: sequenceOffset + 1 };
    const outputDrain = new OrderedOutputDrain(
      async (data) => writeBufferAsChunks(runId, data, sequenceRef),
    );

    child.stdout?.on('data', (data: Buffer) => { outputDrain.append(data); });
    child.stderr?.on('data', (data: Buffer) => { outputDrain.append(data); });

    // 7. Wait for close (not exit), flush remaining bytes, update run status.
    // Same fix as handlePipelineRun (US-007): use 'close' so all stdout/stderr
    // data events have been emitted before we flush the pending buffer.
    const handleChildClose = async (capturedCode: number | null): Promise<void> => {
      // All emitted stream bytes must be durably persisted before closeout.
      await outputDrain.drain();
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
        const wasCancelled = cancellingRuns.delete(runId);
        await finalizeUnfinishedHostAttemptGeneration({
          workspaceId,
          runId,
          cancellationFence: retryHostAttemptFence,
          outcome: wasCancelled ? 'cancelled' : code !== null && code !== 0 ? 'nonzero_exit' : 'crash',
          provenance: wasCancelled ? 'host_cancellation' : code !== null ? 'host_process' : 'host_recovery',
          exitCode: code,
          exitSignal: null,
        });

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

        if (finalStatus === 'done'
          && (runRow.orchestration_mode ?? orchestrationMode) === 'sequential'
          && retryHostAuthority?.terminalRevision) {
          try {
            const authoritativePassed = new Set(retryHostAuthority.authoritativePassedStoryIds);
            const reconciliation = await reconcileFinalizedSequentialIntegrations({
              runId,
              baseRevision: dispatchIdentity.baseRevision,
              terminalRevision: retryHostAuthority.terminalRevision,
              integrationAncestry: retryHostAuthority.integrationAncestry,
              stories: retryHostAuthority.stories.flatMap((story) =>
                story.status === 'pass' && story.commitSha && authoritativePassed.has(story.storyId)
                  ? [{ storyId: story.storyId, resultId: story.resultId, commitSha: story.commitSha }]
                  : []),
            });
            logger.info(
              { runId, ...reconciliation },
              '[worker] Reconciled exact sequential retry integration authority',
            );
          } catch (error) {
            retryHostAuthorityError = error;
            finalStatus = 'failed';
            logger.error(
              { error, runId },
              '[worker] Sequential retry integration reconciliation failed closed',
            );
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
            throw new Error(`[governed-retry] cancellation closeout did not converge (${terminalized.outcome})`);
          }
          await advanceQueue(workspaceId);
          try { fs.unlinkSync(expectedRetrySpecPath); } catch { /* best-effort */ }
          return;
        }

        const governedFinalizedStoryIds: string[] = [];
        const authoritativePassByStory = new Map(
          (retryHostAuthority?.stories ?? []).flatMap((story) =>
            story.status === 'pass' && story.commitSha
              ? [[story.storyId, { resultId: story.resultId, commitSha: story.commitSha }] as const]
              : []),
        );
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
              const authoritativePass = authoritativePassByStory.get(attempt.story_id);
              if (!authoritativePass) continue;
              const ledger = await readExactFinalizedStoryIntegration(client, {
                runId,
                storyId: attempt.story_id,
                governedAttempt: attempt.attempt,
                storyResultId: authoritativePass.resultId,
                resultingHead: authoritativePass.commitSha,
              });
              if (!ledger) continue;
              const finalizationIdentity = retryHash({
                dispatchIdentity: dispatchIdentity.identityHash,
                storyId: attempt.story_id,
                attempt: attempt.attempt,
                resultingHead: ledger.resultingHead,
                ledgerAttempt: ledger.attempt,
                ledgerFinalization: ledger.finalizationIdentity,
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
                [dispatchIdentity.identityHash, attempt.story_id, ledger.sourceCommit, finalizationIdentity],
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
              expectedDispatchFence: retryHostAttemptFence,
            });
            await prepareRunReleaseIntent({
              hostAuthority: retryHostAuthority!,
              mergeStrategy: approvedPreview.options.merge.strategy,
              autoMerge: approvedPreview.options.merge.autoMerge,
              externalSend: approvedPreview.options.safety.externalSend,
              expectedDispatchFence: retryHostAttemptFence,
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
              expectedDispatchFence: retryHostAttemptFence,
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
              ...buildMaintenanceLifecycleInvalidation({
                workspaceId,
                specId: path.basename(runRow.spec_path, '.json'),
                runId,
                changeKind: 'evidence_persisted',
              }),
              learnCloseoutStatus: learnCloseout?.status ?? 'blocked',
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

          // US-009: Run findings feed-forward for retried runs — same
          // non-authoritative capture-candidate posture as the fresh close path.
          if (finalStatus === 'done' || finalStatus === 'failed' || finalStatus === 'partial_failure') {
            try {
              const findings = await tryDeriveAndPersistRunFindings(runId, String(workspaceId));
              if (findings.ok && findings.inserted > 0) {
                logger.info(
                  { runId, inserted: findings.inserted, total: findings.findings.length },
                  '[worker-retry] persisted run findings as capture candidates',
                );
              }
            } catch (findingsError) {
              logger.warn({ findingsError, runId }, '[worker-retry] non-authoritative run findings derivation failed after retry closeout');
            }
          }
        } catch (err) {
          terminalUpdateError = err;
          logger.error({ err, runId }, '[worker] Failed to close retry through durable release seam');
        }

        if (terminalUpdateError) {
          logger.warn({ runId, retrySpecPath: expectedRetrySpecPath }, '[worker] Preserving retry snapshot after terminal persistence failure');
          throw terminalUpdateError;
        }

        await advanceQueue(workspaceId);

        // Preserve a blocked snapshot for deterministic later refinalization.
        if (!retryRecoveryBlocked && finalStatus !== 'release_pending') {
          try { fs.unlinkSync(expectedRetrySpecPath); } catch { /* best-effort */ }
        } else {
          logger.warn({ runId, retrySpecPath: expectedRetrySpecPath }, '[worker] Preserving blocked retry snapshot for recovery');
        }

      };

      const handleChildError = async (err: Error): Promise<void> => {
        logger.error({ err, runId }, '[worker] retry execution-engine spawn error');
        // An error event is not process-death proof. Quiesce the exact owner
        // before any governed terminal row, event, lease release, or advance.
        await resources.dispose();
        await outputDrain.drain();
        cancellingRuns.delete(runId);
        await finalizeUnfinishedHostAttemptGeneration({
          workspaceId,
          runId,
          cancellationFence: retryHostAttemptFence,
          outcome: 'crash',
          provenance: 'host_recovery',
          exitCode: null,
          exitSignal: null,
        });

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
          throw terminalUpdateError;
        }

        await advanceQueue(workspaceId);
        try { fs.unlinkSync(retrySpecPath); } catch { /* best-effort */ }
      };

    const terminal = await childTerminal;
    if (terminal.kind === 'error') {
      await handleChildError(terminal.error ?? new Error('retry execution-engine spawn error'));
    } else {
      await handleChildClose(terminal.code);
    }
    } catch (error) {
      // Dispose first: terminal state must never claim process quiescence while
      // a partially-started engine or lease timer remains owned by this job.
      let disposalError: unknown;
      try {
        await resources.dispose();
      } catch (caughtDisposalError) {
        disposalError = caughtDisposalError;
        if (includesWorkerChildQuiescenceError(caughtDisposalError)) {
          throw new AggregateError(
            [error, caughtDisposalError],
            'Retry child quiescence was not proved; durable terminalization is forbidden',
          );
        }
      }
      if (executionClaim) {
        const { runId: claimedRunId, workspaceId: claimedWorkspaceId } = executionClaim;
        try {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const failureReason = errorMessage === 'retry_spec_missing'
            ? 'retry_spec_missing'
            : 'retry_partial_start_failed';
          await synthesizeAllMissingFrozenStoryFailures(claimedRunId, claimedWorkspaceId, failureReason);
          const terminalized = await terminalizeGovernedRetryRun({
            runId: claimedRunId,
            workspaceId: claimedWorkspaceId,
            requestedTerminal: 'auto',
            reason: `${failureReason}:${errorMessage}`,
            source: 'worker_retry_exact_owner_catch',
          });
          if (terminalized.outcome === 'terminalized' || terminalized.outcome === 'already_terminal') {
            await advanceQueue(claimedWorkspaceId);
          }
        } catch (terminalError) {
          throw new AggregateError(
            [error, ...(disposalError ? [disposalError] : []), terminalError],
            'Retry partial-start cleanup could not reach durable terminal state',
          );
        }
      }
      if (disposalError) {
        throw new AggregateError([error, disposalError], 'Retry terminalized after resource cleanup failure');
      }
      throw error;
    } finally {
      await resources.dispose();
    }
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

export async function handlePipelineCancel(jobs: PgBoss.Job<Record<string, unknown>>[]): Promise<void> {
  for (const job of jobs) {
    logger.info({ jobId: job.id, data: job.data }, '[worker] pipeline:cancel received');

    const parsed = PipelineCancelJobPayload.safeParse(job.data);
    if (!parsed.success) {
      logger.warn({ jobId: job.id, errors: parsed.error.format() }, '[worker] pipeline:cancel invalid payload — skipping');
      return;
    }

    const runId = parsed.data.runId;
    assertNotProtectedWave1Run(runId);
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

// ── Job handler: pipeline:closeout-reconcile ─────────────────────────────

export async function handlePipelineCloseoutReconciliation(
  jobs: PgBoss.Job<Record<string, unknown>>[],
): Promise<void> {
  for (const job of jobs) {
    logger.info({ jobId: job.id, data: job.data }, '[worker] pipeline:closeout-reconcile received');
    const result = await processCloseoutReconciliationJob({
      jobId: job.id,
      data: job.data,
      hasActiveInMemoryProcess: (runId) => activeProcesses.has(runId),
    });
    logger.info({ jobId: job.id, result }, '[worker] pipeline:closeout-reconcile finished');
  }
}

// ── Stale job recovery ───────────────────────────────────────────────────
// Called once at startup, before boss.work() registers handlers.
// Finds any pgboss.job rows that were left in state='active' by a previous
// worker that crashed (or was SIGKILL'd before draining). These jobs will
// are not safe to replay merely because the immutable whole-run-plus-closeout
// transport bound eventually expires; application reconciliation must release
// their occupied callback slots without duplicating committed work.
//
// Safe cutoff: we use WORKER_STARTED_AT as the boundary. Any job whose
// startedon < WORKER_STARTED_AT could not have been started by this process
// instance, so it is definitively orphaned.
//
// We do NOT re-queue — a partially-executed run may have committed code;
// re-running it would create duplicate commits.

export async function synthesizeAllMissingFrozenStoryFailures(
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
  assertNotProtectedWave1Run(runId);
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
       WHERE j.name IN ('pipeline:run', 'pipeline:run:direct', 'pipeline:retry')
         AND j.state = 'active'
         AND j.started_on < $1
         AND (j.data->>'runId')::bigint <> $3
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
      [WORKER_STARTED_AT, WORKER_ID, WAVE_1_PROTECTED_GENESIS_RUN_ID],
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

    const runRow = await queryOne<{
      workspace_id: string;
      status: string;
      pid: number | null;
      dispatch_owner: string | null;
      publication_state: string | null;
      publication_lease_owner: string | null;
      cancellation_requested: boolean;
      retry_dispatch_state: string | null;
      retry_boss_job_id: string | null;
      retry_lease_owner: string | null;
      retry_lease_expires_at: Date | string | null;
      retry_launch_pid: number | null;
      retry_cancellation_requested: boolean;
    }>(
      `SELECT run.workspace_id, run.status, run.pid, run.dispatch_owner,
              publication.state AS publication_state,
              publication.lease_owner AS publication_lease_owner,
              retry_dispatch.state AS retry_dispatch_state,
              retry_dispatch.boss_job_id::text AS retry_boss_job_id,
              retry_dispatch.lease_owner AS retry_lease_owner,
              retry_dispatch.lease_expires_at AS retry_lease_expires_at,
              retry_dispatch.launch_pid AS retry_launch_pid,
              retry_dispatch.cancellation_requested_at IS NOT NULL AS retry_cancellation_requested,
              EXISTS (
                SELECT 1 FROM pipeline_run_cancellation_requests cancellation
                 WHERE cancellation.run_id = run.id
              ) AS cancellation_requested
         FROM pipeline_runs run
         LEFT JOIN pipeline_dispatch_publications publication ON publication.run_id = run.id
         LEFT JOIN governed_retry_dispatches retry_dispatch ON retry_dispatch.retry_run_id = run.id
        WHERE run.id = $1`,
      [runId],
    ).catch(() => undefined);
    if (!runRow) {
      await getBoss().fail(job.name, job.id, { reason: 'canonical_run_missing' }).catch(() => undefined);
      continue;
    }

    try {
      // A crashed callback that never acquired execution authority has no work
      // to fail. Exact fresh publications and governed retry dispatches remain
      // queued and are retried with their existing pg-boss UUID and lane.
      const neverStartedFresh = job.name !== 'pipeline:retry'
        && runRow.status === 'queued'
        && !runRow.dispatch_owner
        && (runRow.publication_state === 'published' || runRow.publication_state === 'claimed');
      const neverStartedRetry = job.name === 'pipeline:retry'
        && runRow.status === 'queued'
        && !runRow.pid
        && !runRow.dispatch_owner
        && runRow.retry_dispatch_state === 'dispatched'
        && runRow.retry_boss_job_id === job.id
        && !runRow.retry_lease_owner
        && !runRow.retry_lease_expires_at
        && !runRow.retry_launch_pid
        && !runRow.retry_cancellation_requested
        && !runRow.cancellation_requested;
      if (neverStartedFresh || neverStartedRetry) {
        if (runRow.cancellation_requested) {
          await finalizeFreshRunCancellation(runId, 'worker_restart_before_budget_admission');
          await getBoss().fail(job.name, job.id, { reason: 'cancelled_before_budget_admission' });
          continue;
        }
        if (neverStartedFresh && runRow.publication_state === 'claimed') {
          const released = await queryOne<{ run_id: number }>(
            `UPDATE pipeline_dispatch_publications
                SET state = 'published', lease_owner = NULL, lease_expires_at = NULL,
                    last_error = 'worker_restarted_before_budget_admission', updated_at = NOW()
              WHERE run_id = $1 AND boss_job_id = $2::uuid
                AND state = 'claimed' AND lease_owner = $3
              RETURNING run_id`,
            [runId, job.id, runRow.publication_lease_owner],
          );
          if (!released) throw new Error('stale never-started publication claim changed during recovery');
        }
        await getBoss().fail(job.name, job.id, { reason: 'worker_restarted_before_budget_admission' });
        await getBoss().retry(job.name, job.id);
        logger.info(
          { runId, jobId: job.id, queueName: job.name },
          '[worker] recovered never-started callback with exact transport identity',
        );
        continue;
      }

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
  assertNotProtectedWave1Run(runId);
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
         AND pr.id <> $2
         AND NOT EXISTS (SELECT 1 FROM pipeline_run_release_intents ri WHERE ri.run_id = pr.id)
         AND NOT EXISTS (
           SELECT 1 FROM governed_retry_dispatches retry
           WHERE retry.retry_run_id = pr.id
         )
         AND (pr.worker_id IS NULL OR (pr.worker_id != $1 AND wh.worker_id IS NULL))`,
      [WORKER_ID, WAVE_1_PROTECTED_GENESIS_RUN_ID],
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
    assertNotProtectedWave1Run(runId);
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
// Case A: a running pipeline row has no matching live execution transport.
//   The job is gone (completed, failed, or manually deleted) but the run row
//   is stuck. Fix: reconcile terminal authority and fail safely.
//
// Case B: an active run/direct-run/retry callback has no nonterminal pipeline
//   row. Queued rows are valid while a callback awaits the shared execution
//   budget; only absent or terminal application state makes the job orphaned.
//   Fix: fail the pg-boss job so the slot is freed.
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
    id: number | string;
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
         AND pr.id <> $1
         AND NOT EXISTS (SELECT 1 FROM pipeline_run_release_intents ri WHERE ri.run_id = pr.id)
         AND NOT EXISTS (
           SELECT 1 FROM ${pgBossSchema}.job j
           WHERE j.name IN ('pipeline:run', 'pipeline:run:direct', 'pipeline:retry')
             AND j.state IN ('created', 'active', 'retry')
             AND (j.data->>'runId')::bigint = pr.id
         )
         AND (pr.last_heartbeat IS NULL OR pr.last_heartbeat < NOW() - INTERVAL '2 minutes')`,
      [WAVE_1_PROTECTED_GENESIS_RUN_ID],
    );
  } catch (err) {
    logger.warn({ err }, '[worker] reconcileState — Case A query failed, skipping');
    stuckRuns = [];
  }

  for (const run of stuckRuns) {
    const runId = Number(run.id);
    assertNotProtectedWave1Run(runId);
    try {
      // Governed retries delegate process termination and terminal state to the
      // application terminalizer before the generic live-PID shortcut.
      const governed = await reconcileStaleGovernedRetry(runId);
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
            { runId, pid: run.pid },
            '[worker] reconcileState — Case A: pg-boss job gone but PID still alive, skipping',
          );
          continue;
        } catch {
          // PID not found — process is dead, proceed with generic reconciliation
        }
      }

      logger.warn(
        { runId, currentStatus: 'running', lastHeartbeat: run.last_heartbeat },
        '[worker] reconcileState — Case A: no live pgboss job, no recent heartbeat, PID dead — reconciling pass boundaries before failure',
      );
      const passRecovery = await recoverUnreleasedIntegratedPasses({ runId });
      if (passRecoveryBlocksCompletion(passRecovery)) {
        logger.error({ runId, passRecovery }, '[worker] startup pass refinalization remains blocked');
      }
      await synthesizeAllMissingFrozenStoryFailures(runId, String(run.workspace_id), 'state_reconciliation');
      await persistHostRunCloseout({ runId, status: 'failed', terminalizeRun: true });
      await transitionRunLifecycle(runId, 'failed', {
        owner: 'worker_reconciliation', process: 'heartbeat_stale_or_pid_dead',
      });

      logger.warn(
        { runId, workspaceId: run.workspace_id },
        '[worker] reconcileState — Case A: run marked failed, WAL emitted',
      );

      advanceQueue(String(run.workspace_id)).catch(qErr =>
        logger.error({ err: qErr, runId }, '[worker] advanceQueue failed after state reconciliation'),
      );
    } catch (err) {
      logger.warn({ err, runId }, '[worker] reconcileState — Case A: failed to update run');
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
       WHERE j.name IN ('pipeline:run', 'pipeline:run:direct', 'pipeline:retry')
         AND j.state = 'active'
         AND (j.data->>'runId') IS NOT NULL
         AND (j.data->>'runId')::bigint <> $1
         AND NOT EXISTS (
           SELECT 1 FROM pipeline_run_release_intents ri
           WHERE ri.run_id = (j.data->>'runId')::bigint
         )
         AND NOT EXISTS (
           SELECT 1 FROM pipeline_runs pr
           WHERE pr.id = (j.data->>'runId')::bigint
             AND pr.status IN ('queued', 'starting', 'running', 'paused', 'pi_native')
         )`,
      [WAVE_1_PROTECTED_GENESIS_RUN_ID],
    );
  } catch (err) {
    logger.warn({ err }, '[worker] reconcileState — Case B query failed, skipping');
    orphanJobs = [];
  }

  for (const job of orphanJobs) {
    if (job.run_id) assertNotProtectedWave1Run(Number(job.run_id));
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

  // ── Case C: terminal governed retry whose preview never converged ──
  // A worker that dies mid-retry (SIGTERM, crash, or engine kill before
  // closeout) can leave the run terminal while the retry preview row is still
  // `dispatched`. The partial unique index idx_pipeline_retry_one_dispatched_scope
  // then blocks any new dispatch for that original run forever. Converge every
  // terminal retry run whose dispatch has already failed but whose preview has
  // not been terminalized. The terminalizer refuses duplicate/contradictory
  // states, so this is idempotent and evidence-safe.
  type TerminalRetryRow = {
    run_id: number | string;
    workspace_id: number | string;
    dispatch_state: string;
    preview_status: string;
  };
  let terminalRetries: TerminalRetryRow[];
  try {
    terminalRetries = await query<TerminalRetryRow>(
      `SELECT run.id AS run_id, run.workspace_id,
              dispatch.state AS dispatch_state, preview.status AS preview_status
         FROM pipeline_runs run
         JOIN governed_retry_dispatches dispatch ON dispatch.retry_run_id = run.id
         JOIN pipeline_retry_previews preview ON preview.preview_hash = dispatch.preview_hash
        WHERE run.status IN ('failed', 'partial_failure', 'cancelled')
          AND run.id <> $1
          AND preview.status = 'dispatched'
          AND dispatch.state IN ('failed', 'cancelled')`,
      [WAVE_1_PROTECTED_GENESIS_RUN_ID],
    );
  } catch (err) {
    logger.warn({ err }, '[worker] reconcileState — Case C query failed, skipping');
    terminalRetries = [];
  }

  for (const row of terminalRetries) {
    const runId = Number(row.run_id);
    try {
      assertNotProtectedWave1Run(runId);
      if (activeProcesses.has(runId)) continue;
      const outcome = await reconcileStaleGovernedRetry(runId);
      if (outcome === 'active') continue;
      logger.warn(
        { runId, workspaceId: row.workspace_id, dispatchState: row.dispatch_state, previewStatus: row.preview_status, outcome },
        '[worker] reconcileState — Case C: terminal governed retry preview converged',
      );
      advanceQueue(String(row.workspace_id)).catch((qErr) =>
        logger.error({ err: qErr, runId }, '[worker] advanceQueue failed after Case C reconciliation'),
      );
    } catch (err) {
      logger.warn({ err, runId }, '[worker] reconcileState — Case C: failed to converge terminal retry preview');
    }
  }

  const totalFixed = stuckRuns.length + orphanJobs.length + terminalRetries.length;
  _lastReconciliationErrors = totalFixed;

  if (totalFixed > 0) {
    logger.warn({ caseA: stuckRuns.length, caseB: orphanJobs.length, caseC: terminalRetries.length }, '[worker] reconcileState — mismatches resolved');
  } else {
    logger.info('[worker] reconcileState — no mismatches found');
  }
}

// ── Worker settings (split concurrency) ─────────────────────────────────

export async function registerRunQueueConsumers(
  boss: PgBoss,
  settings: WorkerConcurrencySettings,
  executionBudget: PipelineExecutionBudget,
): Promise<number> {
  const plan = pipelineWorkerSubscriptionPlan(settings);
  for (let i = 0; i < plan.isolatedRunConsumers; i++) {
    await boss.work<Record<string, unknown>>(PIPELINE_RUN_QUEUE, { batchSize: 1 }, (jobs) =>
      handlePipelineRun(jobs, PIPELINE_RUN_QUEUE, executionBudget));
  }
  for (let i = 0; i < plan.directRunConsumers; i++) {
    await boss.work<Record<string, unknown>>(PIPELINE_DIRECT_RUN_QUEUE, { batchSize: 1 }, (jobs) =>
      handlePipelineRun(jobs, PIPELINE_DIRECT_RUN_QUEUE, executionBudget));
  }
  for (let i = 0; i < plan.retryConsumers; i++) {
    await boss.work<Record<string, unknown>>('pipeline:retry', { batchSize: 1 }, (jobs) =>
      executionBudget.run(() => handlePipelineRetry(jobs)));
  }
  logger.info(
    { ...plan, queueMax: settings.queueMaxConcurrent, runNowMax: settings.runNowMaxConcurrent },
    '[worker] lane-aware queue consumers registered with one shared execution budget',
  );
  return plan.executionCapacity;
}

// ── Graceful shutdown ────────────────────────────────────────────────────

let stopping = false;
let reconcileIntervalHandle: ReturnType<typeof setInterval> | undefined;
let sweepIntervalId: ReturnType<typeof setInterval> | undefined;
let settingsPollIntervalId: ReturnType<typeof setInterval> | undefined;
let wardenIntervalId: ReturnType<typeof setInterval> | undefined;
let workerIdleCostController: WorkerIdleCostController | null = null;

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

  if (wardenIntervalId !== undefined) {
    clearInterval(wardenIntervalId);
    wardenIntervalId = undefined;
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
  if (workerIdleCostController) {
    try { await workerIdleCostController.close(); }
    catch (err) { logger.warn({ err }, '[worker] Wave 4 idle controller pool close failed'); }
    workerIdleCostController = null;
  }

  try {
    await closePool();
    logger.info('[worker] DB pool closed — exiting');
  } catch {
    // best-effort
  }
  process.exit(0);
}

function installWorkerProcessHandlers(): void {
  // Imports are side-effect free. Only the direct worker process may intercept
  // termination/fatal events; otherwise Jest workers and library consumers can
  // be prevented from exiting and require an external SIGKILL.
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
}

// ── Singleton guard ──────────────────────────────────────────────────────
// Prevents duplicate workers from competing for the same pg-boss queue,
// which causes orphan sweep / stale-job recovery to kill each other's
// engine processes (the root cause of runs dying mid-story).

export async function checkSingletonGuard(): Promise<boolean> {
  // Parallel worker mode (RORCA_WORKER_PARALLEL=1): allow multiple worker
  // processes to consume the same pg-boss queue so long engine batches run
  // concurrently. Startup recovery (stale jobs, mismatch repair, orphan
  // sweep) is liveness-aware: runs owned by a heartbeat-fresh worker are
  // never touched, so coexistence is safe by construction.
  if (process.env.RORCA_WORKER_PARALLEL === '1') {
    logger.info('[worker] Parallel worker mode (RORCA_WORKER_PARALLEL=1) — coexisting with other workers');
    return true;
  }
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
    const closeoutRecovery = await recoverPendingCloseoutReconciliationPublications();
    if (closeoutRecovery.scanned > 0) {
      logger.info({ closeoutRecovery }, '[worker] startup closeout reconciliation publication recovery complete');
    }
    const postSaveRecovery = await recoverBoundPostSaveWorkflowPublications();
    if (postSaveRecovery.scanned > 0) {
      logger.info({ postSaveRecovery }, '[worker] startup post-save publication recovery complete');
    }
  } catch (error) {
    logger.error({ error }, '[worker] pipeline dispatch publication recovery failed closed');
    process.exit(1);
    return;
  }
  try {
    await recoverRecentLifecycleAssurancePublications(100, getBoss());
  } catch (error) {
    logger.warn({ error }, '[worker] startup lifecycle assurance publication recovery deferred');
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

  // 3a. Recover exact successful branch-only runs that reached host story
  // closeout but failed before publishing run-level closeout. This remains
  // inside the worker authority boundary and never enables provider effects.
  try {
    const closeoutRecovery = await recoverBranchOnlyWorkerCloseouts(100);
    if (closeoutRecovery.scanned > 0) {
      logger.info({ closeoutRecovery }, '[worker] startup branch-only closeout recovery complete');
    }
  } catch (error) {
    logger.error({ error }, '[worker] startup branch-only closeout recovery deferred');
  }

  // 3b. Resume durable exact-SHA release/terminal intents before stale-run
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

  // 3a-2. Resume Forgejo release/status/federation drains (W5-003..W5-005).
  // Each exact step is rediscovered idempotently, so a crash between the PR
  // creation and the status projection converges on the next startup.
  try {
    const forgejoReleaseDrain = await drainForgejoPendingRunReleases(100, 1000);
    if (forgejoReleaseDrain.scanned > 0) {
      logger.info({ forgejoReleaseDrain }, '[worker] startup Forgejo release reconciliation drain complete');
    }
  } catch (error) {
    logger.error({ error }, '[worker] startup Forgejo release drain failed');
  }
  try {
    await reconcilePendingForgejoStatusProjections();
  } catch (error) {
    logger.warn({ error }, '[worker] startup Forgejo status projection reconciliation deferred');
  }
  try {
    await reconcilePendingForgejoFederationProjections();
  } catch (error) {
    logger.warn({ error }, '[worker] startup Forgejo federation projection reconciliation deferred');
  }

  // 3b. Recover stale jobs left by a previously crashed worker instance.
  // Must run after initBoss() (pg-boss schema exists) but before boss.work()
  // (so freed slots are available when handlers start polling).
  await recoverStaleJobs();

  // 3d. Sweep orphan processes — execution-engine subprocesses left running
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

  // 3d. ROR-28 recovery is deliberately after orphan termination. A prior
  // worker's released/running generation is observed or expired; it is never
  // blindly relaunched and a persisted exact result is handed to closeout.
  try {
    const implementationGate = await loadCanonicalWave3AImplementationGate();
    const entrypoint = resolveExecutionEngineEntrypoint(__dirname);
    if (!entrypoint.exists) throw new Error('Managed recovery requires the current execution-engine entrypoint');
    const launcher = resolveExecutionEngineLauncher(entrypoint);
    const bridge = new CurrentEngineManagedBridge(launcher, process.env);
    const workspaces = await query<{ id: string }>('SELECT id FROM workspaces ORDER BY id LIMIT 100');
    let recovered = 0;
    for (const workspace of workspaces) {
      const executor = new RorcaManagedExecutor(
        new PostgresManagedExecutorStore(workspace.id),
        bridge,
        implementationGate,
      );
      recovered += (await executor.recover(100)).length;
    }
    if (recovered > 0) logger.info({ recovered }, '[worker] startup RorcaManagedExecutor recovery complete');
  } catch (error) {
    // Managed recovery is an authority-gated optional lane. Preserve the
    // failure as a real diagnostic and keep canonical Wave 2 work alive.
    logger.error({ err:error }, '[worker] RorcaManagedExecutor recovery unavailable; managed dispatch remains fail closed');
  }

  // 3e. W5-008: omp lane construction site + recovery. The managed executor,
  // continuation controller, and normative lane are built here (production
  // paths) and reused by dispatch handling. omp is probed at startup and the
  // probe is pinned into launch evidence; a missing/below-v17 omp fails this
  // lane closed without touching canonical Wave 2 work.
  try {
    const implementationGate = await ensureImplementationGate();
    const workspaces = await query<{ id: string }>('SELECT id FROM workspaces ORDER BY id LIMIT 100');
    let ompRecovered = 0;
    for (const workspace of workspaces) {
      const stack = await getOmpManagedStack(workspace.id);
      ompRecovered += (await stack.executor.recover(100)).length;
      const reconciled = await reconcileOmpManagedDispatches(stack.lane, workspace.id);
      if (reconciled.length > 0) {
        logger.info({ workspaceId: workspace.id, reconciled: reconciled.map((entry) => entry.outcome) }, '[worker] startup omp lane dispatch reconciliation complete');
      }
    }
    if (ompRecovered > 0) logger.info({ recovered: ompRecovered }, '[worker] startup OmpManagedExecutor recovery complete');
    void implementationGate;
  } catch (error) {
    // The omp lane is an authority-gated optional surface. Preserve the
    // failure as a real diagnostic and keep canonical Wave 2 work alive.
    logger.error({ err: error }, '[worker] OmpManagedExecutor recovery unavailable; omp dispatch remains fail closed');
  }

  // A prior SIGKILL can bypass child close handlers. The runtime roots live
  // outside reusable worktrees and are swept only after singleton fencing and
  // orphan-process termination, before any new job can observe stale Pi auth.
  const staleEgressRoots = sweepStaleAutonomousModelEgressState();
  if (staleEgressRoots > 0) {
    logger.info({ removed: staleEgressRoots }, '[worker] removed stale run-owned model egress broker roots');
  }
  const liveRunIds = new Set<number>(
    (await query<{ id: number }>(
      `SELECT id FROM pipeline_runs WHERE status = 'running'`,
    )).map((row) => row.id),
  );
  const isRunLive = (runId: number): boolean => liveRunIds.has(runId);
  const _stalePiRuntimeRoots = sweepStaleOrdinaryLocalPiRuntimeState(undefined, isRunLive);
  const staleGitRoots = sweepStaleAutonomousGitState();
  if (staleGitRoots > 0) {
    logger.info({ removed: staleGitRoots }, '[worker] removed stale run-private Git control roots');
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
      await drainForgejoPendingRunReleases(100, 1000).catch((error) =>
        logger.warn({ error }, '[worker] periodic Forgejo release reconciliation deferred'));
      await reconcilePendingForgejoStatusProjections().catch((error) =>
        logger.warn({ error }, '[worker] periodic Forgejo status projection reconciliation deferred'));
      await reconcilePendingForgejoFederationProjections().catch((error) =>
        logger.warn({ error }, '[worker] periodic Forgejo federation projection reconciliation deferred'));
      await recoverPendingDispatchPublications().catch((error) =>
        logger.error({ error }, '[worker] periodic pipeline dispatch publication recovery deferred'));
      await reconcilePendingFreshRunCancellations().catch((error) =>
        logger.error({ error }, '[worker] periodic fresh-run cancellation recovery deferred'));
      await recoverPendingCloseoutReconciliationPublications().catch((error) =>
        logger.error({ error }, '[worker] periodic closeout reconciliation publication recovery deferred'));
      await recoverBoundPostSaveWorkflowPublications().catch((error) =>
        logger.error({ error }, '[worker] periodic post-save publication recovery deferred'));
      await recoverRecentLifecycleAssurancePublications(100, getBoss()).catch((error) =>
        logger.error({ error }, '[worker] periodic lifecycle assurance publication recovery deferred'));
      await reconcileState();
    })();
  }, RECONCILE_INTERVAL_MS);

  // 4. Register job queue handlers.
  // Queues are already created by ensureQueues() inside initBoss() — just register handlers.
  const boss = getBoss();

  // Fetch initial concurrency from DB (falls back to env var / default).
  let currentSettings = await getWorkerConcurrencySettings();
  logger.info(
    { queueMax: currentSettings.queueMaxConcurrent, runNowMax: currentSettings.runNowMaxConcurrent },
    '[worker] initial concurrency settings (queue_max_concurrent / run_now_max_concurrent)',
  );

  // Every generation of pg-boss subscriptions shares this process-lifetime
  // budget. A lower hot-reload limit applies before replacement subscriptions
  // are registered, so callbacks retained by offWork cannot overlap a new
  // semaphore generation.
  const executionBudget = new PipelineExecutionBudget(
    pipelineWorkerSubscriptionPlan(currentSettings).executionCapacity,
  );
  await registerRunQueueConsumers(boss, currentSettings, executionBudget);
  await boss.work('pipeline:cancel', { batchSize: 10 }, handlePipelineCancel);
  await boss.work(CLOSEOUT_RECONCILIATION_QUEUE, { batchSize: 1 }, handlePipelineCloseoutReconciliation);
  await registerAutonomousPrDeliveryWorker(boss);
  await registerSpecJobHandlers(boss);
  await registerHydrationWorker(boss);
  await registerContextCaptureHandlers(boss);
  await registerPreStagingQualificationWorker(boss);

  // Poll worker_settings every WORKER_SETTINGS_POLL_MS (default 30s).
  // If concurrency settings change, hot-reload both run lanes and retry subscriptions.
  const WORKER_SETTINGS_POLL_MS = parseInt(process.env.WORKER_SETTINGS_POLL_MS ?? '30000', 10);
  workerIdleCostController = await initializeWorkerIdleCostController();
  if (workerIdleCostController) logger.info('[worker] Wave 4 durable idle cost controller active');

  let settingsReloadInProgress = false;
  settingsPollIntervalId = setInterval(() => {
    void (async () => {
      if (stopping || settingsReloadInProgress) return;
      settingsReloadInProgress = true;
      try {
        if (workerIdleCostController && !(await workerIdleCostController.beforeIteration(WORKER_SETTINGS_POLL_MS))) {
          logger.warn({ status: workerIdleCostController.snapshot().status },
            '[worker] settings provider scoped controller suspended; provider request skipped');
          return;
        }
        const newSettings = await getWorkerConcurrencySettings();
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

          // Stop current subscriptions gracefully (pg-boss drains in-flight
          // callbacks). Do not publish the new in-memory setting until every
          // lane is registered; a partial registration is removed and the
          // previous bounded capacity is restored before the poll retries.
          const previousSettings = currentSettings;
          executionBudget.reconfigure(pipelineWorkerSubscriptionPlan(newSettings).executionCapacity);
          await boss.offWork(PIPELINE_RUN_QUEUE);
          await boss.offWork(PIPELINE_DIRECT_RUN_QUEUE);
          await boss.offWork('pipeline:retry');
          try {
            await registerRunQueueConsumers(boss, newSettings, executionBudget);
            currentSettings = newSettings;
          } catch (registrationError) {
            await boss.offWork(PIPELINE_RUN_QUEUE).catch(() => undefined);
            await boss.offWork(PIPELINE_DIRECT_RUN_QUEUE).catch(() => undefined);
            await boss.offWork('pipeline:retry').catch(() => undefined);
            executionBudget.reconfigure(pipelineWorkerSubscriptionPlan(previousSettings).executionCapacity);
            await registerRunQueueConsumers(boss, previousSettings, executionBudget);
            throw registrationError;
          }

          logger.info(
            { queueMax: currentSettings.queueMaxConcurrent, runNowMax: currentSettings.runNowMaxConcurrent },
            '[worker] work subscription reloaded successfully',
          );
        }
      } catch (err) {
        logger.warn({ err }, '[worker] settings poll: failed to check/reload concurrency settings');
      } finally {
        settingsReloadInProgress = false;
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
             AND name IN ('pipeline:run', 'pipeline:run:direct', 'pipeline:retry')`,
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

  // 4d. Hermes failure warden — the invariant: a failed run is a ticket, never
  // a tombstone. Sweeps recently-failed runs, classifies root cause against the
  // taxonomy, re-drives bounded through the governed API, escalates everything
  // else with an exact operator action. Runs even with no Pi/UI attached.
  if (process.env.RORCA_FAILURE_WARDEN_ENABLED !== 'false') {
    const WARDEN_INTERVAL_MS = 60_000; // 1 minute
    wardenIntervalId = setInterval(() => {
      void (async () => {
        if (stopping) return;
        try {
          const result = await wardenSweep({
            query,
            emitWalEvent,
            apiBaseUrl: process.env.RORCA_API_URL ?? 'http://127.0.0.1:3030',
            logger,
          });
          if (result.acted > 0) {
            logger.warn({ actions: result.actions }, '[worker] Failure warden acted on failed runs');
          }
          const escalated = await wardenEscalateStalledRuns({
            query,
            emitWalEvent,
            apiBaseUrl: process.env.RORCA_API_URL ?? 'http://127.0.0.1:3030',
            logger,
          });
          if (escalated > 0) {
            logger.warn({ escalated }, '[worker] Failure warden escalated stalled running runs');
          }
        } catch (err) {
          logger.error({ err }, '[worker] Failure warden sweep failed');
        }
      })();
    }, WARDEN_INTERVAL_MS);
  }

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
         WHERE name IN ('pipeline:run', 'pipeline:run:direct', 'pipeline:retry')
           AND state = 'failed'
           AND archived_on > NOW() - INTERVAL '1 day'
           AND (data->>'runId')::bigint <> $1
         ORDER BY archived_on DESC`,
        [WAVE_1_PROTECTED_GENESIS_RUN_ID],
      ).catch(() => [] as DlqRow[]);

      for (const row of rows) {
        if (seenDlqJobIds.has(row.id)) continue;
        seenDlqJobIds.add(row.id);

        const runId = typeof row.data?.runId === 'number' ? row.data.runId : undefined;
        if (!runId) continue;
        assertNotProtectedWave1Run(runId);

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
  installWorkerProcessHandlers();
  start().catch((err) => {
    logger.error({ err }, '[worker] startup failed');
    process.exit(1);
  });
}

/**
 * Explicit entrypoint for packaged binaries: a compiled binary's entry module is
 * the CLI, so `require.main === module` is false here and the auto-start above
 * never fires. `rorca worker` calls this instead.
 */
export async function startWorker(): Promise<void> {
  installWorkerProcessHandlers();
  await start();
}
