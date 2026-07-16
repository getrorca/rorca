/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, Request, Response } from 'express';
import { isUtf8 } from 'buffer';
import { execSync, spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import simpleGit from 'simple-git';
import { z } from 'zod';
import { query, queryOne, execute, transaction } from '../db/index';
import { validateBody } from '../lib/validate';
import { broadcastAll, attachSSE, type WalEvent } from '../lib/sse-hub';
import { runHooks } from '../lib/hook-runner';
import { estimateDryRunCost } from '../lib/cost-estimator';
import { chatComplete, DEFAULT_MODEL, resolveVaultProvider } from '../lib/llm-client';
import { getWorkspaceEnvVars } from './env-vars';
import { checkBudgetThresholds } from './budget';
import { getVaultKey } from './vault';
import type { AgentProfileRow } from './agent-profiles';
import { handleRouteError } from '../lib/async-handler';
import { parsePaginationParams } from '../lib/paginate';
import { getEffectiveUser } from '../lib/get-user';
import { parseLine } from '../lib/semantic-log-parser';
import { activeAgent, activeModel, type AgentType } from '../lib/config';
import { resolveWorkflowConfig } from '../lib/workflow-config-resolver';
import { isPiExternalOrchestrationEnabled } from '../lib/pi-execution-mode';
import { synthesize } from '../lib/direction-stack';
import { scanRequiredEngines, countStoriesByEngine, resolveStoryAgent, reroutedStories, storyAllowsNoCodeChanges, type EngineUserStory } from '../lib/execution-engine';
import { readRunState, type RunState } from '../lib/run-state';
import { lookupTraceRecord, parseRawRef, getTraceArtifactPath } from '../lib/context-trace';
import {
  check as checkStoryCapability,
  checkSpec,
  detectRequiredTools,
  findCapableEngine,
  type CapabilityStory,
  type StoryCapabilityReport,
} from '../lib/tool-capability-checker';
import { loadOrchestrationConfig, type CapabilityMismatchMode } from '../lib/complexity-scorer';
import {
  buildStoryExecutionPacket,
  createStoryExecutionManifest,
  deriveStoryContractRevision,
  detectExecutionModeFromSpec,
  type ImmutableStoryExecutionManifest,
  type StoryChangePolicy,
} from '../lib/story-execution-packet';
import { persistStoryExecutionManifest } from '../lib/story-closeout';
import { inspectApprovedSpecPasses, reconcileApprovedSpecPasses, type PassReconciliationReport } from '../lib/ssdlc-pass-reconciler';
import { classifyRunLiveness } from '../lib/ssdlc-liveness';
import { buildQuickRunContextBlocks, readContractMemory, routeWorkspaceContext, validateRoutingContract } from '../lib/workspace-context-routing';
import { advanceQueue } from '../lib/run-queue';
import { compileWaves, isCycleError, type Wave, type UserStory as WaveUserStory } from '../lib/wave-compiler';
import { detectDrift, isDriftCheckEnabled, hasBlockingViolations, type DriftReport } from '../lib/drift-detector';
import { synthesizeRunMemory } from '../lib/auto-memory';
import * as piDetector from '../lib/pi-detector';
import {
  PiExecutionPreflightError,
  preflightPiModelAndEffort,
  resolvePiRunSafetyOptions,
} from '../lib/pi-autonomous-runner';
import { logger } from '../lib/logger';
import { emitLifecycleInvalidation } from '../lib/lifecycle-mutations';
import { ensureWorktreeRuntimeSupport } from '../lib/worktree-runtime';
import { getBoss } from '../lib/pg-boss';
import { getLatestWorkerHeartbeat, isWorkerHeartbeatStale } from '../lib/worker-heartbeat';
import { authRequired, isSuperUser } from '../lib/auth-utils';
import { ConflictError, ForbiddenError, NotFoundError, ServiceUnavailableError, UnprocessableError, ValidationError } from '../lib/errors';
import { DEFAULT_TERMINAL_MODE, invalidTerminalModeMessage, isPtyTerminalMode, isTerminalMode, normalizeTerminalMode, type TerminalMode } from '../lib/terminal-mode';
import { normalizeRunAgentType, normalizeRunMetadata, type NormalizedRunAgentType } from '../lib/run-metadata';
import { PTY_AVAILABLE, PTY_UNAVAILABLE_HINT } from '../lib/pty-manager';
import { mayFinalizePtyCancellationInline } from '../lib/pty-cancel-policy';
import { lifecycleFromLegacyStatus, transitionRunLifecycle, type RunLifecycleStatus } from '../lib/run-lifecycle';
import { subscribeRunOutput } from '../lib/run-output-listener';
import {
  getRunPtySessionHealth,
  getRunPtySessionStatus,
  getRunPtyOutputLimits,
  listRecentRunPtyChunks,
  listRunPtyChunks,
  requestRunPtyInput,
  requestRunPtyResize,
} from '../lib/run-pty-store';
import { sweepOrphanProcesses, type OrphanSweepResult } from '../worker';
import { safelyRefreshReusableWorktree, validateReusableBranch, validateReusableWorktree } from '../lib/worktree-freshness';
import { PipelineRetryJobPayload } from '../lib/pg-boss-schemas';
import {
  buildGovernedRetrySpec,
  compareRetryPlanToPreview,
  createRetryPreview,
  createRetryPreviewIdentity,
  resolveRetryScope,
  retryHash,
  verifyRetryPreview,
  verifyRetryPreviewIdentity,
  type RetryExecutionOptions,
  type RetryPlanStatus,
  type RetryPlanStory,
  type RetryPreviewIdentity,
  type RetryPreviewPacket,
} from '../lib/retry-governance';
import {
  assertSpecReadinessAllowsMutation,
  getSpecReadiness,
  recordSpecReadinessOverride,
} from '../lib/spec-readiness';
import { safeParseTaskManifest, type TaskManifest } from '../lib/task-manifest';
import { computeTaskManifestHash, resolveTaskManifestArtifactPaths } from '../lib/task-manifest-artifacts';
import {
  createTaskManifestExecutionEnvelope,
  writeTaskManifestExecutionEnvelope,
  type WriteTaskManifestExecutionEnvelopeResult,
} from '../lib/task-manifest-execution-envelope';
import {
  EXECUTION_AGENT_PRECEDENCE,
  EXECUTION_MODEL_PRECEDENCE,
  resolveExecutionOptions,
  type ResolvedExecutionOptions,
} from '../lib/resolve-execution-options';
import { assertExecutionEnvironmentReady, resolveExecutionEnvironment } from '../lib/execution-environment';
import { assertExecutionEnvironmentReadyForRun } from '../lib/execution-environment-registry';
import { createRunnerJob } from '../lib/execution-runner-jobs';
import { resolveExecutionEngineEntrypoint } from '../lib/execution-engine-entrypoint';
import { deleteFallbackFile, readFallbackResults } from '../lib/resilient-post';

// ── Claude binary + env-var stripping for agentic conflict resolution ─────────
// Same pattern as execution-engine.ts — strips nested-session detection vars.
const CLAUDE_BIN_PIPELINE = process.env.CLAUDE_BIN ||
  (() => {
    try { return execSync('which claude', { encoding: 'utf8' }).trim(); } catch { return 'claude'; }
  })();

const CLAUDE_ENV_VARS_STRIP = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
];

function buildCleanEnvForMerge(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !CLAUDE_ENV_VARS_STRIP.includes(k)) {
      env[k] = v;
    }
  }
  return env;
}

const DEFAULT_PI_MODEL = process.env.RORCA_PI_DEFAULT_MODEL?.trim() || 'openai-codex/gpt-5.4';

async function postRetryWalEvent(eventType: 'retry_preview_generated' | 'retry_scope_mismatch' | 'ssdlc_retry_preview_denied', workspaceId: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const response = await fetch(`http://127.0.0.1:${process.env.PORT ?? '3030'}/api/wal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_type: eventType, workspace_id: workspaceId, payload }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    // The durable preview/refusal row remains authoritative if the API is
    // restarting; never bypass /api/wal with a direct insert.
    logger.warn({ error, eventType, workspaceId }, '[retry] WAL API emission failed');
  }
}

function assertReconciliationAllowsAutomaticScope(report: PassReconciliationReport): void {
  if (!report.blocking) return;
  throw new UnprocessableError(
    'Approved-spec pass evidence is ambiguous; automatic run scope was not calculated.',
    'PASS_RECONCILIATION_REQUIRED',
    {
      reconciliation: report,
      operatorActions: report.stories.flatMap((story) => story.operatorActions),
    },
  );
}

/** Auto-select sequential vs wave-parallel based on dependency graph analysis. */
function autoSelectOrchestration(userStories: WaveUserStory[]): {
  mode: 'sequential' | 'wave-parallel';
  parallelism: number;
  reason: string;
  waveCount: number;
  maxWaveSize: number;
  totalStories: number;
  waves: { index: number; storyIds: string[] }[];
} {
  const pending = userStories.filter(s => !s.passes && !s.excluded);
  const totalStories = pending.length;

  if (totalStories === 0) {
    return { mode: 'sequential', parallelism: 1, reason: 'no pending stories', waveCount: 0, maxWaveSize: 0, totalStories: 0, waves: [] };
  }

  const waveResult = compileWaves(pending);
  if (isCycleError(waveResult)) {
    return { mode: 'sequential', parallelism: 1, reason: `cycle detected among ${waveResult.involvedIds.join(', ')}`, waveCount: 0, maxWaveSize: 0, totalStories, waves: [] };
  }

  const waves: Wave[] = waveResult;
  const maxWaveSize = Math.max(...waves.map(w => w.stories.length));
  const waveCount = waves.length;
  const waveSummary = waves.map(w => ({ index: w.index, storyIds: w.stories.map(s => s.id) }));

  // Decision rules:
  // 1. If max wave size < 2 (all waves have exactly 1 story) → sequential
  // 2. If total stories < 5 → sequential (overhead not worth it)
  // 3. Otherwise → wave-parallel with parallelism = maxWaveSize
  if (maxWaveSize < 2) {
    return {
      mode: 'sequential', parallelism: 1,
      reason: `max wave size: ${maxWaveSize}, stories: ${totalStories}`,
      waveCount, maxWaveSize, totalStories, waves: waveSummary,
    };
  }

  if (totalStories < 5) {
    return {
      mode: 'sequential', parallelism: 1,
      reason: `total stories: ${totalStories} (< 5 threshold)`,
      waveCount, maxWaveSize, totalStories, waves: waveSummary,
    };
  }

  return {
    mode: 'wave-parallel', parallelism: maxWaveSize,
    reason: `max wave size: ${maxWaveSize}, stories: ${totalStories}`,
    waveCount, maxWaveSize, totalStories, waves: waveSummary,
  };
}

/** Extract user-visible text from pino JSON log lines before semantic parsing. */
function unwrapSemanticLogLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return line;
  try {
    const parsed = JSON.parse(trimmed) as { msg?: unknown; message?: unknown };
    const message = typeof parsed.msg === 'string' ? parsed.msg : parsed.message;
    return typeof message === 'string' ? message : line;
  } catch {
    return line;
  }
}

/** Extract semantic steps from a raw text chunk (may contain multiple lines). */
function emitSemanticSteps(text: string, agent: string, res: Response): void {
  const lines = text.split('\n');
  for (const line of lines) {
    const semanticLine = unwrapSemanticLogLine(line);
    const steps = parseLine(semanticLine, agent);
    for (const step of steps) {
      res.write(`event: semantic_step\ndata: ${JSON.stringify(step)}\n\n`);
    }
  }
}

const RUN_OUTPUT_BACKPRESSURE_TIMEOUT_MS = 10_000;

/**
 * Respect Node's writable high-water mark. Durable cursors make it safe to end
 * a stalled attachment and let EventSource replay, rather than buffering an
 * unbounded transcript in the server process for a slow consumer.
 */
async function writeOutputChunkEvent(res: Response, sequence: number, chunk: Buffer): Promise<boolean> {
  if (res.destroyed || res.writableEnded) return false;
  const accepted = res.write(`id: ${sequence}\nevent: chunk\ndata: ${chunk.toString('base64')}\n\n`);
  if (accepted) return true;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res.off('drain', onDrain);
      res.off('close', onClose);
      res.off('error', onClose);
      resolve(result);
    };
    const onDrain = () => finish(true);
    const onClose = () => finish(false);
    const timer = setTimeout(() => {
      finish(false);
      if (!res.destroyed) res.destroy();
    }, RUN_OUTPUT_BACKPRESSURE_TIMEOUT_MS);
    timer.unref?.();
    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onClose);
  });
}

function readBoundedIntegerEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

// PTY output SSE is a durable event-driven transport. The execution engine
// commits raw bytes to run_pty_output_chunks; PostgreSQL NOTIFY wakes Express
// immediately, and Express reads those committed rows by sequence. Bounded
// polling remains a recovery path for listener reconnects/notification loss.
const RUN_OUTPUT_PTY_LIVE_TRANSPORT = 'postgres-notify+db-replay' as const;
const RUN_OUTPUT_PTY_REPLAY_SOURCE = 'run_pty_output_chunks' as const;
const RUN_OUTPUT_ANSI_REPLAY_SOURCE = 'run_output_chunks' as const;
type RunOutputReplaySource = typeof RUN_OUTPUT_PTY_REPLAY_SOURCE | typeof RUN_OUTPUT_ANSI_REPLAY_SOURCE;
const RUN_OUTPUT_PTY_POLL_INTERVAL_MS = readBoundedIntegerEnv('RORCA_PTY_OUTPUT_POLL_INTERVAL_MS', 2_000, 250, 10_000);
const RUN_OUTPUT_PTY_EXPECTED_MAX_LATENCY_MS = RUN_OUTPUT_PTY_POLL_INTERVAL_MS * 2;
const RUN_OUTPUT_PTY_HEALTH_EMIT_INTERVAL_MS = 2_000;
const RUN_OUTPUT_PTY_SLOW_POLL_WARN_MS = Math.max(1_000, RUN_OUTPUT_PTY_POLL_INTERVAL_MS * 5);
const RUN_OUTPUT_INITIAL_REPLAY_MAX_CHUNKS = readBoundedIntegerEnv('RORCA_OUTPUT_REPLAY_MAX_CHUNKS', 2_048, 100, 25_000);
const RUN_OUTPUT_REPLAY_BATCH_CHUNKS = getRunPtyOutputLimits().replayBatchChunks;
const MAX_PTY_COLS = 500;
const MAX_PTY_ROWS = 200;
const MAX_PTY_INPUT_CHUNK_BYTES = 65_536;

async function assertPipelineWorkspaceAccess(req: Request, workspaceId: string): Promise<void> {
  const user = req.user;
  if (!user) throw new ForbiddenError('Authentication required');
  if (isSuperUser(user)) return;
  const membership = await queryOne<{ role: string }>(
    'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_auth_id = $2',
    [workspaceId, user.supabaseId],
  );
  if (!membership) throw new ForbiddenError('Run does not belong to an accessible workspace');
}

function parseOutputResumeCursor(value: string, source: 'afterSequence' | 'Last-Event-ID'): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new ValidationError(`${source} must be a non-negative integer sequence`);
  }
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence)) {
    throw new ValidationError(`${source} must be a safe integer sequence`);
  }
  return sequence;
}

/** A durable cursor is valid only within one output store's sequence space. */
function parseOutputReplaySource(value: string): RunOutputReplaySource {
  if (value === RUN_OUTPUT_PTY_REPLAY_SOURCE || value === RUN_OUTPUT_ANSI_REPLAY_SOURCE) {
    return value;
  }
  throw new ValidationError('outputSource must be run_pty_output_chunks or run_output_chunks');
}

function isPtyPidAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function normalizePtyHealthPayload(health: Awaited<ReturnType<typeof getRunPtySessionHealth>>): Record<string, unknown> | null {
  if (!health) return null;
  const totalOutputBytes = typeof health.total_output_bytes === 'number'
    ? health.total_output_bytes
    : Number.parseInt(String(health.total_output_bytes ?? 0), 10) || 0;
  const processAlive = health.status === 'active' && isPtyPidAlive(health.child_pid);
  return {
    ptySessionStatus: health.status,
    pty_session_status: health.status,
    ptyChildPid: health.child_pid,
    pty_child_pid: health.child_pid,
    ptyProcessAlive: processAlive,
    pty_process_alive: processAlive,
    ptyLastOutputAt: health.last_output_at,
    pty_last_output_at: health.last_output_at,
    ptyLastHeartbeatAt: health.last_heartbeat_at,
    pty_last_heartbeat_at: health.last_heartbeat_at,
    ptyCompletionMarker: health.completion_marker,
    pty_completion_marker: health.completion_marker,
    ptyCompletionMarkerSeen: Boolean(health.completion_marker_seen_at),
    pty_completion_marker_seen: Boolean(health.completion_marker_seen_at),
    ptyCompletionMarkerSeenAt: health.completion_marker_seen_at,
    pty_completion_marker_seen_at: health.completion_marker_seen_at,
    ptyCompletionFileSeen: Boolean(health.completion_file_seen_at),
    pty_completion_file_seen: Boolean(health.completion_file_seen_at),
    ptyCompletionFileSeenAt: health.completion_file_seen_at,
    pty_completion_file_seen_at: health.completion_file_seen_at,
    ptyCompletionFileError: health.completion_file_error,
    pty_completion_file_error: health.completion_file_error,
    ptyTerminalMarkerSeen: Boolean(health.terminal_marker_seen_at),
    pty_terminal_marker_seen: Boolean(health.terminal_marker_seen_at),
    ptyPromptReadinessStatus: health.prompt_readiness_status,
    pty_prompt_readiness_status: health.prompt_readiness_status,
    ptyPromptReadinessReason: health.prompt_readiness_reason,
    pty_prompt_readiness_reason: health.prompt_readiness_reason,
    ptyPromptReadyAt: health.prompt_ready_at,
    pty_prompt_ready_at: health.prompt_ready_at,
    ptyPromptInjectedAt: health.prompt_injected_at,
    pty_prompt_injected_at: health.prompt_injected_at,
    ptyTotalOutputBytes: totalOutputBytes,
    pty_total_output_bytes: totalOutputBytes,
    ptyDroppedOutputBytes: Number(health.dropped_output_bytes ?? 0),
    pty_dropped_output_bytes: Number(health.dropped_output_bytes ?? 0),
    ptyOutputTruncated: Boolean(health.output_truncated_at),
    pty_output_truncated: Boolean(health.output_truncated_at),
    ptyOutputTruncatedAt: health.output_truncated_at,
    pty_output_truncated_at: health.output_truncated_at,
  };
}

function writePtyHealthEvent(res: Response, healthPayload: Record<string, unknown> | null): void {
  if (!healthPayload) return;
  res.write(`event: pty_health\ndata: ${JSON.stringify(healthPayload)}\n\n`);
}

/** Legacy tmp-based log path (used as fallback for old runs) */
const tmpLogPath = (runId: number) => path.join(os.tmpdir(), `rorca-run-${runId}.log`);

/** Persistent log file path inside workspace/forge/logs/ — survives backend restarts */
function workspaceLogPath(workspacePath: string, runId: number): string {
  const logDir = path.join(workspacePath, 'forge', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  return path.join(logDir, `run-${runId}.log`);
}

/** Resolve log path for a run: check DB log_path, then legacy /tmp path */
async function resolveLogPath(runId: number): Promise<string | null> {
  const row = await queryOne('SELECT log_path FROM pipeline_runs WHERE id = $1', [runId]) as { log_path: string | null } | undefined;
  if (row?.log_path && fs.existsSync(row.log_path)) return row.log_path;
  const legacy = tmpLogPath(runId);
  if (fs.existsSync(legacy)) return legacy;
  return null;
}

/** True if the given PID is still alive */
function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

interface DispatchManifestProfile {
  profileId?: string;
  changePolicy?: StoryChangePolicy;
  noCodeReason?: string;
  baselineFailurePolicy?: 'block' | 'allow_with_host_evidence';
}

interface DispatchManifestStory extends CapabilityStory {
  acceptance?: string;
  excluded?: boolean;
  passes?: boolean;
  model?: string;
  effort?: string;
  agent?: AgentType;
  executionManifest?: DispatchManifestProfile;
}

function acceptanceCriteriaForManifest(story: DispatchManifestStory): string[] {
  if (Array.isArray(story.acceptanceCriteria) && story.acceptanceCriteria.length > 0) return story.acceptanceCriteria;
  return typeof story.acceptance === 'string'
    ? story.acceptance.split('\n').map((line) => line.replace(/^[-*]\s*/, '').trim()).filter(Boolean)
    : [];
}

/** Resolve historical/null run metadata to a valid engine without changing public Unknown telemetry. */
function resolveDispatchAgent(value: unknown): AgentType {
  const normalized = normalizeRunAgentType(value);
  return normalized === 'unknown' ? activeAgent : normalized;
}

async function resolveAndPersistDispatchManifests(input: {
  workspaceId: string;
  specId: string;
  runId: number;
  specJson: Record<string, unknown>;
  cwd: string;
  agent: AgentType;
  model: string | null;
  effort: string | null;
  terminalMode: TerminalMode;
  worktreePath: string | null;
  branchName: string | null;
  autoMerge: boolean;
  mergeStrategy: 'direct' | 'pr' | 'draft-pr' | 'branch-only';
  parallelism: number;
  /** Retry-only immutable revision bindings from the parent run. */
  frozenRevisionsByStory?: ReadonlyMap<string, { specRevision: string; storyRevision: string }>;
  attemptByStory?: ReadonlyMap<string, number>;
}): Promise<{ path: string; manifests: ImmutableStoryExecutionManifest[] }> {
  const phaseStories = Array.isArray(input.specJson.phases)
    ? (input.specJson.phases as Array<{ stories?: DispatchManifestStory[] }>).flatMap((phase) => phase.stories ?? [])
    : [];
  const stories = (Array.isArray(input.specJson.userStories) ? input.specJson.userStories : phaseStories) as DispatchManifestStory[];
  const mode = detectExecutionModeFromSpec(input.specJson as { mode?: string; phases?: unknown });
  const specProfile = (input.specJson.executionManifest as DispatchManifestProfile | undefined) ?? {};
  const baseRevision = execSync('git rev-parse HEAD', { cwd: input.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const specRevision = deriveStoryContractRevision(input.specJson);
  const manifests: ImmutableStoryExecutionManifest[] = [];
  const dispatchAgent = resolveDispatchAgent(input.agent);

  for (const story of stories.filter((item) => !item.excluded)) {
    const packet = buildStoryExecutionPacket(input.cwd, story, mode);
    const profile = { ...specProfile, ...(story.executionManifest ?? {}) };
    const criteria = acceptanceCriteriaForManifest(story);
    // Freeze the engine's existing legitimate no-code behavior into the
    // authoritative pre-dispatch profile; closeout never re-infers it from mode
    // or story prose after execution starts.
    const changePolicy = profile.changePolicy
      ?? (storyAllowsNoCodeChanges(story as EngineUserStory, mode) ? 'no_code_allowed' : 'code_required');
    const noCodeReason = changePolicy === 'no_code_allowed'
      ? profile.noCodeReason ?? `Resolved from the existing ${mode} story no-code rules before dispatch.`
      : null;
    let resolvedStoryAgent = resolveStoryAgent(story as EngineUserStory, dispatchAgent);
    const orchestrationPolicy = loadOrchestrationConfig(input.cwd);
    if (orchestrationPolicy.capabilityMismatch === 'reroute') {
      const capability = checkStoryCapability(story, resolvedStoryAgent);
      if (!capability.compatible) {
        resolvedStoryAgent = findCapableEngine(detectRequiredTools(story), resolvedStoryAgent) ?? resolvedStoryAgent;
      }
    }
    const storyIsolated = input.parallelism > 1 && input.terminalMode !== 'pty';
    const storyWorktreePath = storyIsolated
      ? path.resolve(input.cwd, '..', `${path.basename(input.cwd)}-${story.id}-run-${input.runId}`)
      : input.cwd;
    const storyBranch = storyIsolated
      ? `feat/${input.specId}-${story.id}-run-${input.runId}`
      : input.branchName;
    const frozenRevisions = input.frozenRevisionsByStory?.get(story.id);
    const manifest = createStoryExecutionManifest({
      identity: {
        workspaceId: input.workspaceId,
        specId: input.specId,
        storyId: story.id,
        runId: input.runId,
        attempt: input.attemptByStory?.get(story.id) ?? 1,
      },
      revisions: frozenRevisions ?? {
        specRevision,
        storyRevision: deriveStoryContractRevision(story),
      },
      executionMode: mode,
      execution: {
        agent: resolvedStoryAgent,
        model: story.model ?? input.model,
        effort: story.effort ?? input.effort,
        terminal: input.terminalMode,
        worktree: {
          enabled: storyIsolated || Boolean(input.worktreePath),
          path: storyWorktreePath,
          branch: storyBranch,
          baseRevision,
        },
        merge: {
          enabled: input.autoMerge,
          strategy: input.mergeStrategy,
          targetBranch: input.mergeStrategy === 'direct' ? 'main' : null,
        },
      },
      validationPlan: packet.validationCommands.map((command, index) => ({
        id: `validation-${index + 1}`,
        command: '/bin/sh',
        args: ['-lc', command],
        required: true,
        revisionSensitive: true,
        timeoutMs: 300_000,
      })),
      evidenceExpectations: criteria.map((criterion, index) => ({
        criterionId: `${story.id}:ac:${deriveStoryContractRevision(criterion)}`,
        description: criterion,
        requiredEvidenceKinds: ['validation', 'revision'],
      })),
      repositoryProfile: {
        profileId: profile.profileId ?? 'rorca-code-change-v1',
        changePolicy,
        noCodeReason,
        runtimeMetadataPaths: ['.rorca/**', '.claude/**', '.opencode/**', '.playwright-mcp/**', 'forge/logs/**', 'forge/specs/**', 'MEMORY.md', 'progress.txt'],
      },
      commandSafety: {
        profileId: 'autonomous-command-guard-v1',
        guardVersion: '1',
        guardedWorkingDirectory: storyWorktreePath,
        allowedWorkingDirectories: [storyWorktreePath],
        blockedCommandPatterns: ['backend/Jest-style tests without an isolated *_test database'],
        redactedEnvironmentKeys: ['ANTHROPIC_API_KEY', 'DATABASE_URL', 'DATABASE_URL_TEST', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'],
        allowBackendJest: false,
        baselineFailurePolicy: profile.baselineFailurePolicy ?? 'block',
      },
    });
    await persistStoryExecutionManifest(manifest);
    manifests.push(manifest);
  }

  const runtimeDir = path.join(input.cwd, '.rorca', 'runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });
  const manifestPath = path.join(runtimeDir, `run-${input.runId}-story-execution-manifests.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifests, null, 2), { encoding: 'utf8', mode: 0o600 });
  return { path: manifestPath, manifests };
}

function buildExecutionReadinessSummary(
  workspacePath: string,
  specJson: Record<string, unknown>,
): {
  mode: 'impl' | 'qa' | 'journey';
  averageScore: number;
  riskyStoryCount: number;
  stories: Array<{
    storyId: string;
    storyTitle: string;
    score: number;
    grade: 'strong' | 'fair' | 'weak';
    warnings: string[];
    recommendedFallbackEngine: 'claude' | 'opencode' | 'codex' | 'pi' | null;
  }>;
} {
  const mode = detectExecutionModeFromSpec(specJson as { mode?: string; phases?: unknown });
  // CTM-006: Resolve the workspace-context signal once through the canonical path
  // so every story's readiness reflects the same context-blindness verdict.
  const wsRouting = routeWorkspaceContext(workspacePath);
  const workspaceContext = {
    richnessScore: wsRouting.richnessScore,
    contractSatisfied: wsRouting.contract.satisfied,
  };
  const stories = ((specJson.userStories ?? []) as CapabilityStory[]).map((story) => {
    const packet = buildStoryExecutionPacket(workspacePath, story, mode, workspaceContext);
    return {
      storyId: story.id,
      storyTitle: story.title,
      score: packet.readiness.score,
      grade: packet.readiness.grade,
      warnings: packet.readiness.warnings,
      recommendedFallbackEngine: packet.readiness.recommendedFallbackEngine,
    };
  });

  const averageScore = stories.length > 0
    ? Math.round(stories.reduce((sum, story) => sum + story.score, 0) / stories.length)
    : 0;

  return {
    mode,
    averageScore,
    riskyStoryCount: stories.filter(story => story.grade === 'weak').length,
    stories,
  };
}

// ─── Fallback Result Syncer ──────────────────────────────────────────────────
// When execution-engine.ts / run-loop.ts can't POST results to the backend
// (backend down, restart, port mismatch), they write to .rorca-results.jsonl.
// This function reads that file and replays entries into the DB.

async function syncFallbackResults(cwd: string, workspaceId: string): Promise<number> {
  const entries = readFallbackResults(cwd);
  if (entries.length === 0) return 0;

  let synced = 0;
  for (const entry of entries) {
    try {
      if (entry.type === 'wal') {
        // Replay WAL event directly into DB
        const p = entry.payload as Record<string, unknown>;
        const walEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, payload) VALUES ($1, $2, $3, $4, $5)` + ' RETURNING *', [p.event_type ?? entry.status,
          p.workspace_id ?? workspaceId,
          p.spec_id ?? null,
          p.story_id ?? entry.storyId,
          JSON.stringify(p.payload ?? p),]);
        broadcastAll(walEvent!);
        synced++;
      } else if (entry.type === 'story_result') {
        // Replay story_result into DB
        const p = entry.payload as Record<string, unknown>;
        const runId = (p.runId as number) ?? entry.runId;
        const storyId = (p.storyId as string) ?? entry.storyId;
        const status = (p.status as string) ?? entry.status;

        if (!runId || !storyId || !status) continue;

        // Check if already synced (idempotent — don't double-insert)
        const existing = await queryOne('SELECT id FROM story_results WHERE run_id = $1 AND story_id = $2', [runId, storyId]);

        if (!existing) {
          const activeSkillsVal = Array.isArray(p.activeSkills) && (p.activeSkills as string[]).length > 0
            ? JSON.stringify(p.activeSkills)
            : null;
          await execute(`INSERT INTO story_results (run_id, story_id, status, finished_at, worktree_path, worktree_branch, input_tokens, output_tokens, model_used, cost_usd, active_skills, completion_packet)
             VALUES ($1, $2, $3, NOW(), $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`, [runId, storyId, status,
            (p.worktreePath as string) ?? null, (p.worktreeBranch as string) ?? null,
            (p.inputTokens as number) ?? null, (p.outputTokens as number) ?? null,
            (p.modelUsed as string) ?? null, (p.costUsd as number) ?? null,
            activeSkillsVal,
            p.completionPacket && typeof p.completionPacket === 'object' ? JSON.stringify(p.completionPacket) : null,]);
        }
        synced++;
      }
    } catch (err: any) {
      logger.error(`[Pipeline] Failed to sync fallback entry: ${err.message}`);
    }
  }

  if (synced > 0) {
    deleteFallbackFile(cwd);
    logger.info(`[Pipeline] Synced ${synced} fallback result(s) from ${cwd}/.rorca-results.jsonl`);
  }
  return synced;
}

// All Claude Code env vars that block nested invocation (same as llm-client.ts)
const CLAUDE_ENV_VARS_TO_REMOVE = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
];

function assertReusableWorktreeFresh(
  workspacePath: string,
  worktreePath: string,
  branchName?: string | null,
): void {
  const result = validateReusableWorktree({
    workspacePath,
    worktreePath,
    expectedBranchName: branchName ?? null,
  });

  if (result.ok) {
    return;
  }

  const detail = result.detail ? ` ${result.detail}.` : '';
  throw new ConflictError(
    `Reusable worktree is stale or invalid (${result.reason}). ` +
    `Refresh or remove ${worktreePath} before retrying.${detail}`,
  );
}

function assertReusableBranchFresh(workspacePath: string, branchName: string): void {
  const result = validateReusableBranch({ workspacePath, branchName });
  if (result.ok) {
    return;
  }

  const detail = result.detail ? ` ${result.detail}.` : '';
  throw new ConflictError(
    `Reusable branch is stale or invalid (${result.reason}). ` +
    `Refresh or recreate ${branchName} before retrying.${detail}`,
  );
}

/** FR-005: When a pipeline run finishes with status='done', snapshot spec version as 'completed'. */
async function markSpecCompleted(specPath: string): Promise<void> {
  try {
    const slug = path.basename(specPath, '.json');
    // Check if latest spec_versions entry is already 'completed'
    const latestVersion = await queryOne(`SELECT status FROM spec_versions WHERE spec_slug = $1 ORDER BY version DESC LIMIT 1`, [slug]) as { status: string } | undefined;
    if (latestVersion?.status === 'completed') return; // already marked

    // Read spec content from filesystem (approved dir is the canonical location)
    // spec_path stored in pipeline_runs is relative like 'forge/specs/approved/slug.json'
    // We just need the slug for the version snapshot
    const run = await queryOne(`SELECT pr.workspace_id, w.path as workspace_path FROM pipeline_runs pr
       JOIN workspaces w ON w.id = pr.workspace_id
       WHERE pr.spec_path = $1 ORDER BY pr.id DESC LIMIT 1`, [specPath]) as { workspace_id: string; workspace_path: string } | undefined;
    if (!run) return;

    const absSpecPath = path.join(run.workspace_path, specPath);
    if (!fs.existsSync(absSpecPath)) return;

    const content = fs.readFileSync(absSpecPath, 'utf8');
    const nextVer = ((await queryOne('SELECT MAX(version) as max_ver FROM spec_versions WHERE spec_slug = $1', [slug]) as { max_ver: number | null } | undefined)?.max_ver ?? 0) + 1;

    await execute(`INSERT INTO spec_versions (spec_slug, version, content_json, status) VALUES ($1, $2, $3, 'completed')`, [slug, nextVer, content]);
  } catch {
    // Non-fatal — completed status is also derived from pipeline_runs at query time
  }
}

const router = Router();

// ─── In-memory output buffers (runId → live stdout/stderr stream) ─────────────
// Chunks are raw text (with ANSI codes). Late-joiners get full buffer replay.
interface OutputBuffer {
  chunks: string[];
  done: boolean;
  subscribers: Set<(chunk: string) => void>;
}
const outputBuffers = new Map<number, OutputBuffer>();

// ─── Types ───────────────────────────────────────────────────────────────────

interface EffectiveRunOptions {
  model: string | null;
  effort: string | null;
  worktree: { enabled: boolean; path: string | null; branch: string | null };
  merge: { strategy: 'direct' | 'pr' | 'draft-pr' | 'branch-only'; autoMerge: boolean };
  graph: { enabled: boolean };
  terminal: TerminalMode;
  safety: {
    guard: 'autonomous-command-guard-v1';
    allowBackendJest: false;
    deploy: boolean;
    externalSend: boolean;
    policyLocked: boolean;
  };
}

function isEffectiveRunOptions(value: unknown): value is EffectiveRunOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<EffectiveRunOptions>;
  return Boolean(candidate.worktree && typeof candidate.worktree.enabled === 'boolean'
    && candidate.merge && ['direct', 'pr', 'draft-pr', 'branch-only'].includes(candidate.merge.strategy)
    && typeof candidate.merge.autoMerge === 'boolean'
    && candidate.graph && typeof candidate.graph.enabled === 'boolean'
    && candidate.safety && candidate.safety.guard === 'autonomous-command-guard-v1'
    && candidate.safety.allowBackendJest === false
    && typeof candidate.safety.deploy === 'boolean'
    && typeof candidate.safety.externalSend === 'boolean'
    && typeof candidate.safety.policyLocked === 'boolean');
}

function buildEffectiveRunOptions(input: {
  model: string | null;
  effort: string | null | undefined;
  autoWorktree: boolean;
  worktreePath: string | null;
  branchName: string | null;
  mergeStrategy: EffectiveRunOptions['merge']['strategy'];
  autoMerge: boolean;
  includeGraph: boolean;
  terminal: TerminalMode;
  policyLocked: boolean;
  deploy: boolean;
  externalSend: boolean;
}): EffectiveRunOptions {
  return {
    model: input.model,
    effort: input.effort ?? null,
    worktree: { enabled: input.autoWorktree, path: input.worktreePath, branch: input.branchName },
    merge: { strategy: input.mergeStrategy, autoMerge: input.autoMerge },
    graph: { enabled: input.includeGraph },
    terminal: input.terminal,
    safety: {
      guard: 'autonomous-command-guard-v1',
      allowBackendJest: false,
      deploy: input.deploy,
      externalSend: input.externalSend,
      policyLocked: input.policyLocked,
    },
  };
}

interface PipelineRunRow {
  id: number;
  spec_path: string;
  workspace_id: string;
  status: string;
  pid: number | null;
  branch_name: string | null;
  worktree_path: string | null;
  trigger_type: string;
  started_at: string;
  finished_at: string | null;
  retried_from_run_id: number | null;
  log_path: string | null;
  agent: string | null;
  agent_type: string | null;
  agent_model: string | null;
  lifecycle_phase?: string | null;
  parallelism: number;
  opencode_server_pid: number | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  total_cost_usd: number | null;
  queued_at: string | null;
  queue_position: number | null;
  auto_merge: boolean;
  merge_status: string | null;
  merge_commit_sha: string | null;
  merge_error?: string | null;
  pr_number?: number | null;
  pr_creating?: boolean | null;
  pr_creation_error?: string | null;
  merge_strategy: 'direct' | 'pr' | 'draft-pr' | 'branch-only' | null;
  triggered_via: 'queue' | 'run_now';
  auto_worktree: boolean;
  include_graph: boolean;
  terminal_mode: TerminalMode | null;
  effective_options: EffectiveRunOptions | null;
  idempotency_key?: string | null;
  task_manifest_id?: string | null;
  task_manifest_artifacts?: Record<string, unknown> | string | null;
  trigger_options?: Record<string, unknown> | string | null;
  lifecycle_status?: string | null;
  lifecycle_updated_at?: string | null;
  lifecycle_diagnostics?: Record<string, unknown> | string | null;
}

function resolveRequestedTerminalMode(value: string | null | undefined): TerminalMode {
  if (value === null || value === undefined) {
    return DEFAULT_TERMINAL_MODE;
  }
  if (!isTerminalMode(value)) {
    throw new ValidationError(invalidTerminalModeMessage(value));
  }
  return value;
}

/** Convert PostgreSQL BIGINT IDs to the strict numeric worker contract safely. */
function normalizeWorkerRunId(value: unknown): number {
  const runId = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(runId) || runId <= 0) {
    throw new ServiceUnavailableError('Pipeline run ID cannot be represented safely by the execution worker.');
  }
  return runId;
}

function assertTerminalModeAvailable(mode: TerminalMode): void {
  if (isPtyTerminalMode(mode) && !PTY_AVAILABLE) {
    throw new ServiceUnavailableError(`PTY terminal mode is unavailable on this server. ${PTY_UNAVAILABLE_HINT}`);
  }
}

type CanonicalPipelineRun<T extends PipelineRunRow> = Omit<T, 'agent_type' | 'agent_model' | 'terminal_mode' | 'lifecycle_status'> & {
  agent_type: NormalizedRunAgentType;
  agent_model: string | null;
  terminal_mode: TerminalMode;
  lifecycle_status: RunLifecycleStatus;
} & ReturnType<typeof normalizeRunMetadata>;

function normalizePipelineRun<T extends PipelineRunRow>(run: T): CanonicalPipelineRun<T> {
  const metadata = normalizeRunMetadata(run);
  const lifecycleStatus = metadata.lifecyclePhase ?? lifecycleFromLegacyStatus(run.status);
  return {
    ...run,
    // Missing historical agent telemetry remains Unknown. Lifecycle stays
    // backend-owned and never comes from terminal/WAL inference.
    agent_type: metadata.agentType,
    agent_model: metadata.agentModel,
    terminal_mode: metadata.terminalMode,
    ...metadata,
    lifecycle_status: lifecycleStatus,
    lifecycleStatus,
    lifecyclePhase: lifecycleStatus,
    lifecycle_phase: lifecycleStatus,
  };
}

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonRecordLike(value: unknown): JsonRecord | null {
  if (isJsonRecord(value)) return value;
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isJsonRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseJsonRecordArrayLike(value: unknown): JsonRecord[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const records = value.filter(isJsonRecord);
  return records.length === value.length ? records : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getStoredManifestHashFromRun(row: Pick<PipelineRunRow, 'trigger_options' | 'task_manifest_artifacts'>): string | undefined {
  const triggerOptions = parseJsonRecordLike(row.trigger_options);
  const artifacts = parseJsonRecordLike(row.task_manifest_artifacts);
  return stringValue(triggerOptions?.manifestHash)
    ?? stringValue(parseJsonRecordLike(triggerOptions?.taskManifest)?.manifestHash)
    ?? stringValue(artifacts?.manifestHash);
}

function getStoredArtifactRefsFromTriggerOptions(value: unknown): JsonRecord[] | undefined {
  const triggerOptions = parseJsonRecordLike(value);
  return parseJsonRecordArrayLike(triggerOptions?.artifactRefs);
}

function buildManifestSourceFromRun(row: Pick<PipelineRunRow, 'idempotency_key' | 'task_manifest_id' | 'task_manifest_artifacts' | 'trigger_options'>): JsonRecord | null {
  const triggerOptions = parseJsonRecordLike(row.trigger_options);
  const artifacts = parseJsonRecordLike(row.task_manifest_artifacts);
  const manifestId = row.task_manifest_id ?? stringValue(triggerOptions?.manifestId);
  const idempotencyKey = row.idempotency_key ?? stringValue(triggerOptions?.idempotencyKey);
  const manifestHash = getStoredManifestHashFromRun(row);

  if (!manifestId && !idempotencyKey && !manifestHash && !artifacts && !triggerOptions) {
    return null;
  }

  const artifactPaths = parseJsonRecordLike(triggerOptions?.artifactPaths)
    ?? (artifacts ? {
      artifactDir: artifacts.artifactDir,
      manifestPath: artifacts.manifestPath,
      tasksMdPath: artifacts.tasksMdPath,
      specPath: artifacts.specPath,
    } : undefined);

  return {
    manifestId: manifestId ?? null,
    idempotencyKey: idempotencyKey ?? null,
    manifestHash: manifestHash ?? null,
    sourceRefs: triggerOptions?.sourceRefs ?? null,
    artifactPaths: artifactPaths ?? null,
    routeDecision: triggerOptions?.routeDecision ?? null,
    routeDecisionSummary: triggerOptions?.routeDecisionSummary ?? null,
    artifacts: artifacts ?? null,
  };
}

interface StoryResultRow {
  id: number;
  run_id: number;
  story_id: string;
  status: string;
  retries: number;
  log_path: string | null;
  started_at: string;
  finished_at: string | null;
  elapsed_seconds: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  model_used: string | null;
  cost_usd: number | null;
}

/**
 * @swagger
 * /api/pipeline/preflight:
 *   post:
 *     tags: [Pipeline]
 *     summary: Pre-flight capability check for spec stories vs engine
 *     operationId: preflightPipelineCheck
 *     description: Validates that the current execution engine supports all tools required by each story in the spec and returns a compatibility report.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [specPath, workspaceId]
 *             properties:
 *               specPath: { type: string }
 *               workspaceId: { type: string }
 *     responses:
 *       200:
 *         description: Capability report
 */
router.post('/preflight', async (req: Request, res: Response) => {
  try {
    const { specPath, workspaceId } = req.body;
    if (!specPath || !workspaceId) {
      throw new ValidationError('Missing required fields: specPath, workspaceId');
      return;
    }

    const workspace = await queryOne('SELECT * FROM workspaces WHERE id = $1', [workspaceId]) as
      { id: string; path: string } | undefined;
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const absSpecPath = path.join(workspace.path, specPath);
    if (!fs.existsSync(absSpecPath)) {
      throw new NotFoundError('Spec file not found');
      return;
    }

    const specJson = JSON.parse(fs.readFileSync(absSpecPath, 'utf8'));
    const stories = (specJson.userStories ?? []) as CapabilityStory[];
    const resolvedAgent = activeAgent;
    const report = checkSpec(stories, resolvedAgent);
    const orchConfig = loadOrchestrationConfig(workspace.path);
    const executionReadiness = buildExecutionReadinessSummary(workspace.path, specJson);

    let browserMcpAvailable = false;
    try {
      require.resolve('@playwright/mcp');
      browserMcpAvailable = true;
    } catch {
      browserMcpAvailable = false;
    }

    res.json({
      compatible: report.compatible,
      mismatchMode: orchConfig.capabilityMismatch,
      engine: resolvedAgent,
      stories: report.stories.map(s => ({
        storyId: s.storyId,
        storyTitle: s.storyTitle,
        engine: s.engine,
        missingTools: s.result.missingTools,
        warnings: s.result.warnings,
      })),
      executionReadiness,
      browserMcpAvailable,
      browserMcpPort: 4040,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Preflight');
  }
});

/**
 * @swagger
 * /api/pipeline/trigger:
 *   post:
 *     tags: [Pipeline]
 *     summary: Trigger a pipeline run (spawn run-loop.sh)
 *     operationId: triggerPipelineRun
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Starting a local spec run is a core open-source CLI action and must remain callable via MCP and REST."
 *     x-rorca-public-api: true
 *     description: Spawns the execution engine as a subprocess to run all stories in the specified spec, optionally in a git worktree.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [specPath, workspaceId]
 *             properties:
 *               specPath: { type: string, example: "forge/specs/approved/my-spec.json" }
 *               workspaceId: { type: string }
 *               autoWorktree: { type: boolean, default: false, description: "Create git worktree for isolated run" }
 *               autoMerge: { type: boolean, default: false, description: "Auto-merge worktree branch to main on successful run" }
 *               mergeStrategy: { type: string, enum: [direct, pr, draft-pr, branch-only], default: direct, description: "Post-run branch handling strategy when worktrees are enabled" }
 *               dryRun: { type: boolean, default: false }
 *               triggerType: { type: string, enum: [manual, scheduled], default: manual }
 *               includeGraph: { type: boolean, default: false, description: "Include knowledge graph context in the pipeline run" }
 *               agentOverride: { type: string, enum: [claude, opencode, codex, pi], description: "Override the execution agent for this run" }
 *               modelOverride: { type: string, description: "Override the execution model for this run" }
 *               storyId: { type: string, description: "Run only a specific story ID from the spec" }
 *               thinkingEnabled: { type: boolean, description: "Enable extended reasoning for supported agents" }
 *               thinkingBudget: { type: integer, description: "Budget for extended reasoning" }
 *               effortLevel: { type: string, enum: [low, medium, high, max, xhigh], description: "Reasoning effort level hint for supported agents" }
 *               forceRerun: { type: boolean, description: "Force rerun even if an identical idempotent request already exists; does not reset passed story state." }
 *               rerunFromScratch: { type: boolean, description: "Reset passed story state and execute the spec from the first non-excluded story." }
 *               readinessOverride: { type: boolean, description: "Explicitly run despite readiness blockers; usage is logged to WAL for auditability." }
 *               terminal_mode:
 *                 type: string
 *                 enum: [ansi-html, pty, native-pty]
 *                 nullable: true
 *                 default: ansi-html
 *                 description: "Run-level terminal renderer mode. native-pty runs the real interactive CLI in xterm with marker-based completion. null/missing resolves to ansi-html for backward compatibility."
 *               executionEnvironment:
 *                 type: string
 *                 enum: [remote-rorca, local-user]
 *                 default: remote-rorca
 *                 description: "Where the implementation engine executes. local-user requires a configured local execution bridge and fails closed otherwise."
 *     responses:
 *       200:
 *         description: Pipeline started or conflict detected
 *         content:
 *           application/json:
 *             schema:
 *               oneOf:
 *                 - type: object
 *                   properties:
 *                     ok: { type: boolean }
 *                     runId: { type: integer }
 *                     worktreePath: { type: string }
 *                     branchName: { type: string }
 *                 - type: object
 *                   properties:
 *                     conflict: { type: boolean }
 *                     activeRunId: { type: integer }
 *       400: { description: "Missing required fields" }
 *       404: { description: "Workspace or spec not found" }
 */
const PipelineTriggerSchema = z.object({
  specPath: z.string().min(1),
  workspaceId: z.union([z.string().min(1), z.number()]),
  autoWorktree: z.boolean().optional(),
  autoMerge: z.boolean().optional(),
  mergeStrategy: z.enum(['direct', 'pr', 'draft-pr', 'branch-only']).optional(),
  dryRun: z.boolean().optional(),
  triggerType: z.enum(['manual', 'scheduled']).optional(),
  forceSequential: z.boolean().optional(),
  agentOverride: z.enum(['claude', 'opencode', 'codex', 'pi']).optional(),
  modelOverride: z.string().optional(),
  storyId: z.string().optional(),
  // PostgreSQL BIGINT values are returned as strings by node-postgres.
  queuedRunId: z.union([z.number(), z.string()]).optional(),
  queue: z.boolean().optional(),
  includeGraph: z.boolean().optional(),
  thinkingEnabled: z.boolean().optional(),
  thinkingBudget: z.number().int().positive().optional(),
  effortLevel: z.enum(['low', 'medium', 'high', 'max', 'xhigh']).optional(),
  reasoningEffort: z.string().optional(),
  reasoning: z.object({ enabled: z.boolean(), effort: z.string().optional() }).optional(),
  forceRerun: z.boolean().optional(),
  rerunFromScratch: z.boolean().optional(),
  readinessOverride: z.boolean().optional(),
  runAnywayOverride: z.boolean().optional(),
  overrideReadinessGate: z.boolean().optional(),
  terminal_mode: z.string().nullable().optional(),
  terminalMode: z.string().nullable().optional(),
  idempotencyKey: z.string().optional(),
  manifestId: z.string().optional(),
  taskManifestArtifacts: z.record(z.string(), z.unknown()).optional(),
  taskManifestArtifactRefs: z.array(z.record(z.string(), z.unknown())).optional(),
  triggerOptions: z.record(z.string(), z.unknown()).optional(),
  reservedRunId: z.number().optional(),
  executionEnvironment: z.enum(['remote-rorca', 'local-user']).optional(),
  executionEnvironmentId: z.string().optional(),
}).passthrough();

const HERMES_LEGACY_REPAIR_METADATA_FIELDS = [
  'repairPlanId',
  'evidenceIds',
  'validationGate',
  'principleSelection',
  'principlePromptBundles',
  'branchStrategy',
  'branchName',
  'worktreePath',
  'baseBranch',
  'baseHead',
] as const;

function presentHermesLegacyRepairMetadataFields(body: Record<string, unknown>): string[] {
  return HERMES_LEGACY_REPAIR_METADATA_FIELDS.filter((field) => (
    Object.prototype.hasOwnProperty.call(body, field) && body[field] !== undefined
  ));
}

function assertNoLegacyHermesRepairMetadataOnPipelineTrigger(body: Record<string, unknown>): void {
  const fields = presentHermesLegacyRepairMetadataFields(body);
  if (fields.length === 0) return;

  throw new ValidationError(
    'Legacy Hermes repair metadata posted to /api/pipeline/trigger is not a typed task manifest. Convert repairPlanId/evidenceIds/validationGate/principleSelection/branchStrategy into a TaskManifest v1 and POST /api/pipeline/task-manifests/trigger with workspaceId, manifest, and idempotencyKey.',
    {
      code: 'HERMES_REPAIR_METADATA_REQUIRES_TASK_MANIFEST',
      fields,
      endpoint: '/api/pipeline/task-manifests/trigger',
    },
  );
}

// Keep registration immediately before the handler declaration so source-level
// dispatch audits can bound the complete trigger path from route to queue send.
router.post('/trigger', validateBody(PipelineTriggerSchema), handlePipelineTrigger);

async function handlePipelineTrigger(req: Request, res: Response): Promise<void> {
  try {
    assertNoLegacyHermesRepairMetadataOnPipelineTrigger(req.body as Record<string, unknown>);
    const { specPath, workspaceId, autoWorktree, autoMerge, mergeStrategy, dryRun, triggerType, forceSequential, queuedRunId, reservedRunId, includeGraph, agentOverride, modelOverride, storyId, thinkingEnabled, thinkingBudget, effortLevel, reasoningEffort, reasoning, rerunFromScratch, readinessOverride, runAnywayOverride, overrideReadinessGate, terminal_mode, terminalMode, idempotencyKey, manifestId, taskManifestArtifacts, taskManifestArtifactRefs, triggerOptions, executionEnvironment, executionEnvironmentId, manifestExecutionAgentOverride, manifestExecutionModelOverride } = req.body;
    const readinessOverrideRequested = readinessOverride === true || runAnywayOverride === true || overrideReadinessGate === true;

    // 1. Look up workspace path
    const workspace = await queryOne('SELECT * FROM workspaces WHERE id = $1', [workspaceId]) as
      { id: string; label: string; path: string; domain?: string } | undefined;
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const resolvedTerminalMode = resolveRequestedTerminalMode(terminal_mode ?? terminalMode);
    assertTerminalModeAvailable(resolvedTerminalMode);
    const resolvedExecutionEnvironment = resolveExecutionEnvironment(executionEnvironment);
    await assertExecutionEnvironmentReady(resolvedExecutionEnvironment);

    // Plan enforcement is handled by requirePlan middleware once billing-launch spec is complete.

    // ── Dry-run: return cost estimate without spawning any processes ─────
    if (dryRun) {
      const absSpecPath = path.join(workspace.path, specPath);
      if (!fs.existsSync(absSpecPath)) {
        throw new UnprocessableError(`Spec file not found at ${absSpecPath}`);
        return;
      }

      const specJson = JSON.parse(fs.readFileSync(absSpecPath, 'utf8'));
      if (!specJson.userStories || !Array.isArray(specJson.userStories)) {
        throw new UnprocessableError('Spec has no userStories array');
        return;
      }

      // Model comes from spec JSON only
      const model: string = specJson.model ?? DEFAULT_MODEL;

      const dryRunReasoningOptions = reasoning !== undefined
        ? { enabled: reasoning.enabled, effort: reasoning.effort ?? effortLevel ?? undefined }
        : thinkingEnabled !== undefined
          ? { enabled: Boolean(thinkingEnabled), effort: reasoningEffort ?? effortLevel ?? undefined }
          : undefined;
      const estimate = await estimateDryRunCost(specJson, workspaceId, model, dryRunReasoningOptions);
      res.json({
        dryRun: true,
        executionEnvironment: resolvedExecutionEnvironment.effective,
        terminalMode: resolvedTerminalMode,
        terminal_mode: resolvedTerminalMode,
        estimate,
      });
      return;
    }

    const specIdForReadiness = path.basename(specPath, '.json');
    const specReadiness = await getSpecReadiness({
      workspaceId,
      workspacePath: workspace.path,
      specId: specIdForReadiness,
      specPath,
    });
    // Do not record overrides yet. Agent/model/effort preflight below must fail
    // before any run/readiness mutation is persisted.
    (req as any)._specReadiness = specReadiness;

    // 2. Budget cap guard — block if hard cap exceeded for this period
    const budgetStatus = await checkBudgetThresholds(workspaceId);
    if (budgetStatus.capExceeded) {
      throw new ConflictError('Budget cap exceeded for this period');
      return;
    }

    // 3. Resolve agent type and model via the shared pipeline/task-manifest helper.
    //    Agent precedence: request > manifest (when provided by caller) > spec/envelope > model auto-switch > workflow router > active fallback.
    //    Model precedence: request > manifest (when provided by caller) > spec/envelope > workflow router > active fallback.
    const pipelineUser = await getEffectiveUser(req);
    const wfConfig = await resolveWorkflowConfig('pipeline_execution', pipelineUser?.id);

    const specModelPath = path.join(workspace.path, specPath);
    const specModelJson = fs.existsSync(specModelPath) ? JSON.parse(fs.readFileSync(specModelPath, 'utf8')) : {};
    const specLevelModel: string | null = specModelJson.model ?? null;
    // Read spec-level agent override saved by SpecModelControlBar (PUT /api/specs/:id) or synthetic task-manifest envelope.
    const specLevelAgent: AgentType | null = specModelJson.agentOverride ?? null;
    // Read spec-level reasoning config — used as defaults when trigger request omits reasoning params
    const specReasoning: { enabled: boolean; effort?: string } | undefined = specModelJson.reasoning;
    const specEffortLevel: string | undefined = typeof specModelJson.effortLevel === 'string' ? specModelJson.effortLevel : undefined;
    const specThinkingEnabled: boolean | undefined = typeof specModelJson.thinkingEnabled === 'boolean' ? specModelJson.thinkingEnabled : undefined;
    const resolvedThinkingEnabled: boolean | undefined = thinkingEnabled !== undefined
      ? thinkingEnabled
      : (reasoning?.enabled ?? specThinkingEnabled ?? specReasoning?.enabled ?? undefined);
    let resolvedReasoningEffort: string | undefined = reasoningEffort
      ?? reasoning?.effort
      ?? effortLevel
      ?? specReasoning?.effort
      ?? specEffortLevel;

    // Preserve the canonical execution-option precedence shared with task-manifest dispatch.
    const executionOptions = resolveExecutionOptions({
      requestAgentOverride: agentOverride,
      manifestAgentOverride: manifestExecutionAgentOverride,
      specAgentOverride: specLevelAgent,
      requestModelOverride: modelOverride,
      manifestModelOverride: manifestExecutionModelOverride,
      specModel: specLevelModel,
      workflowConfig: wfConfig,
      activeAgentFallback: activeAgent,
      activeModelFallback: activeModel,
      log: logger,
    });
    const resolvedAgentType: AgentType = executionOptions.resolvedAgentType;
    let finalAgentModel = executionOptions.finalAgentModel;

    let piCatalog: piDetector.PiModel[] | null = null;
    const preflightPiSelection = (model: string | null, effort: string | null | undefined) => {
      if (!piCatalog) {
        const piStatus = piDetector.detectPi();
        if (!piStatus.piInstalled || !piStatus.piBinPath) {
          throw new ValidationError('pi_preflight:not_installed');
        }
        piCatalog = piDetector.listPiModels(piStatus.piBinPath);
      }
      try {
        return preflightPiModelAndEffort(model, effort, piCatalog, DEFAULT_PI_MODEL);
      } catch (error: unknown) {
        if (error instanceof PiExecutionPreflightError) {
          throw new ValidationError(`pi_preflight:${error.code}: ${error.message}`);
        }
        throw error;
      }
    };

    if (resolvedAgentType === 'pi') {
      const selection = preflightPiSelection(finalAgentModel, resolvedReasoningEffort);
      finalAgentModel = selection.model;
      resolvedReasoningEffort = selection.effort ?? undefined;
    }

    // Per-story Pi assignments use the same model/effort mechanism and must be
    // validated before readiness, run-row, worktree, hook, or queue mutation.
    const phaseStoriesForPreflight = Array.isArray(specModelJson.phases)
      ? (specModelJson.phases as Array<{ stories?: DispatchManifestStory[] }>).flatMap(phase => phase.stories ?? [])
      : [];
    const storiesForPreflight = (Array.isArray(specModelJson.userStories)
      ? specModelJson.userStories
      : phaseStoriesForPreflight) as DispatchManifestStory[];
    for (const dispatchStory of storiesForPreflight) {
      if (dispatchStory.excluded) continue;
      if (resolveStoryAgent(dispatchStory as EngineUserStory, resolvedAgentType) !== 'pi') continue;
      preflightPiSelection(
        dispatchStory.model ?? executionOptions.resolvedAgentModel,
        dispatchStory.effort ?? resolvedReasoningEffort,
      );
    }

    // Lock initial SSDLC safety before the first mutation. Prose/_notes cannot
    // weaken these values; retries consume the persisted structured options.
    const autonomousSafety = resolvePiRunSafetyOptions(specPath, specModelJson, {
      autoWorktree: Boolean(autoWorktree),
      autoMerge: Boolean(autoWorktree) && autoMerge !== false,
      mergeStrategy: mergeStrategy ?? 'direct',
    });

    // All model/effort/safety preflight has succeeded. Readiness override audit
    // is the first intentional mutation in this trigger path.
    assertSpecReadinessAllowsMutation(specReadiness, readinessOverrideRequested);
    if (specReadiness.executionGate.status === 'blocked' && readinessOverrideRequested) {
      await recordSpecReadinessOverride({ workspaceId, specId: specIdForReadiness, action: 'run', readiness: specReadiness });
    }

    // OC-025: Block pipeline trigger if Claude is selected but not authenticated
    if (resolvedExecutionEnvironment.effective === 'remote-rorca' && resolvedAgentType === 'claude') {
      const { getClaudeAuthState } = await import('../lib/claude-auth');
      const authState = getClaudeAuthState();
      if (!authState.connected) {
        throw new ForbiddenError('claude_not_authenticated');
        return;
      }
    }

    // OC-026: Block pipeline trigger if Codex is selected but not authenticated
    if (resolvedExecutionEnvironment.effective === 'remote-rorca' && resolvedAgentType === 'codex') {
      const { getCodexAuthState } = await import('../lib/codex-auth');
      const authState = getCodexAuthState();
      if (!authState.connected) {
        throw new ForbiddenError('codex_not_authenticated');
        return;
      }
    }

    // OC-029: Scan per-story agent assignments and validate ALL required engines
    const requiredEnginesForRun = new Set<AgentType>([resolvedAgentType]);
    const absSpecPathForScan = path.join(workspace.path, specPath);
    if (fs.existsSync(absSpecPathForScan)) {
      try {
        const specJsonForScan = JSON.parse(fs.readFileSync(absSpecPathForScan, 'utf8'));
        const specStories = (specJsonForScan.userStories ?? []) as EngineUserStory[];
        const requiredEngines = scanRequiredEngines(specStories, resolvedAgentType);
        for (const engine of requiredEngines) requiredEnginesForRun.add(engine as AgentType);
        const engineCounts = countStoriesByEngine(specStories, resolvedAgentType);

        // Validate each required engine is authenticated
        const authErrors: string[] = [];

        if (resolvedExecutionEnvironment.effective === 'remote-rorca' && requiredEngines.has('claude')) {
          const { getClaudeAuthState } = await import('../lib/claude-auth');
          const authState = getClaudeAuthState();
          if (!authState.connected) {
            const count = engineCounts.get('claude') ?? 0;
            authErrors.push(`Claude not authenticated — ${count} ${count === 1 ? 'story' : 'stories'} assigned`);
          }
        }

        if (resolvedExecutionEnvironment.effective === 'remote-rorca' && requiredEngines.has('codex')) {
          const { getCodexAuthState } = await import('../lib/codex-auth');
          const authState = getCodexAuthState();
          if (!authState.connected) {
            const count = engineCounts.get('codex') ?? 0;
            authErrors.push(`Codex not authenticated — ${count} ${count === 1 ? 'story' : 'stories'} assigned`);
          }
        }

        if (resolvedExecutionEnvironment.effective === 'remote-rorca' && requiredEngines.has('opencode')) {
          const { detectOpenCode } = await import('../lib/opencode-detector');
          const ocStatus = detectOpenCode();
          if (!ocStatus.opencodeInstalled) {
            const count = engineCounts.get('opencode') ?? 0;
            authErrors.push(`OpenCode not installed — ${count} ${count === 1 ? 'story' : 'stories'} assigned`);
          }
        }

        if (authErrors.length > 0) {
          throw new ForbiddenError('engine_auth_required');
          return;
        }
      } catch (error) {
        if (error instanceof ForbiddenError) throw error;
        // Spec parse error — non-fatal for auth scanning, let the trigger proceed
      }
    }

    for (const requiredAgent of requiredEnginesForRun) {
      const executionReadiness = await assertExecutionEnvironmentReadyForRun({
        environmentId: resolvedExecutionEnvironment.effective,
        workspaceId,
        agent: requiredAgent,
      });
      (req as any)._executionReadiness = executionReadiness;
    }

    // OC-031: Tool capability check — detect stories requiring tools the engine doesn't support
    if (fs.existsSync(path.join(workspace.path, specPath))) {
      try {
        const specJsonForCap = JSON.parse(fs.readFileSync(path.join(workspace.path, specPath), 'utf8'));
        const capStories = (specJsonForCap.userStories ?? []) as CapabilityStory[];
        const capReport = checkSpec(capStories, resolvedAgentType);

        if (!capReport.compatible) {
          const orchConfig = loadOrchestrationConfig(workspace.path);
          const mismatchMode: CapabilityMismatchMode = orchConfig.capabilityMismatch;

          if (mismatchMode === 'block') {
            const incompatible = capReport.stories.map(s => ({
              storyId: s.storyId,
              storyTitle: s.storyTitle,
              engine: s.engine,
              missingTools: s.result.missingTools,
              warnings: s.result.warnings,
            }));
            throw new ValidationError('capability_mismatch', { incompatible });
            return;
          }

          // For 'warn' and 'reroute', attach warnings to the response (handled at end)
          // Store in locals for response augmentation
          (req as any)._capabilityWarnings = capReport.stories.map(s => ({
            storyId: s.storyId,
            storyTitle: s.storyTitle,
            engine: s.engine,
            missingTools: s.result.missingTools,
            warnings: s.result.warnings,
          }));
          (req as any)._capabilityMismatchMode = mismatchMode;
        }
      } catch (error) {
        if (error instanceof ValidationError) throw error;
        // Spec parse or capability inspection errors are non-fatal.
      }
    }

    // Shared execution-readiness summary — surfaces concrete execution quality signals
    // to the UI/API before the run starts. This is advisory for manual runs; the
    // execution-engine enforces the no-op recovery path during execution.
    if (fs.existsSync(path.join(workspace.path, specPath))) {
      try {
        const specJsonForReadiness = JSON.parse(fs.readFileSync(path.join(workspace.path, specPath), 'utf8'));
        (req as any)._executionReadiness = buildExecutionReadinessSummary(workspace.path, specJsonForReadiness);
      } catch {
        // Non-fatal — let the trigger proceed
      }
    }

    // CA-006: Pre-execution convention drift check
    // If .rorca/config.json has execution.driftCheck: true, run drift detection
    // and block the pipeline if error-severity violations exist.
    if (isDriftCheckEnabled(workspace.path)) {
      try {
        const driftReport: DriftReport = await detectDrift(workspace.path, workspaceId);

        // Store the report
        await execute(`INSERT INTO drift_reports (workspace_id, violations_json, score, conventions_checked, files_sampled, trigger_type)
           VALUES ($1, $2, $3, $4, $5, $6)`, [workspaceId,
          JSON.stringify(driftReport.violations),
          driftReport.score,
          driftReport.conventionsChecked,
          driftReport.filesSampled,
          'pre-execution',]);

        // Emit WAL event
        const walPayload: Record<string, unknown> = {
          score: driftReport.score,
          violationCount: driftReport.violations.length,
          errorCount: driftReport.violations.filter(v => v.severity === 'error').length,
          warningCount: driftReport.violations.filter(v => v.severity === 'warning').length,
          conventionsChecked: driftReport.conventionsChecked,
          filesSampled: driftReport.filesSampled,
          triggerType: 'pre-execution',
        };
        const walResult = await queryOne<WalEvent>('INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ($1, $2, $3) RETURNING *', ['convention_drift_detected', workspaceId, JSON.stringify(walPayload)]);
        broadcastAll({
          id: walResult!.id,
          ts: new Date().toISOString(),
          event_type: 'convention_drift_detected',
          workspace_id: workspaceId,
          spec_id: null,
          story_id: null,
          actor: '',
          payload: JSON.stringify(walPayload),
        });

        if (hasBlockingViolations(driftReport)) {
          throw new ConflictError('convention_drift_detected');
          return;
        }
      } catch (driftErr: any) {
        // Drift check failure is non-fatal — log and continue
        logger.warn('[drift-check] Pre-execution drift check failed:', driftErr.message);
      }
    }

    const executionEngineEntrypoint = resolveExecutionEngineEntrypoint(path.join(__dirname, '..'));
    const runLoopSh = path.join(workspace.path, 'forge', 'run-loop.sh');
    const hasExecutionEngine = executionEngineEntrypoint.exists;
    const hasBashRunLoop = fs.existsSync(runLoopSh);

    if (!hasExecutionEngine && !hasBashRunLoop) {
      throw new UnprocessableError('No execution engine found — expected execution-engine.js or execution-engine.ts');
      return;
    }

    // Reconcile before queue-row creation, worktree creation, manifest creation,
    // or pg-boss dispatch. An ambiguous story must never be converted into an
    // automatic scope by the scheduler.
    const passReconciliation = await reconcileApprovedSpecPasses({
      workspaceId,
      workspacePath: workspace.path,
      specPath,
    });
    assertReconciliationAllowsAutomaticScope(passReconciliation);
    (req as any)._passReconciliation = passReconciliation;

    // 4. Conflict check — workspace-scoped, respects queue vs run_now semantics
    //    If queuedRunId is set, this is an internal promotion call — skip conflict check entirely
    const { queue } = req.body;
    const effectiveAutoWorktreeRequest = autonomousSafety.policyLocked
      ? autonomousSafety.autoWorktree
      : Boolean(autoWorktree);
    // The locked SSDLC policy must use the canonical in-engine Pi runner; the
    // optional external orchestration mode would bypass its cleanup/closeout seam.
    const useExternalPiOrchestration = resolvedAgentType === 'pi'
      && isPiExternalOrchestrationEnabled()
      && !autonomousSafety.policyLocked;

    if (!queuedRunId && !reservedRunId) {
      // ── 4a. Queue operations: always accepted up to max queue depth ──────────
      if (queue && !useExternalPiOrchestration) {
        const MAX_QUEUE_DEPTH = 10;
        const queueCount = Number((await queryOne<{ count: string }>(`SELECT COUNT(*) as count FROM pipeline_runs WHERE workspace_id = $1 AND status = 'queued'`, [workspaceId]))?.count ?? '0');

        if (queueCount >= MAX_QUEUE_DEPTH) {
          res.status(429).json({ error: 'Queue full', currentDepth: queueCount, maxQueueDepth: MAX_QUEUE_DEPTH });
          return;
        }

        // Idempotent re-queue warning: same spec already queued for this workspace
        const specSlugForQueue = path.basename(specPath, '.json');
        const existingQueued = await queryOne<{ id: number }>(`SELECT id FROM pipeline_runs WHERE workspace_id = $1 AND status = 'queued' AND spec_path = $2 LIMIT 1`, [workspaceId, specPath]);

        const position = queueCount + 1;
        const queuedSpecSlug = path.basename(specPath, '.json').replace(/[^a-z0-9-]/gi, '-');
        const queuedBranchName = effectiveAutoWorktreeRequest ? `feat/${queuedSpecSlug}` : null;
        const queuedWorktreePath = queuedBranchName
          ? path.resolve(workspace.path, '..', `${path.basename(workspace.path)}-${queuedBranchName.replace(/\//g, '-')}`)
          : null;
        const queuedMergeStrategy = autonomousSafety.policyLocked
          ? 'branch-only'
          : (mergeStrategy ?? 'direct');
        const queuedAutoMerge = autonomousSafety.policyLocked
          ? false
          : effectiveAutoWorktreeRequest && autoMerge !== false;
        const queuedEffectiveOptions = buildEffectiveRunOptions({
          model: finalAgentModel,
          effort: resolvedReasoningEffort,
          autoWorktree: effectiveAutoWorktreeRequest,
          worktreePath: queuedWorktreePath,
          branchName: queuedBranchName,
          mergeStrategy: queuedMergeStrategy,
          autoMerge: queuedAutoMerge,
          includeGraph: includeGraph ?? false,
          terminal: resolvedTerminalMode,
          policyLocked: autonomousSafety.policyLocked,
          deploy: autonomousSafety.deploy,
          externalSend: autonomousSafety.externalSend,
        });
        const queuedBaseTriggerOptions = Object.fromEntries(
          Object.entries({
            autoWorktree: effectiveAutoWorktreeRequest,
            autoMerge: queuedAutoMerge,
            mergeStrategy: queuedMergeStrategy,
            triggerType: triggerType === 'scheduled' ? 'scheduled' : 'manual',
            forceSequential,
            agentOverride,
            modelOverride,
            storyId,
            includeGraph,
            thinkingEnabled: resolvedThinkingEnabled,
            thinkingBudget,
            effortLevel,
            reasoningEffort: resolvedReasoningEffort,
            reasoning,
            rerunFromScratch,
            readinessOverride,
            runAnywayOverride,
            overrideReadinessGate,
            terminal_mode: resolvedTerminalMode,
            executionEnvironment: resolvedExecutionEnvironment.effective,
          }).filter(([, value]) => value !== undefined)
        );
        const queuedTriggerOptions = JSON.stringify({ ...queuedBaseTriggerOptions, ...(triggerOptions ?? {}) });
        const queuedTaskManifestArtifacts = taskManifestArtifacts ? JSON.stringify(taskManifestArtifacts) : null;
        const queueResult = await queryOne<{id: number}>(`INSERT INTO pipeline_runs
          (spec_path, workspace_id, status, trigger_type, queued_at, queue_position, triggered_via,
           auto_worktree, auto_merge, merge_strategy, include_graph, agent, agent_type, agent_model,
           terminal_mode, execution_environment, branch_name, worktree_path, effective_options,
           idempotency_key, task_manifest_id, task_manifest_artifacts, trigger_options)
          VALUES ($1, $2, 'queued', $3, NOW(), $4, 'queue', $5, $6, $7, $8, $9, $10, $11,
                  $12, $13, $14, $15, $16::jsonb, $17, $18, $19::jsonb, $20::jsonb)
          RETURNING id`, [
          specPath,
          workspaceId,
          triggerType === 'scheduled' ? 'scheduled' : 'manual',
          position,
          effectiveAutoWorktreeRequest,
          queuedAutoMerge,
          queuedMergeStrategy,
          includeGraph ?? false,
          resolvedAgentType,
          resolvedAgentType,
          finalAgentModel,
          resolvedTerminalMode,
          resolvedExecutionEnvironment.effective,
          queuedBranchName,
          queuedWorktreePath,
          JSON.stringify(queuedEffectiveOptions),
          idempotencyKey ?? null,
          manifestId ?? null,
          queuedTaskManifestArtifacts,
          queuedTriggerOptions,
        ]);
        const queuedId = normalizeWorkerRunId(queueResult?.id);

        const executionReadiness = (req as any)._executionReadiness;
        const canonicalReadiness = (req as any)._specReadiness;
        res.status(202).json({
          queued: true,
          runId: queuedId,
          queuePosition: position,
          terminalMode: resolvedTerminalMode,
          terminal_mode: resolvedTerminalMode,
          executionEnvironment: resolvedExecutionEnvironment.effective,
          effectiveOptions: queuedEffectiveOptions,
          ...(idempotencyKey ? { idempotencyKey } : {}),
          ...(manifestId ? { manifestId } : {}),
          ...(taskManifestArtifacts ? { artifacts: taskManifestArtifacts } : {}),
          ...(taskManifestArtifactRefs ? { artifactRefs: taskManifestArtifactRefs } : {}),
          ...(triggerOptions ? { manifestSource: buildManifestSourceFromRun({
            idempotency_key: idempotencyKey ?? null,
            task_manifest_id: manifestId ?? null,
            task_manifest_artifacts: taskManifestArtifacts ?? null,
            trigger_options: triggerOptions,
          }) } : {}),
          ...(existingQueued ? { warning: `Spec "${specSlugForQueue}" is already queued (run #${existingQueued.id}). This creates an additional queued run.` } : {}),
          ...(executionReadiness ? { executionReadiness } : {}),
          ...(canonicalReadiness ? { specReadiness: canonicalReadiness } : {}),
        });
        return;
      }

      // ── 4b. Run Now with autoWorktree: allow up to run_now_max_concurrent ──
      if (effectiveAutoWorktreeRequest) {
        const concurrencyRows = await query<{ key: string; value: string }>(
          `SELECT key, value FROM worker_settings WHERE key = 'run_now_max_concurrent'`,
        );
        const runNowMaxConcurrent = concurrencyRows.length > 0 ? parseInt(concurrencyRows[0].value, 10) : 3;

        const activeWorktreeCount = Number((await queryOne<{ count: string }>(
          `SELECT COUNT(*) as count FROM pipeline_runs WHERE workspace_id = $1 AND status IN ('running', 'paused', 'pi_native') AND worktree_path IS NOT NULL`,
          [workspaceId],
        ))?.count ?? '0');

        if (activeWorktreeCount >= runNowMaxConcurrent) {
          const activeRun = await queryOne<{ id: number }>(`SELECT id FROM pipeline_runs WHERE workspace_id = $1 AND status IN ('running', 'paused', 'pi_native') AND worktree_path IS NOT NULL LIMIT 1`, [workspaceId]);
          res.json({ conflict: true, activeRunId: activeRun?.id, reason: `Maximum ${runNowMaxConcurrent} concurrent worktree runs reached. Wait for an active run to complete or increase run_now_max_concurrent.` });
          return;
        }
        // Fall through — allowed, will create worktree below
      } else {
        // ── 4c. Run Now without autoWorktree: conflict if any run active ──────
        const activeRun = await queryOne<PipelineRunRow>(`SELECT * FROM pipeline_runs WHERE workspace_id = $1 AND status IN ('running', 'paused', 'pi_native') LIMIT 1`, [workspaceId]);
        if (activeRun) {
          res.json({ conflict: true, activeRunId: activeRun.id });
          return;
        }
      }
    }

    // 4. Build absolute spec path: workspace/<specPath>
    const absSpecPath = path.join(workspace.path, specPath);

    const validTriggerType = triggerType === 'scheduled' ? 'scheduled' : 'manual';
    const existingRunId = queuedRunId ?? reservedRunId;
    const triggeredVia = queuedRunId ? 'queue' : 'run_now';

    if (useExternalPiOrchestration) {
      const specId = path.basename(specPath, '.json');
      const serializedExternalArtifacts = taskManifestArtifacts ? JSON.stringify(taskManifestArtifacts) : null;
      const serializedExternalTriggerOptions = triggerOptions ? JSON.stringify(triggerOptions) : null;
      let runId: number;
      if (existingRunId) {
        await execute(
          `UPDATE pipeline_runs
              SET spec_path = $1, workspace_id = $2, status = 'pi_native', trigger_type = $3,
                  agent = $4, agent_type = $5, agent_model = $6, started_at = NULL,
                  finished_at = NULL, pid = NULL, triggered_via = $7, terminal_mode = $8,
                  execution_environment = $9, idempotency_key = COALESCE($10, idempotency_key),
                  task_manifest_id = COALESCE($11, task_manifest_id),
                  task_manifest_artifacts = COALESCE($12::jsonb, task_manifest_artifacts),
                  trigger_options = COALESCE($13::jsonb, trigger_options)
            WHERE id = $14`,
          [specPath, workspaceId, validTriggerType, resolvedAgentType, resolvedAgentType, finalAgentModel, triggeredVia, resolvedTerminalMode, resolvedExecutionEnvironment.effective, idempotencyKey ?? null, manifestId ?? null, serializedExternalArtifacts, serializedExternalTriggerOptions, existingRunId],
        );
        runId = normalizeWorkerRunId(existingRunId);
      } else {
        const runResult = await queryOne<{ id: number }>(
          `INSERT INTO pipeline_runs
             (spec_path, workspace_id, status, trigger_type, agent, agent_type, agent_model, started_at, finished_at, pid, triggered_via, terminal_mode, execution_environment, idempotency_key, task_manifest_id, task_manifest_artifacts, trigger_options)
           VALUES ($1, $2, 'pi_native', $3, $4, $5, $6, NULL, NULL, NULL, $7, $8, $9, $10, $11, $12::jsonb, COALESCE($13::jsonb, '{}'::jsonb))
           RETURNING id`,
          [specPath, workspaceId, validTriggerType, resolvedAgentType, resolvedAgentType, finalAgentModel, triggeredVia, resolvedTerminalMode, resolvedExecutionEnvironment.effective, idempotencyKey ?? null, manifestId ?? null, serializedExternalArtifacts, serializedExternalTriggerOptions],
        );
        runId = normalizeWorkerRunId(runResult?.id);
      }
      const piNativeEffectiveOptions = buildEffectiveRunOptions({
        model: finalAgentModel,
        effort: resolvedReasoningEffort,
        autoWorktree: false,
        worktreePath: null,
        branchName: null,
        mergeStrategy: mergeStrategy ?? 'branch-only',
        autoMerge: false,
        includeGraph: includeGraph ?? false,
        terminal: resolvedTerminalMode,
        policyLocked: false,
        deploy: true,
        externalSend: true,
      });
      await execute('UPDATE pipeline_runs SET effective_options = $1::jsonb WHERE id = $2', [
        JSON.stringify(piNativeEffectiveOptions),
        runId,
      ]);
      const piNativeSpec = JSON.parse(fs.readFileSync(path.join(workspace.path, specPath), 'utf8')) as Record<string, unknown>;
      const piNativeManifests = await resolveAndPersistDispatchManifests({
        workspaceId: workspace.id,
        specId,
        runId,
        specJson: piNativeSpec,
        cwd: workspace.path,
        agent: resolvedAgentType,
        model: finalAgentModel ?? null,
        effort: resolvedReasoningEffort ?? effortLevel ?? null,
        terminalMode: resolvedTerminalMode,
        worktreePath: null,
        branchName: null,
        autoMerge: false,
        mergeStrategy: mergeStrategy ?? 'branch-only',
        parallelism: 1,
      });

      const walEvent = await queryOne<WalEvent>(
        `INSERT INTO wal_events (event_type, workspace_id, spec_id, payload)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        ['pi_native_run_requested', workspaceId, specId, JSON.stringify({
          run_id: runId,
          spec_id: specId,
          workspace_id: workspaceId,
          model: finalAgentModel ?? null,
          execution_environment: resolvedExecutionEnvironment.effective,
        })],
      );

      broadcastAll(walEvent!);

      res.status(200).json({
        runId,
        status: 'pi_native',
        terminalMode: resolvedTerminalMode,
        terminal_mode: resolvedTerminalMode,
        executionEnvironment: resolvedExecutionEnvironment.effective,
        expectsExternalOrchestration: true,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(manifestId ? { manifestId } : {}),
        ...(taskManifestArtifacts ? { artifacts: taskManifestArtifacts } : {}),
        ...(taskManifestArtifactRefs ? { artifactRefs: taskManifestArtifactRefs } : {}),
        ...(triggerOptions ? { manifestSource: buildManifestSourceFromRun({
          idempotency_key: idempotencyKey ?? null,
          task_manifest_id: manifestId ?? null,
          task_manifest_artifacts: taskManifestArtifacts ?? null,
          trigger_options: triggerOptions,
        }) } : {}),
        executionManifestPath: piNativeManifests.path,
        executionManifestHashes: piNativeManifests.manifests.map((manifest) => manifest.manifestHash),
        effectiveOptions: piNativeEffectiveOptions,
        specReadiness: (req as any)._specReadiness,
      });
      return;
    }

    // 4b. Auto-select orchestration mode (sequential vs wave-parallel)
    // IMPORTANT: Respect waveParallelism from .rorca/config.json — if false, force sequential
    let parallelism = 1;
    let orchestration: ReturnType<typeof autoSelectOrchestration> | null = null;
    try {
      const specJsonForOrch = JSON.parse(fs.readFileSync(absSpecPath, 'utf8'));
      const orchStories: WaveUserStory[] = (specJsonForOrch.userStories ?? []).map((s: any) => ({
        id: s.id,
        title: s.title ?? '',
        description: s.description ?? '',
        acceptanceCriteria: s.acceptanceCriteria ?? [],
        dependsOn: s.dependsOn ?? [],
        passes: s.passes,
        excluded: s.excluded,
      }));
      orchestration = autoSelectOrchestration(orchStories);

      // Check forceSequential from trigger request (UI toggle) or .rorca/config.json
      if (forceSequential) {
        parallelism = 1;
        logger.info(`[orchestration] Forced sequential (user selected sequential in UI)`);
      } else {
        let waveParallelismEnabled = true;
        try {
          const rorcaConfigPath = path.join(workspace.path, '.rorca', 'config.json');
          if (fs.existsSync(rorcaConfigPath)) {
            const rorcaConfig = JSON.parse(fs.readFileSync(rorcaConfigPath, 'utf8'));
            if (rorcaConfig?.execution?.waveParallelism === false) {
              waveParallelismEnabled = false;
            }
          }
        } catch { /* config parse error — use default */ }

        if (!waveParallelismEnabled) {
          parallelism = 1;
          logger.info(`[orchestration] Forced sequential (waveParallelism: false in .rorca/config.json)`);
        } else {
          parallelism = orchestration.parallelism;
          logger.info(`[orchestration] Using ${orchestration.mode} (${orchestration.reason})`);
        }
      }
    } catch {
      // Spec parse error — fall back to sequential
      logger.info('[orchestration] Using sequential (spec parse error, fallback)');
    }

    if (isPtyTerminalMode(resolvedTerminalMode) && parallelism > 1) {
      parallelism = 1;
      logger.info('[orchestration] Forced sequential because PTY sessions are run-scoped interactive terminals');
    }

    // 5. Determine CWD — main workspace or new worktree
    const needsWorktree = effectiveAutoWorktreeRequest || orchestration?.mode === 'wave-parallel';
    let cwd = workspace.path;
    let branchName: string | null = null;
    let worktreePath: string | null = null;

    if (needsWorktree) {
      const specSlug = path.basename(specPath, '.json').replace(/[^a-z0-9-]/gi, '-');
      const repoName = path.basename(workspace.path);
      // Deterministic branch/path per spec — reuse across retries instead of
      // creating a new timestamped worktree every run.
      branchName = `feat/${specSlug}`;
      const branchSlug = branchName.replace(/\//g, '-');
      worktreePath = path.resolve(workspace.path, '..', `${repoName}-${branchSlug}`);

      const git = simpleGit(workspace.path);

      if (fs.existsSync(worktreePath)) {
        assertReusableWorktreeFresh(workspace.path, worktreePath, branchName);
        // Reuse existing worktree — engine will skip already-passed stories
        logger.info({ specSlug, worktreePath }, '[trigger] Reusing existing worktree');
      } else {
        // Create fresh worktree on the deterministic branch
        const branchExists = (await git.branchLocal()).all.includes(branchName);
        if (branchExists) {
          assertReusableBranchFresh(workspace.path, branchName);
          await git.raw(['worktree', 'add', worktreePath, branchName]);
        } else {
          await git.raw(['worktree', 'add', '-b', branchName, worktreePath, 'HEAD']);
        }
      }

      const runtimeSupport = ensureWorktreeRuntimeSupport(workspace.path, worktreePath);
      for (const rel of runtimeSupport.linkedDirs) {
        logger.info(`  [worktree] Linked ${rel} into worktree`);
      }
      for (const rel of runtimeSupport.copiedEnvFiles) {
        logger.info(`  [worktree] Copied ${rel} to worktree`);
      }

      cwd = worktreePath;
    }

    // 6. Create pipeline_runs record (with agent_type and agent_model)
    //    If queuedRunId is provided, promote the existing queued row instead of inserting
    // Enforce constraint: auto_merge is only true when autoWorktree is true
    const computedAutoMerge = autonomousSafety.policyLocked
      ? false
      : needsWorktree && (autoMerge !== false);

    // Resolve merge strategy: request param > spec JSON > workspace config > 'direct'
    let resolvedMergeStrategy: 'direct' | 'pr' | 'draft-pr' | 'branch-only' = 'direct';
    if (mergeStrategy) {
      resolvedMergeStrategy = mergeStrategy;
    } else {
      // Try spec JSON
      try {
        const specJsonMs = JSON.parse(fs.readFileSync(absSpecPath, 'utf8'));
        if (specJsonMs.mergeStrategy) {
          resolvedMergeStrategy = specJsonMs.mergeStrategy;
        }
      } catch { /* non-fatal — spec read may have already been done above */ }
      // Fall back to workspace pipeline_config
      if (resolvedMergeStrategy === 'direct') {
        try {
          const wsRow = await queryOne<{ pipeline_config: string }>('SELECT pipeline_config FROM workspaces WHERE id = $1', [workspaceId]);
          const pipelineConf = JSON.parse(wsRow?.pipeline_config || '{}');
          if (pipelineConf.mergeStrategy) {
            resolvedMergeStrategy = pipelineConf.mergeStrategy;
          }
        } catch { /* non-fatal */ }
      }
    }

    if (autonomousSafety.policyLocked) {
      resolvedMergeStrategy = 'branch-only';
    }

    // US-002: Track trigger source — 'queue' when promoted from run queue, 'run_now' for direct triggers
    let runId: number;
    const requestedTriggerOptions = Object.fromEntries(
      Object.entries({
        autoWorktree: needsWorktree,
        autoMerge: computedAutoMerge,
        mergeStrategy: resolvedMergeStrategy,
        triggerType: validTriggerType,
        forceSequential,
        agentOverride,
        modelOverride,
        storyId,
        includeGraph: includeGraph ?? false,
        thinkingEnabled: resolvedThinkingEnabled,
        thinkingBudget,
        effortLevel,
        reasoningEffort: resolvedReasoningEffort,
        rerunFromScratch,
        readinessOverride,
        runAnywayOverride,
        overrideReadinessGate,
        orchestration,
        terminal_mode: resolvedTerminalMode,
        executionEnvironment: resolvedExecutionEnvironment.effective,
      }).filter(([, value]) => value !== undefined)
    );

    const existingRunMetadata = existingRunId
      ? await queryOne<Pick<PipelineRunRow, 'idempotency_key' | 'task_manifest_id' | 'task_manifest_artifacts' | 'trigger_options'>>(
        `SELECT idempotency_key, task_manifest_id, task_manifest_artifacts, trigger_options FROM pipeline_runs WHERE id = $1`,
        [existingRunId],
      )
      : undefined;
    const persistedArtifacts = parseJsonRecordLike(existingRunMetadata?.task_manifest_artifacts) ?? undefined;
    const existingTriggerOptions = parseJsonRecordLike(existingRunMetadata?.trigger_options) ?? undefined;
    const effectiveIdempotencyKey = idempotencyKey ?? existingRunMetadata?.idempotency_key ?? stringValue(existingTriggerOptions?.idempotencyKey);
    const effectiveManifestId = manifestId ?? existingRunMetadata?.task_manifest_id ?? stringValue(existingTriggerOptions?.manifestId);
    const effectiveTaskManifestArtifacts = taskManifestArtifacts ?? persistedArtifacts;
    const effectiveTaskManifestArtifactRefs = taskManifestArtifactRefs ?? getStoredArtifactRefsFromTriggerOptions(existingTriggerOptions);
    const effectiveTriggerOptions = {
      ...requestedTriggerOptions,
      ...(existingTriggerOptions ?? {}),
      ...(triggerOptions ?? {}),
    };

    const serializedTaskManifestArtifacts = effectiveTaskManifestArtifacts
      ? JSON.stringify(effectiveTaskManifestArtifacts)
      : null;
    const serializedTriggerOptions = JSON.stringify(effectiveTriggerOptions);

    if (existingRunId) {
      // Promote or complete a pre-reserved queued run — worker will actually execute it.
      await execute(`UPDATE pipeline_runs SET status = 'queued', queued_at = NOW(),
         parallelism = $1, agent = $2, agent_type = $3, agent_model = $4,
         branch_name = $5, worktree_path = $6, auto_merge = $7, triggered_via = $8, auto_worktree = $9, include_graph = $10, merge_strategy = $12, terminal_mode = $13, execution_environment = $14,
         idempotency_key = COALESCE($15, idempotency_key), task_manifest_id = COALESCE($16, task_manifest_id), task_manifest_artifacts = COALESCE($17::jsonb, task_manifest_artifacts), trigger_options = $18::jsonb
         WHERE id = $11 AND status = 'queued'`, [parallelism, resolvedAgentType, resolvedAgentType, finalAgentModel, branchName, worktreePath, computedAutoMerge, triggeredVia, needsWorktree, includeGraph ?? false, existingRunId, resolvedMergeStrategy, resolvedTerminalMode, resolvedExecutionEnvironment.effective, effectiveIdempotencyKey ?? null, effectiveManifestId ?? null, serializedTaskManifestArtifacts, serializedTriggerOptions]);
      runId = existingRunId;
    } else {
      const runResult = await queryOne<{ id: number }>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status, trigger_type, parallelism, agent, agent_type, agent_model, queued_at, branch_name, worktree_path, auto_merge, triggered_via, auto_worktree, include_graph, merge_strategy, terminal_mode, execution_environment, idempotency_key, task_manifest_id, task_manifest_artifacts, trigger_options) VALUES ($1, $2, 'queued', $3, $4, $5, $6, $7, NOW(), $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb, $20::jsonb) RETURNING id`, [specPath, workspaceId, validTriggerType, parallelism, resolvedAgentType, resolvedAgentType, finalAgentModel, branchName, worktreePath, computedAutoMerge, triggeredVia, needsWorktree, includeGraph ?? false, resolvedMergeStrategy, resolvedTerminalMode, resolvedExecutionEnvironment.effective, effectiveIdempotencyKey ?? null, effectiveManifestId ?? null, serializedTaskManifestArtifacts, serializedTriggerOptions]);
      runId = normalizeWorkerRunId(runResult?.id);
    }

    const effectiveRunOptions = buildEffectiveRunOptions({
      model: finalAgentModel,
      effort: resolvedReasoningEffort,
      autoWorktree: needsWorktree,
      worktreePath,
      branchName,
      mergeStrategy: resolvedMergeStrategy,
      autoMerge: computedAutoMerge,
      includeGraph: includeGraph ?? false,
      terminal: resolvedTerminalMode,
      policyLocked: autonomousSafety.policyLocked,
      deploy: autonomousSafety.deploy,
      externalSend: autonomousSafety.externalSend,
    });
    await execute('UPDATE pipeline_runs SET effective_options = $1::jsonb WHERE id = $2', [
      JSON.stringify(effectiveRunOptions),
      runId,
    ]);

    // 7. Build env overrides — workspace-specific and vault key additions only.
    //    The worker already inherits its own process.env when spawning the execution engine,
    //    so we only need to pass the EXTRA vars here (vault keys, workspace env vars).
    //    DO NOT dump all of process.env here — it bloats the pg-boss payload unnecessarily.
    const envOverrides: Record<string, string> = {};

    // Inject workspace-specific env vars (decrypted)
    const workspaceEnvVars = getWorkspaceEnvVars(workspaceId);
    for (const [k, v] of Object.entries(workspaceEnvVars)) {
      envOverrides[k] = v;
    }

    // Inject vault API key from workflow config (WR-006).
    // wfConfig.apiKey is the resolved key for the primary provider (vault → env fallback).
    // Map it to the correct env var based on the provider from wfConfig.
    if (wfConfig.apiKey) {
      const providerEnvMap: Record<string, string> = {
        anthropic: 'ANTHROPIC_API_KEY',
        openrouter: 'OPENROUTER_API_KEY',
        'openai-compat': 'OPENAI_API_KEY',
      };
      const envVarName = providerEnvMap[wfConfig.provider];
      if (envVarName) {
        envOverrides[envVarName] = wfConfig.apiKey;
      }
      if (wfConfig.baseUrl && wfConfig.provider === 'openai-compat') {
        envOverrides['OPENAI_BASE_URL'] = wfConfig.baseUrl;
      }
    }
    // Also inject vault keys for OTHER providers — stories may use per-story agent assignments
    // (OC-029) that require a different provider than the primary one.
    const otherProviders: Array<{ provider: string; envKey: string; baseUrlKey?: string }> = [
      { provider: 'anthropic', envKey: 'ANTHROPIC_API_KEY' },
      { provider: 'openai-compat', envKey: 'OPENAI_API_KEY', baseUrlKey: 'OPENAI_BASE_URL' },
      { provider: 'openrouter', envKey: 'OPENROUTER_API_KEY' },
    ];
    for (const { provider, envKey, baseUrlKey } of otherProviders) {
      if (envOverrides[envKey]) continue; // Already set by wfConfig above
      const vaultKey = pipelineUser ? await getVaultKey(pipelineUser.id, provider) : null;
      if (vaultKey) {
        envOverrides[envKey] = vaultKey.key;
        if (baseUrlKey && vaultKey.baseUrl) {
          envOverrides[baseUrlKey] = vaultKey.baseUrl;
        }
      }
    }


    // Inject active agent profile (system prompt + allowed tools + model override)
    const activeProfile = await queryOne('SELECT * FROM agent_profiles WHERE workspace_id = $1 AND is_active = true LIMIT 1', [workspaceId]) as AgentProfileRow | undefined;
    if (activeProfile) {
      if (activeProfile.system_prompt_override) {
        envOverrides['RORCA_AGENT_SYSTEM_PROMPT'] = activeProfile.system_prompt_override;
      }
      const tools = (Array.isArray(activeProfile.allowed_tools) ? activeProfile.allowed_tools : JSON.parse(activeProfile.allowed_tools)) as string[];
      if (tools.length > 0) {
        envOverrides['RORCA_AGENT_ALLOWED_TOOLS'] = tools.join(',');
      }
      if (activeProfile.model_override) {
        envOverrides['RORCA_AGENT_MODEL_OVERRIDE'] = activeProfile.model_override;
      }
    }

    // 8. Run pre-run hooks — abort if any exit non-zero.
    //    Hooks run synchronously in the trigger request so the caller gets immediate feedback.
    const logPath = workspaceLogPath(workspace.path, runId);
    await execute('UPDATE pipeline_runs SET log_path = $1 WHERE id = $2', [logPath, runId]);
    const preRunResults = await runHooks(workspaceId, 'pre_run', cwd, envOverrides);
    if (preRunResults.length > 0) {
      const hookOutput = preRunResults.map(r =>
        `\x1b[36m[pre_run hook: ${r.command}]\x1b[0m\n${r.output}` +
        (r.exitCode !== 0 ? `\n\x1b[31m[Hook exited with code ${r.exitCode}]\x1b[0m\n` : '\n')
      ).join('');
      fs.writeFileSync(logPath, hookOutput);

      const failed = preRunResults.find(r => r.exitCode !== 0);
      if (failed) {
        await execute(`UPDATE pipeline_runs SET status = 'failed', finished_at = NOW() WHERE id = $1`, [runId]);

        const walEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('run_finished', $1, $2)` + ' RETURNING *', [workspaceId, JSON.stringify({
          run_id: runId, status: 'failed', reason: 'pre_run_hook_failed',
          hook_command: failed.command, exit_code: failed.exitCode,
        })]);
        broadcastAll(walEvent!);
        advanceQueue(workspaceId);

        const failBuf: OutputBuffer = { chunks: [hookOutput], done: true, subscribers: new Set() };
        outputBuffers.set(runId, failBuf);
        setTimeout(() => { outputBuffers.delete(runId); }, 30 * 60 * 1000);

        throw new UnprocessableError('Pre-run hook failed');
        return;
      }
    }

    // 9. Record excluded / already-passing stories so the UI shows them immediately.
    let startFromStoryId: string | undefined;
    try {
      const specJson = JSON.parse(fs.readFileSync(absSpecPath, 'utf8'));
      const specSlug = path.basename(specPath, '.json');

      const excludedStories = (specJson.userStories ?? []).filter(
        (s: { excluded?: boolean }) => s.excluded === true
      );
      for (const s of excludedStories) {
        await execute(
          `INSERT INTO story_results (run_id, story_id, status, finished_at) VALUES ($1, $2, 'excluded', NOW())`,
          [runId, s.id]
        );
        const walEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, payload) VALUES ('story_excluded_from_run', $1, $2, $3, $4)` + ' RETURNING *', [workspaceId, specSlug, s.id, JSON.stringify({ run_id: runId })]);
        broadcastAll(walEvent!);
      }

      // `forceRerun` is an idempotency bypass only. It must not mutate story pass state;
      // continuation runs depend on passes:true remaining authoritative. Use the explicit
      // `rerunFromScratch` option for the UI action that intentionally re-executes all stories.
      if (rerunFromScratch) {
        let modified = false;
        for (const s of (specJson.userStories ?? [])) {
          if (s.passes === true) { s.passes = false; modified = true; }
        }
        if (modified) {
          fs.writeFileSync(absSpecPath, JSON.stringify(specJson, null, 2), 'utf8');
        }
      }

      const alreadyPassing = rerunFromScratch ? [] : (specJson.userStories ?? []).filter(
        (s: { passes?: boolean; excluded?: boolean }) => s.passes === true && s.excluded !== true
      );
      for (const s of alreadyPassing) {
        await execute(
          `INSERT INTO story_results (run_id, story_id, status, reason, finished_at) VALUES ($1, $2, 'skip', 'previously_passed', NOW())`,
          [runId, s.id]
        );
        const walEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, payload) VALUES ('story_skipped', $1, $2, $3, $4)` + ' RETURNING *', [workspaceId, specSlug, s.id, JSON.stringify({ run_id: runId, reason: 'previously_passed' })]);
        broadcastAll(walEvent!);
      }

      // Compute startFromStoryId: first story where passes !== true and not excluded.
      // When rerunFromScratch is true, pass flags were intentionally reset above.
      const startFromStory = (specJson.userStories ?? []).find(
        (s: { passes?: boolean; excluded?: boolean }) => s.passes !== true && s.excluded !== true
      );
      startFromStoryId = startFromStory?.id ?? undefined;
    } catch { /* spec read error — non-fatal, worker will handle */ }

    // 10. Resolve immutable per-story manifests before queue dispatch. The
    // engine receives the resulting execution-only contract and does not
    // recompute lifecycle evidence or command-safety policy from story prose.
    const dispatchSpec = JSON.parse(fs.readFileSync(absSpecPath, 'utf8')) as Record<string, unknown>;
    const manifestBundle = await resolveAndPersistDispatchManifests({
      workspaceId: workspace.id,
      specId: path.basename(specPath, '.json'),
      runId,
      specJson: dispatchSpec,
      cwd,
      agent: resolvedAgentType,
      model: finalAgentModel ?? null,
      effort: resolvedReasoningEffort ?? effortLevel ?? null,
      terminalMode: resolvedTerminalMode,
      worktreePath,
      branchName,
      autoMerge: computedAutoMerge,
      mergeStrategy: resolvedMergeStrategy,
      parallelism,
    });

    // 11. Enqueue the pipeline run via pg-boss.
    //     The worker process picks it up and does the actual spawn / execution.
    //     Job ID = String(runId) for direct lookup by runId.
    const resolvedJobEffortLevel = ['low', 'medium', 'high', 'max', 'xhigh'].includes(resolvedReasoningEffort ?? '')
      ? resolvedReasoningEffort as 'low' | 'medium' | 'high' | 'max' | 'xhigh'
      : effortLevel;

    const jobPayload = {
      runId,
      specPath,
      workspacePath: workspace.path,
      agent: resolvedAgentType,
      model: finalAgentModel ?? null,
      worktreePath: worktreePath ?? null,
      branchName: branchName ?? null,
      terminalMode: resolvedTerminalMode,
      executionEnvironment: resolvedExecutionEnvironment.effective,
      autoWorktree: needsWorktree,
      autoMerge: computedAutoMerge,
      mergeStrategy: resolvedMergeStrategy,
      safetyOptions: {
        deploy: autonomousSafety.deploy,
        externalSend: autonomousSafety.externalSend,
        policyLocked: autonomousSafety.policyLocked,
      },
      executionManifestPath: manifestBundle.path,
      envOverrides,
      ...(!storyId && startFromStoryId ? { startFromStoryId } : {}),
      ...(storyId ? { specificStory: storyId } : {}),
      triggeredVia,
      includeGraph: includeGraph ?? false,
      ...(agentOverride ? { agentOverride } : {}),
      ...(resolvedThinkingEnabled !== undefined ? { thinkingEnabled: resolvedThinkingEnabled } : {}),
      ...(thinkingBudget !== undefined ? { thinkingBudget } : {}),
      ...(resolvedJobEffortLevel ? { effortLevel: resolvedJobEffortLevel } : {}),
      ...(resolvedReasoningEffort ? { reasoningEffort: resolvedReasoningEffort } : {}),
      ...(effectiveIdempotencyKey ? { idempotencyKey: effectiveIdempotencyKey } : {}),
      ...(effectiveManifestId ? { manifestId: effectiveManifestId } : {}),
      ...(effectiveTaskManifestArtifacts ? { taskManifestArtifacts: effectiveTaskManifestArtifacts } : {}),
      ...(effectiveTaskManifestArtifactRefs ? { taskManifestArtifactRefs: effectiveTaskManifestArtifactRefs } : {}),
      ...(effectiveTriggerOptions ? { triggerOptions: effectiveTriggerOptions } : {}),
      ...(executionEnvironment ? { executionEnvironment } : {}),
      ...(executionEnvironmentId ? { executionEnvironmentId } : {}),
    };

    let runnerJobId: string | undefined;
    if (resolvedExecutionEnvironment.effective === 'local-user') {
      const runnerJob = await createRunnerJob({
        runId,
        environmentId: resolvedExecutionEnvironment.effective,
        payload: jobPayload,
      });
      runnerJobId = runnerJob.id;
      logger.info(`[Pipeline] Enqueued local runner job for runId=${runId}`);
    } else {
      const boss = getBoss();
      if (typeof boss.createQueue === 'function') {
        await boss.createQueue('pipeline:run');
      }
      const jobId = await boss.send('pipeline:run', jobPayload, {
        retryLimit: 0,
        expireInSeconds: 300, // Task-Monitor: job spawns engine and returns immediately
      });

      if (jobId === null) {
        await execute(`UPDATE pipeline_runs SET status = 'failed', finished_at = NOW() WHERE id = $1`, [runId]);
        throw new ServiceUnavailableError('Failed to enqueue pipeline:run job: pg-boss returned null (queue may be missing or not started)');
      }

      logger.info(`[Pipeline] Enqueued pipeline:run job for runId=${runId}`);
    }

    // Determine queue position for response (count jobs queued before this one)
    const queuePos = (await queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM pipeline_runs WHERE workspace_id = $1 AND status = 'queued' AND id < $2`,
      [workspaceId, runId]
    ))?.count ?? '0';

    // OC-031: Include capability warnings in trigger response
    const capWarnings = (req as any)._capabilityWarnings;
    const capMode = (req as any)._capabilityMismatchMode;
    const executionReadiness = (req as any)._executionReadiness;
    const canonicalReadiness = (req as any)._specReadiness;
    res.status(201).json({
      ok: true,
      runId,
      queued: true,
      specId: path.basename(specPath, '.json'),
      queuePosition: parseInt(queuePos, 10) + 1,
      worktreePath,
      branchName,
      agentType: resolvedAgentType,
      agentModel: finalAgentModel,
      terminalMode: resolvedTerminalMode,
      terminal_mode: resolvedTerminalMode,
      effectiveOptions: effectiveRunOptions,
      lifecycleStatus: 'queued',
      lifecycle_status: 'queued',
      lifecyclePhase: 'queued',
      lifecycle_phase: 'queued',
      executionEnvironment: resolvedExecutionEnvironment.effective,
      ...(runnerJobId ? { runnerJobId } : {}),
      ...(effectiveIdempotencyKey ? { idempotencyKey: effectiveIdempotencyKey } : {}),
      ...(effectiveManifestId ? { manifestId: effectiveManifestId } : {}),
      ...(effectiveTaskManifestArtifacts ? { artifacts: effectiveTaskManifestArtifacts } : {}),
      ...(effectiveTaskManifestArtifactRefs ? { artifactRefs: effectiveTaskManifestArtifactRefs } : {}),
      ...(executionEnvironmentId ? { executionEnvironmentId } : {}),
      ...(capWarnings ? { capabilityWarnings: capWarnings, capabilityMismatchMode: capMode } : {}),
      ...(executionReadiness ? { executionReadiness } : {}),
      ...(canonicalReadiness ? { specReadiness: canonicalReadiness } : {}),
      ...(orchestration ? { orchestration } : {}),
      passReconciliation: (req as any)._passReconciliation,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Trigger');
  }
}

const TaskManifestTriggerRequestSchema = z.object({
  workspaceId: z.union([z.string().min(1), z.number()]).optional(),
  manifest: z.unknown().optional(),
  dryRun: z.boolean().optional(),
  autoWorktree: z.boolean().optional().default(true),
  autoMerge: z.boolean().optional().default(false),
  mergeStrategy: z.enum(['pr', 'draft-pr', 'branch-only', 'direct']).optional(),
  agentOverride: z.enum(['claude', 'opencode', 'codex', 'pi']).optional(),
  modelOverride: z.string().optional(),
  effortLevel: z.enum(['low', 'medium', 'high', 'max', 'xhigh']).optional(),
  executionEnvironment: z.string().optional(),
  executionEnvironmentId: z.string().optional(),
  terminal_mode: z.string().nullable().optional(),
  terminalMode: z.string().nullable().optional(),
  idempotencyKey: z.string().optional(),
  includeGraph: z.boolean().optional(),
  forceSequential: z.boolean().optional(),
  queue: z.boolean().optional(),
}).passthrough();

type TaskManifestTriggerRequestBody = z.infer<typeof TaskManifestTriggerRequestSchema>;

type TaskManifestArtifactsResponse = {
  artifactDir: string;
  manifestPath: string;
  tasksMdPath: string;
  specPath: string;
  manifestHash: string;
  reused: boolean;
  absolute: {
    artifactDir: string;
    manifestPath: string;
    tasksMdPath: string;
    specPath: string;
  };
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function stringFromId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return isNonEmptyString(value) ? value.trim() : null;
}

function routeHasWrappedManifest(body: TaskManifestTriggerRequestBody): boolean {
  return Object.prototype.hasOwnProperty.call(body, 'manifest');
}

function taskManifestIssueSummary(issues: Array<{ path: PropertyKey[]; message: string }>): string {
  return issues
    .map((issue) => {
      const prefix = issue.path.length > 0 ? `${issue.path.map(String).join('.')}: ` : '';
      return `${prefix}${issue.message}`;
    })
    .join('; ');
}

function taskManifestIssueDetails(
  code: string,
  issues: Array<{ path: PropertyKey[]; message: string }>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    code,
    ...extra,
    issues: issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    })),
  };
}

function taskManifestValidationCodeFromIssues(issues: Array<{ path: PropertyKey[]; message: string }>): string {
  const normalized = issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));

  if (normalized.some((issue) => (
    /(?:^|\.)path$|Paths|artifactRefs/.test(issue.path)
    && /workspace-relative|traverse|absolute|URL|home-directory|Windows drive|NUL|unsafe/i.test(issue.message)
  ))) {
    return 'TASK_MANIFEST_UNSAFE_ARTIFACT_PATH';
  }

  if (normalized.some((issue) => (
    /payload exceeds|serialized bytes/i.test(issue.message)
    || (
      /^context(?:\.|$)/.test(issue.path)
      && /at most|exceeds|oversized|too large|maximum/i.test(issue.message)
    )
  ))) {
    return 'TASK_MANIFEST_CONTEXT_TOO_LARGE';
  }

  return 'TASK_MANIFEST_INVALID';
}

function validationErrorWithCode(message: string, code: string, extra: Record<string, unknown> = {}): ValidationError {
  return new ValidationError(message, { code, ...extra });
}

function assertTaskManifestRouteDecisionAllowed(manifest: TaskManifest): void {
  const route = manifest.routeDecision.route;
  const normalizedRoute = route.toLowerCase();
  const highRiskRoute = normalizedRoute === 'rorca.spec.run'
    || normalizedRoute === 'direct-repair'
    || normalizedRoute === 'direct_repair'
    || normalizedRoute === 'directrepair'
    || normalizedRoute.includes('direct-repair')
    || normalizedRoute.includes('direct_repair')
    || normalizedRoute.includes('directrepair');

  if (!highRiskRoute) return;

  throw validationErrorWithCode(
    `Task manifest routeDecision.route '${route}' is not eligible for direct execution; Hermes repair manifests must use the typed task-manifest bridge with branch/PR-only policy, not a high-risk direct-repair/spec-run route.`,
    'TASK_MANIFEST_HIGH_RISK_ROUTE',
    {
      route,
      allowedPolicy: 'branchPrOnly=true, autoMerge=false, mergeStrategy=pr|draft-pr|branch-only',
    },
  );
}

function sourceAuthorityHasValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.some(sourceAuthorityHasValue);
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(sourceAuthorityHasValue);
  }
  return false;
}

function assertTaskManifestSourceAuthority(
  body: TaskManifestTriggerRequestBody,
  manifest: TaskManifest,
  requestWorkspaceId: string,
  requestIdempotencyKey: string,
): void {
  if (String(manifest.workspaceId) !== requestWorkspaceId) {
    throw validationErrorWithCode(
      'Invalid source authority: request workspaceId must match manifest.workspaceId',
      'TASK_MANIFEST_WORKSPACE_AUTHORITY_MISMATCH',
    );
  }

  if (manifest.idempotencyKey !== requestIdempotencyKey) {
    throw validationErrorWithCode(
      'Invalid source authority: request idempotencyKey must match manifest.idempotencyKey',
      'TASK_MANIFEST_IDEMPOTENCY_AUTHORITY_MISMATCH',
    );
  }

  const source = manifest.source as Record<string, unknown>;
  if (!Object.values(source).some(sourceAuthorityHasValue)) {
    throw validationErrorWithCode(
      'Invalid source authority: task manifest source must include at least one provenance reference',
      'TASK_MANIFEST_SOURCE_REQUIRED',
    );
  }

  const sourceSpecPath = manifest.source.rorca?.specPath;
  if (sourceSpecPath && !sourceSpecPath.startsWith('forge/specs/')) {
    throw validationErrorWithCode(
      'Invalid source authority: source.rorca.specPath must be workspace-relative under forge/specs/',
      'TASK_MANIFEST_SOURCE_SPEC_PATH_INVALID',
    );
  }

  if (routeHasWrappedManifest(body)) {
    if (body.workspaceId === undefined || body.workspaceId === null || stringFromId(body.workspaceId) === null) {
      throw validationErrorWithCode('Missing required field: workspaceId', 'TASK_MANIFEST_WORKSPACE_ID_REQUIRED');
    }
    if (!isNonEmptyString(body.idempotencyKey)) {
      throw validationErrorWithCode('Missing required field: idempotencyKey', 'TASK_MANIFEST_IDEMPOTENCY_KEY_REQUIRED');
    }
  }
}

function buildTaskManifestArtifactsResponse(
  envelope: WriteTaskManifestExecutionEnvelopeResult,
): TaskManifestArtifactsResponse {
  const manifestPath = path.join(envelope.relativeArtifactDir, 'manifest.json');
  const tasksMdPath = path.join(envelope.relativeArtifactDir, 'tasks.md');
  return {
    artifactDir: envelope.relativeArtifactDir,
    manifestPath,
    tasksMdPath,
    specPath: envelope.relativeSpecPath,
    manifestHash: envelope.manifestHash,
    reused: envelope.artifactReused,
    absolute: {
      artifactDir: envelope.artifactDir,
      manifestPath: envelope.manifestPath,
      tasksMdPath: envelope.tasksMdPath,
      specPath: envelope.specPath,
    },
  };
}

function buildTaskManifestArtifactRefs(artifacts: TaskManifestArtifactsResponse): Array<Record<string, unknown>> {
  return [
    {
      kind: 'task-manifest',
      role: 'manifest-json',
      path: artifacts.manifestPath,
      digest: artifacts.manifestHash,
    },
    {
      kind: 'task-manifest',
      role: 'tasks-md-projection',
      path: artifacts.tasksMdPath,
      durableSourceOfTruth: false,
    },
    {
      kind: 'task-manifest',
      role: 'synthetic-spec',
      path: artifacts.specPath,
      digest: artifacts.manifestHash,
    },
  ];
}

function buildTaskManifestEstimatedPlan(input: {
  manifest: TaskManifest;
  envelope: WriteTaskManifestExecutionEnvelopeResult;
  artifacts: TaskManifestArtifactsResponse;
  autoWorktree: boolean;
  mergeStrategy: 'pr' | 'draft-pr' | 'branch-only';
  agentOverride?: 'claude' | 'opencode' | 'codex' | 'pi';
  modelOverride?: string;
  effortLevel?: 'low' | 'medium' | 'high' | 'max' | 'xhigh';
  terminalMode: TerminalMode;
  executionEnvironment?: string;
  executionEnvironmentId?: string;
  executionEnvironmentSupported?: boolean;
  executionOptions?: ResolvedExecutionOptions;
}): Record<string, unknown> {
  return {
    willQueue: false,
    willSpawnSubprocess: false,
    workspaceId: input.manifest.workspaceId,
    manifestId: input.manifest.manifestId,
    idempotencyKey: input.manifest.idempotencyKey,
    specPath: input.envelope.relativeSpecPath,
    artifactPaths: {
      manifest: input.artifacts.manifestPath,
      tasksMd: input.artifacts.tasksMdPath,
      syntheticSpec: input.artifacts.specPath,
    },
    autoWorktree: input.autoWorktree,
    autoMerge: false,
    mergeStrategy: input.mergeStrategy,
    agentOverride: input.agentOverride ?? input.manifest.execution.agentOverride ?? null,
    modelOverride: input.modelOverride ?? input.manifest.execution.modelOverride ?? null,
    effortLevel: input.effortLevel ?? input.manifest.execution.effortLevel ?? null,
    terminalMode: input.terminalMode,
    terminal_mode: input.terminalMode,
    executionEnvironment: input.executionEnvironment ?? input.manifest.execution.executionEnvironment ?? null,
    executionEnvironmentId: input.executionEnvironmentId ?? input.manifest.execution.executionEnvironmentId ?? null,
    executionEnvironmentSupported: input.executionEnvironmentSupported ?? false,
    executionOptionPrecedence: {
      agent: EXECUTION_AGENT_PRECEDENCE,
      model: EXECUTION_MODEL_PRECEDENCE,
    },
    ...(input.executionOptions ? {
      resolvedAgentType: input.executionOptions.resolvedAgentType,
      resolvedAgentModel: input.executionOptions.finalAgentModel,
      agentSource: input.executionOptions.agentSource,
      modelSource: input.executionOptions.modelSource,
      autoSwitchedToOpenCode: input.executionOptions.autoSwitchedToOpenCode,
    } : {}),
    storyCount: input.envelope.spec.userStories.length,
    tasks: input.envelope.spec.userStories.map((story) => ({
      storyId: story.id,
      title: story.title,
      dependsOn: story.dependsOn,
    })),
  };
}

function resolveTaskManifestInput(body: TaskManifestTriggerRequestBody): unknown {
  return body && (body as Record<string, unknown>).manifestVersion === 1
    ? body
    : body.manifest;
}

function hasExecutionEnvironmentSupport(): boolean {
  return [
    path.join(__dirname, '..', 'lib', 'execution-environment.ts'),
    path.join(__dirname, '..', 'lib', 'execution-environment.js'),
  ].some((candidate) => fs.existsSync(candidate));
}

function resolveTaskManifestExecutionEnvironment(
  body: TaskManifestTriggerRequestBody,
  manifest: TaskManifest,
): { supported: boolean; executionEnvironment: 'remote-rorca' | 'local-user'; executionEnvironmentId?: string } {
  const bridgeSupported = hasExecutionEnvironmentSupport();
  const requestedEnvironment = body.executionEnvironment ?? manifest.execution.executionEnvironment ?? 'remote-rorca';
  const requestedEnvironmentId = body.executionEnvironmentId ?? manifest.execution.executionEnvironmentId;
  const supportedEnvironment = requestedEnvironment === 'remote-rorca' || requestedEnvironment === 'local-user';

  return {
    supported: bridgeSupported && supportedEnvironment,
    executionEnvironment: requestedEnvironment === 'local-user' ? 'local-user' : 'remote-rorca',
    ...(requestedEnvironmentId ? { executionEnvironmentId: requestedEnvironmentId } : {}),
  };
}

type TaskManifestRunLookupRow = Pick<PipelineRunRow,
  'idempotency_key' | 'task_manifest_id' | 'task_manifest_artifacts' | 'trigger_options'
> & {
  id: number;
  spec_path: string;
  status: string;
  queue_position: number | null;
  triggered_via?: 'queue' | 'run_now' | null;
};

type TaskManifestRunReservation =
  | { kind: 'existing'; row: TaskManifestRunLookupRow }
  | { kind: 'created'; runId: number; queuePosition: number | null };

function buildPlannedTaskManifestEnvelope(workspacePath: string, manifest: TaskManifest): WriteTaskManifestExecutionEnvelopeResult {
  const spec = createTaskManifestExecutionEnvelope(manifest);
  const paths = resolveTaskManifestArtifactPaths(workspacePath, manifest.manifestId);
  const fileName = `${spec.id}.json`;
  return {
    spec,
    specPath: path.join(paths.artifactDir, fileName),
    relativeSpecPath: path.join(paths.relativeArtifactDir, fileName),
    artifactDir: paths.artifactDir,
    relativeArtifactDir: paths.relativeArtifactDir,
    manifestPath: paths.manifestPath,
    tasksMdPath: paths.tasksMdPath,
    manifestHash: computeTaskManifestHash(manifest),
    artifactReused: false,
  };
}

function buildTaskManifestTriggerOptions(input: {
  manifest: TaskManifest;
  manifestHash: string;
  artifacts: TaskManifestArtifactsResponse;
  artifactRefs: JsonRecord[];
  autoWorktree: boolean;
  mergeStrategy: 'pr' | 'draft-pr' | 'branch-only';
  terminalMode: TerminalMode;
  agentOverride?: 'claude' | 'opencode' | 'codex' | 'pi';
  modelOverride?: string;
  effortLevel?: 'low' | 'medium' | 'high' | 'max' | 'xhigh';
  executionEnvironment?: string;
  executionEnvironmentId?: string;
  executionEnvironmentSupported: boolean;
  executionOptions: ResolvedExecutionOptions;
  sourceStoryIds: string[];
}): JsonRecord {
  const routeDecisionSummary = [
    input.manifest.routeDecision.route,
    input.manifest.routeDecision.reason,
  ].filter((part): part is string => typeof part === 'string' && part.length > 0).join(' — ');

  return {
    source: 'task-manifest',
    manifestId: input.manifest.manifestId,
    idempotencyKey: input.manifest.idempotencyKey,
    manifestHash: input.manifestHash,
    sourceRefs: {
      ...input.manifest.source,
      sourceStoryIds: input.sourceStoryIds,
    },
    artifactPaths: {
      artifactDir: input.artifacts.artifactDir,
      manifestPath: input.artifacts.manifestPath,
      tasksMdPath: input.artifacts.tasksMdPath,
      specPath: input.artifacts.specPath,
    },
    artifactRefs: input.artifactRefs,
    routeDecision: input.manifest.routeDecision,
    routeDecisionSummary,
    policySummary: {
      dryRun: input.manifest.policy.dryRun,
      branchPrOnly: input.manifest.policy.branchPrOnly,
      autoMerge: input.manifest.policy.autoMerge,
      deploysAllowed: input.manifest.policy.deploysAllowed,
      credentialCopyingAllowed: input.manifest.policy.credentialCopyingAllowed,
      commandDenylistCount: input.manifest.policy.commandDenylist.length,
      requiredValidation: input.manifest.policy.requiredValidation,
    },
    validationPlanSummary: {
      requiredCommands: input.manifest.validation.requiredCommands,
      successCriteriaCount: input.manifest.validation.successCriteria.length,
      artifactRefCount: input.manifest.validation.artifactRefs.length,
    },
    execution: {
      autoWorktree: input.autoWorktree,
      autoMerge: false,
      mergeStrategy: input.mergeStrategy,
      terminalMode: input.terminalMode,
      agentOverride: input.agentOverride ?? input.manifest.execution.agentOverride ?? null,
      modelOverride: input.modelOverride ?? input.manifest.execution.modelOverride ?? null,
      effortLevel: input.effortLevel ?? input.manifest.execution.effortLevel ?? null,
      executionEnvironment: input.executionEnvironment ?? input.manifest.execution.executionEnvironment ?? null,
      executionEnvironmentId: input.executionEnvironmentId ?? input.manifest.execution.executionEnvironmentId ?? null,
      executionEnvironmentSupported: input.executionEnvironmentSupported,
      resolvedAgentType: input.executionOptions.resolvedAgentType,
      resolvedAgentModel: input.executionOptions.finalAgentModel ?? null,
      agentSource: input.executionOptions.agentSource,
      modelSource: input.executionOptions.modelSource,
      autoSwitchedToOpenCode: input.executionOptions.autoSwitchedToOpenCode,
    },
  };
}

async function findTaskManifestRunByIdempotencyKey(
  workspaceId: string,
  idempotencyKey: string,
): Promise<TaskManifestRunLookupRow | undefined> {
  return queryOne<TaskManifestRunLookupRow>(
    `SELECT id, spec_path, status, queue_position, triggered_via, idempotency_key, task_manifest_id, task_manifest_artifacts, trigger_options
       FROM pipeline_runs
      WHERE workspace_id = $1
        AND idempotency_key = $2
      ORDER BY id DESC
      LIMIT 1`,
    [workspaceId, idempotencyKey],
  );
}

function assertExistingTaskManifestRunMatchesHash(
  row: TaskManifestRunLookupRow,
  manifestHash: string,
  idempotencyKey: string,
): void {
  const storedHash = getStoredManifestHashFromRun(row);
  if (storedHash === manifestHash) return;

  throw new ConflictError(
    `Task manifest idempotency key '${idempotencyKey}' already exists with a different manifest hash`,
    {
      runId: Number(row.id),
      idempotencyKey,
      existingManifestHash: storedHash ?? null,
      requestedManifestHash: manifestHash,
    },
  );
}

function buildTaskManifestReplayResponse(input: {
  row: TaskManifestRunLookupRow;
  manifest: TaskManifest;
  manifestHash: string;
  fallbackArtifacts: TaskManifestArtifactsResponse;
  fallbackArtifactRefs: JsonRecord[];
}): JsonRecord {
  const artifacts = parseJsonRecordLike(input.row.task_manifest_artifacts) ?? input.fallbackArtifacts;
  const artifactRefs = getStoredArtifactRefsFromTriggerOptions(input.row.trigger_options) ?? input.fallbackArtifactRefs;
  return {
    ok: true,
    idempotent: true,
    reused: true,
    queued: input.row.status === 'queued',
    runId: Number(input.row.id),
    status: input.row.status,
    queuePosition: input.row.queue_position,
    manifestId: input.row.task_manifest_id ?? input.manifest.manifestId,
    idempotencyKey: input.row.idempotency_key ?? input.manifest.idempotencyKey,
    manifestHash: getStoredManifestHashFromRun(input.row) ?? input.manifestHash,
    artifacts,
    artifactRefs,
    manifestSource: buildManifestSourceFromRun(input.row),
  };
}

async function getTaskManifestActiveConflict(
  workspaceId: string,
  autoWorktree: boolean,
): Promise<{ activeRunId?: number; reason?: string } | null> {
  if (autoWorktree) {
    const concurrencyRows = await query<{ key: string; value: string }>(
      `SELECT key, value FROM worker_settings WHERE key = 'run_now_max_concurrent'`,
    );
    const runNowMaxConcurrent = concurrencyRows.length > 0 ? parseInt(concurrencyRows[0].value, 10) : 3;
    const activeWorktreeCount = Number((await queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM pipeline_runs WHERE workspace_id = $1 AND status IN ('running', 'paused', 'pi_native') AND worktree_path IS NOT NULL`,
      [workspaceId],
    ))?.count ?? '0');

    if (activeWorktreeCount >= runNowMaxConcurrent) {
      const activeRun = await queryOne<{ id: number }>(
        `SELECT id FROM pipeline_runs WHERE workspace_id = $1 AND status IN ('running', 'paused', 'pi_native') AND worktree_path IS NOT NULL LIMIT 1`,
        [workspaceId],
      );
      return {
        activeRunId: activeRun ? Number(activeRun.id) : undefined,
        reason: `Maximum ${runNowMaxConcurrent} concurrent worktree runs reached. Wait for an active run to complete or increase run_now_max_concurrent.`,
      };
    }
    return null;
  }

  const activeRun = await queryOne<{ id: number }>(
    `SELECT id
       FROM pipeline_runs
      WHERE workspace_id = $1
        AND status IN ('queued', 'running', 'paused', 'pi_native')
      ORDER BY id DESC
      LIMIT 1`,
    [workspaceId],
  );
  return activeRun ? { activeRunId: Number(activeRun.id) } : null;
}

async function reserveTaskManifestRun(input: {
  workspaceId: string;
  specPath: string;
  idempotencyKey: string;
  manifestId: string;
  manifestHash: string;
  artifacts: TaskManifestArtifactsResponse;
  triggerOptions: JsonRecord;
  queue: boolean;
  autoWorktree: boolean;
  mergeStrategy: 'pr' | 'draft-pr' | 'branch-only';
  terminalMode: TerminalMode;
  includeGraph: boolean;
  agentType: AgentType;
  agentModel: string | null;
}): Promise<TaskManifestRunReservation> {
  return transaction(async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');

    const existingResult = await client.query<TaskManifestRunLookupRow>(
      `SELECT id, spec_path, status, queue_position, triggered_via, idempotency_key, task_manifest_id, task_manifest_artifacts, trigger_options
         FROM pipeline_runs
        WHERE workspace_id = $1
          AND idempotency_key = $2
        ORDER BY id DESC
        LIMIT 1
        FOR UPDATE`,
      [input.workspaceId, input.idempotencyKey],
    );
    const existing = existingResult.rows[0];
    if (existing) {
      assertExistingTaskManifestRunMatchesHash(existing, input.manifestHash, input.idempotencyKey);
      return { kind: 'existing', row: existing };
    }

    let queuePosition: number | null = null;
    if (input.queue) {
      const queueCountResult = await client.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM pipeline_runs WHERE workspace_id = $1 AND status = 'queued'`,
        [input.workspaceId],
      );
      const queueCount = Number(queueCountResult.rows[0]?.count ?? '0');
      if (queueCount >= 10) {
        throw new ConflictError('Queue full', { currentDepth: queueCount, maxQueueDepth: 10 });
      }
      queuePosition = queueCount + 1;
    }

    const insertResult = await client.query<{ id: number; queue_position: number | null }>(
      `INSERT INTO pipeline_runs (
         spec_path, workspace_id, status, trigger_type, queued_at, queue_position,
         triggered_via, auto_worktree, auto_merge, merge_strategy, terminal_mode,
         include_graph, agent, agent_type, agent_model,
         idempotency_key, task_manifest_id, task_manifest_artifacts, trigger_options
       ) VALUES (
         $1, $2, 'queued', 'manual', NOW(), $3,
         $4, $5, false, $6, $7,
         $8, $9, $10, $11,
         $12, $13, $14::jsonb, $15::jsonb
       )
       ON CONFLICT (workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id, queue_position`,
      [
        input.specPath,
        input.workspaceId,
        queuePosition,
        input.queue ? 'queue' : 'run_now',
        input.autoWorktree,
        input.mergeStrategy,
        input.terminalMode,
        input.includeGraph,
        input.agentType,
        input.agentType,
        input.agentModel,
        input.idempotencyKey,
        input.manifestId,
        JSON.stringify(input.artifacts),
        JSON.stringify(input.triggerOptions),
      ],
    );

    const inserted = insertResult.rows[0];
    if (inserted) {
      return { kind: 'created', runId: Number(inserted.id), queuePosition: inserted.queue_position };
    }

    const racedResult = await client.query<TaskManifestRunLookupRow>(
      `SELECT id, spec_path, status, queue_position, triggered_via, idempotency_key, task_manifest_id, task_manifest_artifacts, trigger_options
         FROM pipeline_runs
        WHERE workspace_id = $1
          AND idempotency_key = $2
        ORDER BY id DESC
        LIMIT 1
        FOR UPDATE`,
      [input.workspaceId, input.idempotencyKey],
    );
    const raced = racedResult.rows[0];
    if (!raced) {
      throw new ConflictError('Task manifest idempotency reservation failed; retry the request');
    }
    assertExistingTaskManifestRunMatchesHash(raced, input.manifestHash, input.idempotencyKey);
    return { kind: 'existing', row: raced };
  });
}

async function deleteTaskManifestReservation(runId: number, idempotencyKey: string): Promise<void> {
  await execute(
    `DELETE FROM pipeline_runs
      WHERE id = $1
        AND idempotency_key = $2
        AND status = 'queued'`,
    [runId, idempotencyKey],
  ).catch(() => undefined);
}

/**
 * @swagger
 * /api/pipeline/task-manifests/trigger:
 *   post:
 *     tags: [Pipeline]
 *     summary: Trigger a bounded Hermes task manifest through the Rorca pipeline broker
 *     operationId: triggerTaskManifestPipelineRun
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Stable local task-manifest execution is safe for MCP/CLI because the route validates bounded Hermes manifests, requires workspaceId and idempotencyKey, rejects autoMerge=true and mergeStrategy=direct, and the manifest policy forbids deploys and credential-copying before any pg-boss job is inserted."
 *     x-rorca-public-api: true
 *     description: >
 *       Validates a Hermes task manifest, writes manifest.json/tasks.md plus an internal synthetic spec under
 *       forge/task-manifests/{manifestId}/, and queues the existing pipeline:run broker path. Generated MCP tool:
 *       rorca_pipeline_task_manifests_trigger. Friendly alias: rorca_trigger_task_manifest. Hermes supplies
 *       agent/model intent only; Rorca resolves provider/model interoperability through the broker and execution
 *       engine. Execution precedence is request overrides > manifest.execution overrides > synthetic envelope/spec
 *       metadata > provider/model auto-switch > workflow router > active fallback (model uses the analogous request
 *       > manifest > spec > workflow > active chain). Safe defaults are dry-run support, branch/PR-only,
 *       autoMerge=false, no deploys, no credential copying, no production DB writes, and no secret mutation.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, manifest, idempotencyKey]
 *             properties:
 *               workspaceId: { type: string, description: "Rorca workspace authority anchor" }
 *               manifest: { type: object, description: "Hermes TaskManifest v1 payload" }
 *               idempotencyKey: { type: string, format: uuid, description: "Hermes-issued idempotency key; must match manifest.idempotencyKey" }
 *               dryRun: { type: boolean, default: false }
 *               autoWorktree: { type: boolean, default: true }
 *               autoMerge: { type: boolean, default: false, description: "Must be false; task manifests never auto-merge" }
 *               mergeStrategy: { type: string, enum: [pr, draft-pr, branch-only], default: draft-pr }
 *               agentOverride: { type: string, enum: [claude, opencode, codex, pi] }
 *               modelOverride: { type: string }
 *               effortLevel: { type: string, enum: [low, medium, high, max, xhigh] }
 *               executionEnvironment: { type: string, description: "Optional; carried to the broker only when local execution-environment support is installed, otherwise defaults to remote-rorca." }
 *               executionEnvironmentId: { type: string, description: "Optional execution-environment identifier when supported." }
 *               terminal_mode: { type: string, enum: [ansi-html, pty, native-pty], nullable: true }
 *               terminalMode: { type: string, enum: [ansi-html, pty, native-pty], nullable: true }
 *     responses:
 *       200:
 *         description: Dry-run plan or idempotency conflict
 *       201:
 *         description: Pipeline run queued with manifest artifact references
 *       202:
 *         description: Manifest accepted into the queue when queue=true
 *       400: { description: Invalid task manifest, missing workspace/idempotency, invalid source authority, or ineligible route decision }
 *       409: { description: Active workspace run conflict when autoWorktree=false }
 *       422: { description: Unsafe task-manifest execution policy such as autoMerge=true or mergeStrategy=direct }
 */
async function handleTaskManifestTrigger(req: Request, res: Response): Promise<void> {
  try {
    const requestBody = req.body as TaskManifestTriggerRequestBody;
    const manifestInput = resolveTaskManifestInput(requestBody);
    const parsed = safeParseTaskManifest(manifestInput);
    if (!parsed.success) {
      const validationCode = taskManifestValidationCodeFromIssues(parsed.error.issues);
      throw new ValidationError(
        `Invalid task manifest: ${taskManifestIssueSummary(parsed.error.issues)}`,
        taskManifestIssueDetails(validationCode, parsed.error.issues),
      );
    }
    const manifest = parsed.data;

    const requestWorkspaceId = stringFromId(requestBody.workspaceId ?? ((manifestInput as Record<string, unknown> | undefined)?.workspaceId));
    if (!requestWorkspaceId) {
      throw validationErrorWithCode('Missing required field: workspaceId', 'TASK_MANIFEST_WORKSPACE_ID_REQUIRED');
    }

    const requestIdempotencyKey = stringFromId(requestBody.idempotencyKey ?? ((manifestInput as Record<string, unknown> | undefined)?.idempotencyKey));
    if (!requestIdempotencyKey) {
      throw validationErrorWithCode('Missing required field: idempotencyKey', 'TASK_MANIFEST_IDEMPOTENCY_KEY_REQUIRED');
    }

    assertTaskManifestSourceAuthority(requestBody, manifest, requestWorkspaceId, requestIdempotencyKey);
    assertTaskManifestRouteDecisionAllowed(manifest);

    const resolvedAutoWorktree = requestBody.autoWorktree !== false;
    const resolvedAutoMerge = requestBody.autoMerge === true;
    const resolvedMergeStrategy = requestBody.mergeStrategy ?? manifest.execution.mergeStrategy;
    if (resolvedAutoMerge && resolvedMergeStrategy === 'direct') {
      throw new UnprocessableError(
        'Task manifest execution rejects autoMerge=true with mergeStrategy=direct; high-risk direct repair must use PR, draft-PR, or branch-only review.',
        'TASK_MANIFEST_HIGH_RISK_DIRECT_REPAIR',
        { code: 'TASK_MANIFEST_HIGH_RISK_DIRECT_REPAIR' },
      );
    }
    if (resolvedAutoMerge) {
      throw new UnprocessableError(
        'Task manifest execution rejects autoMerge=true; use PR, draft-PR, or branch-only review',
        'TASK_MANIFEST_AUTO_MERGE_REJECTED',
        { code: 'TASK_MANIFEST_AUTO_MERGE_REJECTED' },
      );
    }

    if (resolvedMergeStrategy === 'direct') {
      throw new UnprocessableError(
        'Task manifest execution rejects mergeStrategy=direct; use pr, draft-pr, or branch-only',
        'TASK_MANIFEST_DIRECT_MERGE_REJECTED',
        { code: 'TASK_MANIFEST_DIRECT_MERGE_REJECTED' },
      );
    }

    const workspace = await queryOne('SELECT * FROM workspaces WHERE id = $1', [requestWorkspaceId]) as
      { id: string; label: string; path: string; domain?: string } | undefined;
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
    }

    const plannedEnvelope = buildPlannedTaskManifestEnvelope(workspace.path, manifest);
    const plannedArtifacts = buildTaskManifestArtifactsResponse(plannedEnvelope);
    const plannedArtifactRefs = buildTaskManifestArtifactRefs(plannedArtifacts);
    const resolvedTerminalMode = resolveRequestedTerminalMode(requestBody.terminal_mode ?? requestBody.terminalMode ?? manifest.execution.terminalMode);
    assertTerminalModeAvailable(resolvedTerminalMode);
    const resolvedDryRun = requestBody.dryRun === true || manifest.policy.dryRun === true;
    const resolvedAgentOverride = requestBody.agentOverride ?? manifest.execution.agentOverride;
    const resolvedModelOverride = requestBody.modelOverride ?? manifest.execution.modelOverride;
    const resolvedEffortLevel = requestBody.effortLevel ?? manifest.execution.effortLevel;
    const executionEnvironmentResolution = resolveTaskManifestExecutionEnvironment(requestBody, manifest);
    const resolvedExecutionEnvironment = executionEnvironmentResolution.executionEnvironment;
    const resolvedExecutionEnvironmentId = executionEnvironmentResolution.executionEnvironmentId;

    const taskManifestUser = await getEffectiveUser(req);
    const taskManifestWfConfig = await resolveWorkflowConfig('pipeline_execution', taskManifestUser?.id);
    const taskManifestExecutionOptions = resolveExecutionOptions({
      requestAgentOverride: requestBody.agentOverride,
      manifestAgentOverride: manifest.execution.agentOverride,
      specAgentOverride: plannedEnvelope.spec.agentOverride,
      requestModelOverride: requestBody.modelOverride,
      manifestModelOverride: manifest.execution.modelOverride,
      specModel: plannedEnvelope.spec.model ?? null,
      workflowConfig: taskManifestWfConfig,
      activeAgentFallback: activeAgent,
      activeModelFallback: activeModel,
      log: logger,
    });

    const plannedTriggerOptions = buildTaskManifestTriggerOptions({
      manifest,
      manifestHash: plannedEnvelope.manifestHash,
      artifacts: plannedArtifacts,
      artifactRefs: plannedArtifactRefs,
      autoWorktree: resolvedAutoWorktree,
      mergeStrategy: resolvedMergeStrategy,
      agentOverride: resolvedAgentOverride,
      modelOverride: resolvedModelOverride,
      effortLevel: resolvedEffortLevel,
      terminalMode: resolvedTerminalMode,
      executionEnvironment: resolvedExecutionEnvironment,
      executionEnvironmentId: resolvedExecutionEnvironmentId,
      executionEnvironmentSupported: executionEnvironmentResolution.supported,
      executionOptions: taskManifestExecutionOptions,
      sourceStoryIds: plannedEnvelope.spec.sourceStoryIds,
    });

    if (resolvedDryRun) {
      const dryRunEnvelope = await writeTaskManifestExecutionEnvelope({
        workspacePath: workspace.path,
        manifest,
      });
      const dryRunArtifacts = buildTaskManifestArtifactsResponse(dryRunEnvelope);
      const dryRunArtifactRefs = buildTaskManifestArtifactRefs(dryRunArtifacts);
      const dryRunTriggerOptions = buildTaskManifestTriggerOptions({
        manifest,
        manifestHash: dryRunEnvelope.manifestHash,
        artifacts: dryRunArtifacts,
        artifactRefs: dryRunArtifactRefs,
        autoWorktree: resolvedAutoWorktree,
        mergeStrategy: resolvedMergeStrategy,
        agentOverride: resolvedAgentOverride,
        modelOverride: resolvedModelOverride,
        effortLevel: resolvedEffortLevel,
        terminalMode: resolvedTerminalMode,
        executionEnvironment: resolvedExecutionEnvironment,
        executionEnvironmentId: resolvedExecutionEnvironmentId,
        executionEnvironmentSupported: executionEnvironmentResolution.supported,
        executionOptions: taskManifestExecutionOptions,
        sourceStoryIds: dryRunEnvelope.spec.sourceStoryIds,
      });
      const model = taskManifestExecutionOptions.finalAgentModel ?? DEFAULT_MODEL;
      const estimate = await estimateDryRunCost(
        dryRunEnvelope.spec,
        requestWorkspaceId,
        model,
        resolvedEffortLevel ? { enabled: true, effort: resolvedEffortLevel } : undefined,
      );
      res.status(200).json({
        ok: true,
        dryRun: true,
        queued: false,
        manifestId: manifest.manifestId,
        idempotencyKey: requestIdempotencyKey,
        manifestHash: dryRunEnvelope.manifestHash,
        artifacts: dryRunArtifacts,
        artifactRefs: dryRunArtifactRefs,
        manifestSource: buildManifestSourceFromRun({
          idempotency_key: requestIdempotencyKey,
          task_manifest_id: manifest.manifestId,
          task_manifest_artifacts: dryRunArtifacts,
          trigger_options: dryRunTriggerOptions,
        }),
        estimatedExecutionPlan: buildTaskManifestEstimatedPlan({
          manifest,
          envelope: dryRunEnvelope,
          artifacts: dryRunArtifacts,
          autoWorktree: resolvedAutoWorktree,
          mergeStrategy: resolvedMergeStrategy,
          agentOverride: resolvedAgentOverride,
          modelOverride: resolvedModelOverride,
          effortLevel: resolvedEffortLevel,
          terminalMode: resolvedTerminalMode,
          executionEnvironment: resolvedExecutionEnvironment,
          executionEnvironmentId: resolvedExecutionEnvironmentId,
          executionEnvironmentSupported: executionEnvironmentResolution.supported,
          executionOptions: taskManifestExecutionOptions,
        }),
        estimate,
      });
      return;
    }

    const existingIdempotentRun = await findTaskManifestRunByIdempotencyKey(requestWorkspaceId, requestIdempotencyKey);
    if (existingIdempotentRun) {
      assertExistingTaskManifestRunMatchesHash(existingIdempotentRun, plannedEnvelope.manifestHash, requestIdempotencyKey);
      res.status(200).json(buildTaskManifestReplayResponse({
        row: existingIdempotentRun,
        manifest,
        manifestHash: plannedEnvelope.manifestHash,
        fallbackArtifacts: plannedArtifacts,
        fallbackArtifactRefs: plannedArtifactRefs,
      }));
      return;
    }

    const activeConflict = await getTaskManifestActiveConflict(requestWorkspaceId, resolvedAutoWorktree);
    if (activeConflict) {
      res.status(200).json({
        ok: false,
        conflict: true,
        activeRunId: activeConflict.activeRunId,
        reason: activeConflict.reason,
        manifestId: manifest.manifestId,
        idempotencyKey: requestIdempotencyKey,
        manifestHash: plannedEnvelope.manifestHash,
      });
      return;
    }

    const reservation = await reserveTaskManifestRun({
      workspaceId: requestWorkspaceId,
      specPath: plannedEnvelope.relativeSpecPath,
      idempotencyKey: requestIdempotencyKey,
      manifestId: manifest.manifestId,
      manifestHash: plannedEnvelope.manifestHash,
      artifacts: plannedArtifacts,
      triggerOptions: plannedTriggerOptions,
      queue: requestBody.queue === true,
      autoWorktree: resolvedAutoWorktree,
      mergeStrategy: resolvedMergeStrategy,
      terminalMode: resolvedTerminalMode,
      includeGraph: requestBody.includeGraph === true,
      agentType: taskManifestExecutionOptions.resolvedAgentType,
      agentModel: taskManifestExecutionOptions.finalAgentModel ?? null,
    });

    if (reservation.kind === 'existing') {
      res.status(200).json(buildTaskManifestReplayResponse({
        row: reservation.row,
        manifest,
        manifestHash: plannedEnvelope.manifestHash,
        fallbackArtifacts: plannedArtifacts,
        fallbackArtifactRefs: plannedArtifactRefs,
      }));
      return;
    }

    let envelope = plannedEnvelope;
    let artifacts = plannedArtifacts;
    let artifactRefs = plannedArtifactRefs;
    let triggerOptions = plannedTriggerOptions;
    try {
      envelope = await writeTaskManifestExecutionEnvelope({
        workspacePath: workspace.path,
        manifest,
      });
      artifacts = buildTaskManifestArtifactsResponse(envelope);
      artifactRefs = buildTaskManifestArtifactRefs(artifacts);
      triggerOptions = buildTaskManifestTriggerOptions({
        manifest,
        manifestHash: envelope.manifestHash,
        artifacts,
        artifactRefs,
        autoWorktree: resolvedAutoWorktree,
        mergeStrategy: resolvedMergeStrategy,
        agentOverride: resolvedAgentOverride,
        modelOverride: resolvedModelOverride,
        effortLevel: resolvedEffortLevel,
        terminalMode: resolvedTerminalMode,
        executionEnvironment: resolvedExecutionEnvironment,
        executionEnvironmentId: resolvedExecutionEnvironmentId,
        executionEnvironmentSupported: executionEnvironmentResolution.supported,
        executionOptions: taskManifestExecutionOptions,
        sourceStoryIds: envelope.spec.sourceStoryIds,
      });
      await execute(
        `UPDATE pipeline_runs
            SET task_manifest_artifacts = $1::jsonb,
                trigger_options = $2::jsonb
          WHERE id = $3`,
        [JSON.stringify(artifacts), JSON.stringify(triggerOptions), reservation.runId],
      );
    } catch (artifactError) {
      await deleteTaskManifestReservation(reservation.runId, requestIdempotencyKey);
      throw artifactError;
    }

    if (requestBody.queue === true) {
      res.status(202).json({
        ok: true,
        queued: true,
        runId: reservation.runId,
        queuePosition: reservation.queuePosition,
        manifestId: manifest.manifestId,
        idempotencyKey: requestIdempotencyKey,
        manifestHash: envelope.manifestHash,
        artifacts,
        artifactRefs,
        manifestSource: buildManifestSourceFromRun({
          idempotency_key: requestIdempotencyKey,
          task_manifest_id: manifest.manifestId,
          task_manifest_artifacts: artifacts,
          trigger_options: triggerOptions,
        }),
      });
      return;
    }

    req.body = {
      specPath: envelope.relativeSpecPath,
      workspaceId: requestWorkspaceId,
      autoWorktree: resolvedAutoWorktree,
      autoMerge: false,
      mergeStrategy: resolvedMergeStrategy,
      dryRun: false,
      triggerType: 'manual',
      queue: false,
      reservedRunId: reservation.runId,
      forceSequential: requestBody.forceSequential === true,
      includeGraph: requestBody.includeGraph === true,
      readinessOverride: true,
      idempotencyKey: requestIdempotencyKey,
      manifestId: manifest.manifestId,
      taskManifestArtifacts: artifacts,
      taskManifestArtifactRefs: artifactRefs,
      triggerOptions,
      ...(requestBody.agentOverride ? { agentOverride: requestBody.agentOverride } : {}),
      ...(manifest.execution.agentOverride ? { manifestExecutionAgentOverride: manifest.execution.agentOverride } : {}),
      ...(requestBody.modelOverride ? { modelOverride: requestBody.modelOverride } : {}),
      ...(manifest.execution.modelOverride ? { manifestExecutionModelOverride: manifest.execution.modelOverride } : {}),
      ...(resolvedEffortLevel ? { effortLevel: resolvedEffortLevel } : {}),
      terminalMode: resolvedTerminalMode,
      ...(executionEnvironmentResolution.supported ? { executionEnvironment: resolvedExecutionEnvironment } : {}),
      ...(executionEnvironmentResolution.supported && resolvedExecutionEnvironmentId ? { executionEnvironmentId: resolvedExecutionEnvironmentId } : {}),
    };

    await handlePipelineTrigger(req, res);
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Task manifest trigger');
  }
}

router.post('/task-manifests/trigger', validateBody(TaskManifestTriggerRequestSchema), handleTaskManifestTrigger);
router.post('/task-manifest/trigger', validateBody(TaskManifestTriggerRequestSchema), handleTaskManifestTrigger);

// ─── POST /api/pipeline/context-preview — Preview context routing per story ───

/**
 * @swagger
 * /api/pipeline/context-preview:
 *   post:
 *     tags: [Pipeline]
 *     summary: Preview context routing for each story in a spec
 *     operationId: previewContextRouting
 *     description: >
 *       Returns the predicted context payload for each story, including
 *       global files, scope matches, tag matches, token estimates, and
 *       budget warnings. Use before triggering to show users exactly what
 *       context will be injected.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [specPath, workspaceId]
 *             properties:
 *               specPath: { type: string, example: "forge/specs/approved/my-spec.json" }
 *               workspaceId: { type: string }
 *     responses:
 *       200:
 *         description: Context preview payload
 *       400: { description: "Missing required fields" }
 *       404: { description: "Workspace or spec not found" }
 */
router.post('/context-preview', async (req: Request, res: Response) => {
  try {
    const { specPath, workspaceId } = req.body;
    if (!specPath || !workspaceId) {
      throw new ValidationError('Missing required fields: specPath, workspaceId');
      return;
    }

    const workspace = await queryOne('SELECT * FROM workspaces WHERE id = $1', [workspaceId]) as
      { id: string; path: string } | undefined;
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const absSpecPath = path.join(workspace.path, specPath);
    if (!fs.existsSync(absSpecPath)) {
      throw new NotFoundError('Spec file not found');
      return;
    }

    const specJson = JSON.parse(fs.readFileSync(absSpecPath, 'utf8'));
    if (!specJson.userStories || !Array.isArray(specJson.userStories)) {
      throw new UnprocessableError('Spec has no userStories array');
      return;
    }

    // Load routing config from .rorca/config.json
    const { loadRorcaConfig } = require('../lib/rorca-config') as typeof import('../lib/rorca-config');
    const rorcaConfig = loadRorcaConfig(workspace.path);
    const routingConfig = rorcaConfig.routing;
    const tokenBudget = routingConfig.tokenBudget;

    // Import context-router functions
    const { route, estimateTokens, extractPathMentions, matchScopes, matchTags, detectCrossAppPaths } =
      require('../lib/context-router') as typeof import('../lib/context-router');

    // CIE-017: Load monorepo apps for cross-app story detection
    const { loadMonorepoApps } = require('../lib/workspace-echolocation') as typeof import('../lib/workspace-echolocation');
    let monorepoApps: import('../lib/workspace-echolocation').MonorepoPackage[] | undefined;
    try {
      const apps = loadMonorepoApps(workspace.path);
      if (apps.length > 0) monorepoApps = apps;
    } catch { /* non-fatal */ }

    // Build per-story preview
    const stories: Array<{
      storyId: string;
      title: string;
      predictedPaths: string[];
      crossAppPaths: string[];
      globalFiles: Array<{ path: string; tokens: number }>;
      scopedFiles: Array<{ path: string; tokens: number; matchedScope: string }>;
      taggedFiles: Array<{ path: string; tokens: number; matchedTag: string }>;
      globalTokens: number;
      scopedTokens: number;
      taggedTokens: number;
      totalTokens: number;
      exceeded: boolean;
      droppedFiles: string[];
    }> = [];

    let anyExceeded = false;

    for (const story of specJson.userStories) {
      if (story.passes || story.excluded) continue;

      // Run the full routing pipeline (CIE-017: pass monorepo apps for cross-app detection)
      const payload = route(story, routingConfig, workspace.path, monorepoApps);

      // Re-run routing in detail mode to get per-file breakdown
      const predictedPaths = extractPathMentions(story);
      // CIE-017: Detect cross-app references in monorepo stories
      const crossAppPaths = monorepoApps ? detectCrossAppPaths(story, monorepoApps) : [];
      const allPredictedPaths = [...predictedPaths, ...crossAppPaths];
      const matchedScopes = matchScopes(allPredictedPaths, routingConfig.scopes);
      const storyTags = story.tags ?? [];
      const matchedTagRules = matchTags(storyTags, routingConfig.tags);

      // Build per-file detail lists (reading files to get token counts)
      const globalFiles: Array<{ path: string; tokens: number }> = [];
      for (const gp of routingConfig.global) {
        try {
          const absPath = path.isAbsolute(gp) ? gp : path.join(workspace.path, gp);
          const content = fs.readFileSync(absPath, 'utf-8');
          globalFiles.push({ path: gp, tokens: estimateTokens(content) });
        } catch {
          // File doesn't exist — skip
        }
      }

      const scopedFiles: Array<{ path: string; tokens: number; matchedScope: string }> = [];
      for (const scope of matchedScopes) {
        for (const ip of scope.inject) {
          try {
            const absPath = path.isAbsolute(ip) ? ip : path.join(workspace.path, ip);
            const content = fs.readFileSync(absPath, 'utf-8');
            scopedFiles.push({ path: ip, tokens: estimateTokens(content), matchedScope: scope.path });
          } catch {
            // File doesn't exist — skip
          }
        }
      }

      const taggedFiles: Array<{ path: string; tokens: number; matchedTag: string }> = [];
      for (const tagRule of matchedTagRules) {
        for (const ip of tagRule.inject) {
          try {
            const absPath = path.isAbsolute(ip) ? ip : path.join(workspace.path, ip);
            const content = fs.readFileSync(absPath, 'utf-8');
            taggedFiles.push({ path: ip, tokens: estimateTokens(content), matchedTag: tagRule.tag });
          } catch {
            // File doesn't exist — skip
          }
        }
      }

      const globalTokens = globalFiles.reduce((s, f) => s + f.tokens, 0);
      const scopedTokens = scopedFiles.reduce((s, f) => s + f.tokens, 0);
      const taggedTokens = taggedFiles.reduce((s, f) => s + f.tokens, 0);

      // Determine dropped files (files that would be injected but were cut by budget)
      const allCandidatePaths = [
        ...globalFiles.map(f => f.path),
        ...scopedFiles.map(f => f.path),
        ...taggedFiles.map(f => f.path),
      ];
      const injectedSet = new Set(payload.injectedFiles);
      const droppedFiles = allCandidatePaths.filter(p => !injectedSet.has(p));

      const exceeded = payload.totalTokens > tokenBudget || droppedFiles.length > 0;
      if (exceeded) anyExceeded = true;

      stories.push({
        storyId: story.id,
        title: story.title,
        predictedPaths,
        crossAppPaths,
        globalFiles,
        scopedFiles,
        taggedFiles,
        globalTokens,
        scopedTokens,
        taggedTokens,
        totalTokens: payload.totalTokens,
        exceeded,
        droppedFiles,
      });
    }

    res.json({
      tokenBudget,
      anyExceeded,
      globalFileCount: routingConfig.global.length,
      scopeCount: routingConfig.scopes.length,
      tagCount: routingConfig.tags.length,
      monorepo: monorepoApps ? { detected: true, appCount: monorepoApps.length } : { detected: false },
      stories,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Context preview');
  }
});

// ─── POST /api/pipeline/orchestration-preview — Preview auto-orchestration mode ─

/**
 * @swagger
 * /api/pipeline/orchestration-preview:
 *   post:
 *     tags: [Pipeline]
 *     summary: Preview auto-orchestration mode for a spec
 *     operationId: previewOrchestrationMode
 *     description: Analyzes the spec's dependency graph and returns the recommended orchestration mode (sequential or wave-parallel) with wave groupings.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [specPath, workspaceId]
 *             properties:
 *               specPath: { type: string }
 *               workspaceId: { type: string }
 *     responses:
 *       200:
 *         description: Orchestration preview
 */
router.post('/orchestration-preview', async (req: Request, res: Response) => {
  try {
    const { specPath, workspaceId } = req.body;
    if (!specPath || !workspaceId) {
      throw new ValidationError('Missing required fields: specPath, workspaceId');
      return;
    }

    const workspace = await queryOne('SELECT * FROM workspaces WHERE id = $1', [workspaceId]) as
      { id: string; path: string } | undefined;
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const absSpecPath = path.join(workspace.path, specPath);
    if (!fs.existsSync(absSpecPath)) {
      throw new NotFoundError('Spec file not found');
      return;
    }

    const specJson = JSON.parse(fs.readFileSync(absSpecPath, 'utf8'));
    const orchStories: WaveUserStory[] = (specJson.userStories ?? []).map((s: any) => ({
      id: s.id,
      title: s.title ?? '',
      description: s.description ?? '',
      acceptanceCriteria: s.acceptanceCriteria ?? [],
      dependsOn: s.dependsOn ?? [],
      passes: s.passes,
      excluded: s.excluded,
    }));

    const result = autoSelectOrchestration(orchStories);
    res.json(result);
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Orchestration preview');
  }
});

// ─── POST /api/pipeline/quick-run — Brief → single-story spec → immediate run ─
// Accepts a plain-English brief, generates a 1-story spec, writes it directly
// to approved/ (no review queue), emits spec_approved WAL, triggers execution.

/**
 * @swagger
 * /api/pipeline/quick-run:
 *   post:
 *     tags: [Pipeline]
 *     summary: Quick-run — generate a 1-story spec from a brief and execute immediately
 *     operationId: quickRunPipeline
 *     description: |
 *       Generates a single-story spec from a plain-English brief, writes it directly to
 *       approved (no review queue), and immediately triggers pipeline execution.
 *
 *       The spec generation prompt incorporates a layered context cascade in this order:
 *       1. **Direction Stack (L1-L3)** — synthesized from direction_layers table:
 *          L1 (global engineering principles), L2 (domain conventions matched by workspace.domain),
 *          L3 (project-specific context scoped to this workspace). Merged via synthesize().
 *       2. **MEMORY.md** — episodic ledger from workspace root (first 2000 chars).
 *          Contains timestamped Architecture/Convention/Bug Fix/Decision/Pattern/Gotcha entries.
 *       3. **Installed Skills** — list of skills from installed_skills table (name + description).
 *          Informs the LLM which reusable skill files are available for the generated story.
 *       All three context sources are best-effort: silently omitted if missing or on error.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, brief]
 *             properties:
 *               workspaceId: { type: string }
 *               brief: { type: string, description: "Plain-English description of what to build" }
 *               model: { type: string, description: "LLM model to use for spec generation" }
 *     responses:
 *       202:
 *         description: Quick-run started
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 runId: { type: integer }
 *                 specId: { type: string }
 *       400: { description: "Missing required fields" }
 *       404: { description: "Workspace not found" }
 *       409: { description: "Active run conflict or budget cap exceeded" }
 */
router.post('/quick-run', async (req: Request, res: Response) => {
  try {
    const { workspaceId, brief, model: requestedModel } = req.body;

    if (!workspaceId || !brief) {
      throw new ValidationError('Missing required fields: workspaceId, brief');
      return;
    }

    // 1. Look up workspace
    const workspace = await queryOne('SELECT * FROM workspaces WHERE id = $1', [workspaceId]) as
      { id: string; label: string; path: string; domain?: string } | undefined;
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    // Plan enforcement is handled by requirePlan middleware once billing-launch spec is complete.

    // 3. Budget cap guard
    const budgetStatus = await checkBudgetThresholds(workspaceId);
    if (budgetStatus.capExceeded) {
      throw new ConflictError('Budget cap exceeded for this period');
      return;
    }

    // 4. Conflict detection
    const activeRun = await queryOne(`SELECT * FROM pipeline_runs WHERE workspace_id = $1 AND status IN ('running', 'paused', 'pi_native') LIMIT 1`, [workspaceId]) as PipelineRunRow | undefined;
    if (activeRun) {
      res.json({ conflict: true, activeRunId: activeRun.id });
      return;
    }

    // 5. Resolve model — from request only, no hidden DB fallbacks
    const resolvedModel: string = requestedModel ?? DEFAULT_MODEL;

    // 6. Resolve vault creds for LLM call
    const user = await getEffectiveUser(req);
    let vaultCreds: { apiKey?: string; baseUrl?: string } = {};
    if (user?.id) {
      const vaultProvider = resolveVaultProvider(resolvedModel);
      if (vaultProvider) {
        const result = await getVaultKey(user.id, vaultProvider);
        if (result) vaultCreds = { apiKey: result.key, baseUrl: result.baseUrl ?? undefined };
      }
      if (!vaultCreds.apiKey) {
        const compat = await getVaultKey(user.id, 'openai-compat');
        if (compat) vaultCreds = { apiKey: compat.key, baseUrl: compat.baseUrl ?? undefined };
      }
      if (!vaultCreds.apiKey) {
        const anthropic = await getVaultKey(user.id, 'anthropic');
        if (anthropic) vaultCreds = { apiKey: anthropic.key };
      }
    }

    // Context cascade: direction stack → MEMORY.md → installed skills → instructions
    // Each layer is best-effort (silently omitted on error or absence):
    //   1. Direction Stack (L1–L3): global engineering principles → domain conventions → project context
    //   2. MEMORY.md: episodic ledger at workspace root, capped at 2000 chars
    //   3. Installed Skills: names + descriptions from installed_skills table
    // Layers are assembled in this order and prepended to the LLM instructions block.
    // An empty layer is filtered out — the prompt degrades gracefully to bare instructions.

    // 7. Synthesize direction stack (L1–L3) for this workspace
    let directionContext = '';
    try {
      const domain = workspace.domain ?? '';
      const [l1Row, l2Row, l3Row] = await Promise.all([
        queryOne<{ content_yaml: string }>(`SELECT content_yaml FROM direction_layers WHERE layer = 1 AND COALESCE(workspace_id, '') = '' AND COALESCE(domain, '') = '' AND COALESCE(team_id, '') = '' LIMIT 1`, []),
        queryOne<{ content_yaml: string }>(`SELECT content_yaml FROM direction_layers WHERE layer = 2 AND COALESCE(workspace_id, '') = '' AND (domain = $1 OR COALESCE(domain, '') = '') AND COALESCE(team_id, '') = '' ORDER BY (domain = $1) DESC LIMIT 1`, [domain]),
        queryOne<{ content_yaml: string }>(`SELECT content_yaml FROM direction_layers WHERE layer = 3 AND workspace_id = $1 AND COALESCE(domain, '') = '' LIMIT 1`, [workspaceId]),
      ]);
      directionContext = synthesize({ l1: l1Row?.content_yaml, l2: l2Row?.content_yaml, l3: l3Row?.content_yaml, specBrief: brief });
    } catch (err: unknown) {
      // Silently skip — direction context is best-effort
      if (err instanceof Error) void err.message;
    }

    // 8. Generate 1-story spec via LLM
    // CTM-006: Route quick-run context injection through the canonical workspace-context path.
    // Validate the .rorca / AGENTS.md / MEMORY.md contract once, then resolve MEMORY.md and
    // installed skills against it so quick-run specs are never context blind by accident.
    const routingContract = validateRoutingContract(workspace.path);

    // Read MEMORY.md from workspace root (best-effort, silent on error).
    // Keep the root-relative read so the contract's resolved path can never break a
    // workspace whose ledger lives at the conventional root MEMORY.md.
    let memoryContent = '';
    try {
      memoryContent = await fs.promises.readFile(path.join(workspace.path, 'MEMORY.md'), 'utf8');
    } catch (err: unknown) {
      // ENOENT or any read error — fall back to the contract-resolved ledger (also nonfatal)
      if (err instanceof Error) void err.message;
      memoryContent = readContractMemory(workspace.path, routingContract);
    }

    // Fetch installed skills for this workspace (best-effort, silent on error)
    let installedSkills: Array<{ name: string; description: string | null }> = [];
    try {
      installedSkills = await query<{ name: string; description: string | null }>(
        `SELECT name, description FROM installed_skills ORDER BY name`,
        [],
      );
    } catch (err: unknown) {
      // DB error — silently skip
      if (err instanceof Error) void err.message;
    }

    // Build ordered, non-empty context blocks via the single deterministic assembler.
    const { blocks: contextBlocks } = buildQuickRunContextBlocks({
      directionContext,
      memoryContent,
      installedSkills,
    });

    const instructions = [
      '=== INSTRUCTIONS: READ THIS FIRST ===',
      'You are a spec writer. Your ONLY job is to output a single valid JSON object.',
      'Do NOT explain. Do NOT ask questions. Do NOT add markdown fences. Do NOT converse.',
      'Your ENTIRE response must be a single JSON object starting with { and ending with }.',
      'If you output anything other than raw JSON, the system will fail.',
      '=== END INSTRUCTIONS ===',
      '',
      `TASK: Generate a software specification JSON with exactly 1 user story.`,
      `Brief: ${brief}`,
      '',
      'OUTPUT FORMAT: Respond with ONLY a raw JSON object. No markdown fences. No explanation.',
      '',
      'JSON schema:',
      '{"stories":[{"id":"QR-001","title":"string","description":"string","acceptanceCriteria":["string"],"dependsOn":[]}]}',
      '',
      'Rules:',
      '- Generate exactly 1 story with id "QR-001"',
      '- Acceptance criteria should fully and unambiguously specify the story; use as many as needed for completeness, with no fixed target count.',
      '- acceptanceCriteria must be specific and testable',
      '- dependsOn must be an empty array (single story has no deps)',
      '- The description should be detailed enough for an engineer to implement',
      '- Your entire response must be valid JSON parseable by JSON.parse()',
    ].join('\n');

    const quickRunPrompt = contextBlocks.length > 0
      ? `${contextBlocks.join('\n\n')}\n\n${instructions}`
      : instructions;

    const llmResult = await chatComplete(
      [{ role: 'user', content: quickRunPrompt }],
      { model: resolvedModel, apiKey: vaultCreds.apiKey, baseUrl: vaultCreds.baseUrl },
    );
    const rawResponse = llmResult.text;

    // 8. Parse JSON
    let parsed: { stories: Array<{ id: string; title: string; description: string; acceptanceCriteria: string[]; dependsOn: string[] }> };
    try {
      const fenceMatch = rawResponse.match(/```(?:json)?\s*([\s\S]*?)```/);
      const jsonStr = fenceMatch ? fenceMatch[1].trim() : rawResponse.trim();
      const jsonStart = jsonStr.indexOf('{');
      parsed = JSON.parse(jsonStart > 0 ? jsonStr.slice(jsonStart) : jsonStr);
    } catch {
      res.status(500).json({ error: 'LLM returned non-JSON', raw: rawResponse });
      return;
    }

    if (!Array.isArray(parsed.stories) || parsed.stories.length === 0) {
      res.status(500).json({ error: 'Invalid spec structure from LLM' });
      return;
    }

    // Enforce single story only; keep all acceptance criteria returned by the model.
    const story = parsed.stories[0];

    // 9. Build slug and write spec directly to approved/
    const slug = `qr-${brief.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50)}-${Date.now()}`;
    const approvedDir = path.join(workspace.path, 'forge', 'specs', 'approved');
    fs.mkdirSync(approvedDir, { recursive: true });

    const specJson = {
      title: brief.slice(0, 120),
      generatedAt: new Date().toISOString(),
      model: resolvedModel,
      source: 'quick-run',
      userStories: [{
        id: story.id || 'QR-001',
        title: story.title,
        description: story.description,
        acceptanceCriteria: story.acceptanceCriteria || [],
        dependsOn: [],
        passes: false,
      }],
    };

    const specPath = path.join(approvedDir, `${slug}.json`);
    fs.writeFileSync(specPath, JSON.stringify(specJson, null, 2), 'utf8');
    const relativeSpecPath = `forge/specs/approved/${slug}.json`;

    // 10. Emit spec_approved WAL event with actor: 'quick-run'
    const walApproveEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, spec_id, workspace_id, payload) VALUES ('spec_approved', $1, $2, $3)` + ' RETURNING *', [slug, workspaceId, JSON.stringify({ actor: 'quick-run', brief: brief.slice(0, 200), model: resolvedModel })]);
    broadcastAll(walApproveEvent!);

    // 11. Trigger pipeline execution (same logic as /trigger)
    const runLoopSh = path.join(workspace.path, 'forge', 'run-loop.sh');
    const runLoopTs = path.join(__dirname, '..', 'lib', 'run-loop.ts');
    const hasBashRunLoop = fs.existsSync(runLoopSh);
    const hasTsRunLoop = fs.existsSync(runLoopTs);
    if (!hasBashRunLoop && !hasTsRunLoop) {
      throw new UnprocessableError(`No run-loop engine found for workspace`);
      return;
    }
    const useTypescriptRunLoop = !hasBashRunLoop && hasTsRunLoop;

    const runResult = await queryOne<{id: number}>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status, trigger_type) VALUES ($1, $2, 'running', 'quick-run') RETURNING id`, [relativeSpecPath, workspaceId]);
    const runId = normalizeWorkerRunId(runResult!.id);

    // Build clean env
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !CLAUDE_ENV_VARS_TO_REMOVE.includes(k)) {
        env[k] = v;
      }
    }
    env['RORCA_PROCESS_ROLE'] = 'engine';
    const workspaceEnvVars = getWorkspaceEnvVars(workspaceId);
    for (const [k, v] of Object.entries(workspaceEnvVars)) {
      env[k] = v;
    }

    // Inject vault API keys
    if (user?.id) {
      const anthropicVaultKey = await getVaultKey(user.id, 'anthropic');
      if (anthropicVaultKey) env['ANTHROPIC_API_KEY'] = anthropicVaultKey.key;
      const openaiVaultKey = await getVaultKey(user.id, 'openai-compat');
      if (openaiVaultKey) {
        env['OPENAI_API_KEY'] = openaiVaultKey.key;
        if (openaiVaultKey.baseUrl) env['OPENAI_BASE_URL'] = openaiVaultKey.baseUrl;
      }
      const openrouterVaultKey = await getVaultKey(user.id, 'openrouter');
      if (openrouterVaultKey) env['OPENROUTER_API_KEY'] = openrouterVaultKey.key;

    }

    // Inject agent profile
    const activeProfile = await queryOne('SELECT * FROM agent_profiles WHERE workspace_id = $1 AND is_active = true LIMIT 1', [workspaceId]) as AgentProfileRow | undefined;
    if (activeProfile) {
      if (activeProfile.system_prompt_override) env['RORCA_AGENT_SYSTEM_PROMPT'] = activeProfile.system_prompt_override;
      const tools = (Array.isArray(activeProfile.allowed_tools) ? activeProfile.allowed_tools : JSON.parse(activeProfile.allowed_tools)) as string[];
      if (tools.length > 0) env['RORCA_AGENT_ALLOWED_TOOLS'] = tools.join(',');
      if (activeProfile.model_override) env['RORCA_AGENT_MODEL_OVERRIDE'] = activeProfile.model_override;
    }

    // Spawn run-loop
    const logPath = workspaceLogPath(workspace.path, runId);
    await execute('UPDATE pipeline_runs SET log_path = $1 WHERE id = $2', [logPath, runId]);
    const logFd = fs.openSync(logPath, 'a');
    let child: ReturnType<typeof spawn>;

    if (useTypescriptRunLoop) {
      const tsxBin = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'tsx');
      const backendPort = process.env.PORT || '3030';
      child = spawn(tsxBin, [
        runLoopTs,
        '--json', specPath,
        '--cwd', workspace.path,
        '--run-id', String(runId),
        '--port', backendPort,
        '--parallelism', '1',
      ], {
        cwd: workspace.path,
        stdio: ['ignore', logFd, logFd],
        detached: true,
        env,
      });
    } else {
      const scriptInCwd = path.join(workspace.path, 'forge', 'run-loop.sh');
      child = spawn('bash', [scriptInCwd, '--json', specPath], {
        cwd: workspace.path,
        stdio: ['ignore', logFd, logFd],
        detached: true,
        env,
      });
    }
    fs.closeSync(logFd);
    child.unref();

    if (child.pid) {
      await execute(`UPDATE pipeline_runs SET pid = $1 WHERE id = $2`, [child.pid, runId]);
    }

    // Set up output buffer
    const buf: OutputBuffer = { chunks: [], done: false, subscribers: new Set() };
    outputBuffers.set(runId, buf);

    let tailPos = 0;
    const tailInterval = setInterval(() => {
      try {
        const stat = fs.statSync(logPath);
        if (stat.size > tailPos) {
          const fd = fs.openSync(logPath, 'r');
          const newBytes = Buffer.alloc(stat.size - tailPos);
          fs.readSync(fd, newBytes, 0, newBytes.length, tailPos);
          fs.closeSync(fd);
          tailPos = stat.size;
          const text = newBytes.toString('utf8');
          buf.chunks.push(text);
          buf.subscribers.forEach(cb => cb(text));
        }
      } catch { /* transient read error */ }
    }, 200);

    // Handle process exit
    child.on('exit', async (code) => {
      clearInterval(tailInterval);
      try {
        const stat = fs.statSync(logPath);
        if (stat.size > tailPos) {
          const fd = fs.openSync(logPath, 'r');
          const remaining = Buffer.alloc(stat.size - tailPos);
          fs.readSync(fd, remaining, 0, remaining.length, tailPos);
          fs.closeSync(fd);
          buf.chunks.push(remaining.toString('utf8'));
          buf.subscribers.forEach(cb => cb(remaining.toString('utf8')));
        }
      } catch { /* ignore */ }

      if (false /* pg pool always available */) {
        buf.done = true;
        buf.subscribers.clear();
        return;
      }

      const status = code === 0 ? 'done' : 'failed';
      await execute(`UPDATE pipeline_runs SET status = $1, finished_at = NOW() WHERE id = $2`, [status, runId]);

      // FR-005: Mark spec as completed when run succeeds
      if (status === 'done') markSpecCompleted(relativeSpecPath);

      // PG-021: Synthesize run-level memory (non-blocking, best-effort)
      synthesizeRunMemory(runId, workspaceId).catch(() => {});

      const postRunEnv = { ...env, RUN_STATUS: status, RUN_ID: String(runId) };
      const postRunResults = await runHooks(workspaceId, 'post_run', workspace.path, postRunEnv);
      if (postRunResults.length > 0) {
        const hookOutput = postRunResults.map(r =>
          `\r\n\x1b[36m[post_run hook: ${r.command}]\x1b[0m\r\n${r.output}` +
          (r.exitCode !== 0 ? `\r\n\x1b[31m[Hook exited with code ${r.exitCode}]\x1b[0m\r\n` : '\r\n')
        ).join('');
        buf.chunks.push(hookOutput);
        buf.subscribers.forEach(cb => cb(hookOutput));
        fs.appendFileSync(logPath, hookOutput);
      }

      const walFinishEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('run_finished', $1, $2)` + ' RETURNING *', [workspaceId, JSON.stringify({ run_id: runId, status, exit_code: code, source: 'quick-run' })]);
      broadcastAll(walFinishEvent!);

      // PR-RQ-1: Advance run queue — promote next queued run if any
      advanceQueue(workspaceId);

      buf.done = true;
      buf.subscribers.forEach(cb => cb(`\r\n\x1b[90m[Process exited with code ${code}]\x1b[0m\r\n`));
      buf.subscribers.clear();
      setTimeout(() => { outputBuffers.delete(runId); }, 30 * 60 * 1000);
    });

    res.status(202).json({ runId, specId: slug });
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Quick-run');
  }
});

// ─── POST /api/pipeline/runs — Create a pipeline run ────────────────────────

/**
 * @swagger
 * /api/pipeline/runs:
 *   post:
 *     tags: [Pipeline]
 *     summary: Create a pipeline run record
 *     operationId: createPipelineRun
 *     description: Creates a new pipeline_runs row with status 'running' and emits a run_started WAL event. Does not spawn an execution engine — use POST /api/pipeline/trigger for that.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [specPath, workspaceId]
 *             properties:
 *               specPath: { type: string, description: "Relative spec path within the workspace" }
 *               workspaceId: { type: string, description: "Workspace ID" }
 *               terminal_mode:
 *                 type: string
 *                 enum: [ansi-html, pty, native-pty]
 *                 nullable: true
 *                 default: ansi-html
 *     responses:
 *       201:
 *         description: Pipeline run created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 run: { $ref: '#/components/schemas/PipelineRun' }
 *       400: { description: "Missing required fields (specPath, workspaceId)" }
 *       500: { description: "Internal server error" }
 */
router.post('/runs', async (req: Request, res: Response) => {
  try {
    const { specPath, workspaceId, terminal_mode, terminalMode } = req.body as { specPath?: string; workspaceId?: string; terminal_mode?: string | null; terminalMode?: string | null };

    if (!specPath || !workspaceId) {
      throw new ValidationError('Missing required fields: specPath, workspaceId');
      return;
    }

    const resolvedTerminalMode = resolveRequestedTerminalMode(terminal_mode ?? terminalMode);
    assertTerminalModeAvailable(resolvedTerminalMode);

    const result = await queryOne<{id: number}>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status, terminal_mode) VALUES ($1, $2, 'running', $3) RETURNING id`, [specPath, workspaceId, resolvedTerminalMode]);

    const runId = normalizeWorkerRunId(result!.id);

    const runRow = await queryOne('SELECT * FROM pipeline_runs WHERE id = $1', [runId]) as PipelineRunRow;
    const run = normalizePipelineRun(runRow);

    // Insert WAL event and broadcast to SSE subscribers
    const walEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('run_started', $1, $2) RETURNING *`, [workspaceId, JSON.stringify({ run_id: runId, spec_path: specPath })]);

    broadcastAll(walEvent!);

    res.status(201).json({
      run,
      agentType: run.agentType,
      agentModel: run.agentModel,
      terminalMode: run.terminalMode,
      terminal_mode: run.terminalMode,
      lifecycleStatus: run.lifecycleStatus,
      lifecycle_status: run.lifecycleStatus,
      lifecyclePhase: run.lifecyclePhase,
      lifecycle_phase: run.lifecyclePhase,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Create run');
  }
});

// ─── GET /api/pipeline/runs — List pipeline runs ─────────────────────────────

/**
 * @swagger
 * /api/pipeline/runs:
 *   get:
 *     tags: [Pipeline]
 *     summary: List pipeline runs
 *     operationId: listPipelineRuns
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Run listing is read-only execution metadata that the open-source CLI and MCP tools depend on."
 *     x-rorca-public-api: true
 *     description: Returns a paginated list of pipeline runs for the specified workspace, ordered by most recent first.
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: List of runs
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 runs:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/PipelineRun' }
 */
router.get('/runs', authRequired, async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string;
    if (!workspaceId) {
      throw new ValidationError('Missing required query param: workspaceId');
      return;
    }

    const { limit, offset } = parsePaginationParams(req);
    const total = (await queryOne<{ total: number }>(
      'SELECT COUNT(*)::int as total FROM pipeline_runs WHERE workspace_id = $1',
      [workspaceId]
    ))?.total ?? 0;
    const rows = await query<PipelineRunRow>(
      'SELECT * FROM pipeline_runs WHERE workspace_id = $1 ORDER BY id DESC LIMIT $2 OFFSET $3',
      [workspaceId, limit, offset]
    );
    const items = rows.map((row) => normalizePipelineRun(row));

    res.json({ items, total, limit, offset });
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] List runs');
  }
});

// ─── GET /api/pipeline/runs/compare — Compare two pipeline runs side-by-side ─

/**
 * @swagger
 * /api/pipeline/runs/compare:
 *   get:
 *     tags: [Pipeline]
 *     summary: Compare two pipeline runs side-by-side
 *     operationId: comparePipelineRuns
 *     description: Fetches story results for two runs and produces a per-story diff showing improved, regressed, new, or removed stories along with summary statistics.
 *     parameters:
 *       - in: query
 *         name: run1
 *         required: true
 *         schema: { type: integer }
 *         description: First run ID
 *       - in: query
 *         name: run2
 *         required: true
 *         schema: { type: integer }
 *         description: Second run ID
 *     responses:
 *       200:
 *         description: Side-by-side comparison with per-story diffs and summary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 run1: { $ref: '#/components/schemas/PipelineRun' }
 *                 run2: { $ref: '#/components/schemas/PipelineRun' }
 *                 stories:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       storyId: { type: string }
 *                       run1Status: { type: string, nullable: true }
 *                       run2Status: { type: string, nullable: true }
 *                       change: { type: string, enum: [unchanged, improved, regressed, new_in_run2, removed_in_run2] }
 *                 summary:
 *                   type: object
 *                   properties:
 *                     run1PassRate: { type: integer }
 *                     run2PassRate: { type: integer }
 *                     improved: { type: integer }
 *                     regressed: { type: integer }
 *       400: { description: "Missing or invalid run1/run2 params, or comparing a run with itself" }
 *       404: { description: "One or both runs not found" }
 *       500: { description: "Internal server error" }
 */
router.get('/runs/compare', async (req: Request, res: Response) => {
  try {
    const run1Id = parseInt(String(req.query.run1), 10);
    const run2Id = parseInt(String(req.query.run2), 10);

    if (isNaN(run1Id) || isNaN(run2Id)) {
      throw new ValidationError('Missing or invalid run1/run2 query params');
      return;
    }

    if (run1Id === run2Id) {
      throw new ValidationError('Cannot compare a run with itself');
      return;
    }

    // Fetch both runs
    const run1Row = await queryOne('SELECT * FROM pipeline_runs WHERE id = $1', [run1Id]) as PipelineRunRow | undefined;
    const run2Row = await queryOne('SELECT * FROM pipeline_runs WHERE id = $1', [run2Id]) as PipelineRunRow | undefined;

    if (!run1Row) { throw new NotFoundError(`Run ${run1Id} not found`); return; }
    if (!run2Row) { throw new NotFoundError(`Run ${run2Id} not found`); return; }

    const run1 = normalizePipelineRun(run1Row);
    const run2 = normalizePipelineRun(run2Row);

    // Fetch story results for both runs (latest per story_id by highest id)
    const stories1All = await query('SELECT * FROM story_results WHERE run_id = $1 ORDER BY id ASC', [run1Id]) as StoryResultRow[];
    const stories2All = await query('SELECT * FROM story_results WHERE run_id = $1 ORDER BY id ASC', [run2Id]) as StoryResultRow[];

    // Deduplicate to latest result per story_id (retries produce multiple rows)
    const latestStory = (rows: StoryResultRow[]) => {
      const map = new Map<string, StoryResultRow>();
      for (const r of rows) map.set(r.story_id, r); // last row wins (ordered by id ASC)
      return map;
    };

    const map1 = latestStory(stories1All);
    const map2 = latestStory(stories2All);

    // Collect all story IDs from both runs
    const allStoryIds = new Set([...map1.keys(), ...map2.keys()]);

    // Build per-story comparison
    type StoryChange = 'unchanged' | 'improved' | 'regressed' | 'new_in_run2' | 'removed_in_run2';
    interface StoryComparison {
      storyId: string;
      run1Status: string | null;
      run2Status: string | null;
      run1Elapsed: number | null;
      run2Elapsed: number | null;
      run1Retries: number | null;
      run2Retries: number | null;
      run1InputTokens: number | null;
      run1OutputTokens: number | null;
      run2InputTokens: number | null;
      run2OutputTokens: number | null;
      change: StoryChange;
    }

    const stories: StoryComparison[] = [];

    for (const storyId of allStoryIds) {
      const s1 = map1.get(storyId);
      const s2 = map2.get(storyId);

      let change: StoryChange = 'unchanged';
      if (!s1 && s2) {
        change = 'new_in_run2';
      } else if (s1 && !s2) {
        change = 'removed_in_run2';
      } else if (s1 && s2 && s1.status !== s2.status) {
        // Determine if improved or regressed
        const isPass = (st: string) => st === 'pass';
        if (!isPass(s1.status) && isPass(s2.status)) {
          change = 'improved';
        } else if (isPass(s1.status) && !isPass(s2.status)) {
          change = 'regressed';
        } else {
          change = 'unchanged'; // e.g. fail→skip — neither clear improvement nor regression
        }
      }

      stories.push({
        storyId,
        run1Status: s1?.status ?? null,
        run2Status: s2?.status ?? null,
        run1Elapsed: s1?.elapsed_seconds ?? null,
        run2Elapsed: s2?.elapsed_seconds ?? null,
        run1Retries: s1?.retries ?? null,
        run2Retries: s2?.retries ?? null,
        run1InputTokens: s1?.input_tokens ?? null,
        run1OutputTokens: s1?.output_tokens ?? null,
        run2InputTokens: s2?.input_tokens ?? null,
        run2OutputTokens: s2?.output_tokens ?? null,
        change,
      });
    }

    // Sort: changes first, then alphabetical
    const changePriority: Record<StoryChange, number> = {
      regressed: 0, improved: 1, new_in_run2: 2, removed_in_run2: 3, unchanged: 4,
    };
    stories.sort((a, b) =>
      changePriority[a.change] !== changePriority[b.change]
        ? changePriority[a.change] - changePriority[b.change]
        : a.storyId.localeCompare(b.storyId)
    );

    // Compute summary stats
    const passCount = (map: Map<string, StoryResultRow>) =>
      Array.from(map.values()).filter(s => s.status === 'pass').length;
    const totalElapsed = (map: Map<string, StoryResultRow>) =>
      Array.from(map.values()).reduce((sum, s) => sum + (s.elapsed_seconds ?? 0), 0);

    const run1PassCount = passCount(map1);
    const run2PassCount = passCount(map2);
    const run1Total = map1.size;
    const run2Total = map2.size;

    const summary = {
      run1PassRate: run1Total > 0 ? Math.round((run1PassCount / run1Total) * 100) : 0,
      run2PassRate: run2Total > 0 ? Math.round((run2PassCount / run2Total) * 100) : 0,
      passRateDelta: (run2Total > 0 ? (run2PassCount / run2Total) : 0) - (run1Total > 0 ? (run1PassCount / run1Total) : 0),
      run1TotalElapsed: totalElapsed(map1),
      run2TotalElapsed: totalElapsed(map2),
      elapsedDelta: totalElapsed(map2) - totalElapsed(map1),
      run1StoryCount: run1Total,
      run2StoryCount: run2Total,
      improved: stories.filter(s => s.change === 'improved').length,
      regressed: stories.filter(s => s.change === 'regressed').length,
      newStories: stories.filter(s => s.change === 'new_in_run2').length,
      removedStories: stories.filter(s => s.change === 'removed_in_run2').length,
    };

    res.json({ run1, run2, stories, summary });
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Compare runs');
  }
});

// ─── GET /api/pipeline/runs/:runId — Get run detail + story results ──────────

/**
 * @swagger
 * /api/pipeline/runs/{runId}:
 *   get:
 *     tags: [Pipeline]
 *     summary: Get a pipeline run with story results
 *     operationId: getPipelineRun
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Detailed run state is core read-only execution data for CLI reattachment, monitoring, and MCP usage."
 *     x-rorca-public-api: true
 *     description: Retrieves a single pipeline run by ID along with all its story results and spec metadata.
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Run details with story results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 run: { $ref: '#/components/schemas/PipelineRun' }
 *                 stories:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/StoryResult' }
 *                 terminal_mode:
 *                   type: string
 *                   enum: [ansi-html, pty, native-pty]
 *                   description: "Normalized run terminal renderer mode. Missing/null historical values resolve to ansi-html."
 *                 worktreePath: { type: string, nullable: true, description: "Worktree path (if run uses worktree isolation)" }
 *                 branchName: { type: string, nullable: true, description: "Git branch name (if run uses worktree isolation)" }
 *       404: { description: "Run not found" }
 */
router.get('/runs/:runId', async (req: Request, res: Response) => {
  try {
    const runId = parseInt(String(req.params.runId), 10);
    if (isNaN(runId)) {
      throw new ValidationError('Invalid runId');
      return;
    }

    const runRow = await queryOne('SELECT * FROM pipeline_runs WHERE id = $1', [runId]) as PipelineRunRow | undefined;

    if (!runRow) {
      throw new NotFoundError('Run not found');
      return;
    }
    const run = normalizePipelineRun(runRow);

    const stories = await query('SELECT * FROM story_results WHERE run_id = $1 ORDER BY id ASC', [runId]) as StoryResultRow[];

    // Read spec JSON to return full userStories list (including pending ones)
    // OC-029: Include per-story engine assignment in response
    const normalizedRunAgent = normalizeRunAgentType(run.agent_type);
    const runAgentType: AgentType | null = normalizedRunAgent === 'unknown' ? null : normalizedRunAgent;
    let specStories: { id: string; title: string; dependsOn?: string[]; passes?: boolean; excluded?: boolean; agent?: string; reroute?: { fromEngine: string; toEngine: string; reason: string } }[] = [];
    let specModel: string | null = null;
    try {
      const workspace = await queryOne('SELECT path FROM workspaces WHERE id = $1', [run.workspace_id]) as { path: string } | undefined;
      if (workspace) {
        const absSpecPath = path.join(workspace.path, run.spec_path);
        if (fs.existsSync(absSpecPath)) {
          const specJson = JSON.parse(fs.readFileSync(absSpecPath, 'utf-8'));
          specModel = specJson.model || null;
          if (Array.isArray(specJson.userStories)) {
            specStories = specJson.userStories.map((s: any) => {
              const storyAgent = runAgentType ? resolveStoryAgent(s, runAgentType) : null;
              const reroute = reroutedStories.get(s.id);
              return {
                id: s.id,
                title: s.title,
                dependsOn: s.dependsOn,
                passes: s.passes,
                excluded: s.excluded,
                agent: storyAgent,
                suggestedSkills: Array.isArray(s.suggestedSkills) ? s.suggestedSkills : [],
                ...(reroute ? { reroute: { fromEngine: reroute.fromEngine, toEngine: reroute.toEngine, reason: reroute.reason } } : {}),
              };
            });
          }
        }
      }
    } catch {
      // Spec file missing or malformed — specStories stays empty
    }

    // OC-029: Enrich specStories with reroute data from WAL events (for historical runs)
    if (specStories.length > 0) {
      try {
        const rerouteEvents = await query<{ story_id: string; payload: string }>(`SELECT story_id, payload FROM wal_events WHERE event_type = 'story_rerouted' AND (payload->>'run_id')::bigint = $1 ORDER BY id ASC`, [runId]);
        for (const evt of rerouteEvents) {
          const story = specStories.find(s => s.id === evt.story_id);
          if (story && !story.reroute) {
            try {
              const p = JSON.parse(evt.payload);
              story.reroute = { fromEngine: p.fromEngine, toEngine: p.toEngine, reason: p.reason };
            } catch { /* malformed payload */ }
          }
        }
      } catch { /* WAL query error — non-fatal */ }
    }

    // Aggregate token counts and cost from story_results
    const tokenRow = await queryOne(`SELECT SUM(input_tokens) AS total_input,
              SUM(output_tokens) AS total_output,
              SUM(cost_usd) AS total_cost
       FROM story_results WHERE run_id = $1`, [runId]) as { total_input: number | null; total_output: number | null; total_cost: number | null } | undefined;

    const nullableNumber = (value: unknown): number | null => {
      if (value === null || value === undefined) return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const tokenSummary = {
      inputTokens: nullableNumber(tokenRow?.total_input),
      outputTokens: nullableNumber(tokenRow?.total_output),
      totalCostUsd: nullableNumber(tokenRow?.total_cost),
    };

    // Null means the transport never reported this telemetry. Do not turn an
    // unknown PTY count/cost into a fabricated zero in the public DTO.
    const storyTokenBreakdown = stories.map((s) => ({
      storyId: s.story_id,
      status: s.status,
      inputTokens: s.input_tokens,
      outputTokens: s.output_tokens,
      modelUsed: s.model_used ?? null,
      costUsd: s.cost_usd,
    }));

    // CIE-007: Read run-state.json for real-time story progress fallback
    let runState: RunState | null = null;
    try {
      const workspace = await queryOne('SELECT path FROM workspaces WHERE id = $1', [run.workspace_id]) as { path: string } | undefined;
      if (workspace) {
        // Isolated runs write live state inside their worktree, not the dirty/main
        // workspace. Reading only workspace.path makes active worktree runs appear
        // stuck at 0/N even while stories complete.
        runState = readRunState(run.worktree_path || workspace.path);
        // Only include if it belongs to this run
        if (runState && runState.runId !== runId) runState = null;
      }
    } catch { /* non-fatal */ }

    // CIE-016: Build actual vs predicted context comparison.
    // Predicted context comes from pipeline_runs.context_preview when a preview was
    // generated. Actual context comes from story_started WAL events and must be
    // exposed even for continuation/historical runs that do not have a preview.
    let contextComparison: {
      predicted: Record<string, { totalTokens: number; injectedFiles: string[] }>;
      actual: Record<string, { contextFiles: string[] }>;
    } | null = null;

    const predictedMap: Record<string, { totalTokens: number; injectedFiles: string[] }> = {};
    const predictedRaw = (run as any).context_preview;
    if (predictedRaw) {
      try {
        const predicted = typeof predictedRaw === 'string' ? JSON.parse(predictedRaw) : predictedRaw;
        for (const s of (predicted.stories ?? [])) {
          predictedMap[s.storyId] = { totalTokens: s.totalTokens, injectedFiles: s.injectedFiles };
        }
      } catch { /* malformed context_preview */ }
    }

    const actualMap: Record<string, { contextFiles: string[] }> = {};
    try {
      const walRows = await query<{ story_id: string; payload: string | Record<string, any> }>(`SELECT story_id, payload FROM wal_events WHERE event_type = 'story_started' AND (payload->>'run_id')::bigint = $1 ORDER BY id ASC`, [runId]);
      for (const row of walRows) {
        try {
          const p = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
          if (Array.isArray(p?.context_files)) {
            actualMap[row.story_id] = { contextFiles: p.context_files };
          }
        } catch { /* skip malformed payload */ }
      }
    } catch { /* non-fatal */ }

    if (Object.keys(predictedMap).length > 0 || Object.keys(actualMap).length > 0) {
      contextComparison = { predicted: predictedMap, actual: actualMap };
    }

    const manifestSource = buildManifestSourceFromRun(run as PipelineRunRow);

    res.json({
      run,
      stories,
      specStories,
      specModel,
      agentType: run.agentType,
      agentModel: run.agentModel,
      terminalMode: run.terminalMode,
      terminal_mode: run.terminalMode,
      lifecycleStatus: run.lifecycleStatus,
      lifecycle_status: run.lifecycleStatus,
      lifecyclePhase: run.lifecyclePhase,
      lifecycle_phase: run.lifecyclePhase,
      effectiveOptions: run.effective_options ?? null,
      // US-004: Expose worktree fields at top level for easy frontend access
      worktreePath: run.worktree_path || null,
      branchName: run.branch_name || null,
      includeGraph: run.include_graph ?? false,
      tokenSummary,
      storyTokenBreakdown,
      runState,
      contextComparison,
      ...(manifestSource ? { manifestSource } : {}),
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Get run');
  }
});

/**
 * @swagger
 * /api/pipeline/runs/{runId}/liveness:
 *   get:
 *     tags: [Pipeline]
 *     summary: Classify a run from bounded runtime evidence
 *     operationId: getPipelineRunLiveness
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only, run-scoped lifecycle evidence helps local CLI and MCP operators choose a safe recovery action."
 *     x-rorca-public-api: true
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: storyId
 *         schema: { type: string }
 *         description: Optionally limit story and completion evidence to one story.
 *     responses:
 *       200: { description: Bounded liveness classification and next safe action }
 *       404: { description: Run not found }
 */
router.get('/runs/:runId/liveness', async (req: Request, res: Response) => {
  try {
    const runId = Number(req.params.runId);
    if (!Number.isSafeInteger(runId) || runId <= 0) throw new ValidationError('Invalid runId');
    const storyId = typeof req.query.storyId === 'string' && req.query.storyId.trim()
      ? req.query.storyId.trim().slice(0, 200)
      : undefined;
    const classification = await classifyRunLiveness(runId, { storyId });
    if (!classification) throw new NotFoundError('Run not found');
    res.json(classification);
  } catch (error: unknown) {
    handleRouteError(res, error, '[Pipeline] Get run liveness');
  }
});

async function listContextTraceRoots(
  runId: number,
  workspacePath: string,
  runWorktreePath: string | null | undefined,
): Promise<string[]> {
  const storyWorktreeRows = await query<{ worktree_path: string | null }>(
    `SELECT DISTINCT worktree_path
       FROM story_results
      WHERE run_id = $1
        AND worktree_path IS NOT NULL`,
    [runId],
  );

  return Array.from(new Set([
    workspacePath,
    runWorktreePath ?? null,
    ...storyWorktreeRows.map((row) => row.worktree_path),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)));
}

// ─── GET /api/pipeline/runs/:runId/context-inspector-events — Metadata backfill
// Returns historical context_trace WAL metadata when present. For older or
// continuation runs that did not emit CTM artifacts, reconstructs trace-like
// metadata from story_started WAL payloads and story token rows so the Context
// tab can still explain CAG/RAG/KG/prompt context channels.
router.get('/runs/:runId/context-inspector-events', async (req: Request, res: Response) => {
  try {
    const runId = parseInt(String(req.params.runId), 10);
    if (isNaN(runId)) throw new ValidationError('Invalid runId');

    const run = await queryOne('SELECT * FROM pipeline_runs WHERE id = $1', [runId]) as PipelineRunRow | undefined;
    if (!run) throw new NotFoundError('Run not found');

    const traceRows = await query<{ id: number; payload: string | Record<string, any> }>(
      `SELECT id, payload FROM wal_events
       WHERE event_type = 'context_trace' AND (payload->>'run_id')::bigint = $1
       ORDER BY id ASC`,
      [runId],
    );

    const events: Array<Record<string, any>> = [];
    for (const row of traceRows) {
      try {
        const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
        if (payload && typeof payload === 'object' && payload.rawRef) events.push(payload);
      } catch { /* skip malformed trace payload */ }
    }

    if (events.length > 0) {
      const workspace = await queryOne('SELECT path FROM workspaces WHERE id = $1', [run.workspace_id]) as { path: string } | undefined;
      if (workspace) {
        const traceRoots = await listContextTraceRoots(runId, workspace.path, run.worktree_path);
        const artifactExists = traceRoots.some((traceRoot) => fs.existsSync(getTraceArtifactPath(traceRoot, runId)));

        // Retroactive fallback: older runs may still have context_trace metadata
        // but have lost their raw artifact (for example, trace blobs written into
        // a cleaned-up worktree before the stable workspace-root fix). In that
        // case, enrich retrieval rows with retrievalTelemetryId from story_started
        // so the UI can open the structured retrieval drawer instead of a dead
        // raw-payload lookup.
        if (!artifactExists) {
          const storyTelemetryRows = await query<{ story_id: string | null; payload: string | Record<string, any> }>(
            `SELECT story_id, payload FROM wal_events
             WHERE event_type = 'story_started' AND (payload->>'run_id')::bigint = $1
             ORDER BY id DESC`,
            [runId],
          );
          const telemetryIdByStory = new Map<string, string>();
          for (const row of storyTelemetryRows) {
            if (!row.story_id || telemetryIdByStory.has(row.story_id)) continue;
            try {
              const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
              const telemetryId = payload && typeof payload === 'object' && typeof payload.retrieval_telemetry_id === 'string'
                ? payload.retrieval_telemetry_id
                : null;
              if (telemetryId) telemetryIdByStory.set(row.story_id, telemetryId);
            } catch { /* skip malformed payload */ }
          }

          for (const event of events) {
            event.synthetic = true;
            event.detailSource = 'artifact-metadata-fallback';
            if (!Array.isArray(event.details)) {
              event.details = [];
            }
            if (!event.details.some((detail: unknown) => typeof detail === 'string' && detail.toLowerCase().includes('metadata only'))) {
              event.details.unshift('Raw trace artifact missing for this historical run — showing metadata only.');
            }
            if (event.phase === 'prompt' && typeof event.metrics?.bytes === 'number') {
              const promptBytesDetail = `prompt bytes: ${event.metrics.bytes}`;
              if (!event.details.some((detail: unknown) => typeof detail === 'string' && detail.trim().toLowerCase() === promptBytesDetail.toLowerCase())) {
                event.details.push(promptBytesDetail);
              }
            }

            if (event.retrievalTelemetryId) continue;
            if (event.phase !== 'memory') continue;
            if (typeof event.storyId !== 'string' || event.storyId.length === 0) continue;
            const telemetryId = telemetryIdByStory.get(event.storyId);
            if (!telemetryId) continue;
            event.retrievalTelemetryId = telemetryId;
            event.detailSource = 'retrieval-telemetry-fallback';
            if (!event.details.some((detail: unknown) => typeof detail === 'string' && detail.trim().toLowerCase() === `telemetry: ${telemetryId}`.toLowerCase())) {
              event.details.unshift(`telemetry: ${telemetryId}`);
            }
          }
        }
      }

      res.json({ events, reconstructed: false });
      return;
    }

    const storyRows = await query<{ id: number; ts: string | Date; story_id: string | null; payload: string | Record<string, any> }>(
      `SELECT id, ts, story_id, payload FROM wal_events
       WHERE event_type = 'story_started' AND (payload->>'run_id')::bigint = $1
       ORDER BY id ASC`,
      [runId],
    );
    const tokenRows = await query<{ story_id: string; input_tokens: number | null; output_tokens: number | null }>(
      `SELECT story_id, input_tokens, output_tokens FROM story_results WHERE run_id = $1 ORDER BY id ASC`,
      [runId],
    );
    const tokenByStory = new Map(tokenRows.map((row) => [row.story_id, row]));

    let seq = 0;
    const makeEvent = (phase: string, status: 'ok' | 'partial' | 'error' | 'start', label: string, opts: {
      storyId?: string | null;
      ts?: string;
      metrics?: Record<string, number>;
      details?: string[];
      retrievalTelemetryId?: string;
    } = {}) => {
      const event: Record<string, any> = {
        traceId: `reconstructed:${runId}:${phase}`,
        runId,
        storyId: opts.storyId ?? null,
        seq,
        rawRef: `synthetic:${runId}:${seq}`,
        phase,
        status,
        ts: opts.ts ?? new Date().toISOString(),
        metrics: opts.metrics,
        label,
        synthetic: true,
        details: opts.details ?? [],
      };
      if (opts.retrievalTelemetryId) {
        event.retrievalTelemetryId = opts.retrievalTelemetryId;
      }
      seq += 1;
      events.push(event);
    };

    const seenStories = new Set<string>();
    for (const row of storyRows) {
      const storyId = row.story_id;
      if (!storyId) continue;
      seenStories.add(storyId);
      let payload: Record<string, any> = {};
      try { payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload; } catch { /* keep empty */ }
      const ts = row.ts instanceof Date ? row.ts.toISOString() : String(row.ts);

      makeEvent('context', 'ok', `spec/cag:${storyId}`, {
        storyId,
        ts,
        details: ['Story title, description, acceptance criteria, dependencies, and execution packet were prompt context.'],
      });

      const contextFiles = Array.isArray(payload.context_files)
        ? payload.context_files.filter((value: unknown): value is string => typeof value === 'string')
        : [];
      if (contextFiles.length > 0) {
        makeEvent('context', 'ok', `routed-files:${storyId}`, {
          storyId,
          ts,
          metrics: { fileCount: contextFiles.length },
          details: contextFiles,
        });
      }

      const selectedCount = typeof payload.retrieval_selected_count === 'number' ? payload.retrieval_selected_count : null;
      const telemetryId = typeof payload.retrieval_telemetry_id === 'string' ? payload.retrieval_telemetry_id : null;
      const needsMoreEvidence = payload.retrieval_needs_more_evidence === true;
      const matchedSkills = Array.isArray(payload.retrieval_matched_skills)
        ? payload.retrieval_matched_skills.filter((value: unknown): value is string => typeof value === 'string')
        : [];
      if (selectedCount != null || telemetryId || needsMoreEvidence || matchedSkills.length > 0) {
        makeEvent('memory', needsMoreEvidence ? 'partial' : 'ok', `retrieval:${storyId}`, {
          storyId,
          ts,
          metrics: selectedCount != null ? { fileCount: selectedCount } : undefined,
          details: [
            ...(telemetryId ? [`telemetry: ${telemetryId}`] : []),
            ...(selectedCount != null ? [`selected: ${selectedCount}`] : []),
            ...(needsMoreEvidence ? ['needs more evidence'] : []),
            ...(matchedSkills.length > 0 ? [`matched skills: ${matchedSkills.join(', ')}`] : []),
          ],
          retrievalTelemetryId: telemetryId ?? undefined,
        });
      }

      const graphHits = typeof payload.graph_hits === 'number' ? payload.graph_hits : null;
      if (run.include_graph) {
        makeEvent('graph', graphHits && graphHits > 0 ? 'ok' : 'partial', `graph:${storyId}`, {
          storyId,
          ts,
          metrics: graphHits != null ? { fileCount: graphHits } : undefined,
          details: ['Graph context enabled for run.', `hits: ${graphHits ?? 0}`],
        });
      }

      const tokens = tokenByStory.get(storyId);
      const input = Number(tokens?.input_tokens ?? 0);
      const output = Number(tokens?.output_tokens ?? 0);
      if (input > 0 || output > 0) {
        makeEvent('prompt', 'ok', `prompt:${storyId}`, {
          storyId,
          ts,
          metrics: { tokens: input + output },
          details: [`input tokens: ${input}`, `output tokens: ${output}`],
        });
      }
    }

    for (const row of tokenRows) {
      if (seenStories.has(row.story_id)) continue;
      const input = Number(row.input_tokens ?? 0);
      const output = Number(row.output_tokens ?? 0);
      if (input > 0 || output > 0) {
        makeEvent('prompt', 'ok', `prompt:${row.story_id}`, {
          storyId: row.story_id,
          metrics: { tokens: input + output },
          details: [`input tokens: ${input}`, `output tokens: ${output}`],
        });
      }
    }

    if (!run.include_graph && storyRows.length > 0) {
      makeEvent('graph', 'partial', 'graph:disabled', {
        details: ['Knowledge graph context was not enabled for this run.'],
      });
    }

    res.json({ events, reconstructed: events.length > 0 });
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] List context traces');
  }
});

// ─── GET /api/pipeline/runs/:runId/context-trace/:rawRef — Lazy raw payload ───
// CTM-002: context-trace metadata streams over SSE without the heavy payload.
// The browser calls this endpoint only when a user opens a detail view, so the
// raw blob is read from the run's on-disk artifact on demand. Run-scoped:
// the rawRef's embedded runId must match the path runId.

/**
 * @swagger
 * /api/pipeline/runs/{runId}/context-trace/{rawRef}:
 *   get:
 *     tags: [Pipeline]
 *     summary: Resolve a context-trace raw payload by rawRef
 *     operationId: getContextTraceRaw
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only context-trace inspection of local run artifacts — no write or operator-only side effects, safe for CLI/MCP."
 *     x-rorca-public-api: true
 *     description: |
 *       Lazily resolves the full raw payload for a single context-trace event,
 *       referenced by its deterministic rawRef (r{runId}:{seq}). Metadata-only
 *       events are streamed over SSE; this endpoint returns the heavy payload
 *       kept off the hot path in the run's append-only artifact.
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: rawRef
 *         required: true
 *         schema: { type: string }
 *         description: "Deterministic raw payload pointer, e.g. r42:7"
 *     responses:
 *       200:
 *         description: Raw payload record
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 rawRef: { type: string }
 *                 runId: { type: integer }
 *                 seq: { type: integer }
 *                 phase: { type: string }
 *                 ts: { type: string }
 *                 payload: {}
 *       400: { description: "Malformed rawRef" }
 *       404: { description: "Run or raw payload not found" }
 *       422: { description: "Artifact present but payload unrecoverable (corrupt)" }
 */
router.get('/runs/:runId/context-trace/:rawRef', async (req: Request, res: Response) => {
  try {
    const runId = parseInt(String(req.params.runId), 10);
    if (isNaN(runId)) {
      throw new ValidationError('Invalid runId');
    }

    const rawRef = String(req.params.rawRef);
    const parsed = parseRawRef(rawRef);
    if (!parsed) {
      throw new ValidationError('Malformed rawRef');
    }

    // Run-scoped validation: a rawRef encodes its own runId; it must match the
    // path runId so a trace cannot be read across run boundaries.
    if (parsed.runId !== runId) {
      throw new ValidationError('rawRef does not belong to this run');
    }

    const runRow = await queryOne('SELECT workspace_id, worktree_path FROM pipeline_runs WHERE id = $1', [runId]) as { workspace_id: string; worktree_path: string | null } | undefined;
    if (!runRow) {
      throw new NotFoundError('Run not found');
    }

    const workspace = await queryOne('SELECT path FROM workspaces WHERE id = $1', [runRow.workspace_id]) as { path: string } | undefined;
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
    }

    const traceRoots = await listContextTraceRoots(runId, workspace.path, runRow.worktree_path);

    for (const traceRoot of traceRoots) {
      const record = lookupTraceRecord(traceRoot, rawRef);
      if (record) {
        res.json(record);
        return;
      }
    }

    // No record. Distinguish a genuinely-absent trace from a corrupt artifact:
    // if any candidate artifact file exists but yields no record for an
    // otherwise valid in-run rawRef, the artifact is unreadable/corrupt or was
    // partially pruned — return 422 instead of a misleading 404.
    const artifactExists = traceRoots.some((traceRoot) => fs.existsSync(getTraceArtifactPath(traceRoot, runId)));
    if (artifactExists) {
      throw new UnprocessableError('Context-trace artifact present but payload could not be recovered (corrupt or pruned)');
    }

    throw new NotFoundError('Context-trace payload not found');
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Get context-trace raw');
  }
});

// ─── GET /api/pipeline/runs/:runId/retrieval-telemetry/:telemetryId — Resolve retrieval details
// Resolves retrieval_telemetry_id into full selected and dropped candidate details.
// Run-scoped: telemetryId must belong to a story in the specified run.

/**
 * @swagger
 * /api/pipeline/runs/{runId}/retrieval-telemetry/{telemetryId}:
 *   get:
 *     tags: [Pipeline]
 *     summary: Resolve retrieval telemetry details for a specific telemetry event
 *     operationId: getRunRetrievalTelemetry
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only retrieval telemetry inspection of local run artifacts — no write or operator-only side effects, safe for CLI/MCP."
 *     x-rorca-public-api: true
 *     description: |
 *       Resolves a retrieval_telemetry_id into full selected and dropped candidate details.
 *       Validates that the telemetry event belongs to a story within the specified run.
 *       Returns normalized candidate objects with memory/context identifier, title/source,
 *       category/type, snippet/summary, selection status, relevance scores, and reasons.
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: telemetryId
 *         required: true
 *         schema: { type: string }
 *         description: "Retrieval telemetry event ID from retrieval_telemetry_events table"
 *     responses:
 *       200:
 *         description: Retrieval telemetry details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 telemetryId: { type: string }
 *                 runId: { type: integer }
 *                 storyId: { type: string }
 *                 query: { type: string }
 *                 selectedCandidates: { type: array }
 *                 droppedCandidates: { type: array }
 *                 candidateCount: { type: integer }
 *                 selectedCount: { type: integer }
 *                 matchedSkills: { type: array }
 *                 retrievalTier: { type: string }
 *                 latencyMs: { type: integer }
 *                 needsMoreEvidence: { type: boolean }
 *                 tokenBudget: { type: integer }
 *                 contradictions: { type: array, items: { type: array, items: { type: string } } }
 *                 rawSummary: { type: string }
 *       400: { description: "Invalid runId or telemetryId" }
 *       404: { description: "Run not found or telemetry event not found or doesn't belong to this run" }
 */
router.get('/runs/:runId/retrieval-telemetry/:telemetryId', async (req: Request, res: Response) => {
  try {
    const runId = parseInt(String(req.params.runId), 10);
    if (isNaN(runId)) {
      throw new ValidationError('Invalid runId');
    }

    const telemetryId = String(req.params.telemetryId);
    if (!telemetryId || telemetryId.trim().length === 0) {
      throw new ValidationError('Invalid telemetryId');
    }

    // Verify run exists
    const run = await queryOne(
      'SELECT id, workspace_id, spec_path, worktree_path FROM pipeline_runs WHERE id = $1',
      [runId]
    ) as { id: number; workspace_id: string; spec_path: string; worktree_path: string | null } | undefined;
    if (!run) {
      throw new NotFoundError('Run not found');
    }

    // Fetch telemetry event from database
    const telemetryRow = await queryOne(
      `SELECT
         id,
         workspace_id,
         query_preview,
         matched_skills,
         selected_candidate_keys,
         dropped_candidate_keys,
         needs_more_evidence,
         candidate_count,
         selected_count,
         token_budget,
         contradiction_pairs,
         payload,
         latency_ms,
         retrieval_tier,
         created_at
       FROM retrieval_telemetry_events
       WHERE id = $1`,
      [telemetryId]
    ) as any;

    if (!telemetryRow) {
      throw new NotFoundError('Retrieval telemetry event not found');
    }

    // Verify telemetry event belongs to a story in this run by checking story_started WAL events
    const storyWithTelemetry = await queryOne(
      `SELECT story_id
       FROM wal_events
       WHERE event_type = 'story_started'
         AND (payload->>'run_id')::bigint = $1
         AND payload->>'retrieval_telemetry_id' = $2
       LIMIT 1`,
      [runId, telemetryId]
    ) as { story_id: string } | undefined;

    if (!storyWithTelemetry) {
      throw new NotFoundError('Retrieval telemetry event does not belong to this run');
    }

    // Parse payload to extract candidates
    const payload = telemetryRow.payload && typeof telemetryRow.payload === 'object'
      ? telemetryRow.payload as Record<string, any>
      : {};

    const candidatesRaw = Array.isArray(payload.candidates) ? payload.candidates : [];

    // Normalize candidates
    interface NormalizedCandidate {
      key: string;
      origin: string;
      sourceType?: string;
      title?: string;
      snippet?: string;
      category?: string;
      confidence?: string | null;
      source?: string | null;
      sourceStoryId?: string | null;
      sourceSpecId?: string | null;
      sourceRunId?: number | null;
      relatedFiles?: string[];
      canonicalKey?: string;
      pinned?: boolean;
      createdAt?: string | null;
      updatedAt?: string | null;
      decision?: 'keep' | 'drop' | 'needs-more' | 'conflict';
      conflictsWith?: string[];
      supersededBy?: string;
      selected: boolean;
      enteredPrompt?: boolean;
      relevanceScore: number;
      scoreBreakdown: {
        semantic?: number;
        keyword?: number;
        graph?: number;
        recency?: number;
        skill?: number;
      };
      matchedSkills?: string[];
      keptOrDroppedReason: string;
    }

    const selectedKeys = new Set(
      Array.isArray(telemetryRow.selected_candidate_keys)
        ? telemetryRow.selected_candidate_keys
        : []
    );

    const normalizeStringArray = (value: unknown): string[] => Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string')
      : [];

    const deriveMemoryTitle = (candidate: Record<string, any>): string | undefined => {
      if (typeof candidate.title === 'string' && candidate.title.trim().length > 0) {
        return candidate.title.trim();
      }
      const text = typeof candidate.snippet === 'string'
        ? candidate.snippet
        : typeof candidate.text === 'string'
          ? candidate.text
          : '';
      const [title] = text.split(':', 1);
      if (title.trim().length >= 4 && title.trim().length <= 120) return title.trim();
      return undefined;
    };

    const deriveMemorySnippet = (candidate: Record<string, any>): string | undefined => {
      if (typeof candidate.snippet === 'string' && candidate.snippet.trim().length > 0) {
        return candidate.snippet.trim();
      }
      if (typeof candidate.text === 'string' && candidate.text.trim().length > 0) {
        return candidate.text.trim();
      }
      return undefined;
    };

    interface ContextReceipt {
      specPath: string | null;
      specId: string | null;
      specTitle: string | null;
      storyId: string;
      storyTitle: string | null;
      storyDescription: string | null;
      acceptanceCriteria: string[];
      retrievalQuery: string;
      promptRawRef: string | null;
      promptExcerpt: string | null;
      promptBytes: number | null;
      promptUnavailableReason: string | null;
      receiptSteps: string[];
    }

    const excerptText = (text: string, max = 1800): string => {
      const compact = text.replace(/\r\n/g, '\n').trim();
      if (compact.length <= max) return compact;
      return `${compact.slice(0, max).trimEnd()}…`;
    };

    const normalizeStoryCriteria = (value: unknown): string[] => Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string')
      : [];

    const resolveStoryFromSpec = async (storyId: string): Promise<Pick<ContextReceipt, 'specPath' | 'specId' | 'specTitle' | 'storyTitle' | 'storyDescription' | 'acceptanceCriteria'>> => {
      const fallback = {
        specPath: run.spec_path ?? null,
        specId: run.spec_path ? path.basename(run.spec_path, '.json') : null,
        specTitle: null,
        storyTitle: null,
        storyDescription: null,
        acceptanceCriteria: [],
      };

      try {
        const workspace = await queryOne('SELECT path FROM workspaces WHERE id = $1', [run.workspace_id]) as { path: string } | undefined;
        const roots = [run.worktree_path, workspace?.path].filter((value): value is string => Boolean(value));
        for (const root of roots) {
          const specPath = path.join(root, run.spec_path);
          if (!fs.existsSync(specPath)) continue;
          const spec = JSON.parse(fs.readFileSync(specPath, 'utf8')) as Record<string, any>;
          const stories = Array.isArray(spec.userStories)
            ? spec.userStories
            : Array.isArray(spec.stories)
              ? spec.stories
              : [];
          const story = stories.find((entry: any) => entry && String(entry.id) === storyId) as Record<string, any> | undefined;
          return {
            specPath: run.spec_path ?? null,
            specId: typeof spec.id === 'string' ? spec.id : fallback.specId,
            specTitle: typeof spec.title === 'string' ? spec.title : typeof spec.specName === 'string' ? spec.specName : null,
            storyTitle: typeof story?.title === 'string' ? story.title : null,
            storyDescription: typeof story?.description === 'string' ? story.description : null,
            acceptanceCriteria: normalizeStoryCriteria(story?.acceptanceCriteria),
          };
        }
      } catch {
        // Receipt metadata is best-effort; retrieval detail should still render.
      }
      return fallback;
    };

    const resolvePromptReceipt = async (storyId: string): Promise<Pick<ContextReceipt, 'promptRawRef' | 'promptExcerpt' | 'promptBytes' | 'promptUnavailableReason'>> => {
      try {
        const promptRows = await query<{ payload: string | Record<string, any> }>(
          `SELECT payload FROM wal_events
           WHERE event_type = 'context_trace'
             AND (payload->>'run_id')::bigint = $1
             AND payload->>'phase' = 'prompt'
             AND payload->>'storyId' = $2
           ORDER BY id DESC
           LIMIT 5`,
          [runId, storyId],
        );
        const workspace = await queryOne('SELECT path FROM workspaces WHERE id = $1', [run.workspace_id]) as { path: string } | undefined;
        const traceRoots = workspace ? await listContextTraceRoots(runId, workspace.path, run.worktree_path) : [];

        for (const row of promptRows) {
          const event = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
          const rawRef = event && typeof event.rawRef === 'string' ? event.rawRef : null;
          if (!rawRef) continue;
          for (const traceRoot of traceRoots) {
            const record = lookupTraceRecord(traceRoot, rawRef);
            const prompt = record?.payload && typeof record.payload === 'object' && typeof (record.payload as Record<string, unknown>).prompt === 'string'
              ? (record.payload as Record<string, string>).prompt
              : null;
            if (prompt) {
              return {
                promptRawRef: rawRef,
                promptExcerpt: excerptText(prompt),
                promptBytes: Buffer.byteLength(prompt),
                promptUnavailableReason: null,
              };
            }
          }
          return {
            promptRawRef: rawRef,
            promptExcerpt: null,
            promptBytes: typeof event.metrics?.bytes === 'number' ? event.metrics.bytes : null,
            promptUnavailableReason: 'Prompt trace metadata exists, but the raw prompt artifact is unavailable for this run.',
          };
        }
      } catch {
        // Prompt receipt is best-effort.
      }
      return {
        promptRawRef: null,
        promptExcerpt: null,
        promptBytes: null,
        promptUnavailableReason: 'No prompt trace was recorded for this story, likely because the run predates context tracing.',
      };
    };

    const selectedCandidates: NormalizedCandidate[] = [];
    const droppedCandidates: NormalizedCandidate[] = [];

    for (const candidate of candidatesRaw) {
      if (!candidate || typeof candidate !== 'object') continue;
      if (typeof candidate.key !== 'string' || typeof candidate.origin !== 'string') continue;

      const isSelected = selectedKeys.has(candidate.key) || candidate.decision === 'keep';

      const normalized: NormalizedCandidate = {
        key: candidate.key,
        origin: candidate.origin,
        sourceType: typeof candidate.sourceType === 'string' ? candidate.sourceType : undefined,
        title: deriveMemoryTitle(candidate),
        snippet: deriveMemorySnippet(candidate),
        category: typeof candidate.category === 'string' ? candidate.category : undefined,
        confidence: typeof candidate.confidence === 'string' ? candidate.confidence : null,
        source: typeof candidate.source === 'string' ? candidate.source : null,
        sourceStoryId: typeof candidate.sourceStoryId === 'string' ? candidate.sourceStoryId : null,
        sourceSpecId: typeof candidate.sourceSpecId === 'string' ? candidate.sourceSpecId : null,
        sourceRunId: typeof candidate.sourceRunId === 'number' ? candidate.sourceRunId : null,
        relatedFiles: normalizeStringArray(candidate.relatedFiles),
        canonicalKey: typeof candidate.canonicalKey === 'string' ? candidate.canonicalKey : undefined,
        pinned: typeof candidate.pinned === 'boolean' ? candidate.pinned : undefined,
        createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : null,
        updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : null,
        decision: ['keep', 'drop', 'needs-more', 'conflict'].includes(candidate.decision) ? candidate.decision : undefined,
        conflictsWith: normalizeStringArray(candidate.conflictsWith),
        supersededBy: typeof candidate.supersededBy === 'string' ? candidate.supersededBy : undefined,
        selected: isSelected,
        enteredPrompt: isSelected,
        relevanceScore: typeof candidate.finalScore === 'number' ? candidate.finalScore : 0,
        scoreBreakdown: {
          semantic: typeof candidate.semanticRankScore === 'number' ? candidate.semanticRankScore : undefined,
          keyword: typeof candidate.scoring?.keywordScore === 'number' ? candidate.scoring.keywordScore : undefined,
          graph: typeof candidate.graphScore === 'number' ? candidate.graphScore : undefined,
          recency: typeof candidate.freshnessScore === 'number' ? candidate.freshnessScore : undefined,
          skill: typeof candidate.scoring?.skillScore === 'number' ? candidate.scoring.skillScore : undefined,
        },
        matchedSkills: Array.isArray(candidate.matchedSkills)
          ? candidate.matchedSkills.filter((s: any) => typeof s === 'string')
          : Array.isArray(candidate.scoring?.breakdown?.skillAlignment?.matchedSkills)
            ? candidate.scoring.breakdown.skillAlignment.matchedSkills.filter((s: any) => typeof s === 'string')
            : undefined,
        keptOrDroppedReason: Array.isArray(candidate.reasons) && candidate.reasons.length > 0
          ? candidate.reasons.join('; ')
          : (candidate.decision === 'keep' ? 'Selected' : 'Dropped'),
      };

      if (isSelected) {
        selectedCandidates.push(normalized);
      } else {
        droppedCandidates.push(normalized);
      }
    }

    // Build a concise rawSummary from the telemetry metadata
    const selCount = Number(telemetryRow.selected_count) || 0;
    const candCount = Number(telemetryRow.candidate_count) || 0;
    const tier = telemetryRow.retrieval_tier || 'unknown';
    const latMs = telemetryRow.latency_ms != null ? Number(telemetryRow.latency_ms) : null;
    const rawSummary = [
      `${selCount}/${candCount} candidates selected`,
      `tier: ${tier}`,
      ...(latMs != null ? [`latency: ${latMs}ms`] : []),
      ...(telemetryRow.needs_more_evidence ? ['needs more evidence'] : []),
    ].join(', ');

    // Parse contradiction pairs from the DB column
    const contradictionPairsRaw = telemetryRow.contradiction_pairs;
    const contradictions: Array<[string, string]> = [];
    if (Array.isArray(contradictionPairsRaw)) {
      for (const pair of contradictionPairsRaw) {
        if (Array.isArray(pair) && pair.length >= 2 && typeof pair[0] === 'string' && typeof pair[1] === 'string') {
          contradictions.push([pair[0], pair[1]]);
        }
      }
    }

    const storyId = storyWithTelemetry.story_id;
    const [storyReceipt, promptReceipt] = await Promise.all([
      resolveStoryFromSpec(storyId),
      resolvePromptReceipt(storyId),
    ]);
    const contextReceipt: ContextReceipt = {
      ...storyReceipt,
      ...promptReceipt,
      storyId,
      retrievalQuery: telemetryRow.query_preview,
      receiptSteps: [
        `Story ${storyId} triggered context retrieval.`,
        `${selCount}/${candCount} memory candidates were selected for agent context.`,
        promptReceipt.promptExcerpt
          ? 'The selected context was assembled into the final agent prompt.'
          : 'The final prompt excerpt is unavailable for this run, but retrieval metadata is still shown.',
      ],
    };

    res.json({
      telemetryId: telemetryRow.id,
      runId,
      storyId,
      query: telemetryRow.query_preview,
      contextReceipt,
      selectedCandidates,
      droppedCandidates,
      candidateCount: candCount,
      selectedCount: selCount,
      matchedSkills: Array.isArray(telemetryRow.matched_skills)
        ? telemetryRow.matched_skills.filter((s: any) => typeof s === 'string')
        : [],
      retrievalTier: telemetryRow.retrieval_tier || null,
      latencyMs: latMs,
      needsMoreEvidence: Boolean(telemetryRow.needs_more_evidence),
      tokenBudget: Number(telemetryRow.token_budget) || 0,
      contradictions,
      rawSummary,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Get retrieval telemetry');
  }
});

// ─── POST /api/pipeline/runs/:runId/retry — Retry failed stories ─────────────
// Accepts optional 'storyIds' array; when omitted, retries all failed stories.
// Preserves original failed story_result rows for audit trail.

const PipelineRetrySchema = z.object({
  storyIds: z.array(z.string().trim().min(1).max(256)).max(100).optional(),
  forceSequential: z.boolean().optional(),
  previewHash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  approvalToken: z.string().trim().min(8).max(512).optional(),
  cancelPreview: z.boolean().optional(),
  safeMode: z.boolean().optional(),
  approvedPreview: z.record(z.string(), z.unknown()).optional(),
  previewIdentity: z.object({
    schemaVersion: z.literal('retry-preview-identity.v1'),
    previewHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    originalRunId: z.number().int().positive(),
    expiresAt: z.string().datetime(),
    signature: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  }).strict().optional(),
}).strict();

/**
 * @swagger
 * /api/pipeline/runs/{runId}/retry:
 *   post:
 *     tags: [Pipeline]
 *     summary: Retry failed stories in a pipeline run via pg-boss job queue
 *     operationId: retryPipelineRun
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Retry preview and dispatch expose workspace-owned execution scope and can create a retry run, so an authenticated caller and governed packet are required."
 *     description: Two-phase governed retry. First call without previewHash returns a read-only exact packet plus expiring identity; dispatch recomputes scope and submits to the existing queue only when packet, identity, hash, policy, and replay key still match.
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               storyIds:
 *                 type: array
 *                 items: { type: string }
 *                 description: Specific story IDs to retry (all failed if omitted)
 *               forceSequential:
 *                 type: boolean
 *                 description: Force the retry run to execute sequentially (parallelism = 1)
 *               safeMode:
 *                 type: boolean
 *                 description: Explicitly preview branch-only/no-send safety changes instead of destructive option replay
 *               previewHash:
 *                 type: string
 *                 description: Hash returned by the preview call and approved for dispatch
 *               approvedPreview:
 *                 type: object
 *                 description: Exact packet returned by the read-only preview call
 *               previewIdentity:
 *                 type: object
 *                 description: Unexpired self-verifying identity returned with the packet
 *               approvalToken:
 *                 type: string
 *                 description: Existing explicit operator approval token required when the preview marks requiresApproval
 *               cancelPreview:
 *                 type: boolean
 *                 description: Cancel this preview before dispatch
 *     responses:
 *       200: { description: "Governed retry preview, cancellation, or duplicate dispatch result" }
 *       201: { description: "Approved retry job enqueued", content: { application/json: { schema: { type: object, properties: { ok: { type: boolean }, queued: { type: boolean }, runId: { type: integer }, previewHash: { type: string } } } } } }
 *       404: { description: "Run not found" }
 *       409: { description: "Retry job already queued for this run" }
 */
router.post('/runs/:runId/retry', validateBody(PipelineRetrySchema), retryPipelineRunHandler);

export async function retryPipelineRunHandler(req: Request, res: Response): Promise<void> {
  try {
    const originalRunId = parseInt(String(req.params.runId), 10);
    if (isNaN(originalRunId)) {
      throw new ValidationError('Invalid runId');
      return;
    }

    const { storyIds, forceSequential, previewHash, approvalToken, cancelPreview, safeMode, approvedPreview: approvedPreviewRaw, previewIdentity } = req.body as {
      storyIds?: string[];
      forceSequential?: boolean;
      previewHash?: string;
      approvalToken?: string;
      cancelPreview?: boolean;
      approvedPreview?: RetryPreviewPacket;
      previewIdentity?: RetryPreviewIdentity;
      /** Explicitly preview branch-only/no-send safety changes instead of replaying destructive options. */
      safeMode?: boolean;
    };

    // 1. Fetch the original run
    const originalRunRow = await queryOne('SELECT * FROM pipeline_runs WHERE id = $1', [originalRunId]) as PipelineRunRow | undefined;

    if (!originalRunRow) {
      throw new NotFoundError('Run not found');
      return;
    }
    const originalRun = normalizePipelineRun(originalRunRow);

    // Only retry runs that have terminal failure states
    if (!['failed', 'done', 'completed', 'partial_failure'].includes(originalRun.status)) {
      throw new ConflictError(`Cannot retry run with status '${originalRun.status}'`);
      return;
    }

    // Reconcile before reading retry scope, creating a retry run/temp spec, or
    // sending a pg-boss job. This prevents copied results and stale false flags
    // from causing already-proven work to run again.
    const workspace = await queryOne('SELECT * FROM workspaces WHERE id = $1', [originalRun.workspace_id]) as
      { id: string; label: string; path: string } | undefined;
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }
    const passReconciliation = await (previewHash ? reconcileApprovedSpecPasses : inspectApprovedSpecPasses)({
      workspaceId: originalRun.workspace_id,
      workspacePath: workspace.path,
      specPath: originalRun.spec_path,
    });
    assertReconciliationAllowsAutomaticScope(passReconciliation);
    const reconciliationByStory = new Map(passReconciliation.stories.map((story) => [story.storyId, story]));

    // 2. Find all stories and their latest status from the original run
    const allStories = await query('SELECT * FROM story_results WHERE run_id = $1 ORDER BY id ASC', [originalRunId]) as StoryResultRow[];

    // Get the latest result per story_id (last row wins — ordered by id ASC)
    const latestByStory = new Map<string, StoryResultRow>();
    for (const s of allStories) {
      latestByStory.set(s.story_id, s);
    }

    // Fallback: if story_results is empty (subprocess HTTP calls failed), derive from spec JSON
    if (latestByStory.size === 0 && originalRun.spec_path) {
      try {
        const wsRow = await queryOne('SELECT path FROM workspaces WHERE id = $1', [originalRun.workspace_id]) as { path: string } | undefined;
        if (wsRow) {
          const specPath = path.join(wsRow.path, originalRun.spec_path);
          if (fs.existsSync(specPath)) {
            const specData = JSON.parse(fs.readFileSync(specPath, 'utf8'));
            const stories = specData.userStories || specData.phases?.flatMap((p: { stories: unknown[] }) => p.stories) || [];
            for (const s of stories as Array<{ id: string; passes?: boolean }>) {
              latestByStory.set(s.id, {
                id: 0, run_id: originalRunId, story_id: s.id,
                status: s.passes ? 'pass' : 'fail',
                retries: 0, log_path: null, started_at: new Date().toISOString(), finished_at: null,
                elapsed_seconds: null, input_tokens: null, output_tokens: null,
                model_used: null, cost_usd: null,
              } as StoryResultRow);
            }
            logger.info(`[retry] Derived ${latestByStory.size} story statuses from spec JSON (story_results table was empty)`);
          }
        }
      } catch (specErr: unknown) {
        logger.warn(`[retry] Could not derive stories from spec JSON: ${(specErr as Error).message}`);
      }
    }

    // Include only failed/blocked rows whose current reconciled projection is
    // still not passed. Safely repaired stale flags and excluded stories cannot
    // enter retry scope.
    const failedStories = Array.from(latestByStory.values()).filter((s) => {
      const reconciliation = reconciliationByStory.get(s.story_id);
      return (s.status === 'fail' || s.status === 'skip')
        && reconciliation?.status === 'consistent-not-passed'
        && !reconciliation.reasonCodes.includes('EXCLUDED_STORY');
    });
    const passedStories = Array.from(latestByStory.values()).filter((s) => {
      const reconciliation = reconciliationByStory.get(s.story_id);
      return s.status === 'pass' && reconciliation?.status === 'consistent-passed';
    });

    if (failedStories.length === 0) {
      throw new UnprocessableError('No failed stories to retry');
      return;
    }

    // 3. Determine which stories to retry
    let storiesToRetry: StoryResultRow[];
    if (storyIds && storyIds.length > 0) {
      storiesToRetry = failedStories.filter(s => storyIds.includes(s.story_id));
      if (storiesToRetry.length === 0) {
        throw new UnprocessableError('None of the specified storyIds are failed stories in this run');
        return;
      }
    } else {
      storiesToRetry = failedStories;
    }

    // 4. Classify reusable worktree state for the governed preview. Unsafe
    // states are surfaced rather than silently reset or deleted.
    let worktreePreflight = originalRun.worktree_path
      ? validateReusableWorktree({
        workspacePath: workspace.path,
        worktreePath: originalRun.worktree_path,
        expectedBranchName: originalRun.branch_name ?? null,
        expectedDirtyPaths: ['.rorca/progress', '.rorca/run-state.json', 'progress.txt'],
      })
      : null;

    const originalEffectiveOptions = isEffectiveRunOptions(originalRun.effective_options)
      ? originalRun.effective_options
      : buildEffectiveRunOptions({
      model: originalRun.agent_model ?? null,
      effort: null,
      autoWorktree: originalRun.auto_worktree ?? Boolean(originalRun.worktree_path),
      worktreePath: originalRun.worktree_path ?? null,
      branchName: originalRun.branch_name ?? null,
      mergeStrategy: originalRun.merge_strategy ?? 'branch-only',
      autoMerge: originalRun.auto_merge ?? false,
      includeGraph: originalRun.include_graph ?? false,
      terminal: originalRun.terminal_mode,
      policyLocked: false,
      // Missing/legacy option snapshots fail closed. Retry policy may preserve
      // capabilities only when a complete host-authored snapshot proves them.
      deploy: false,
      externalSend: false,
    });
    // Canonical API metadata intentionally preserves Unknown for historical
    // rows; retry execution still needs the legacy active-agent fallback.
    const retryAgent = resolveDispatchAgent(originalRunRow.agent_type ?? originalRunRow.agent);
    let retryModel = originalEffectiveOptions.model ?? originalRun.agent_model ?? null;
    let retryEffort = originalEffectiveOptions.effort;
    if (retryAgent === 'pi') {
      const piStatus = piDetector.detectPi();
      if (!piStatus.piInstalled || !piStatus.piBinPath) throw new ValidationError('pi_preflight:not_installed');
      try {
        const selection = preflightPiModelAndEffort(
          retryModel,
          retryEffort,
          piDetector.listPiModels(piStatus.piBinPath),
          DEFAULT_PI_MODEL,
        );
        retryModel = selection.model;
        retryEffort = selection.effort;
      } catch (error: unknown) {
        if (error instanceof PiExecutionPreflightError) {
          throw new ValidationError(`pi_preflight:${error.code}: ${error.message}`);
        }
        throw error;
      }
    }

    const absSpecPath = path.join(workspace.path, originalRun.spec_path);
    if (!fs.existsSync(absSpecPath)) throw new UnprocessableError(`Spec file not found at ${absSpecPath}`);
    const sourceSpecJson = JSON.parse(fs.readFileSync(absSpecPath, 'utf8')) as Record<string, unknown>;
    const phaseStories = Array.isArray(sourceSpecJson.phases)
      ? (sourceSpecJson.phases as Array<{ stories?: RetryPlanStory[] }>).flatMap((phase) => phase.stories ?? [])
      : [];
    const retryPlanStories = (Array.isArray(sourceSpecJson.userStories) ? sourceSpecJson.userStories : phaseStories) as RetryPlanStory[];
    const retryStatuses: RetryPlanStatus[] = retryPlanStories.map((story) => {
      const reconciled = reconciliationByStory.get(story.id);
      const latest = latestByStory.get(story.id);
      if (story.excluded || reconciled?.reasonCodes.includes('EXCLUDED_STORY')) return { storyId: story.id, status: 'excluded' };
      if (story.skipped) return { storyId: story.id, status: 'skipped' };
      if (reconciled?.status === 'consistent-passed') return { storyId: story.id, status: 'passed' };
      if (latest && (latest.status === 'fail' || latest.status === 'skip')) return { storyId: story.id, status: 'failed' };
      return { storyId: story.id, status: 'other' };
    });
    const retryScope = resolveRetryScope({ stories: retryPlanStories, statuses: retryStatuses, requestedStoryIds: storyIds });
    if (retryScope.executable.length === 0) throw new UnprocessableError('No executable failed stories remain in the requested retry scope');
    storiesToRetry = retryScope.executable
      .map((entry) => latestByStory.get(entry.storyId))
      .filter((entry): entry is StoryResultRow => Boolean(entry));

    if (previewHash && worktreePreflight?.classification === 'stale_base' && originalRun.worktree_path) {
      const refresh = safelyRefreshReusableWorktree({
        workspacePath: workspace.path,
        worktreePath: originalRun.worktree_path,
        expectedBranchName: originalRun.branch_name ?? null,
        expectedDirtyPaths: ['.rorca/progress', '.rorca/run-state.json', 'progress.txt'],
      });
      await execute(
        `UPDATE pipeline_retry_previews SET override_record = COALESCE(override_record, '{}'::jsonb) || $2::jsonb WHERE preview_hash = $1`,
        [previewHash, JSON.stringify({ worktreeRefresh: refresh })],
      );
      worktreePreflight = validateReusableWorktree({
        workspacePath: workspace.path,
        worktreePath: originalRun.worktree_path,
        expectedBranchName: originalRun.branch_name ?? null,
        expectedDirtyPaths: ['.rorca/progress', '.rorca/run-state.json', 'progress.txt'],
      });
    }

    // Initial trigger and retry dispatch resolve the same host-enforced policy.
    // Structured policy wins; spec prose (including `_notes`) is never authority.
    const retrySafety = resolvePiRunSafetyOptions(originalRun.spec_path, sourceSpecJson, {
      autoWorktree: originalEffectiveOptions.worktree.enabled,
      autoMerge: originalEffectiveOptions.merge.autoMerge,
      mergeStrategy: originalEffectiveOptions.merge.strategy,
    });
    const enforceSafeRetry = safeMode === true || retrySafety.policyLocked;
    const replayedOptions: RetryExecutionOptions = {
      agent: retryAgent,
      model: retryModel,
      effort: retryEffort,
      terminalMode: originalRun.terminal_mode,
      includeGraph: originalRun.include_graph ?? originalEffectiveOptions.graph.enabled,
      worktree: {
        ...originalEffectiveOptions.worktree,
        enabled: retrySafety.autoWorktree,
      },
      merge: enforceSafeRetry
        ? { strategy: 'branch-only', autoMerge: false }
        : { strategy: retrySafety.mergeStrategy, autoMerge: retrySafety.autoMerge },
      safety: {
        deploy: enforceSafeRetry ? false : retrySafety.deploy,
        externalSend: enforceSafeRetry ? false : retrySafety.externalSend,
        policyLocked: retrySafety.policyLocked,
        allowBackendJest: false,
      },
    };
    const unsafeWorktree = worktreePreflight != null
      && !['fresh', 'dirty_expected_work', 'stale_base'].includes(worktreePreflight.classification);
    const destructiveReplay = replayedOptions.merge.autoMerge
      || replayedOptions.merge.strategy === 'direct'
      || replayedOptions.safety.deploy
      || replayedOptions.safety.externalSend;
    const highRisk = destructiveReplay || Boolean(worktreePreflight && worktreePreflight.classification !== 'fresh');
    const retryPreview = createRetryPreview({
      originalRunId,
      scope: retryScope,
      options: replayedOptions,
      forceSequential: Boolean(forceSequential || highRisk),
      requiresApproval: destructiveReplay || unsafeWorktree,
    });
    const scopeHash = retryHash(retryPreview.scope.executable.map((entry) => entry.storyId));

    if (!previewHash) {
      // Preview is deliberately read-only: no approval row, WAL record, run, or
      // queue job exists until the caller dispatches this exact expiring packet.
      const identity = createRetryPreviewIdentity(retryPreview);
      res.status(200).json({ ok: true, preview: retryPreview, previewIdentity: identity, worktreePreflight, passReconciliation });
      return;
    }

    if (!approvedPreviewRaw || !previewIdentity || !verifyRetryPreview(approvedPreviewRaw)) {
      await postRetryWalEvent('ssdlc_retry_preview_denied', originalRun.workspace_id, {
        original_run_id: originalRunId,
        reason: 'missing_or_invalid_packet',
      });
      throw new ConflictError('Dispatch requires the exact self-verifying retry preview packet');
    }
    if (approvedPreviewRaw.previewHash !== previewHash || approvedPreviewRaw.originalRunId !== originalRunId) {
      await postRetryWalEvent('ssdlc_retry_preview_denied', originalRun.workspace_id, {
        original_run_id: originalRunId,
        reason: 'mismatched_run_or_hash',
      });
      throw new ConflictError('Retry preview identity does not match the requested run/hash');
    }
    const identityCheck = verifyRetryPreviewIdentity(previewIdentity, approvedPreviewRaw);
    if (!identityCheck.valid) {
      await postRetryWalEvent('ssdlc_retry_preview_denied', originalRun.workspace_id, {
        original_run_id: originalRunId,
        reason: identityCheck.reason,
      });
      throw new ConflictError(
        identityCheck.reason === 'expired' ? 'Retry preview has expired; generate a new preview' : 'Retry preview identity is invalid or mismatched',
        { reason: identityCheck.reason },
      );
    }
    if (cancelPreview) {
      res.json({ ok: true, cancelled: true, previewHash });
      return;
    }

    const storedPreviewRow = await queryOne<{ packet: RetryPreviewPacket; status: string; retry_run_id: number | null; approval_token: string | null }>(
      `SELECT packet, status, retry_run_id, approval_token
       FROM pipeline_retry_previews WHERE preview_hash = $1 AND original_run_id = $2`,
      [previewHash, originalRunId],
    );
    if (storedPreviewRow?.status === 'dispatched' && storedPreviewRow.retry_run_id) {
      await emitLifecycleInvalidation({
        workspaceId: originalRun.workspace_id,
        specId: path.basename(originalRun.spec_path, '.json'),
        runId: storedPreviewRow.retry_run_id,
        changeKind: 'retry_dispatched',
      });
      res.status(200).json({ ok: true, queued: true, duplicate: true, runId: storedPreviewRow.retry_run_id, originalRunId, previewHash });
      return;
    }
    if (storedPreviewRow && (storedPreviewRow.status === 'cancelled' || storedPreviewRow.status === 'refused')) {
      throw new ConflictError('Retry preview is no longer dispatchable');
    }
    if (retryPreview.previewHash !== previewHash) {
      await postRetryWalEvent('retry_scope_mismatch', originalRun.workspace_id, {
        original_run_id: originalRunId,
        approved_preview_hash: previewHash,
        actual_preview_hash: retryPreview.previewHash,
        approved_scope: approvedPreviewRaw.scope.executable,
        actual_scope: retryPreview.scope.executable,
      });
      throw new ConflictError('Retry scope differs from the approved preview; generate a new preview');
    }
    const approvedPreview = approvedPreviewRaw;
    if (approvedPreview.requiresApproval && !approvalToken) {
      throw new ForbiddenError('Retry preview requires the existing explicit operator approval path before destructive options may be replayed');
    }
    if (unsafeWorktree) throw new ConflictError(`Worktree preflight requires operator action (${worktreePreflight?.classification})`);

    const dispatchIdempotencyKey = req.get('Idempotency-Key')?.trim() || `retry:${previewHash}`;
    const approvalClaim = await queryOne<{ preview_hash: string }>(
      `INSERT INTO pipeline_retry_previews (
         preview_hash, original_run_id, workspace_id, scope_hash, status, packet,
         approval_token, preview_identity_hash, expires_at, idempotency_key, approved_at
       ) VALUES ($1, $2, $3, $4, 'approved', $5::jsonb, $6, $7, $8, $9, NOW())
       ON CONFLICT DO NOTHING
       RETURNING preview_hash`,
      [
        previewHash,
        originalRunId,
        originalRun.workspace_id,
        scopeHash,
        JSON.stringify(approvedPreview),
        approvalToken ? retryHash({ approvalToken }) : null,
        retryHash(previewIdentity),
        previewIdentity.expiresAt,
        dispatchIdempotencyKey,
      ],
    );
    if (!approvalClaim) {
      const replay = await queryOne<{ preview_hash: string; retry_run_id: number | null; status: string }>(
        `SELECT preview_hash, retry_run_id, status FROM pipeline_retry_previews
         WHERE workspace_id = $1 AND idempotency_key = $2`,
        [originalRun.workspace_id, dispatchIdempotencyKey],
      );
      if (replay?.status === 'dispatched' && replay.retry_run_id) {
        await emitLifecycleInvalidation({
          workspaceId: originalRun.workspace_id,
          specId: path.basename(originalRun.spec_path, '.json'),
          runId: replay.retry_run_id,
          changeKind: 'retry_dispatched',
        });
        res.status(200).json({ ok: true, queued: true, duplicate: true, runId: replay.retry_run_id, originalRunId, previewHash });
        return;
      }
      if (!replay || replay.preview_hash !== previewHash) {
        throw new ConflictError('Retry dispatch Idempotency-Key was reused with a different preview');
      }
      // The unique preview/idempotency claim is the single dispatch owner. A
      // concurrent/restart replay must never create a second run while that
      // owner is still approved but not durably marked dispatched.
      throw new ConflictError('Retry preview dispatch is already in progress; replay after its durable queue outcome');
    }

    // 5. Duplicate-job guard — check for an active pipeline:retry job for this run and scope.
    //    Correlation stays in job data; pg-boss owns and generates the UUID id.
    const existingJob = await queryOne<{ id: string; run_id: string | null }>(
      `SELECT id::text, data->>'runId' AS run_id FROM pgboss.job
       WHERE name = 'pipeline:retry'
         AND data->>'originalRunId' = $1
         AND data->>'scopeHash' = $2
         AND state IN ('created', 'active', 'retry')
       LIMIT 1`,
      [String(originalRunId), scopeHash],
    ).catch(() => undefined);
    if (existingJob) throw new ConflictError('An active retry job already owns this approved scope');

    // 6. Capture sequenceOffset BEFORE creating the new run row to avoid race conditions
    //    between two simultaneous retry requests. The worker starts chunks at sequenceOffset + 1.
    const seqRow = await queryOne<{ max_seq: number | null }>(
      `SELECT MAX(sequence) AS max_seq FROM run_output_chunks WHERE run_id = $1`,
      [originalRunId],
    );
    const sequenceOffset = seqRow?.max_seq ?? 0;

    // 7. Create a NEW pipeline_run linked to the original while preserving the
    // host-enforced model, effort, worktree, merge, graph, terminal, and safety options.
    const retryTerminalMode = normalizeTerminalMode(approvedPreview.options.terminalMode);
    const retryParallelism = isPtyTerminalMode(retryTerminalMode)
      ? 1
      : approvedPreview.forceSequential ? 1 : (originalRun.parallelism ?? 1);
    const retryEffectiveOptions: EffectiveRunOptions = {
      ...originalEffectiveOptions,
      model: approvedPreview.options.model,
      effort: approvedPreview.options.effort,
      worktree: { ...approvedPreview.options.worktree },
      merge: { ...approvedPreview.options.merge },
      graph: { enabled: approvedPreview.options.includeGraph },
      terminal: retryTerminalMode,
      safety: { ...originalEffectiveOptions.safety, ...approvedPreview.options.safety },
    };
    const newRunResult = await queryOne<{id: number}>(`INSERT INTO pipeline_runs
      (spec_path, workspace_id, status, trigger_type, branch_name, worktree_path,
       retried_from_run_id, parallelism, terminal_mode, agent, agent_type, agent_model,
       auto_worktree, auto_merge, include_graph, merge_strategy, effective_options)
      VALUES ($1, $2, 'queued', 'retry', $3, $4, $5, $6, $7, $8, $9, $10,
              $11, $12, $13, $14, $15::jsonb)
      RETURNING id`, [
      originalRun.spec_path,
      originalRun.workspace_id,
      originalRun.branch_name,
      originalRun.worktree_path,
      originalRunId,
      retryParallelism,
      retryTerminalMode,
      approvedPreview.options.agent,
      approvedPreview.options.agent,
      approvedPreview.options.model,
      approvedPreview.options.worktree.enabled,
      approvedPreview.options.merge.autoMerge,
      approvedPreview.options.includeGraph,
      approvedPreview.options.merge.strategy,
      JSON.stringify(retryEffectiveOptions),
    ]);
    const newRunId = normalizeWorkerRunId(newRunResult!.id);
    await execute(
      `UPDATE pipeline_retry_previews SET retry_run_id = $2 WHERE preview_hash = $1 AND status = 'approved'`,
      [previewHash, newRunId],
    );

    // 8. Copy successful story results from the original run to the new run
    for (const passed of passedStories) {
      await execute(
        `INSERT INTO story_results (run_id, story_id, status, retries, log_path, started_at, finished_at, elapsed_seconds, input_tokens, output_tokens)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          newRunId,
          passed.story_id,
          'pass',
          passed.retries,
          passed.log_path,
          passed.started_at,
          passed.finished_at,
          passed.elapsed_seconds,
          passed.input_tokens,
          passed.output_tokens,
        ]
      );
    }

    // 9. Insert 'retry' placeholder rows for stories being retried + emit WAL events
    const retriedStoryInfo: Array<{ storyId: string; attempt: number }> = [];

    for (const story of storiesToRetry) {
      const attempt = story.retries + 1;
      await execute(
        `INSERT INTO story_results (run_id, story_id, status, retries) VALUES ($1, $2, 'retry', $3)`,
        [newRunId, story.story_id, attempt]
      );

      const walEvent = await queryOne<WalEvent>(
        `INSERT INTO wal_events (event_type, workspace_id, story_id, payload) VALUES ('story_retried', $1, $2, $3) RETURNING *`,
        [
          originalRun.workspace_id,
          story.story_id,
          JSON.stringify({ run_id: newRunId, original_run_id: originalRunId, story_id: story.story_id, attempt }),
        ]
      );
      if (walEvent) broadcastAll(walEvent!);

      retriedStoryInfo.push({ storyId: story.story_id, attempt });
    }

    // 10. Read the original spec and write a temporary retry spec.
    //     Include all stories so dependency resolution works correctly — passed stories
    //     (passes:true) are skipped naturally by the engine.
    const specJson = buildGovernedRetrySpec(sourceSpecJson, approvedPreview.scope);
    const retrySpecName = `retry-${newRunId}-${Date.now()}.json`;
    const retrySpecDir = path.join(workspace.path, 'forge', 'specs', 'approved');
    const retrySpecPath = path.join(retrySpecDir, retrySpecName);
    fs.mkdirSync(retrySpecDir, { recursive: true });
    fs.writeFileSync(retrySpecPath, JSON.stringify(specJson, null, 2));

    // 11. Build env overrides (same logic as pipeline trigger)
    const envOverrides: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !CLAUDE_ENV_VARS_TO_REMOVE.includes(k)) {
        envOverrides[k] = v;
      }
    }
    envOverrides['RORCA_PROCESS_ROLE'] = 'engine';
    const wsEnvVars = getWorkspaceEnvVars(originalRun.workspace_id);
    for (const [k, v] of Object.entries(wsEnvVars)) {
      envOverrides[k] = v;
    }

    // Reuse the existing pre-run approval path. Explicit approval tokens are
    // audit claims, not a bypass for a failing workspace hook.
    const retryHookResults = await runHooks(originalRun.workspace_id, 'pre_run', approvedPreview.options.worktree.path ?? workspace.path, envOverrides);
    const failedRetryHook = retryHookResults.find((result) => result.exitCode !== 0);
    if (failedRetryHook) {
      await execute(`UPDATE pipeline_retry_previews SET status = 'refused', refusal_reason = 'pre_run_hook_failed' WHERE preview_hash = $1`, [previewHash]);
      await execute(`UPDATE pipeline_runs SET status = 'cancelled', finished_at = NOW(), summary = 'pre_run_hook_failed' WHERE id = $1`, [newRunId]);
      throw new ForbiddenError(`Retry pre-run approval hook failed: ${failedRetryHook.command}`);
    }

    // 12. Resolve retry manifests from the same immutable policy/profile inputs
    // before dispatch. Retry gets a new run identity; prior failed attempts stay
    // attached to the original run for audit.
    const retryCwd = approvedPreview.options.worktree.path ?? workspace.path;
    const parentManifestRevisions = await query<{ story_id: string; spec_revision: string; story_revision: string }>(
      `SELECT DISTINCT ON (story_id) story_id, spec_revision, story_revision
       FROM story_execution_manifests
       WHERE run_id = $1 AND story_id = ANY($2::text[])
       ORDER BY story_id, attempt DESC`,
      [originalRunId, approvedPreview.scope.executable.map((entry) => entry.storyId)],
    );
    const frozenRevisionsByStory = new Map(parentManifestRevisions.map((row) => [row.story_id, {
      specRevision: row.spec_revision,
      storyRevision: row.story_revision,
    }]));
    const attemptByStory = new Map(retriedStoryInfo.map((story) => [story.storyId, story.attempt + 1]));
    const retryManifests = await resolveAndPersistDispatchManifests({
      workspaceId: workspace.id,
      specId: path.basename(originalRun.spec_path, '.json'),
      runId: Number(newRunId),
      specJson,
      cwd: retryCwd,
      agent: approvedPreview.options.agent,
      model: approvedPreview.options.model,
      effort: approvedPreview.options.effort,
      terminalMode: normalizeTerminalMode(approvedPreview.options.terminalMode),
      worktreePath: approvedPreview.options.worktree.path,
      branchName: approvedPreview.options.worktree.branch,
      autoMerge: approvedPreview.options.merge.autoMerge,
      mergeStrategy: approvedPreview.options.merge.strategy,
      parallelism: retryParallelism,
      frozenRevisionsByStory,
      attemptByStory,
    });

    // 13. Recompute the actual generated execution plan immediately before
    // dispatch. Neither manifests nor prompt prose can widen this frozen scope.
    const planComparison = compareRetryPlanToPreview(specJson, approvedPreview);
    if (!planComparison.matches) {
      await execute(`UPDATE pipeline_retry_previews SET status = 'refused', refusal_reason = 'generated_plan_mismatch' WHERE preview_hash = $1`, [previewHash]);
      await execute(`UPDATE pipeline_runs SET status = 'cancelled', finished_at = NOW(), summary = 'retry_scope_mismatch' WHERE id = $1`, [newRunId]);
      await postRetryWalEvent('retry_scope_mismatch', originalRun.workspace_id, {
        original_run_id: originalRunId,
        retry_run_id: newRunId,
        preview_hash: previewHash,
        approved_scope: planComparison.approved,
        actual_scope: planComparison.actual,
      });
      throw new ConflictError('Generated retry execution plan differs from the approved preview');
    }

    const jobPayload = PipelineRetryJobPayload.parse({
      runId: Number(newRunId),
      originalRunId,
      storyIds: planComparison.actual,
      scopeHash,
      previewHash,
      approvedPreview: approvedPreview as unknown as Record<string, unknown>,
      generatedPlanHash: planComparison.scopeHash,
      workspacePath: workspace.path,
      specPath: originalRun.spec_path,
      retrySpecPath,
      agent: approvedPreview.options.agent,
      model: approvedPreview.options.model,
      worktreePath: approvedPreview.options.worktree.path,
      branchName: approvedPreview.options.worktree.branch,
      terminalMode: normalizeTerminalMode(approvedPreview.options.terminalMode),
      sequenceOffset,
      executionManifestPath: retryManifests.path,
      envOverrides,
      includeGraph: approvedPreview.options.includeGraph,
      ...(approvedPreview.options.effort ? { effortLevel: approvedPreview.options.effort } : {}),
    });

    // 14. Enqueue through the existing queue. Explicit queue creation is
    // idempotent and pg-boss generates the UUID; runId remains payload data.
    const boss = getBoss();
    await boss.createQueue('pipeline:retry');
    const bossJobId = await boss.send('pipeline:retry', jobPayload, {
      retryLimit: 0,
      expireInSeconds: 300,
    });
    if (!bossJobId) {
      await execute(`UPDATE pipeline_retry_previews SET status = 'refused', refusal_reason = 'pgboss_send_returned_null' WHERE preview_hash = $1`, [previewHash]);
      await execute(`UPDATE pipeline_runs SET status = 'cancelled', finished_at = NOW(), summary = 'retry_dispatch_failed' WHERE id = $1`, [newRunId]);
      throw new ServiceUnavailableError('Retry queue rejected dispatch');
    }
    await execute(
      `UPDATE pipeline_retry_previews SET status = 'dispatched', retry_run_id = $2, boss_job_id = $3::uuid, dispatched_at = NOW() WHERE preview_hash = $1 AND status = 'approved'`,
      [previewHash, newRunId, bossJobId],
    );

    logger.info(`[Pipeline] Enqueued pipeline:retry job for newRunId=${newRunId} (originalRunId=${originalRunId})`);
    await emitLifecycleInvalidation({
      workspaceId: originalRun.workspace_id,
      specId: path.basename(originalRun.spec_path, '.json'),
      runId: newRunId,
      changeKind: 'retry_dispatched',
    });

    res.status(201).json({
      ok: true,
      queued: true,
      runId: newRunId,
      originalRunId,
      queuePosition: 1,
      previewHash,
      scopeHash,
      retriedStories: retriedStoryInfo,
      copiedStories: passedStories.map(s => s.story_id),
      effectiveOptions: retryEffectiveOptions,
      passReconciliation,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Retry');
  }
}

// ─── POST /api/pipeline/runs/:runId/retry-merge — Retry a failed worktree merge ─
// Re-enqueues the merge job for a run whose merge_status is 'failed'.

/**
 * @swagger
 * /api/pipeline/runs/{runId}/retry-merge:
 *   post:
 *     tags: [Pipeline]
 *     summary: Retry a failed worktree auto-merge
 *     operationId: retryMerge
 *     description: Re-enqueues a pipeline:merge pg-boss job for a run whose merge_status is 'failed'. Resets merge_status to 'merging'.
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: string, pattern: '^[0-9]+$' }
 *     responses:
 *       200: { description: "Merge job enqueued", content: { application/json: { schema: { type: object, properties: { ok: { type: boolean }, runId: { type: string }, queued: { type: boolean } } } } } }
 *       404: { description: "Run not found" }
 *       409: { description: "merge_status is not failed" }
 */
router.post('/runs/:runId/retry-merge', async (req: Request, res: Response) => {
  try {
    const runId = String(req.params.runId);
    if (!/^[1-9][0-9]*$/.test(runId)) {
      throw new ValidationError('Invalid runId');
    }

    const run = await queryOne<{
      id: string;
      merge_status: string | null;
      branch_name: string | null;
      worktree_path: string | null;
      workspace_id: string;
    }>(
      'SELECT id, merge_status, branch_name, worktree_path, workspace_id FROM pipeline_runs WHERE id = $1',
      [runId],
    );

    if (!run) {
      throw new NotFoundError('Run', String(runId));
    }

    if (run.merge_status !== 'failed') {
      throw new ConflictError(
        `Cannot retry merge: merge_status is '${run.merge_status ?? 'null'}', expected 'failed'`,
      );
    }

    if (!run.branch_name) {
      throw new ConflictError('Cannot retry merge: run has no branch_name (not a worktree run)');
    }

    // Reset merge_status to 'merging' — use rowCount to detect race condition
    const { rowCount } = await execute(
      `UPDATE pipeline_runs SET merge_status = 'merging' WHERE id = $1 AND merge_status = 'failed'`,
      [runId],
    );

    if (rowCount === 0) {
      throw new ConflictError('Merge status was already changed by another request');
    }

    // Enqueue pipeline:merge job
    await getBoss().send('pipeline:merge', {
      runId,
      branch: run.branch_name,
      workspaceId: run.workspace_id,
    }, {
      retryLimit: 0,
      expireInSeconds: 3600, // 1 hour
    });

    logger.info({ runId, branch: run.branch_name }, '[Pipeline] Enqueued pipeline:merge retry job');

    res.status(200).json({ ok: true, runId, queued: true });
  } catch (error: any) {
    // AppError subclasses are caught and serialized by the centralized error handler
    logger.error({ error }, '[Pipeline] retry-merge error');
    throw error;
  }
});

// ─── POST /api/pipeline/runs/:runId/pause — Pause a running pipeline ─────────
// Sends SIGTSTP to the process group so the current story finishes before pausing.

/**
 * @swagger
 * /api/pipeline/runs/{runId}/pause:
 *   post:
 *     tags: [Pipeline]
 *     summary: Pause a running pipeline
 *     operationId: pausePipelineRun
 *     description: Sends SIGTSTP to the pipeline process group, allowing the current story to finish before pausing execution.
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: "Paused", content: { application/json: { schema: { type: object, properties: { ok: { type: boolean }, runId: { type: integer }, status: { type: string } } } } } }
 *       404: { description: "Run not found" }
 */
router.post('/runs/:runId/pause', async (req: Request, res: Response) => {
  try {
    const runId = parseInt(String(req.params.runId), 10);
    if (isNaN(runId)) {
      throw new ValidationError('Invalid runId');
      return;
    }

    const run = await queryOne('SELECT * FROM pipeline_runs WHERE id = $1', [runId]) as PipelineRunRow | undefined;

    if (!run) {
      throw new NotFoundError('Run not found');
      return;
    }

    if (run.status !== 'running') {
      throw new ConflictError(`Cannot pause run with status '${run.status}'`);
      return;
    }

    if (!run.pid || !isPidAlive(run.pid)) {
      throw new ConflictError('Process is not alive');
      return;
    }

    // Send SIGTSTP to the process group (negative pid) — the current story
    // finishes because SIGTSTP is a "soft" stop that the shell handles at
    // the next job-control boundary, letting the foreground child complete.
    try {
      process.kill(-run.pid, 'SIGTSTP');
    } catch (err: any) {
      if (err.code === 'ESRCH') {
        throw new ConflictError('Process is no longer running');
      }
      handleRouteError(res, err, '[Pipeline] Send SIGTSTP');
      return;
    }

    // Update status to 'paused'
    await execute(`UPDATE pipeline_runs SET status = 'paused' WHERE id = $1`, [runId]);

    // Compute elapsed time and completed story count for the WAL event
    const elapsedMs = Date.now() - new Date(run.started_at + 'Z').getTime();
    const elapsedSeconds = Math.floor(elapsedMs / 1000);
    const completedStories = await queryOne(`SELECT COUNT(*)::int as cnt FROM story_results WHERE run_id = $1 AND status IN ('pass', 'fail')`, [runId]) as { cnt: number };

    // Emit WAL event
    const walEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('run_paused', $1, $2)` + ' RETURNING *', [run.workspace_id, JSON.stringify({
      run_id: runId,
      elapsed_seconds: elapsedSeconds,
      completed_stories: completedStories.cnt,
    })]);
    broadcastAll(walEvent!);

    res.json({ ok: true, runId, status: 'paused' });
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Pause');
  }
});

// ─── POST /api/pipeline/runs/:runId/resume — Resume a paused pipeline ────────
// Sends SIGCONT to the process group to resume execution.

/**
 * @swagger
 * /api/pipeline/runs/{runId}/resume:
 *   post:
 *     tags: [Pipeline]
 *     summary: Resume a paused pipeline
 *     operationId: resumePipelineRun
 *     description: Sends SIGCONT to the paused pipeline process group to resume story execution from where it left off.
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: "Resumed", content: { application/json: { schema: { type: object, properties: { ok: { type: boolean }, runId: { type: integer }, status: { type: string } } } } } }
 *       404: { description: "Run not found" }
 */
router.post('/runs/:runId/resume', async (req: Request, res: Response) => {
  try {
    const runId = parseInt(String(req.params.runId), 10);
    if (isNaN(runId)) {
      throw new ValidationError('Invalid runId');
      return;
    }

    const run = await queryOne('SELECT * FROM pipeline_runs WHERE id = $1', [runId]) as PipelineRunRow | undefined;

    if (!run) {
      throw new NotFoundError('Run not found');
      return;
    }

    if (run.status !== 'paused') {
      throw new ConflictError(`Cannot resume run with status '${run.status}'`);
      return;
    }

    if (!run.pid || !isPidAlive(run.pid)) {
      throw new ConflictError('Process is not alive');
      return;
    }

    // Send SIGCONT to the process group
    try {
      process.kill(-run.pid, 'SIGCONT');
    } catch (err: any) {
      handleRouteError(res, err, '[Pipeline] Send SIGCONT');
      return;
    }

    // Update status back to 'running'
    await execute(`UPDATE pipeline_runs SET status = 'running' WHERE id = $1`, [runId]);

    // Emit WAL event
    const walEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('run_resumed', $1, $2)` + ' RETURNING *', [run.workspace_id, JSON.stringify({ run_id: runId })]);
    broadcastAll(walEvent!);

    res.json({ ok: true, runId, status: 'running' });
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Resume');
  }
});

// ─── POST /api/pipeline/runs/:runId/context — Inject context into a blocked run ─
// When a run_blocked WAL event fires (HITL pause), the user can inject free-text
// context. This writes the context to a file the run-loop can read, emits a
// run_resumed WAL event, and sends SIGCONT to resume the process.

/**
 * @swagger
 * /api/pipeline/runs/{runId}/context:
 *   post:
 *     tags: [Pipeline]
 *     summary: Inject context into a blocked (HITL) pipeline run and resume
 *     operationId: injectPipelineContext
 *     description: Writes free-text context to a file for the run-loop to pick up and sends SIGCONT to resume a blocked or paused pipeline run.
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [context]
 *             properties:
 *               context: { type: string, description: "Free-text context to inject" }
 *     responses:
 *       200: { description: "Context injected and run resumed" }
 *       400: { description: "Missing or empty context" }
 *       404: { description: "Run not found" }
 *       409: { description: "Run is not in blocked or paused state" }
 */
router.post('/runs/:runId/context', async (req: Request, res: Response) => {
  try {
    const runId = parseInt(String(req.params.runId), 10);
    if (isNaN(runId)) {
      throw new ValidationError('Invalid runId');
      return;
    }

    const { context } = req.body as { context?: string };
    if (!context || context.trim().length === 0) {
      throw new ValidationError('Context is required and cannot be empty');
      return;
    }

    const run = await queryOne('SELECT * FROM pipeline_runs WHERE id = $1', [runId]) as PipelineRunRow | undefined;

    if (!run) {
      throw new NotFoundError('Run not found');
      return;
    }

    // Accept context injection when run is blocked or paused
    if (run.status !== 'paused' && run.status !== 'running') {
      throw new ConflictError(`Cannot inject context into run with status '${run.status}'`);
      return;
    }

    // Write context to a file the run-loop can pick up
    const workspace = await queryOne('SELECT path FROM workspaces WHERE id = $1', [run.workspace_id]) as { path: string } | undefined;
    if (workspace) {
      const contextDir = path.join(workspace.path, 'forge', 'logs');
      fs.mkdirSync(contextDir, { recursive: true });
      const contextFile = path.join(contextDir, `run-${runId}-context.txt`);
      fs.writeFileSync(contextFile, context.trim(), 'utf8');
    }

    // If process is stopped (paused/blocked), send SIGCONT to resume
    if (run.pid && isPidAlive(run.pid)) {
      try {
        process.kill(-run.pid, 'SIGCONT');
      } catch {
        // Process may have already exited
      }
    }

    // Update status back to running
    await execute(`UPDATE pipeline_runs SET status = 'running' WHERE id = $1`, [runId]);

    // Emit run_resumed WAL event with injected context info
    const walEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('run_resumed', $1, $2)` + ' RETURNING *', [run.workspace_id, JSON.stringify({
      run_id: runId,
      context_injected: true,
      context_length: context.trim().length,
    })]);
    broadcastAll(walEvent!);

    // Also append context to the output buffer so it shows in the terminal
    const buf = outputBuffers.get(runId);
    if (buf) {
      const contextMsg = `\r\n\x1b[1;33m[Context injected by user]\x1b[0m\r\n\x1b[36m${context.trim()}\x1b[0m\r\n`;
      buf.chunks.push(contextMsg);
      buf.subscribers.forEach(cb => cb(contextMsg));
    }

    res.json({ ok: true, runId, status: 'running' });
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Context injection');
  }
});

// ─── POST /api/pipeline/runs/:runId/cancel — Cancel a queued or running pipeline ─
// Queued path: calls getBoss().cancel(String(runId)) to remove the pg-boss job
//   before the worker picks it up, then marks the run as cancelled immediately.
// Running path: sends a 'pipeline:cancel' job to the worker, returns 200 immediately.
//   The worker owns SIGTERM → SIGKILL sequencing and DB/WAL updates for this path.
// Completed/cancelled: returns 409 Conflict.

/**
 * @swagger
 * /api/pipeline/runs/{runId}/cancel:
 *   post:
 *     tags: [Pipeline]
 *     summary: Cancel a queued or running pipeline run
 *     operationId: cancelPipelineRun
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Cancelling a local run is a core operator action required by the stable open-source CLI surface."
 *     x-rorca-public-api: true
 *     description: >
 *       For queued runs: removes the pg-boss job and marks the run as cancelled immediately.
 *       For running runs: delivers a pipeline:cancel job to the worker (which sends SIGTERM then SIGKILL after 10s) and returns 200 immediately — DB and WAL updates happen asynchronously in the worker.
 *       Returns 409 if the run is already completed or cancelled.
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: "Cancelled (or cancel delivered to worker)", content: { application/json: { schema: { type: object, properties: { ok: { type: boolean }, runId: { type: integer }, status: { type: string } } } } } }
 *       404: { description: "Run not found" }
 *       409: { description: "Run is already completed or cancelled" }
 */
router.post('/runs/:runId/cancel', async (req: Request, res: Response) => {
  try {
    const runId = parseInt(String(req.params.runId), 10);
    if (isNaN(runId)) {
      throw new ValidationError('Invalid runId');
      return;
    }

    const run = await queryOne<{ id: number; status: string; workspace_id: string; started_at: string; pid: number | null }>(
      'SELECT id, status, workspace_id, started_at, pid FROM pipeline_runs WHERE id = $1',
      [runId],
    );

    if (!run) {
      throw new NotFoundError('Run not found');
      return;
    }

    await assertPipelineWorkspaceAccess(req, run.workspace_id);
    const { status } = run;

    // Already done — conflict
    if (status !== 'queued' && status !== 'running' && status !== 'paused') {
      throw new ConflictError(`Run is already ${status} and cannot be cancelled`);
    }

    if (status === 'queued') {
      // ── Queued path ──────────────────────────────────────────────────────
      // Attempt to remove the pg-boss job before the worker picks it up.
      // pg-boss requires UUID job IDs — look up by payload runId.
      const jobRow = await queryOne<{ id: string }>(
        `SELECT id FROM pgboss.job WHERE name = 'pipeline:run' AND data->>'runId' = $1 AND state IN ('created', 'active') LIMIT 1`,
        [String(runId)]
      );
      if (jobRow) {
        await getBoss().cancel('pipeline:run', jobRow.id);
      }

      // Re-read status: if the worker picked up the job between our check and
      // cancel, the run may have already transitioned to 'running'. Fall through.
      const refreshed = await queryOne<{ status: string }>(
        'SELECT status FROM pipeline_runs WHERE id = $1',
        [runId],
      );

      if (refreshed && (refreshed.status === 'running' || refreshed.status === 'paused')) {
        // Worker picked it up — delegate to the running path
        await getBoss().send('pipeline:cancel', { runId }, { expireInSeconds: 120 });
        res.json({ ok: true, runId, status: 'cancelling' });
        return;
      }

      // Mark run as cancelled in DB (it's still queued or the job was removed)
      await execute(
        `UPDATE pipeline_runs SET status = 'cancelled', finished_at = NOW(), queue_position = NULL WHERE id = $1`,
        [runId],
      );
      await transitionRunLifecycle(runId, 'cancelled', { owner: 'pipeline_api', reason: 'queued_cancel' });

      // Recalculate queue positions for remaining queued runs
      const { recalculateQueuePositions } = require('../lib/run-queue') as typeof import('../lib/run-queue');
      recalculateQueuePositions(run.workspace_id);

      // Emit WAL event
      const walEvent = await queryOne<WalEvent>(
        `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('run_cancelled', $1, $2) RETURNING *`,
        [run.workspace_id, JSON.stringify({ run_id: runId, cancelledAt: new Date().toISOString() })],
      );
      if (walEvent) broadcastAll(walEvent);

      res.json({ ok: true, runId, status: 'cancelled' });
      return;
    }

    // ── Running / paused path ─────────────────────────────────────────────
    // Deliver cancel job to the worker for SIGTERM/SIGKILL sequencing.
    await getBoss().send('pipeline:cancel', { runId }, { expireInSeconds: 120 });

    // If both the engine and its independently tracked PTY process are gone,
    // finalize inline. A dead wrapper PID alone is not enough: the forkpty child
    // may still be alive and must remain visible to the worker cancellation job.
    const ptyHealth = await getRunPtySessionHealth(runId);
    const pidAlive = run.pid ? isPidAlive(run.pid) : false;
    if (mayFinalizePtyCancellationInline(pidAlive, ptyHealth?.status)) {
      // Process is already gone — handle cancellation inline
      await execute(
        `UPDATE pipeline_runs SET status = 'cancelled', finished_at = NOW() WHERE id = $1`,
        [runId],
      );
      await transitionRunLifecycle(runId, 'cancelled', { owner: 'pipeline_api', reason: 'pid_not_alive' });
      const walEvent = await queryOne<WalEvent>(
        `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('run_cancelled', $1, $2) RETURNING *`,
        [run.workspace_id, JSON.stringify({ run_id: runId, cancelledAt: new Date().toISOString(), reason: 'pid_not_alive' })],
      );
      if (walEvent) broadcastAll(walEvent);
      res.json({ ok: true, runId, status: 'cancelled' });
      return;
    }

    // The worker owns process-tree termination. Do not race it with a direct
    // PID signal here: a stale/recycled PID must not be targeted by the API.
    res.json({ ok: true, runId, status: 'cancelling' });
  } catch (error: unknown) {
    // AppError subclasses are caught and serialized by the centralized error handler
    logger.error({ err: error }, '[Pipeline] Cancel error');
    throw error;
  }
});

// ─── DELETE /api/pipeline/runs/:runId — Cancel a queued run ──────────────────
// Only works for runs with status='queued'. Returns 409 if the run is active/done.
// Recalculates queue_position for remaining queued runs after cancellation.

/**
 * @swagger
 * /api/pipeline/runs/{runId}:
 *   delete:
 *     tags: [Pipeline]
 *     summary: Cancel a queued pipeline run
 *     operationId: cancelQueuedRun
 *     description: Cancels a queued run by marking it as failed with finished_at set. Only works for runs with status='queued'. Returns 409 if the run is already active or completed.
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: "Queued run cancelled", content: { application/json: { schema: { type: object, properties: { ok: { type: boolean }, runId: { type: integer } } } } } }
 *       404: { description: "Run not found" }
 *       409: { description: "Run is not in queued state" }
 */
router.delete('/runs/:runId', async (req: Request, res: Response) => {
  try {
    const runId = parseInt(String(req.params.runId), 10);
    if (isNaN(runId)) {
      throw new ValidationError('Invalid runId');
      return;
    }

    const run = await queryOne('SELECT * FROM pipeline_runs WHERE id = $1', [runId]) as PipelineRunRow | undefined;

    if (!run) {
      throw new NotFoundError('Run not found');
      return;
    }

    await assertPipelineWorkspaceAccess(req, run.workspace_id);
    if (run.status !== 'queued') {
      throw new ConflictError(`Cannot cancel run with status '${run.status}' — only queued runs can be cancelled via DELETE`);
      return;
    }

    // Remove the pg-boss job before the worker picks it up.
    // pg-boss requires UUID job IDs — look up by payload runId.
    const jobRow = await queryOne<{ id: string }>(
      `SELECT id FROM pgboss.job WHERE name = 'pipeline:run' AND data->>'runId' = $1 AND state IN ('created', 'active') LIMIT 1`,
      [String(runId)]
    );
    if (jobRow) {
      await getBoss().cancel('pipeline:run', jobRow.id);
    }

    // Mark as cancelled
    await execute(`UPDATE pipeline_runs SET status = 'cancelled', finished_at = NOW(), queued_at = NULL, queue_position = NULL WHERE id = $1`, [runId]);
    await transitionRunLifecycle(runId, 'cancelled', { owner: 'pipeline_api', reason: 'queued_delete' });

    // Recalculate positions for remaining queued runs
    const { recalculateQueuePositions } = require('../lib/run-queue') as typeof import('../lib/run-queue');
    recalculateQueuePositions(run.workspace_id);

    res.json({ ok: true, runId });
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Delete queued run');
  }
});

// ─── POST /api/pipeline/runs/:runId/pty/resize ───────────────────────────────

/**
 * @swagger
 * /api/pipeline/runs/{runId}/pty/resize:
 *   post:
 *     tags: [Pipeline]
 *     summary: Resize the live PTY terminal for a running pipeline run
 *     operationId: resizePipelineRunPty
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Terminal resize is a local run-control operation for an already-running user-owned pipeline."
 *     x-rorca-public-api: true
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [cols, rows]
 *             properties:
 *               cols: { type: integer, minimum: 1, maximum: 500 }
 *               rows: { type: integer, minimum: 1, maximum: 200 }
 *     responses:
 *       200: { description: PTY resize request recorded }
 */
router.post('/runs/:runId/pty/resize', async (req: Request, res: Response) => {
  try {
    const runId = parseInt(String(req.params.runId), 10);
    const cols = parseInt(String(req.body?.cols), 10);
    const rows = parseInt(String(req.body?.rows), 10);

    if (isNaN(runId)) throw new ValidationError('Invalid runId');
    if (!Number.isInteger(cols) || cols <= 0 || cols > MAX_PTY_COLS
      || !Number.isInteger(rows) || rows <= 0 || rows > MAX_PTY_ROWS) {
      throw new ValidationError(`cols must be 1-${MAX_PTY_COLS} and rows must be 1-${MAX_PTY_ROWS}`);
    }
    if (!PTY_AVAILABLE) {
      throw new ServiceUnavailableError(`PTY terminal mode is unavailable on this server. ${PTY_UNAVAILABLE_HINT}`);
    }

    const run = await queryOne<{ terminal_mode: string | null; status: string; workspace_id: string }>(
      'SELECT terminal_mode, status, workspace_id FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    if (!run) throw new NotFoundError('Run not found');
    await assertPipelineWorkspaceAccess(req, run.workspace_id);
    if (!isPtyTerminalMode(normalizeTerminalMode(run.terminal_mode))) {
      throw new ConflictError('Run is not using PTY terminal mode');
    }
    if (['done', 'failed', 'partial_failure', 'cancelled'].includes(run.status)) {
      throw new ConflictError('Run is no longer active');
    }

    const ptyStatus = await getRunPtySessionStatus(runId);
    if (ptyStatus !== 'active') {
      throw new ConflictError('Run PTY session is not active');
    }

    await requestRunPtyResize(runId, cols, rows);
    res.json({ ok: true, runId, cols, rows });
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Resize PTY run');
  }
});

// ─── POST /api/pipeline/runs/:runId/input — Forward stdin to active PTY ───────

/**
 * @swagger
 * /api/pipeline/runs/{runId}/input:
 *   post:
 *     tags: [Pipeline]
 *     summary: Send keyboard input to the live PTY for a running pipeline run
 *     operationId: sendPipelineRunInput
 *     x-rorca-tier: public
 *     x-rorca-rationale: "PTY stdin is local interactive run control for an already-running user-owned pipeline in single-user mode."
 *     x-rorca-public-api: true
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               dataBase64:
 *                 type: string
 *                 description: "Base64-encoded UTF-8 terminal input bytes from xterm.onData."
 *             required: [dataBase64]
 *     responses:
 *       200: { description: PTY input request recorded }
 */
router.post('/runs/:runId/input', async (req: Request, res: Response) => {
  try {
    const runId = parseInt(String(req.params.runId), 10);
    if (isNaN(runId)) {
      throw new ValidationError('Invalid runId');
    }
    if (!PTY_AVAILABLE) {
      throw new ServiceUnavailableError(`PTY terminal mode is unavailable on this server. ${PTY_UNAVAILABLE_HINT}`);
    }

    const dataBase64 = typeof req.body?.dataBase64 === 'string' ? req.body.dataBase64 : '';
    if (!dataBase64) {
      throw new ValidationError('dataBase64 is required');
    }
    if (dataBase64.length > 87_384) {
      throw new ValidationError('PTY input chunk is too large');
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64) || dataBase64.length % 4 !== 0) {
      throw new ValidationError('dataBase64 must be valid base64');
    }

    let input: Buffer;
    try {
      input = Buffer.from(dataBase64, 'base64');
    } catch {
      throw new ValidationError('dataBase64 must be valid base64');
    }
    if (input.length === 0) {
      throw new ValidationError('PTY input chunk cannot be empty');
    }
    if (input.length > MAX_PTY_INPUT_CHUNK_BYTES) {
      throw new ValidationError('PTY input chunk is too large');
    }
    if (!isUtf8(input)) {
      throw new ValidationError('dataBase64 must decode to valid UTF-8 terminal input');
    }

    const run = await queryOne<{ terminal_mode: string | null; status: string; workspace_id: string }>(
      'SELECT terminal_mode, status, workspace_id FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    if (!run) throw new NotFoundError('Run not found');
    await assertPipelineWorkspaceAccess(req, run.workspace_id);
    if (!isPtyTerminalMode(normalizeTerminalMode(run.terminal_mode))) {
      throw new ConflictError('Run is not using PTY terminal mode');
    }
    if (['done', 'failed', 'partial_failure', 'cancelled'].includes(run.status)) {
      throw new ConflictError('Run is no longer active');
    }

    const ptyStatus = await getRunPtySessionStatus(runId);
    if (ptyStatus !== 'active') {
      throw new ConflictError('Run PTY session is not active');
    }

    const accepted = await requestRunPtyInput(runId, input);
    if (!accepted) {
      throw new ConflictError('PTY input queue is full or the session is no longer active');
    }
    res.json({ ok: true, runId, bytes: input.length });
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] PTY input');
  }
});

// ─── GET /api/pipeline/runs/:runId/output — Raw terminal output SSE ──────────
// Streams raw stdout/stderr (with ANSI codes) to the active terminal renderer.
// ANSI/HTML runs replay from run_output_chunks; PTY runs replay from run_pty_output_chunks.
// Late-joiners receive full replay of all existing chunks, then live updates via polling.

/**
 * @swagger
 * /api/pipeline/runs/{runId}/output:
 *   get:
 *     tags: [Pipeline]
 *     summary: Stream raw terminal output (SSE)
 *     operationId: streamPipelineOutput
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only live run output is core local execution telemetry for CLI/MCP reattachment."
 *     x-rorca-public-api: true
 *     description: Server-Sent Events stream of base64-encoded terminal output. Transcript runs replay from run_output_chunks; PTY runs replay from the dedicated PTY capture store. Committed PostgreSQL notifications wake streams immediately, durable sequence replay supports reconnects, and bounded polling recovers from notification loss.
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: afterSequence
 *         required: false
 *         schema: { type: integer, minimum: 0 }
 *         description: Explicit durable output cursor for refresh persistence. Overrides Last-Event-ID when both are supplied.
 *       - in: query
 *         name: outputSource
 *         required: false
 *         schema: { type: string, enum: [run_pty_output_chunks, run_output_chunks] }
 *         description: Optional durable store identity paired with afterSequence. A changed source resets the cursor so independent PTY and ANSI sequence spaces cannot suppress fallback output.
 *     responses:
 *       200:
 *         description: SSE stream with chunk events (base64 data) and done event
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 */
router.get('/runs/:runId/output', async (req: Request, res: Response) => {
  const runId = parseInt(String(req.params.runId), 10);
  if (isNaN(runId)) {
    throw new ValidationError('Invalid runId');
    return;
  }

  // Resolve and authorize the run before committing SSE headers. This keeps
  // lookup failures as normal HTTP errors instead of half-open event streams.
  const runRow = await queryOne(
    'SELECT workspace_id, agent_type, agent, agent_model, status, lifecycle_status, terminal_mode FROM pipeline_runs WHERE id = $1',
    [runId],
  ) as { workspace_id: string; agent_type: string; agent: string; agent_model: string | null; status: string; lifecycle_status: string | null; terminal_mode: string | null } | undefined;
  if (!runRow) throw new NotFoundError('Run not found');

  await assertPipelineWorkspaceAccess(req, runRow.workspace_id);
  const wsId = req.query.workspaceId as string | undefined;
  if (wsId && String(runRow.workspace_id) !== wsId) {
    throw new ForbiddenError('Run does not belong to this workspace');
  }

  // A query cursor survives explicit browser refresh/navigation. It deliberately
  // overrides Last-Event-ID, which EventSource may retain from an older stream.
  const afterSequenceQuery = req.query.afterSequence;
  if (Array.isArray(afterSequenceQuery)) {
    throw new ValidationError('afterSequence must be a single non-negative integer sequence');
  }
  const afterSequence = typeof afterSequenceQuery === 'string' ? afterSequenceQuery : null;
  const outputSourceQuery = req.query.outputSource;
  if (Array.isArray(outputSourceQuery)) {
    throw new ValidationError('outputSource must be a single replay source');
  }
  const requestedReplaySource = typeof outputSourceQuery === 'string'
    ? parseOutputReplaySource(outputSourceQuery)
    : null;
  const lastEventId = req.get('Last-Event-ID');
  const resumeSource = afterSequence !== null ? 'afterSequence' : lastEventId !== undefined ? 'Last-Event-ID' : null;
  let hasResumeCursor = resumeSource !== null;
  let lastSequence = hasResumeCursor
    ? parseOutputResumeCursor(afterSequence ?? lastEventId!, resumeSource!)
    : 0;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 1000\n\n');
  res.write(': connected\n\n');

  const hb = setInterval(() => {
    if (!res.destroyed && !res.writableEnded && !res.writableNeedDrain) res.write(': hb\n\n');
  }, 15_000);
  let streamClosed = false;
  let pollInterval: NodeJS.Timeout | null = null;
  let unsubscribeOutputWakeup: (() => void) | null = null;
  const cleanupOutputStream = () => {
    if (streamClosed) return;
    streamClosed = true;
    clearInterval(hb);
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
    unsubscribeOutputWakeup?.();
    unsubscribeOutputWakeup = null;
  };
  req.on('close', cleanupOutputStream);

  // One canonical metadata source powers both this SSE DTO and HTTP DTOs.
  const runMetadata = normalizeRunMetadata(runRow);
  const agent = runMetadata.agentType;
  const requestedTerminalMode = runMetadata.terminalMode;
  const terminalStatuses = ['done', 'failed', 'partial_failure', 'cancelled'];
  const runIsTerminalAtOpen = terminalStatuses.includes(runRow.status);
  const requestedPtyMode = isPtyTerminalMode(requestedTerminalMode);
  const ptyStatusAtOpen = requestedPtyMode
    ? await getRunPtySessionStatus(runId)
    : null;
  // An active PTY run is legitimately session-pending while context routing and
  // prompt assembly run. Never permanently demote it because the browser attached
  // before node-pty started. A terminal run with no session is a real fallback.
  const usePtyCapture = requestedPtyMode
    && PTY_AVAILABLE
    && (ptyStatusAtOpen !== null || !runIsTerminalAtOpen);
  const ptyHealthPayloadAtOpen = usePtyCapture
    ? normalizePtyHealthPayload(await getRunPtySessionHealth(runId))
    : null;
  const terminalMode = usePtyCapture ? requestedTerminalMode : 'ansi-html';
  const isPty = usePtyCapture;
  const replaySource: RunOutputReplaySource = isPty ? RUN_OUTPUT_PTY_REPLAY_SOURCE : RUN_OUTPUT_ANSI_REPLAY_SOURCE;
  // PTY and ANSI captures intentionally have independent sequence spaces. A
  // resume cursor from the other source must never suppress freshly selected
  // fallback output; force the same bounded first-attach semantics instead.
  const cursorReset = hasResumeCursor && requestedReplaySource !== null && requestedReplaySource !== replaySource;
  if (cursorReset) {
    hasResumeCursor = false;
    lastSequence = 0;
  }
  const ptyFallbackActive = requestedPtyMode && !isPty;
  const ptyFallbackReason = ptyFallbackActive
    ? PTY_AVAILABLE
      ? 'pty-session-unavailable'
      : 'node-pty-unavailable'
    : null;
  const ptyUnavailableHint = ptyFallbackReason === 'node-pty-unavailable'
    ? PTY_UNAVAILABLE_HINT
    : ptyFallbackReason === 'pty-session-unavailable'
      ? 'Inspect engine startup logs; the requested PTY session was never created.'
      : null;
  if (streamClosed || req.destroyed || res.destroyed) {
    cleanupOutputStream();
    return;
  }

  // Emit run metadata so frontend knows which renderer to use. When a requested
  // PTY stream has no PTY session, this is the canonical demotion signal for the
  // TUI: keep the ANSI replay stream open and label it as degraded/replay-only.
  res.write(`event: run_meta\ndata: ${JSON.stringify({
    agentType: runMetadata.agentType,
    agentModel: runMetadata.agentModel,
    terminalMode,
    lifecyclePhase: runMetadata.lifecyclePhase,
    lifecycle_phase: runMetadata.lifecyclePhase,
    terminal_mode: terminalMode,
    lifecycleStatus: runRow.lifecycle_status ?? lifecycleFromLegacyStatus(runRow.status),
    lifecycle_status: runRow.lifecycle_status ?? lifecycleFromLegacyStatus(runRow.status),
    requestedTerminalMode,
    requested_terminal_mode: requestedTerminalMode,
    isPty,
    ptyAvailable: PTY_AVAILABLE,
    ptyFallbackActive,
    ptyFallbackReason,
    ptyLiveTransport: isPty ? RUN_OUTPUT_PTY_LIVE_TRANSPORT : null,
    pty_live_transport: isPty ? RUN_OUTPUT_PTY_LIVE_TRANSPORT : null,
    outputSource: replaySource,
    output_source: replaySource,
    cursorReset,
    cursor_reset: cursorReset,
    ptyReplaySource: replaySource,
    pty_replay_source: replaySource,
    ptyPollIntervalMs: isPty ? RUN_OUTPUT_PTY_POLL_INTERVAL_MS : null,
    pty_poll_interval_ms: isPty ? RUN_OUTPUT_PTY_POLL_INTERVAL_MS : null,
    ptyExpectedMaxLatencyMs: isPty ? RUN_OUTPUT_PTY_EXPECTED_MAX_LATENCY_MS : null,
    pty_expected_max_latency_ms: isPty ? RUN_OUTPUT_PTY_EXPECTED_MAX_LATENCY_MS : null,
    ptyUnavailableHint,
    pty_unavailable_hint: ptyUnavailableHint,
    ...(ptyHealthPayloadAtOpen ?? {}),
  })}\n\n`);
  writePtyHealthEvent(res, ptyHealthPayloadAtOpen);

  // ── Replay existing chunks (late-join/reconnect support) ──────────────────
  // EventSource sends Last-Event-ID automatically after a disconnect. The
  // validated cursor above resumes exactly after that sequence; first attaches
  // get a bounded tail instead of an unbounded historical transcript.
  interface ChunkRow { sequence: number; chunk: Buffer }
  let lastPtyHealthSignature = JSON.stringify(ptyHealthPayloadAtOpen ?? {});
  let lastPtyHealthEmitAt = Date.now();
  let pollInFlight = false;

  let initialReplayMayHaveMore = false;
  if (usePtyCapture) {
    const existingChunks = hasResumeCursor
      ? await listRunPtyChunks(runId, lastSequence, RUN_OUTPUT_REPLAY_BATCH_CHUNKS)
      : await listRecentRunPtyChunks(runId, RUN_OUTPUT_INITIAL_REPLAY_MAX_CHUNKS);
    initialReplayMayHaveMore = hasResumeCursor && existingChunks.length === RUN_OUTPUT_REPLAY_BATCH_CHUNKS;
    if (!hasResumeCursor && existingChunks[0]?.sequence > 1) {
      res.write(`event: replay_truncated\ndata: ${JSON.stringify({ fromSequence: existingChunks[0].sequence, maxChunks: RUN_OUTPUT_INITIAL_REPLAY_MAX_CHUNKS })}\n\n`);
    }
    for (const row of existingChunks) {
      const chunkBuf = Buffer.isBuffer(row.chunk) ? row.chunk : Buffer.from(row.chunk);
      if (!(await writeOutputChunkEvent(res, row.sequence, chunkBuf))) {
        cleanupOutputStream();
        return;
      }
      lastSequence = row.sequence;
    }
  } else {
    const existingChunks = hasResumeCursor
      ? await query<ChunkRow>(
          'SELECT sequence, chunk FROM run_output_chunks WHERE run_id = $1 AND sequence > $2 ORDER BY sequence ASC LIMIT $3',
          [runId, lastSequence, RUN_OUTPUT_REPLAY_BATCH_CHUNKS],
        )
      : await query<ChunkRow>(
          `SELECT sequence, chunk
           FROM (
             SELECT sequence, chunk FROM run_output_chunks
             WHERE run_id = $1 ORDER BY sequence DESC LIMIT $2
           ) recent ORDER BY sequence ASC`,
          [runId, RUN_OUTPUT_INITIAL_REPLAY_MAX_CHUNKS],
        );

    initialReplayMayHaveMore = hasResumeCursor && existingChunks.length === RUN_OUTPUT_REPLAY_BATCH_CHUNKS;
    if (!hasResumeCursor && existingChunks[0]?.sequence > 1) {
      res.write(`event: replay_truncated\ndata: ${JSON.stringify({ fromSequence: existingChunks[0].sequence, maxChunks: RUN_OUTPUT_INITIAL_REPLAY_MAX_CHUNKS })}\n\n`);
    }
    for (const row of existingChunks) {
      const chunkBuf = Buffer.isBuffer(row.chunk) ? row.chunk : Buffer.from(row.chunk);
      if (!(await writeOutputChunkEvent(res, row.sequence, chunkBuf))) {
        cleanupOutputStream();
        return;
      }
      emitSemanticSteps(chunkBuf.toString('utf8'), agent, res);
      lastSequence = row.sequence;
    }
  }

  // ── If the client disconnected during metadata/replay, do not arm polling. ──
  if (streamClosed || req.destroyed || res.destroyed) {
    cleanupOutputStream();
    return;
  }

  // ── If the run is already terminal, close immediately ────────────────────
  if (terminalStatuses.includes(runRow.status) && !initialReplayMayHaveMore) {
    clearInterval(hb);
    res.write('event: done\ndata: \n\n');
    res.end();
    return;
  }

  // ── Poll for new chunks while run is active ───────────────────────────────
  // Uses lastSequence to fetch only new rows efficiently. PostgreSQL NOTIFY
  // drives the normal path; this cadence is the bounded recovery fallback.
  const pollOutput = async (): Promise<void> => {
    if (pollInFlight || streamClosed) return;
    pollInFlight = true;
    const pollStartedAt = Date.now();
    let drainImmediately = false;
    try {
      let fetchedBatchIsFull = false;
      if (usePtyCapture) {
        const newChunks = await listRunPtyChunks(runId, lastSequence, RUN_OUTPUT_REPLAY_BATCH_CHUNKS);
        fetchedBatchIsFull = newChunks.length === RUN_OUTPUT_REPLAY_BATCH_CHUNKS;
        for (const row of newChunks) {
          const chunkBuf = Buffer.isBuffer(row.chunk) ? row.chunk : Buffer.from(row.chunk);
          if (!(await writeOutputChunkEvent(res, row.sequence, chunkBuf))) {
            cleanupOutputStream();
            return;
          }
          lastSequence = row.sequence;
        }
      } else {
        const newChunks = await query<ChunkRow>(
          'SELECT sequence, chunk FROM run_output_chunks WHERE run_id = $1 AND sequence > $2 ORDER BY sequence ASC LIMIT $3',
          [runId, lastSequence, RUN_OUTPUT_REPLAY_BATCH_CHUNKS],
        );
        fetchedBatchIsFull = newChunks.length === RUN_OUTPUT_REPLAY_BATCH_CHUNKS;

        for (const row of newChunks) {
          const chunkBuf = Buffer.isBuffer(row.chunk) ? row.chunk : Buffer.from(row.chunk);
          if (!(await writeOutputChunkEvent(res, row.sequence, chunkBuf))) {
            cleanupOutputStream();
            return;
          }
          emitSemanticSteps(chunkBuf.toString('utf8'), agent, res);
          lastSequence = row.sequence;
        }
      }

      const [statusRow, ptyHealth] = await Promise.all([
        queryOne<{ status: string; lifecycle_status: string | null }>(
          'SELECT status, lifecycle_status FROM pipeline_runs WHERE id = $1', [runId],
        ),
        usePtyCapture ? getRunPtySessionHealth(runId) : Promise.resolve(null),
      ]);
      const ptyHealthPayload = normalizePtyHealthPayload(ptyHealth);
      if (ptyHealthPayload) {
        const now = Date.now();
        const signature = JSON.stringify(ptyHealthPayload);
        if (signature !== lastPtyHealthSignature || now - lastPtyHealthEmitAt > RUN_OUTPUT_PTY_HEALTH_EMIT_INTERVAL_MS) {
          writePtyHealthEvent(res, ptyHealthPayload);
          lastPtyHealthSignature = signature;
          lastPtyHealthEmitAt = now;
        }
      }
      const ptyStatus = ptyHealth?.status ?? null;
      const runBecameTerminal = Boolean(statusRow && terminalStatuses.includes(statusRow.status));
      const ptyTerminal = usePtyCapture && ptyStatus !== null && ptyStatus !== 'active';

      // An attached browser may have observed the legitimate PTY startup-pending
      // state before the engine later failed to create any session. Demote that
      // same stream at terminal state and replay the durable wrapper transcript,
      // so the operator sees the startup diagnostic without reconnecting.
      if (usePtyCapture && ptyStatus === null && runBecameTerminal) {
        const fallbackChunks = await query<ChunkRow>(
          `SELECT sequence, chunk
           FROM (
             SELECT sequence, chunk FROM run_output_chunks
             WHERE run_id = $1 ORDER BY sequence DESC LIMIT $2
           ) recent ORDER BY sequence ASC`,
          [runId, RUN_OUTPUT_INITIAL_REPLAY_MAX_CHUNKS],
        );
        res.write(`event: run_meta\ndata: ${JSON.stringify({
          agentType: runMetadata.agentType,
          agentModel: runMetadata.agentModel,
          terminalMode: 'ansi-html',
          lifecyclePhase: statusRow?.lifecycle_status ?? lifecycleFromLegacyStatus(statusRow?.status),
          lifecycle_phase: statusRow?.lifecycle_status ?? lifecycleFromLegacyStatus(statusRow?.status),
          lifecycleStatus: statusRow?.lifecycle_status ?? lifecycleFromLegacyStatus(statusRow?.status),
          lifecycle_status: statusRow?.lifecycle_status ?? lifecycleFromLegacyStatus(statusRow?.status),
          terminal_mode: 'ansi-html',
          requestedTerminalMode,
          requested_terminal_mode: requestedTerminalMode,
          isPty: false,
          ptyAvailable: PTY_AVAILABLE,
          ptyFallbackActive: true,
          ptyFallbackReason: 'pty-session-unavailable',
          ptyUnavailableHint: 'The requested PTY session was never created; showing the durable engine transcript.',
          pty_unavailable_hint: 'The requested PTY session was never created; showing the durable engine transcript.',
          outputSource: RUN_OUTPUT_ANSI_REPLAY_SOURCE,
          output_source: RUN_OUTPUT_ANSI_REPLAY_SOURCE,
          // This stream previously emitted PTY IDs. Tell the browser to reset
          // its persisted cursor before accepting ANSI IDs from a new source.
          cursorReset: true,
          cursor_reset: true,
          ptyReplaySource: RUN_OUTPUT_ANSI_REPLAY_SOURCE,
          pty_replay_source: RUN_OUTPUT_ANSI_REPLAY_SOURCE,
        })}\n\n`);
        if (fallbackChunks[0]?.sequence > 1) {
          res.write(`event: replay_truncated\ndata: ${JSON.stringify({ fromSequence: fallbackChunks[0].sequence, maxChunks: RUN_OUTPUT_INITIAL_REPLAY_MAX_CHUNKS })}\n\n`);
        }
        for (const row of fallbackChunks) {
          const chunkBuf = Buffer.isBuffer(row.chunk) ? row.chunk : Buffer.from(row.chunk);
          if (!(await writeOutputChunkEvent(res, row.sequence, chunkBuf))) {
            cleanupOutputStream();
            return;
          }
          emitSemanticSteps(chunkBuf.toString('utf8'), agent, res);
        }
      }

      if (!statusRow || runBecameTerminal || ptyTerminal) {
        // Never emit done before a bounded cursor batch has fully drained.
        // Queue another non-overlapping poll; an exact-multiple batch simply
        // performs one empty confirmation read before closing.
        if (fetchedBatchIsFull) {
          drainImmediately = true;
        } else {
          cleanupOutputStream();
          res.write('event: done\ndata: \n\n');
          res.end();
        }
      } else if (fetchedBatchIsFull) {
        // Active noisy streams drain in bounded slices without waiting for the
        // recovery interval, while `pollInFlight` prevents overlap.
        drainImmediately = true;
      }
      const elapsedMs = Date.now() - pollStartedAt;
      if (usePtyCapture && elapsedMs > RUN_OUTPUT_PTY_SLOW_POLL_WARN_MS) {
        logger.warn({ runId, elapsedMs, pollIntervalMs: RUN_OUTPUT_PTY_POLL_INTERVAL_MS }, '[pipeline-output] slow PTY DB poll');
      }
    } catch (err: unknown) {
      logger.warn({ err, runId, terminalMode }, '[pipeline-output] transient output poll failure; allowing SSE reconnect');
      cleanupOutputStream();
      // A transport failure is not run completion. Emit a retryable error and
      // end the HTTP response without a `done` marker so EventSource reconnects
      // with Last-Event-ID and resumes exactly where it stopped.
      res.write(`event: stream_error\ndata: ${JSON.stringify({ retryable: true, code: 'OUTPUT_POLL_FAILED', afterSequence: lastSequence })}\n\n`);
      res.end();
    } finally {
      pollInFlight = false;
      if (drainImmediately && !streamClosed && !req.destroyed && !res.destroyed) {
        queueMicrotask(() => { void pollOutput(); });
      }
    }
  };

  // PostgreSQL NOTIFY provides immediate cross-process wakeups after durable
  // chunk commits. The interval remains as loss/reconnect protection.
  unsubscribeOutputWakeup = subscribeRunOutput(runId, () => { void pollOutput(); });
  pollInterval = setInterval(() => { void pollOutput(); }, RUN_OUTPUT_PTY_POLL_INTERVAL_MS);
  if (initialReplayMayHaveMore) void pollOutput();

  if (streamClosed || req.destroyed || res.destroyed) {
    cleanupOutputStream();
  }
});

// ─── Token usage recording helper ─────────────────────────────────────────────
// Inserts into token_usage table with cost calculation from model_pricing.
// Called by both the POST endpoint and WAL auto-record.

interface ModelPricingRow {
  model_id: string;
  input_cost_per_1k: number;
  output_cost_per_1k: number;
}

async function recordTokenUsage(
  runId: number,
  storyId: string,
  inputTokens: number,
  outputTokens: number,
  model?: string,
  reasoningTokens?: number,
  explicitCostUsd?: number,
) {
  const run = await queryOne('SELECT workspace_id FROM pipeline_runs WHERE id = $1', [runId]) as { workspace_id: string } | undefined;
  if (!run) return;

  const modelName = model || 'unknown';
  const pricing = await queryOne('SELECT * FROM model_pricing WHERE model_id = $1', [modelName]) as ModelPricingRow | undefined;

  const derivedCostUsd = pricing
    ? (inputTokens / 1000) * pricing.input_cost_per_1k + (outputTokens / 1000) * pricing.output_cost_per_1k
    : 0;
  const costUsd = explicitCostUsd ?? derivedCostUsd;

  await execute(`INSERT INTO token_usage (run_id, story_id, workspace_id, model, input_tokens, output_tokens, reasoning_tokens, cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [runId, storyId, run.workspace_id, modelName, inputTokens, outputTokens, reasoningTokens ?? 0, Math.round(costUsd * 1_000_000) / 1_000_000]);
}

// ─── POST /api/pipeline/story-result — Record story outcome from run-loop.ts ──
// Called by the TypeScript run-loop to insert story_results rows.

/**
 * @swagger
 * /api/pipeline/story-result:
 *   post:
 *     tags: [Pipeline]
 *     summary: Record a story outcome from the execution engine
 *     operationId: recordStoryResult
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Internal execution-engine closeout write — operator-only because it mutates canonical story result metadata."
 *     description: Called by run-loop.ts or execution-engine.ts to insert a story_results row after a story finishes. Also records token usage into the analytics table when tokens are present.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [runId, storyId, status]
 *             properties:
 *               runId: { type: integer, description: "Pipeline run ID" }
 *               storyId: { type: string, description: "Story ID (e.g. US-001)" }
 *               status: { type: string, enum: [pass, fail, skip, excluded] }
 *               worktreePath: { type: string, nullable: true }
 *               worktreeBranch: { type: string, nullable: true }
 *               commitSha: { type: string, nullable: true, description: "Host-observed story/worktree branch commit" }
 *               commitMessage: { type: string, nullable: true }
 *               inputTokens: { type: integer, nullable: true }
 *               outputTokens: { type: integer, nullable: true }
 *               modelUsed: { type: string, nullable: true }
 *               costUsd: { type: number, nullable: true }
 *               logPath: { type: string, nullable: true }
 *               blockedBy: { type: array, items: { type: string }, nullable: true }
 *               activeSkills: { type: array, items: { type: string }, nullable: true }
 *               completionPacket: { type: object, nullable: true, description: "Bounded agent proposal plus host closeout status; never grants lifecycle authority." }
 *     responses:
 *       201: { description: "Story result recorded" }
 *       400: { description: "Missing required fields or invalid status" }
 *       500: { description: "Internal server error" }
 */
router.post('/story-result', async (req: Request, res: Response) => {
  try {
    const {
      runId, storyId, status, worktreePath, worktreeBranch, commitSha, commitMessage,
      inputTokens, outputTokens, reasoningTokens, modelUsed, costUsd,
      logPath, blockedBy, activeSkills, completionPacket, idempotencyKey,
    } = req.body as {
      runId?: number; storyId?: string; status?: string;
      worktreePath?: string; worktreeBranch?: string; commitSha?: string; commitMessage?: string;
      inputTokens?: number; outputTokens?: number; reasoningTokens?: number; modelUsed?: string; costUsd?: number;
      logPath?: string; blockedBy?: string[]; activeSkills?: string[];
      completionPacket?: Record<string, unknown>;
      idempotencyKey?: string;
    };

    if (!runId || !storyId || !status) {
      throw new ValidationError('runId, storyId, and status are required');
      return;
    }

    if (!['pass', 'fail', 'skip', 'excluded'].includes(status)) {
      throw new ValidationError(`Invalid status: ${status}`);
      return;
    }

    if (commitSha && !/^[0-9a-f]{40}$/i.test(commitSha)) {
      throw new ValidationError('commitSha must be a full git SHA');
    }
    if (completionPacket !== undefined && (completionPacket === null || Array.isArray(completionPacket) || typeof completionPacket !== 'object')) {
      throw new ValidationError('completionPacket must be an object');
    }

    const projection = await queryOne<{
      workspace_id: string;
      spec_path: string;
      branch_name: string | null;
      manifest_hash: string | null;
      spec_revision: string | null;
      story_revision: string | null;
      closeout_decision_id: string | null;
    }>(`
      SELECT pr.workspace_id, pr.spec_path, pr.branch_name,
             sem.manifest_hash, sem.spec_revision, sem.story_revision,
             scd.decision_id AS closeout_decision_id
      FROM pipeline_runs pr
      LEFT JOIN LATERAL (
        SELECT manifest_hash, spec_revision, story_revision
        FROM story_execution_manifests
        WHERE workspace_id = pr.workspace_id AND run_id = pr.id AND story_id = $2
        ORDER BY attempt DESC, created_at DESC LIMIT 1
      ) sem ON TRUE
      LEFT JOIN LATERAL (
        SELECT decision_id
        FROM story_closeout_decisions
        WHERE workspace_id = pr.workspace_id AND run_id = pr.id AND story_id = $2
          AND manifest_hash = sem.manifest_hash
        ORDER BY attempt DESC, created_at DESC LIMIT 1
      ) scd ON TRUE
      WHERE pr.id = $1
    `, [runId, storyId]);
    if (!projection) throw new NotFoundError('Pipeline run not found');
    const specId = path.basename(projection.spec_path, '.json');

    const inserted = await queryOne<{ id: number }>(`INSERT INTO story_results (
         run_id, story_id, status, finished_at, worktree_path, worktree_branch,
         input_tokens, output_tokens, model_used, cost_usd, log_path, blocked_by,
         active_skills, completion_packet, spec_id, spec_revision, story_revision,
         manifest_hash, closeout_decision_id, ingest_key
       ) VALUES (
         $1, $2, $3, NOW(), $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb,
         $14, $15, $16, $17, $18, $19
       )
       ON CONFLICT (ingest_key) WHERE ingest_key IS NOT NULL DO NOTHING
       RETURNING id`, [runId, storyId, status,
      worktreePath ?? null, worktreeBranch ?? null,
      inputTokens ?? null, outputTokens ?? null,
      modelUsed ?? null, costUsd ?? null,
      logPath ?? null,
      blockedBy && blockedBy.length > 0 ? JSON.stringify(blockedBy) : null,
      activeSkills && activeSkills.length > 0 ? JSON.stringify(activeSkills) : null,
      completionPacket ? JSON.stringify(completionPacket) : null,
      specId,
      projection.spec_revision,
      projection.story_revision,
      projection.manifest_hash,
      projection.closeout_decision_id,
      idempotencyKey ?? null,
    ]);

    if (inserted && status === 'pass' && commitSha) {
      await execute(`
        INSERT INTO story_commits (
          story_id, spec_id, workspace_id, run_id, commit_sha, commit_message, author, pushed_at, branch_name, observed_source
        ) VALUES ($1,$2,$3,$4,$5,$6,'rorca-execution-engine',NOW(),$7,'worktree_branch')
        ON CONFLICT DO NOTHING
      `, [
        storyId,
        specId,
        projection.workspace_id,
        runId,
        commitSha,
        commitMessage?.trim() || `story(${storyId}): host-observed output`,
        worktreeBranch ?? projection.branch_name,
      ]);
    }

    // Only the first ingest records analytics. A retry after a response timeout
    // returns the original logical result without double-accounting.
    if (inserted && ((inputTokens && inputTokens > 0) || (outputTokens && outputTokens > 0))) {
      await recordTokenUsage(runId, storyId, inputTokens || 0, outputTokens || 0, modelUsed, reasoningTokens ?? 0, costUsd);
    }

    res.status(inserted ? 201 : 200).json({ ok: true, duplicate: !inserted });
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Story result');
  }
});

// ─── POST /api/pipeline/runs/:runId/stories/:storyId/tokens — Record token usage ─
// Allows run-loop.ts or external callers to report token usage for a story.

/**
 * @swagger
 * /api/pipeline/runs/{runId}/stories/{storyId}/tokens:
 *   post:
 *     tags: [Pipeline]
 *     summary: Record token usage for a story
 *     operationId: recordStoryTokenUsage
 *     description: Updates the story_results row with token counts and records an entry in the token_usage analytics table. Called by run-loop.ts or external callers.
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: storyId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               inputTokens: { type: integer, description: "Number of input tokens consumed" }
 *               outputTokens: { type: integer, description: "Number of output tokens consumed" }
 *               model: { type: string, description: "Model name used for this story" }
 *     responses:
 *       200: { description: "Token usage recorded" }
 *       400: { description: "Invalid runId or missing token counts" }
 *       404: { description: "Story result not found for this run and story" }
 *       500: { description: "Internal server error" }
 */
router.post('/runs/:runId/stories/:storyId/tokens', async (req: Request, res: Response) => {
  try {
    const runId = parseInt(String(req.params.runId), 10);
    const storyId = String(req.params.storyId);
    const { inputTokens, outputTokens, reasoningTokens, model, costUsd } = req.body as {
      inputTokens?: number; outputTokens?: number; reasoningTokens?: number; model?: string; costUsd?: number;
    };

    if (isNaN(runId)) {
      throw new ValidationError('Invalid runId');
      return;
    }

    if (inputTokens == null && outputTokens == null) {
      throw new ValidationError('At least one of inputTokens or outputTokens required');
      return;
    }

    // Find the latest story_result row for this run + storyId
    const row = await queryOne(`SELECT id FROM story_results WHERE run_id = $1 AND story_id = $2 ORDER BY id DESC LIMIT 1`, [runId, storyId]) as { id: number } | undefined;

    if (!row) {
      throw new NotFoundError('Story result not found');
      return;
    }

    await execute(
      `UPDATE story_results
       SET input_tokens = COALESCE($1, input_tokens),
           output_tokens = COALESCE($2, output_tokens),
           cost_usd = COALESCE($3, cost_usd)
       WHERE id = $4`,
      [inputTokens ?? null, outputTokens ?? null, costUsd ?? null, row.id],
    );

    // Also record into token_usage analytics table
    await recordTokenUsage(runId, storyId, inputTokens || 0, outputTokens || 0, model, reasoningTokens ?? 0, costUsd);

    res.json({ ok: true });
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Record tokens');
  }
});

// ─── GET /api/pipeline/runs/:runId/stories/:storyId/output — Last N lines of story output ─
// Extracts the story's log section from the run log file or returns WAL failure info.

/**
 * @swagger
 * /api/pipeline/runs/{runId}/stories/{storyId}/output:
 *   get:
 *     tags: [Pipeline]
 *     summary: Get last N lines of a story's output
 *     operationId: getStoryOutput
 *     description: Returns the tail of a story's log output extracted from the per-story log file, the run log file, or the in-memory buffer. Also includes failure reason and blocked-by info from WAL events.
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: storyId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: lines
 *         schema: { type: integer, default: 20, maximum: 100 }
 *         description: Number of lines to return (max 100)
 *     responses:
 *       200:
 *         description: Story output lines with metadata
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 storyId: { type: string }
 *                 runId: { type: integer }
 *                 status: { type: string }
 *                 retries: { type: integer }
 *                 failureReason: { type: string, nullable: true }
 *                 failureAttempts: { type: integer, nullable: true }
 *                 blockedBy: { type: array, items: { type: string }, nullable: true }
 *                 output: { type: array, items: { type: string } }
 *                 lineCount: { type: integer }
 *       400: { description: "Invalid runId" }
 *       404: { description: "Story result not found" }
 *       500: { description: "Internal server error" }
 */
router.get('/runs/:runId/stories/:storyId/output', async (req: Request, res: Response) => {
  try {
    const runId = parseInt(String(req.params.runId), 10);
    const storyId = String(req.params.storyId);
    const lines = Math.min(parseInt(String(req.query.lines ?? '20'), 10) || 20, 100);

    if (isNaN(runId)) {
      throw new ValidationError('Invalid runId');
      return;
    }

    // 1. Check story_result exists
    const storyResult = await queryOne(`SELECT * FROM story_results WHERE run_id = $1 AND story_id = $2 ORDER BY id DESC LIMIT 1`, [runId, storyId]) as StoryResultRow | undefined;

    if (!storyResult) {
      throw new NotFoundError('Story result not found');
      return;
    }

    // 2. Try to get failure details from WAL events
    const walEvent = await queryOne<{ payload: Record<string, unknown> | string }>(`SELECT payload FROM wal_events WHERE event_type = 'story_failed' AND story_id = $1 AND (payload->>'run_id')::bigint = $2 ORDER BY id DESC LIMIT 1`, [storyId, runId]);

    let failureReason: string | null = null;
    let failureAttempts: number | null = null;
    let blockedBy: string[] | null = null;
    if (walEvent?.payload) {
      try {
        const payload = typeof walEvent.payload === 'string' ? JSON.parse(walEvent.payload) : walEvent.payload;
        failureReason = payload.reason ?? null;
        failureAttempts = payload.attempts ?? null;
        if (Array.isArray(payload.blockedBy)) blockedBy = payload.blockedBy;
      } catch { /* ignore */ }
    }

    // Also check story_results.blocked_by
    if (!blockedBy && (storyResult as any).blocked_by) {
      try {
        blockedBy = JSON.parse((storyResult as any).blocked_by);
      } catch { /* ignore */ }
    }

    // 3. Try reading from per-story log file (log_path in story_results)
    let outputLines: string[] = [];
    const storyLogPath = (storyResult as any).log_path as string | null;
    if (storyLogPath && fs.existsSync(storyLogPath)) {
      try {
        const content = fs.readFileSync(storyLogPath, 'utf-8');
        const allLines = content.split('\n');
        outputLines = allLines.slice(-lines);
      } catch { /* log read error */ }
    }

    // 4. Fallback: Try to extract story output from the run log file
    const logPath = await resolveLogPath(runId);
    if (outputLines.length === 0 && logPath) {
      try {
        const content = fs.readFileSync(logPath, 'utf-8');
        const allLines = content.split('\n');

        // Find the section for this story by searching for story start/end markers
        const storyStartPattern = new RegExp(`(^|\\s)${storyId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$|:)`);
        let startIdx = -1;
        let endIdx = allLines.length;

        for (let i = 0; i < allLines.length; i++) {
          if (storyStartPattern.test(allLines[i])) {
            startIdx = i;
          }
        }

        if (startIdx >= 0) {
          // Find next story start after this one
          for (let i = startIdx + 1; i < allLines.length; i++) {
            // Next story starts with a different US-XXX or story ID pattern
            if (/^(US-\d+|[A-Z]+-\d+)\s/.test(allLines[i]) && !storyStartPattern.test(allLines[i])) {
              endIdx = i;
              break;
            }
          }
          const storySection = allLines.slice(startIdx, endIdx);
          outputLines = storySection.slice(-lines);
        } else {
          // Fallback: return last N lines of the entire log
          outputLines = allLines.slice(-lines);
        }
      } catch { /* log read error */ }
    }

    // 4. If no log output, try in-memory buffer
    if (outputLines.length === 0) {
      const buf = outputBuffers.get(runId);
      if (buf) {
        const fullText = buf.chunks.join('');
        const allLines = fullText.split('\n');
        // Try to find story section in buffer too
        const storyStartPattern = new RegExp(`(^|\\s)${storyId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$|:)`);
        let startIdx = -1;
        for (let i = 0; i < allLines.length; i++) {
          if (storyStartPattern.test(allLines[i])) {
            startIdx = i;
          }
        }
        if (startIdx >= 0) {
          outputLines = allLines.slice(startIdx).slice(-lines);
        } else {
          outputLines = allLines.slice(-lines);
        }
      }
    }

    res.json({
      storyId,
      runId,
      status: storyResult.status,
      retries: storyResult.retries,
      failureReason,
      failureAttempts,
      blockedBy,
      output: outputLines,
      lineCount: outputLines.length,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Story output');
  }
});

// ─── GET /api/pipeline/runs/:runId/stories/:storyId/log — SSE per-story log stream ─
// Streams a per-story log file as SSE chunks (same protocol as /runs/:runId/output).
// Used by the multi-pane terminal grid when parallelism > 1.

/**
 * @swagger
 * /api/pipeline/runs/{runId}/stories/{storyId}/log:
 *   get:
 *     tags: [Pipeline]
 *     summary: Stream per-story log output via SSE
 *     operationId: streamStoryLog
 *     description: Opens an SSE connection that streams a per-story log file in real time. Used by the multi-pane terminal grid for parallel story execution. Emits base64-encoded output chunks and semantic_step events.
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: storyId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: SSE stream of log chunks
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 *       400: { description: "Invalid runId" }
 */
router.get('/runs/:runId/stories/:storyId/log', async (req: Request, res: Response) => {
  const runId = parseInt(String(req.params.runId), 10);
  const storyId = String(req.params.storyId);
  if (isNaN(runId)) {
    throw new ValidationError('Invalid runId');
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');

  const hb = setInterval(() => res.write(': hb\n\n'), 15_000);

  // Semantic parsing may proceed with an explicit unknown engine, but never
  // claim that missing historical metadata was Claude.
  const runRow = await queryOne('SELECT agent, agent_type, workspace_id FROM pipeline_runs WHERE id = $1', [runId]) as { agent: string | null; agent_type: string | null; workspace_id: string } | undefined;
  const agent = normalizeRunMetadata(runRow ?? {}).agentType;

  // Find story log file: check WAL event payload first, then scan forge/logs/
  let storyLogPath: string | null = null;

  // 1. Check story_started WAL event for log_file path
  const walRow = await queryOne<{ payload: Record<string, unknown> | string }>(`SELECT payload FROM wal_events WHERE event_type = 'story_started' AND story_id = $1 AND (payload->>'run_id')::bigint = $2 ORDER BY id DESC LIMIT 1`, [storyId, runId]);
  if (walRow?.payload) {
    try {
      const payload = typeof walRow.payload === 'string' ? JSON.parse(walRow.payload) : walRow.payload;
      if (payload.log_file && fs.existsSync(String(payload.log_file))) {
        storyLogPath = payload.log_file;
      }
    } catch { /* ignore */ }
  }

  // 2. Fallback: scan forge/specs/logs/ and forge/logs/ for <storyId>_*.log pattern
  if (!storyLogPath && runRow?.workspace_id) {
    const workspace = await queryOne('SELECT path FROM workspaces WHERE id = $1', [runRow.workspace_id]) as { path: string } | undefined;
    if (workspace) {
      // Check both log directories — execution-engine writes to forge/specs/logs/ (relative to spec JSON path)
      const logDirs = [
        path.join(workspace.path, 'forge', 'specs', 'logs'),
        path.join(workspace.path, 'forge', 'logs'),
      ];
      for (const logDir of logDirs) {
        if (storyLogPath) break;
        if (fs.existsSync(logDir)) {
          try {
            const files = fs.readdirSync(logDir)
              .filter(f => f.startsWith(`${storyId}_`) && f.endsWith('.log'))
              .sort()
              .reverse(); // most recent first
            if (files.length > 0) {
              storyLogPath = path.join(logDir, files[0]);
            }
          } catch { /* ignore */ }
        }
      }
    }
  }

  if (!storyLogPath) {
    // No log file yet — send waiting status, then poll until it appears or story finishes
    res.write(`event: status\ndata: waiting\n\n`);

    // Poll every 3s for the log file to appear (slow interval to avoid pool exhaustion under parallelism)
    const wsPath = runRow?.workspace_id
      ? (await queryOne('SELECT path FROM workspaces WHERE id = $1', [runRow.workspace_id]) as { path: string } | undefined)?.path
      : undefined;
    const pollForLog = setInterval(async () => {
      try {
        // Re-check WAL event — use JSONB accessor instead of payload::text LIKE (10x faster)
        const freshWal = await queryOne<{ payload: Record<string, unknown> }>(
          `SELECT payload FROM wal_events WHERE event_type = 'story_started' AND story_id = $1 AND (payload->>'run_id')::bigint = $2 ORDER BY id DESC LIMIT 1`,
          [storyId, runId]
        );
        if (freshWal?.payload) {
          const payload = typeof freshWal.payload === 'string' ? JSON.parse(freshWal.payload) : freshWal.payload;
          if (payload.log_file && fs.existsSync(String(payload.log_file))) {
            storyLogPath = String(payload.log_file);
            clearInterval(pollForLog);
            startTailing(storyLogPath!, agent, res, hb, runId, storyId);
            return;
          }
        }

        // Filesystem fallback: scan forge/specs/logs/ and forge/logs/ for the log file
        if (!storyLogPath && wsPath) {
          const fallbackDirs = [
            path.join(wsPath, 'forge', 'specs', 'logs'),
            path.join(wsPath, 'forge', 'logs'),
          ];
          for (const dir of fallbackDirs) {
            if (storyLogPath) break;
            if (fs.existsSync(dir)) {
              try {
                const files = fs.readdirSync(dir)
                  .filter(f => f.startsWith(`${storyId}_`) && f.endsWith('.log'))
                  .sort()
                  .reverse();
                if (files.length > 0) {
                  storyLogPath = path.join(dir, files[0]);
                  clearInterval(pollForLog);
                  startTailing(storyLogPath!, agent, res, hb, runId, storyId);
                  return;
                }
              } catch { /* ignore */ }
            }
          }
        }

        // Check if story already finished (no log will come)
        const finishEvent = await queryOne(
          `SELECT id FROM wal_events WHERE event_type IN ('story_passed', 'story_failed', 'story_skipped') AND story_id = $1 AND (payload->>'run_id')::bigint = $2 LIMIT 1`,
          [storyId, runId]
        );
        if (finishEvent) {
          clearInterval(pollForLog);
          clearInterval(hb);
          res.write('event: done\ndata: \n\n');
          res.end();
        }
      } catch {
        // Swallow DB connection errors — they're transient under heavy load.
        // The next poll tick will retry.
      }
    }, 3000);

    req.on('close', () => {
      clearInterval(pollForLog);
      clearInterval(hb);
    });
    return;
  }

  // Log file exists — start tailing
  startTailing(storyLogPath, agent, res, hb, runId, storyId);

  req.on('close', () => {
    clearInterval(hb);
  });
});

/** Tail a story log file and stream as SSE chunks. */
async function startTailing(logPath: string, agent: string, res: Response, hb: ReturnType<typeof setInterval>, runId: number, storyId: string): Promise<void> {
  // Replay existing content
  let offset = 0;
  try {
    const existing = fs.readFileSync(logPath);
    if (existing.length > 0) {
      res.write(`event: chunk\ndata: ${existing.toString('base64')}\n\n`);
      emitSemanticSteps(existing.toString('utf8'), agent, res);
    }
    offset = existing.length;
  } catch { /* file may have disappeared */ }

  // Check if story already finished
  const finishEvent = await queryOne(`SELECT id FROM wal_events WHERE event_type IN ('story_passed', 'story_failed', 'story_skipped') AND story_id = $1 AND (payload->>'run_id')::bigint = $2 LIMIT 1`, [storyId, runId]);
  if (finishEvent) {
    clearInterval(hb);
    res.write('event: done\ndata: \n\n');
    res.end();
    return;
  }

  // Tail the log file — poll for new bytes every 200 ms
  const tailInterval = setInterval(async () => {
    try {
      const stat = fs.statSync(logPath);
      if (stat.size > offset) {
        const newBytes = Buffer.alloc(stat.size - offset);
        const fd = fs.openSync(logPath, 'r');
        fs.readSync(fd, newBytes, 0, newBytes.length, offset);
        fs.closeSync(fd);
        offset = stat.size;
        const text = newBytes.toString('utf8');
        res.write(`event: chunk\ndata: ${newBytes.toString('base64')}\n\n`);
        emitSemanticSteps(text, agent, res);
      }

      // Check if story finished
      const done = await queryOne(`SELECT id FROM wal_events WHERE event_type IN ('story_passed', 'story_failed', 'story_skipped') AND story_id = $1 AND (payload->>'run_id')::bigint = $2 LIMIT 1`, [storyId, runId]);
      if (done) {
        // Read any final bytes
        const finalStat = fs.statSync(logPath);
        if (finalStat.size > offset) {
          const finalBytes = Buffer.alloc(finalStat.size - offset);
          const fd = fs.openSync(logPath, 'r');
          fs.readSync(fd, finalBytes, 0, finalBytes.length, offset);
          fs.closeSync(fd);
          res.write(`event: chunk\ndata: ${finalBytes.toString('base64')}\n\n`);
          emitSemanticSteps(finalBytes.toString('utf8'), agent, res);
        }
        clearInterval(tailInterval);
        clearInterval(hb);
        res.write('event: done\ndata: \n\n');
        res.end();
      }
    } catch {
      clearInterval(tailInterval);
      clearInterval(hb);
      res.write('event: done\ndata: \n\n');
      res.end();
    }
  }, 200);

  res.req?.on('close', () => {
    clearInterval(tailInterval);
    clearInterval(hb);
  });
}

// ─── GET /api/pipeline/runs/:runId/stories/:storyId/stream — DB-backed story output SSE ───

/**
 * @swagger
 * /api/pipeline/runs/{runId}/stories/{storyId}/stream:
 *   get:
 *     tags: [Pipeline]
 *     summary: Stream per-story prose output via SSE (DB-backed)
 *     operationId: streamStoryOutput
 *     description: >
 *       Opens an SSE connection that replays all existing story_output_chunks rows
 *       for the given (runId, storyId), then polls for new rows every 200ms.
 *       Emits base64-encoded output chunks and semantic_step events.
 *       Terminates when the story has a completion WAL event.
 *       Falls back to file-based tailing if no DB chunks exist.
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: storyId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: SSE stream of output chunks
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 *       400: { description: "Invalid runId" }
 */
router.get('/runs/:runId/stories/:storyId/stream', async (req: Request, res: Response) => {
  let hb: ReturnType<typeof setInterval> | undefined;
  try {
  const runId = Number(req.params.runId);
  const storyId = String(req.params.storyId);
  if (!Number.isFinite(runId) || runId <= 0) {
    res.status(400).json({ error: 'Invalid runId' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');

  hb = setInterval(() => res.write(': hb\n\n'), 15_000);
  let closed = false;
  let pollInterval: ReturnType<typeof setInterval> | null = null;

  // Single close handler — clears all intervals on client disconnect
  req.on('close', () => {
    closed = true;
    clearInterval(hb);
    if (pollInterval) clearInterval(pollInterval);
  });

  // Semantic parsing may proceed with an explicit unknown engine, but never
  // claim that missing historical metadata was Claude.
  const runRow = await queryOne<{ agent: string | null; agent_type: string | null; workspace_id: string }>(
    'SELECT agent, agent_type, workspace_id FROM pipeline_runs WHERE id = $1', [runId]
  );
  const agent = normalizeRunMetadata(runRow ?? {}).agentType;

  // ── Replay phase: send all existing chunks ──
  // (may be empty if StoryLogFollower hasn't written yet — poll loop will pick them up)
  let lastSeq = -1;
  const existingRows = await query<{ chunk: string; sequence: number }>(
    'SELECT chunk, sequence FROM story_output_chunks WHERE run_id = $1 AND story_id = $2 ORDER BY sequence',
    [runId, storyId]
  );
  for (const row of existingRows) {
    if (closed) return;
    const buf = Buffer.from(row.chunk, 'utf8');
    res.write(`event: output\ndata: ${buf.toString('base64')}\n\n`);
    emitSemanticSteps(row.chunk, agent, res);
    lastSeq = row.sequence;
  }

  // Check if story already finished before entering poll loop
  if (await isStoryDone(runId, storyId)) {
    clearInterval(hb);
    if (!closed) {
      res.write('event: done\ndata: \n\n');
      res.end();
    }
    return;
  }

  // ── Live poll phase: 200ms interval ──
  pollInterval = setInterval(async () => {
    if (closed) {
      if (pollInterval) clearInterval(pollInterval);
      return;
    }
    try {
      const newRows = await query<{ chunk: string; sequence: number }>(
        'SELECT chunk, sequence FROM story_output_chunks WHERE run_id = $1 AND story_id = $2 AND sequence > $3 ORDER BY sequence',
        [runId, storyId, lastSeq]
      );
      for (const row of newRows) {
        if (closed) { if (pollInterval) clearInterval(pollInterval); return; }
        const buf = Buffer.from(row.chunk, 'utf8');
        res.write(`event: output\ndata: ${buf.toString('base64')}\n\n`);
        emitSemanticSteps(row.chunk, agent, res);
        lastSeq = row.sequence;
      }

      // Check for story completion
      if (await isStoryDone(runId, storyId)) {
        // Drain any remaining chunks
        const finalRows = await query<{ chunk: string; sequence: number }>(
          'SELECT chunk, sequence FROM story_output_chunks WHERE run_id = $1 AND story_id = $2 AND sequence > $3 ORDER BY sequence',
          [runId, storyId, lastSeq]
        );
        for (const row of finalRows) {
          if (closed) break;
          const buf = Buffer.from(row.chunk, 'utf8');
          res.write(`event: output\ndata: ${buf.toString('base64')}\n\n`);
          emitSemanticSteps(row.chunk, agent, res);
        }
        if (pollInterval) clearInterval(pollInterval);
        clearInterval(hb);
        if (!closed) {
          res.write('event: done\ndata: \n\n');
          res.end();
        }
      }
    } catch {
      // Swallow transient DB errors — next tick retries
    }
  }, 200);
  } catch {
    clearInterval(hb);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Stream setup failed' });
    } else {
      res.end();
    }
  }
});

/** Check whether a story completion WAL event exists. */
async function isStoryDone(runId: number, storyId: string): Promise<boolean> {
  const row = await queryOne(
    `SELECT id FROM wal_events WHERE event_type IN ('story_passed', 'story_failed', 'story_skipped') AND story_id = $1 AND (payload->>'run_id')::bigint = $2 LIMIT 1`,
    [storyId, runId]
  );
  return !!row;
}

// ─── GET /api/pipeline/stream — SSE event stream ─────────────────────────────

const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * @swagger
 * /api/pipeline/stream:
 *   get:
 *     tags: [Pipeline]
 *     summary: Stream WAL events (SSE)
 *     operationId: streamPipelineEvents
 *     description: >
 *       Server-Sent Events stream of WAL events (story progress).
 *       Events are pushed in real-time via PostgreSQL LISTEN/NOTIFY through the sse-hub.
 *     parameters:
 *       - in: query
 *         name: runId
 *         schema: { type: string }
 *         description: Filter events for a specific run
 *     responses:
 *       200:
 *         description: SSE stream of WAL events
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 */
router.get('/stream', async (_req: Request, res: Response) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // Send initial keepalive
  res.write(': keepalive\n\n');

  // Wire up real-time broadcast via sse-hub.
  // Events arrive from the dedicated LISTEN/NOTIFY client (wal-listener.ts)
  // which calls broadcastAll() on every pg notification.
  const unsubscribe = attachSSE(res);

  // Heartbeat every 15s
  const heartbeatInterval = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, HEARTBEAT_INTERVAL_MS);

  _req.on('close', () => {
    unsubscribe();
    clearInterval(heartbeatInterval);
  });
});

// ─── GET /api/pipeline/runs/:runId/log — Download raw log file ───────────────

/**
 * @swagger
 * /api/pipeline/runs/{runId}/log:
 *   get:
 *     tags: [Pipeline]
 *     summary: Download raw pipeline log file
 *     operationId: downloadPipelineLog
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Raw run logs are read-only debugging output that the local CLI contract explicitly supports."
 *     x-rorca-public-api: true
 *     description: Returns the raw log file for a completed pipeline run as a downloadable text/plain attachment.
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Raw log file
 *         content:
 *           text/plain:
 *             schema: { type: string }
 *       404: { description: "Log file not found" }
 */
router.get('/runs/:runId/log', async (req: Request, res: Response) => {
  const runId = parseInt(String(req.params.runId), 10);
  if (isNaN(runId)) {
    throw new ValidationError('Invalid runId');
    return;
  }

  const logPath = await resolveLogPath(runId);
  if (!logPath) {
    throw new NotFoundError('Log file not found for this run');
    return;
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="run-${runId}.log"`);
  const stream = fs.createReadStream(logPath);
  stream.pipe(res);
  stream.on('error', () => {
    res.status(500).json({ error: 'Failed to read log file' });
  });
});

// ─── Log cleanup: delete logs older than 30 days ─────────────────────────────

const LOG_RETENTION_DAYS = 30;

export async function cleanupOldLogs(): Promise<number> {
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let deleted = 0;

  // Clean logs referenced in pipeline_runs.log_path
  const rows = await query(`SELECT id, log_path FROM pipeline_runs WHERE log_path IS NOT NULL AND finished_at IS NOT NULL`) as { id: number; log_path: string }[];

  for (const row of rows) {
    try {
      if (fs.existsSync(row.log_path)) {
        const stat = fs.statSync(row.log_path);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(row.log_path);
          deleted++;
        }
      }
    } catch { /* ignore individual file errors */ }
  }

  // Also clean legacy /tmp logs for old runs without log_path
  const legacyRows = await query(`SELECT id FROM pipeline_runs WHERE log_path IS NULL AND finished_at IS NOT NULL`) as { id: number }[];

  for (const row of legacyRows) {
    try {
      const legacy = tmpLogPath(row.id);
      if (fs.existsSync(legacy)) {
        const stat = fs.statSync(legacy);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(legacy);
          deleted++;
        }
      }
    } catch { /* ignore */ }
  }

  if (deleted > 0) {
    logger.info(`[Pipeline] Cleaned up ${deleted} log file(s) older than ${LOG_RETENTION_DAYS} days`);
  }
  return deleted;
}

// ─── GET /api/pipeline/runs/:runId/commits — Git log for run's branch ────────

/**
 * @swagger
 * /api/pipeline/runs/{runId}/commits:
 *   get:
 *     tags: [Pipeline]
 *     summary: Get git commits for a pipeline run's branch
 *     operationId: getPipelineRunCommits
 *     description: Returns the list of git commits made on the pipeline run's feature branch since it diverged from main.
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: List of commits on the run's branch
 *       404: { description: "Run not found" }
 */
router.get('/runs/:runId/commits', async (req: Request, res: Response) => {
  try {
    const runId = parseInt(String(req.params.runId), 10);
    if (isNaN(runId)) {
      throw new ValidationError('Invalid runId');
      return;
    }

    const run = await queryOne('SELECT * FROM pipeline_runs WHERE id = $1', [runId]) as PipelineRunRow | undefined;

    if (!run) {
      throw new NotFoundError('Run not found');
      return;
    }

    const workspace = await queryOne('SELECT path FROM workspaces WHERE id = $1', [run.workspace_id]) as { path: string } | undefined;

    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const gitCwd = run.worktree_path || workspace.path;
    const git = simpleGit(gitCwd);

    // If branch_name is set, get commits on that branch since it diverged from main/master
    // Otherwise get recent commits on whatever branch the workspace is on
    const branchName = run.branch_name;
    let commits: Array<{ sha: string; message: string; date: string; author: string }> = [];

    try {
      if (branchName) {
        // Find the merge-base to only show commits on the feature branch
        let baseRef = 'main';
        try {
          await git.raw(['rev-parse', '--verify', 'main']);
        } catch {
          try {
            await git.raw(['rev-parse', '--verify', 'master']);
            baseRef = 'master';
          } catch {
            // No main/master — just show last 50 commits on the branch
            baseRef = '';
          }
        }

        const log = await git.log({ from: baseRef || undefined, to: branchName, maxCount: 100 });
        commits = log.all.map((c) => ({
          sha: c.hash,
          message: c.message,
          date: c.date,
          author: c.author_name,
        }));
      } else {
        // No branch — show commits since run started
        const log = await git.log({ maxCount: 50, '--after': run.started_at });
        commits = log.all.map((c) => ({
          sha: c.hash,
          message: c.message,
          date: c.date,
          author: c.author_name,
        }));
      }
    } catch (gitErr: any) {
      // Branch may not exist yet or repo issues
      logger.warn(`[Pipeline] Git log error for run ${runId}:`, gitErr.message);
    }

    res.json({ commits, branchName: branchName || null });
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Get run commits');
  }
});

// ─── SL-004: Skills Usage Per-Run API Endpoint ──────────────────────────────

/**
 * @swagger
 * /api/pipeline/runs/{runId}/skills:
 *   get:
 *     summary: Get per-story skill usage data for a specific pipeline run
 *     tags: [Pipeline]
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Skill usage data with per-story breakdown and run-level summary
 *       400:
 *         description: Invalid runId
 *       404:
 *         description: Run not found
 */
router.get('/runs/:runId/skills', async (req: Request, res: Response) => {
  try {
    const runId = parseInt(String(req.params.runId), 10);
    if (isNaN(runId)) {
      throw new ValidationError('Invalid runId');
      return;
    }

    const run = await queryOne('SELECT id, spec_path, workspace_id, status FROM pipeline_runs WHERE id = $1', [runId]) as { id: number; spec_path: string; workspace_id: string; status: string } | undefined;

    if (!run) {
      throw new NotFoundError('Run not found');
      return;
    }

    // Get all story results for this run
    const storyRows = await query('SELECT story_id, status, active_skills FROM story_results WHERE run_id = $1 ORDER BY id ASC', [runId]) as Array<{ story_id: string; status: string; active_skills: string | null }>;

    // Try to read spec JSON for suggestedSkills and story titles
    const workspace = await queryOne('SELECT path FROM workspaces WHERE id = $1', [run.workspace_id]) as { path: string } | undefined;

    let specStories: Array<{
      id: string;
      title: string;
      suggestedSkills?: Array<{ name: string; relevance: number; reason: string }>;
    }> = [];

    if (workspace) {
      try {
        const absSpecPath = path.join(workspace.path, run.spec_path);
        const specJson = JSON.parse(fs.readFileSync(absSpecPath, 'utf-8'));
        specStories = specJson.userStories || [];
      } catch {
        // Spec file missing/unreadable — titles and relevance will be null
      }
    }

    // Build title and suggestedSkills lookup maps
    const titleMap = new Map<string, string>();
    const skillSuggestionsMap = new Map<string, Array<{ name: string; relevance: number; reason: string }>>();
    for (const s of specStories) {
      titleMap.set(s.id, s.title);
      if (s.suggestedSkills) {
        skillSuggestionsMap.set(s.id, s.suggestedSkills);
      }
    }

    // Get installed skill descriptions
    const installedSkills = await query('SELECT name, description FROM installed_skills') as Array<{ name: string; description: string }>;
    const descriptionMap = new Map<string, string>();
    for (const sk of installedSkills) {
      descriptionMap.set(sk.name, sk.description);
    }

    // Build per-story data. During an active run, story_results may not exist yet;
    // fall back to spec stories so matched/scheduled skills are visible while execution is in progress.
    const skillCounts = new Map<string, { count: number; passCount: number; totalCount: number }>();
    const storyRowMap = new Map(storyRows.map((row) => [row.story_id, row]));
    const orderedStoryIds = [
      ...specStories.map((story) => story.id),
      ...storyRows.map((row) => row.story_id).filter((storyId) => !titleMap.has(storyId)),
    ];

    const perStory = orderedStoryIds.map((storyId) => {
      const row = storyRowMap.get(storyId);
      let activeSkillNames: string[] = [];
      if (row?.active_skills) {
        try {
          activeSkillNames = JSON.parse(row.active_skills);
        } catch { /* malformed JSON */ }
      }

      const suggestions = skillSuggestionsMap.get(storyId) || [];
      const suggestionMap = new Map<string, { relevance: number; reason: string }>();
      for (const s of suggestions) {
        suggestionMap.set(s.name, { relevance: s.relevance, reason: s.reason });
      }

      // If active_skills was never recorded (older runs or in-flight stories), fall back to suggestedSkills from spec.
      const skillNamesToShow = activeSkillNames.length > 0
        ? activeSkillNames
        : suggestions.map(s => s.name);

      const skills = skillNamesToShow.map((name) => {
        const suggestion = suggestionMap.get(name);
        return {
          name,
          relevance: suggestion?.relevance ?? null,
          reason: suggestion?.reason ?? null,
          description: descriptionMap.get(name) ?? null,
          category: null as string | null,
        };
      });

      const storyStatus = row?.status ?? (run.status === 'running' || run.status === 'queued' ? 'pending' : 'not_run');

      // Update frequency counts (use the names actually shown)
      for (const name of skillNamesToShow) {
        const existing = skillCounts.get(name) || { count: 0, passCount: 0, totalCount: 0 };
        existing.count++;
        existing.totalCount++;
        if (storyStatus === 'pass') existing.passCount++;
        skillCounts.set(name, existing);
      }

      return {
        storyId,
        storyTitle: titleMap.get(storyId) || storyId,
        storyStatus,
        skills,
      };
    });

    // Build summary
    const skillFrequency = Array.from(skillCounts.entries())
      .map(([name, data]) => ({
        name,
        count: data.count,
        passRate: data.totalCount > 0 ? data.passCount / data.totalCount : 0,
        category: null as string | null,
      }))
      .sort((a, b) => b.count - a.count);

    const uniqueSkills = skillFrequency.map((s) => s.name);
    const storiesWithSkills = perStory.filter((s) => s.skills.length > 0).length;
    const storiesWithoutSkills = perStory.filter((s) => s.skills.length === 0).length;
    const totalSkillInjections = perStory.reduce((sum, s) => sum + s.skills.length, 0);

    res.json({
      runId,
      perStory,
      summary: {
        totalSkillInjections,
        uniqueSkills,
        skillFrequency,
        storiesWithSkills,
        storiesWithoutSkills,
      },
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Get run skills');
  }
});

/**
 * @swagger
 * /api/pipeline/runs/{runId}/wal-events:
 *   get:
 *     summary: Get all WAL events for a specific run
 *     tags: [Pipeline]
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Array of WAL events ordered by id ASC
 *       400:
 *         description: Invalid runId
 */
router.get('/runs/:runId/wal-events', async (req: Request, res: Response) => {
  try {
    const runId = parseInt(String(req.params.runId), 10);
    if (isNaN(runId)) {
      throw new ValidationError('Invalid runId');
    }

    const events = await query<{
      id: number;
      ts: string;
      event_type: string;
      workspace_id: string | null;
      spec_id: string | null;
      story_id: string | null;
      actor: string;
      payload: string | null;
    }>(
      `SELECT id, ts, event_type, workspace_id, spec_id, story_id, actor, payload
       FROM wal_events
       WHERE (payload->>'run_id')::bigint = $1
       ORDER BY id ASC`,
      [runId]
    );

    res.json({ events });
  } catch (error: any) {
    handleRouteError(res, error, '[Pipeline] Get run WAL events');
  }
});

// ─── OC-015: Orphan Process Cleanup on Backend Startup ──────────────────────
// Scans pipeline_runs WHERE status='running', kills orphan PIDs (engine + OpenCode server),
// marks runs as failed. Called once at server startup.

export async function cleanupOrphanRuns(): Promise<number> {
  // Guard: if any worker has checked in within the last 90s, it owns lifecycle management — skip entirely
  try {
    const activeWorker = await queryOne<{ worker_id: string }>(
      `SELECT worker_id FROM worker_heartbeat WHERE last_seen > NOW() - INTERVAL '90 seconds' LIMIT 1`
    );
    if (activeWorker) {
      logger.info(`[Cleanup] Active worker detected (${activeWorker.worker_id}), skipping orphan cleanup`);
      return 0;
    }
  } catch {
    // worker_heartbeat table may not exist on first startup — proceed with cleanup
  }

  const staleRuns = await query(`SELECT id, pid, opencode_server_pid, workspace_id, agent_type FROM pipeline_runs WHERE status IN ('running', 'paused')`) as Array<{
    id: number;
    pid: number | null;
    opencode_server_pid: number | null;
    workspace_id: string;
    agent_type: string | null;
  }>;

  if (staleRuns.length === 0) return 0;

  let cleaned = 0;

  for (const run of staleRuns) {
    // Skip runs with an active or queued pg-boss job — includes 'retry' state which was previously missed
    try {
      const pgBossJob = await queryOne<{ id: string }>(
        `SELECT id FROM pgboss.job WHERE name IN ('pipeline:run', 'pipeline:retry') AND data->>'runId' = $1 AND state IN ('created', 'active', 'retry') LIMIT 1`,
        [String(run.id)]
      );
      if (pgBossJob) {
        logger.info(`[Cleanup] Skipping run ${run.id} — active pg-boss job ${pgBossJob.id} found`);
        continue;
      }
    } catch {
      // pgboss schema may not exist yet — treat as no active job, proceed with cleanup
    }

    // Only clean up runs whose PID is no longer alive
    if (run.pid) {
      try {
        process.kill(run.pid, 0); // Throws if process is dead
        // Process is still alive — skip, it may be legitimately running without a worker
        logger.info(`[Cleanup] Skipping run ${run.id} — PID ${run.pid} is still alive`);
        continue;
      } catch {
        // Process is dead — safe to clean up
      }
    }

    // Kill OpenCode server process (if alive)
    if (run.opencode_server_pid) {
      try {
        process.kill(run.opencode_server_pid, 0); // Check alive
        try {
          process.kill(run.opencode_server_pid, 'SIGTERM');
          logger.info(`[Cleanup] Sent SIGTERM to OpenCode server PID ${run.opencode_server_pid} (run ${run.id})`);
        } catch { /* already dead */ }
      } catch {
        // Process already dead — expected
      }
    }

    // Mark run as failed
    await execute(`UPDATE pipeline_runs SET status = 'failed', finished_at = NOW() WHERE id = $1`, [run.id]);

    // Emit WAL event
    try {
      const walEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('orphan_cleanup', $1, $2)` + ' RETURNING *', [run.workspace_id, JSON.stringify({
        run_id: run.id,
        status: 'failed',
        reason: 'orphan_cleanup',
        error: 'Run was still marked as running after backend restart — process likely crashed.',
        agent_type: normalizeRunAgentType(run.agent_type),
      })]);
      broadcastAll(walEvent!);
    } catch {
      // WAL emit failure is non-fatal during startup cleanup
    }

    cleaned++;
    logger.info(`[Cleanup] Run ${run.id} (agent: ${normalizeRunAgentType(run.agent_type)}) marked as failed (orphan cleanup)`);
  }

  if (cleaned > 0) {
    logger.info(`[Cleanup] Cleaned up ${cleaned} orphan run(s)`);
  }

  return cleaned;
}

/**
 * @swagger
 * /api/pipeline/queue:
 *   post:
 *     summary: Smart run trigger — start immediately or queue if a run is active
 *     description: >
 *       Checks for an active run in the workspace. If none, triggers the run immediately.
 *       If one is active, queues the run and returns its position. Accepts workspaceId + specId
 *       (filename slug) instead of specPath for convenience.
 *     tags: [Pipeline]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, specId]
 *             properties:
 *               workspaceId:
 *                 type: string
 *                 description: Rorca workspace ID
 *               specId:
 *                 type: string
 *                 description: Spec slug (filename without .json)
 *     responses:
 *       200:
 *         description: Run started immediately
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 queued:
 *                   type: boolean
 *                   example: false
 *                 runId:
 *                   type: number
 *                 message:
 *                   type: string
 *                   example: "Run started immediately"
 *       202:
 *         description: Run queued (active run exists)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 queued:
 *                   type: boolean
 *                   example: true
 *                 queuePosition:
 *                   type: number
 *                 activeRunId:
 *                   type: number
 *                 message:
 *                   type: string
 *                   example: "Run queued, position 2"
 *       404:
 *         description: Workspace or spec not found
 */
router.post('/queue', async (req: Request, res: Response) => {
  try {
    const { workspaceId, specId } = req.body as { workspaceId?: string; specId?: string };

    if (!workspaceId || !specId) {
      throw new ValidationError('workspaceId and specId are required');
      return;
    }

    // Validate workspace exists
    const workspace = await queryOne('SELECT id FROM workspaces WHERE id = $1', [workspaceId]) as
      { id: string } | undefined;
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    // Validate spec file exists
    const workspaceRow = await queryOne('SELECT path FROM workspaces WHERE id = $1', [workspaceId]) as
      { path: string } | undefined;
    const specPath = `forge/specs/approved/${specId}.json`;
    const absSpecPath = path.join(workspaceRow!.path, specPath);
    if (!fs.existsSync(absSpecPath)) {
      throw new NotFoundError(`Spec not found at ${specPath}`);
      return;
    }

    // Check for active run
    const activeRun = await queryOne(
      `SELECT id FROM pipeline_runs WHERE workspace_id = $1 AND status IN ('running', 'paused', 'pi_native') LIMIT 1`,
      [workspaceId]
    ) as { id: number } | undefined;

    if (!activeRun) {
      // No active run — trigger immediately
      const triggerRes = await fetch(`http://localhost:${process.env.PORT || 3030}/api/pipeline/trigger`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, specPath }),
      });
      const triggerData = await triggerRes.json() as Record<string, unknown>;
      if (!triggerRes.ok) {
        res.status(triggerRes.status).json(triggerData);
        return;
      }
      res.json({
        queued: false,
        runId: triggerData.runId,
        message: 'Run started immediately',
      });
      return;
    }

    // Active run exists — queue it
    const triggerRes = await fetch(`http://localhost:${process.env.PORT || 3030}/api/pipeline/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, specPath, queue: true }),
    });
    const triggerData = await triggerRes.json() as Record<string, unknown>;
    if (!triggerRes.ok) {
      res.status(triggerRes.status).json(triggerData);
      return;
    }
    const queuePosition = (triggerData.position as number) ?? 1;
    res.status(202).json({
      queued: true,
      queuePosition,
      activeRunId: activeRun.id,
      message: `Run queued, position ${queuePosition}`,
    });
  } catch (err) {
    handleRouteError(res, err, '[Pipeline] Queue run');
  }
});

// ─── GET /api/pipeline/runs/:id/dlq — Check if run's job is in DLQ ──────────

/**
 * @swagger
 * /api/pipeline/runs/{id}/dlq:
 *   get:
 *     tags: [Pipeline]
 *     summary: Get DLQ entry for a run
 *     operationId: getRunDlq
 *     description: >
 *       Returns the dead-letter-queue entry for a pipeline run's job if it
 *       exhausted all pg-boss retries. Returns 404 if the run's job is not in
 *       the DLQ. Wraps pgboss.archive queries in try/catch — returns 404 on
 *       fresh installs where pgboss.archive may not yet exist.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: DLQ entry
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 jobId: { type: string }
 *                 lastError: { type: string, nullable: true }
 *                 attempts: { type: integer }
 *                 failedAt: { type: string, format: date-time }
 *                 originalPayload: { type: object }
 *       404:
 *         description: Run not in DLQ
 */
router.get('/runs/:id/dlq', async (req: Request, res: Response) => {
  const runId = parseInt(req.params.id as string, 10);
  if (isNaN(runId)) {
    throw new ValidationError('Invalid run ID');
    return;
  }

  try {
    // Query pgboss.archive for any pipeline job tied to this runId.
    // Guard: pgboss.archive may not exist on fresh install — catch and return 404.
    const row = await queryOne<{
      id: string;
      output: unknown;
      retrycount: number;
      archivedon: string;
      data: unknown;
    }>(
      `SELECT id, output, retrycount, archivedon, data
       FROM pgboss.archive
       WHERE name IN ('pipeline:run', 'pipeline:retry')
         AND state = 'failed'
         AND data->>'runId' = $1
       ORDER BY archivedon DESC
       LIMIT 1`,
      [String(runId)],
    ).catch(() => undefined);

    if (!row) {
      res.status(404).json({ error: 'Run not in DLQ' });
      return;
    }

    const lastError = typeof row.output === 'string'
      ? row.output
      : (row.output != null ? JSON.stringify(row.output) : null);

    res.json({
      jobId: row.id,
      lastError,
      attempts: row.retrycount ?? 0,
      failedAt: row.archivedon,
      originalPayload: row.data,
    });
  } catch (err) {
    handleRouteError(res, err, '[Pipeline] DLQ lookup');
  }
});

// ─── POST /api/pipeline/runs/:id/dlq/retry — Retry a DLQ run ─────────────────

/**
 * @swagger
 * /api/pipeline/runs/{id}/dlq/retry:
 *   post:
 *     tags: [Pipeline]
 *     summary: Retry a run from the DLQ
 *     operationId: retryRunFromDlq
 *     description: >
 *       Creates a new pipeline_runs row (retried_from_run_id = originalId)
 *       and sends a fresh pg-boss pipeline:run job. The original run remains
 *       in 'failed' status — this creates a new linked run.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       201:
 *         description: New retry run created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 runId: { type: integer }
 *                 originalRunId: { type: integer }
 *                 jobId: { type: string }
 *       404:
 *         description: Original run not found
 *       409:
 *         description: Run not in failed state
 */
router.post('/runs/:id/dlq/retry', async (req: Request, res: Response) => {
  const originalRunId = parseInt(req.params.id as string, 10);
  if (isNaN(originalRunId)) {
    throw new ValidationError('Invalid run ID');
    return;
  }

  try {
    // Fetch original run
    const originalRun = await queryOne<{
      id: number;
      spec_path: string;
      workspace_id: string;
      status: string;
      agent: string | null;
      agent_type: string | null;
      agent_model: string | null;
      branch_name: string | null;
      worktree_path: string | null;
      terminal_mode: TerminalMode | null;
    }>(
      `SELECT id, spec_path, workspace_id, status, agent, agent_type, agent_model, branch_name, worktree_path, terminal_mode
       FROM pipeline_runs WHERE id = $1`,
      [originalRunId],
    );

    if (!originalRun) {
      throw new NotFoundError('Run not found');
      return;
    }

    if (originalRun.status !== 'failed') {
      throw new ConflictError(`Run is in '${originalRun.status}' state — only 'failed' runs can be retried from DLQ`);
      return;
    }

    // Fetch workspace path
    const workspace = await queryOne<{ path: string }>(
      `SELECT path FROM workspaces WHERE id = $1`,
      [originalRun.workspace_id],
    );
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const retryAgent = normalizeRunAgentType(originalRun.agent_type ?? originalRun.agent);
    if (retryAgent === 'unknown') {
      throw new UnprocessableError('Cannot retry a run without recorded agent metadata. Select an execution engine and trigger a new run.');
    }

    // Create new pipeline_run linked to original
    const newRunRow = await queryOne<{ id: number }>(
      `INSERT INTO pipeline_runs
         (spec_path, workspace_id, status, trigger_type, retried_from_run_id, agent, agent_type, agent_model, queued_at, terminal_mode)
       VALUES ($1, $2, 'queued', 'dlq-retry', $3, $4, $5, $6, NOW(), $7)
       RETURNING id`,
      [
        originalRun.spec_path,
        originalRun.workspace_id,
        originalRunId,
        retryAgent,
        retryAgent,
        originalRun.agent_model,
        normalizeTerminalMode(originalRun.terminal_mode),
      ],
    );
    if (!newRunRow) throw new Error('Failed to create new run row');
    const newRunId = normalizeWorkerRunId(newRunRow.id);

    const dlqCwd = originalRun.worktree_path ?? workspace.path;
    const dlqSpec = JSON.parse(fs.readFileSync(path.join(workspace.path, originalRun.spec_path), 'utf8')) as Record<string, unknown>;
    const dlqManifests = await resolveAndPersistDispatchManifests({
      workspaceId: originalRun.workspace_id,
      specId: path.basename(originalRun.spec_path, '.json'),
      runId: newRunId,
      specJson: dlqSpec,
      cwd: dlqCwd,
      agent: retryAgent,
      model: originalRun.agent_model ?? null,
      effort: null,
      terminalMode: normalizeTerminalMode(originalRun.terminal_mode),
      worktreePath: originalRun.worktree_path ?? null,
      branchName: originalRun.branch_name ?? null,
      autoMerge: false,
      mergeStrategy: 'branch-only',
      parallelism: 1,
    });

    // Build the job payload (mirrors pipeline:trigger payload shape)
    const jobPayload = {
      runId: newRunId,
      specPath: originalRun.spec_path,
      workspacePath: workspace.path,
      agent: retryAgent,
      model: originalRun.agent_model ?? null,
      worktreePath: originalRun.worktree_path ?? null,
      branchName: originalRun.branch_name ?? null,
      terminalMode: normalizeTerminalMode(originalRun.terminal_mode),
      autoWorktree: false,
      autoMerge: false,
      executionManifestPath: dlqManifests.path,
      envOverrides: {},
    };

    await getBoss().send('pipeline:run', jobPayload, {
      retryLimit: 0,
      expireInSeconds: 300, // Task-Monitor: job spawns engine and returns immediately
    });

    // Emit WAL event
    await execute(
      `INSERT INTO wal_events (event_type, workspace_id, run_id, payload) VALUES ($1, $2, $3, $4)`,
      [
        'run_started',
        originalRun.workspace_id,
        newRunId,
        JSON.stringify({ runId: newRunId, originalRunId, trigger: 'dlq-retry', specPath: originalRun.spec_path }),
      ],
    ).catch(() => {
      // wal_events may not have run_id column on older migrations — fall back to without it
      return execute(
        `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ($1, $2, $3)`,
        [
          'run_started',
          originalRun.workspace_id,
          JSON.stringify({ runId: newRunId, originalRunId, trigger: 'dlq-retry', specPath: originalRun.spec_path }),
        ],
      );
    });

    res.status(201).json({ ok: true, runId: newRunId, originalRunId });
  } catch (err) {
    handleRouteError(res, err, '[Pipeline] DLQ retry');
  }
});

// NOTE: /queue/:workspaceId moved AFTER static /queue/* routes to prevent Express param matching.
// See below export default router.

// ─── GET /api/pipeline/worker/health — Worker health check ───────────────────
// Queries Postgres directly — no IPC with the worker process.
// Accessible without authentication (health checks must be unauthenticated).

/**
 * @swagger
 * /api/pipeline/worker/health:
 *   get:
 *     tags: [Pipeline]
 *     summary: Worker process health check
 *     operationId: getWorkerHealth
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only worker liveness and queue status are needed by local operators and VM/server sidecar rollout checks without mutating pipeline state."
 *     x-rorca-public-api: true
 *     description: >
 *       Returns the health status of the standalone pg-boss worker process by
 *       querying the worker_heartbeat table and pgboss.* tables directly.
 *       No IPC with the worker is required. The worker is considered active when
 *       its last_seen timestamp is within the past 90 seconds.
 *     responses:
 *       200:
 *         description: Worker health object with queue statistics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 workerActive: { type: boolean }
 *                 workerPid: { type: integer, nullable: true }
 *                 workerStartedAt: { type: string, nullable: true, format: date-time }
 *                 activeChildProcesses: { type: integer, description: "Number of active execution-engine child processes (from latest heartbeat)" }
 *                 queueMaxConcurrent: { type: integer, description: "Max concurrent queued (non-worktree) pipeline:run jobs" }
 *                 runNowMaxConcurrent: { type: integer, description: "Max concurrent immediate worktree-isolated runs" }
 *                 lastReconciliationErrors: { type: integer, description: "Number of state mismatches fixed in last reconcile cycle (last 90s)" }
 *                 activeJobs:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       runId: { type: integer }
 *                       specId: { type: string }
 *                       startedAt: { type: string, format: date-time }
 *                       elapsedMs: { type: integer }
 *                 queueDepth: { type: integer }
 *                 scheduledJobs:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       scheduleId: { type: string }
 *                       cronExpr: { type: string }
 *                       nextFireAt: { type: string, nullable: true, format: date-time }
 *                 dlqDepth: { type: integer }
 *                 pgBossVersion: { type: string }
 *                 queueHealth: { type: string, enum: ["healthy", "degraded", "critical"], description: "Health classification based on queue stats" }
 *                 queueStats:
 *                   type: object
 *                   properties:
 *                     pending: { type: integer, description: "Number of jobs waiting to be picked up" }
 *                     active: { type: integer, description: "Number of jobs currently being processed" }
 *                     failed: { type: integer, description: "Number of jobs in failed state (not yet archived)" }
 *                     completed24h: { type: integer, description: "Number of jobs completed in the last 24 hours" }
 *                     failedInLast24h: { type: integer, description: "Number of jobs failed in the last 24 hours" }
 *                     failedInLast7d: { type: integer, description: "Number of jobs failed in the last 7 days" }
 *                     archiveSize: { type: integer, description: "Total number of archived jobs" }
 *                     oldestPendingAgeSeconds: { type: integer, nullable: true, description: "Age in seconds of the oldest pending job (null if no pending jobs)" }
 *                     pickupLatency:
 *                       type: object
 *                       nullable: true
 *                       description: "Job pickup latency metrics over a 24-hour rolling window (pipeline:run + pipeline:retry only)"
 *                       properties:
 *                         avgSeconds: { type: number, nullable: true }
 *                         p50Seconds: { type: number, nullable: true }
 *                         p95Seconds: { type: number, nullable: true }
 *                         maxSeconds: { type: number, nullable: true }
 *                         sampleCount: { type: integer }
 *                         windowHours: { type: integer }
 *                         status: { type: string, enum: ["healthy", "degraded", "critical"] }
 *                     queues:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           name: { type: string }
 *                           pending: { type: integer }
 *                           active: { type: integer }
 *                           failed: { type: integer }
 */
router.get('/worker/health', async (req: Request, res: Response) => {
  try {
    // ── 1. Worker heartbeat ─────────────────────────────────────────────────
    const heartbeat = await getLatestWorkerHeartbeat();
    const workerActive = heartbeat ? !isWorkerHeartbeatStale(heartbeat.last_seen) : false;

    // ── 2. Active jobs (pgboss.job joined with pipeline_runs) ───────────────
    interface ActiveJobRow {
      run_id: string;
      spec_path: string | null;
      started_at: string;
    }
    const activeJobRows = await query<ActiveJobRow>(
      `SELECT (j.data->>'runId') AS run_id,
              pr.spec_path,
              j.created_on::text AS started_at
       FROM   pgboss.job j
       LEFT   JOIN pipeline_runs pr ON pr.id = (j.data->>'runId')::bigint
       WHERE  j.name = 'pipeline:run'
         AND  j.state = 'active'`,
    ).catch(() => [] as ActiveJobRow[]);

    const activeJobs = activeJobRows.map(row => ({
      runId: parseInt(row.run_id, 10),
      specId: row.spec_path ? row.spec_path.replace(/^.*\//, '').replace(/\.json$/, '') : null,
      startedAt: row.started_at,
      elapsedMs: Date.now() - new Date(row.started_at).getTime(),
    }));

    // ── 3. Queue depth (pending pipeline:run jobs) ──────────────────────────
    const queueDepthRow = await queryOne<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM pgboss.job WHERE name = 'pipeline:run' AND state = 'created'`,
    ).catch(() => ({ cnt: '0' }));
    const queueDepth = parseInt(queueDepthRow?.cnt ?? '0', 10);

    // ── 4. Scheduled jobs ───────────────────────────────────────────────────
    interface ScheduleRow {
      name: string;
      cron: string;
      timezone: string | null;
    }
    const scheduleRows = await query<ScheduleRow>(
      `SELECT name, cron, timezone FROM pgboss.schedule ORDER BY name`,
    ).catch(() => [] as ScheduleRow[]);

    const scheduledJobs = scheduleRows.map(r => ({
      scheduleId: r.name,
      cronExpr: r.cron,
      nextFireAt: null as string | null, // pgboss doesn't surface next-fire directly
    }));

    // ── 5. DLQ depth (failed archived jobs) ────────────────────────────────
    const dlqRow = await queryOne<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM pgboss.archive WHERE state = 'failed'`,
    ).catch(() => ({ cnt: '0' }));
    const dlqDepth = parseInt(dlqRow?.cnt ?? '0', 10);

    // ── 6. pg-boss schema version ───────────────────────────────────────────
    const versionRow = await queryOne<{ version: string }>(
      `SELECT version FROM pgboss.version LIMIT 1`,
    ).catch(() => undefined);
    const pgBossVersion = versionRow?.version ?? 'unknown';

    // ── 7. Last reconciliation errors (WAL events from last reconcile cycle) ─
    // Count run_finished events with reason='state_reconciliation' or
    // reason='worker_crash_recovery' emitted in the past 90s (covers one full
    // reconcile interval + one heartbeat interval).
    const reconRow = await queryOne<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt
       FROM wal_events
       WHERE event_type = 'run_finished'
         AND payload->>'reason' IN ('state_reconciliation', 'worker_crash_recovery')
         AND ts > NOW() - INTERVAL '90 seconds'`,
    ).catch(() => ({ cnt: '0' }));
    const lastReconciliationErrors = parseInt(reconRow?.cnt ?? '0', 10);

    // ── 8. Queue statistics (run in parallel) ─────────────────────────────────
    interface CountRow {
      cnt: string;
    }
    interface AgeRow {
      age_seconds: number | null;
    }
    interface QueueRow {
      name: string;
      pending: string;
      active: string;
      failed: string;
    }
    interface LatencyRow {
      avg_pickup_seconds: number | null;
      p50_pickup_seconds: number | null;
      p95_pickup_seconds: number | null;
      min_pickup_seconds: number | null;
      max_pickup_seconds: number | null;
      sample_count: string;
    }

    const [
      pendingRow,
      activeRow,
      failedRow,
      completed24hRow,
      failedLast24hRow,
      failedLast7dRow,
      archiveSizeRow,
      oldestAgeRow,
      queueRows,
      latencyRow,
    ] = await Promise.all([
      queryOne<CountRow>('SELECT COUNT(*)::text AS cnt FROM pgboss.job WHERE state = $1', ['created']).catch(() => ({ cnt: '0' })),
      queryOne<CountRow>('SELECT COUNT(*)::text AS cnt FROM pgboss.job WHERE state = $1', ['active']).catch(() => ({ cnt: '0' })),
      queryOne<CountRow>('SELECT COUNT(*)::text AS cnt FROM pgboss.job WHERE state = $1', ['failed']).catch(() => ({ cnt: '0' })),
      queryOne<CountRow>('SELECT COUNT(*)::text AS cnt FROM pgboss.archive WHERE state = $1 AND archived_on > NOW() - INTERVAL \'24 hours\'', ['completed']).catch(() => ({ cnt: '0' })),
      queryOne<CountRow>('SELECT COUNT(*)::text AS cnt FROM pgboss.archive WHERE state = $1 AND archived_on > NOW() - INTERVAL \'24 hours\'', ['failed']).catch(() => ({ cnt: '0' })),
      queryOne<CountRow>('SELECT COUNT(*)::text AS cnt FROM pgboss.archive WHERE state = $1 AND archived_on > NOW() - INTERVAL \'7 days\'', ['failed']).catch(() => ({ cnt: '0' })),
      queryOne<CountRow>('SELECT COUNT(*)::text AS cnt FROM pgboss.archive').catch(() => ({ cnt: '0' })),
      queryOne<AgeRow>('SELECT EXTRACT(EPOCH FROM (NOW() - MIN(created_on)))::integer AS age_seconds FROM pgboss.job WHERE state = $1', ['created']).catch(() => ({ age_seconds: null })),
      query<QueueRow>(
        `SELECT name,
                COUNT(*) FILTER (WHERE state = 'created')::text AS pending,
                COUNT(*) FILTER (WHERE state = 'active')::text AS active,
                COUNT(*) FILTER (WHERE state = 'failed')::text AS failed
         FROM pgboss.job
         GROUP BY name
         ORDER BY name`,
      ).catch(() => [] as QueueRow[]),
      queryOne<LatencyRow>(
        `SELECT
           AVG(EXTRACT(EPOCH FROM (started_on - created_on)))                                                             AS avg_pickup_seconds,
           PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (started_on - created_on)))                   AS p50_pickup_seconds,
           PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (started_on - created_on)))                   AS p95_pickup_seconds,
           MIN(EXTRACT(EPOCH FROM (started_on - created_on)))                                                             AS min_pickup_seconds,
           MAX(EXTRACT(EPOCH FROM (started_on - created_on)))                                                             AS max_pickup_seconds,
           COUNT(*)::text                                                                                                  AS sample_count
         FROM pgboss.archive
         WHERE started_on IS NOT NULL
           AND created_on IS NOT NULL
           AND archived_on > NOW() - INTERVAL '24 hours'
           AND name IN ('pipeline:run', 'pipeline:retry')`,
      ).catch(() => null),
    ]);

    const pending = parseInt(pendingRow?.cnt ?? '0', 10);
    const active = parseInt(activeRow?.cnt ?? '0', 10);
    const failed = parseInt(failedRow?.cnt ?? '0', 10);
    const completed24h = parseInt(completed24hRow?.cnt ?? '0', 10);
    const failedInLast24h = parseInt(failedLast24hRow?.cnt ?? '0', 10);
    const failedInLast7d = parseInt(failedLast7dRow?.cnt ?? '0', 10);
    const archiveSize = parseInt(archiveSizeRow?.cnt ?? '0', 10);
    const oldestPendingAgeSeconds = oldestAgeRow?.age_seconds ?? null;

    // ── Pickup latency classification ──────────────────────────────────────────
    const latencySampleCount = parseInt(latencyRow?.sample_count ?? '0', 10);
    const latencyP95 = latencyRow?.p95_pickup_seconds ?? null;
    let latencyStatus: 'healthy' | 'degraded' | 'critical' = 'healthy';
    if (latencyP95 === null) {
      // No completed pipeline jobs in the last 24 hours.
      // Mark critical only when jobs are stuck in pending (never started).
      latencyStatus = pending > 0 ? 'critical' : 'healthy';
    } else if (latencyP95 > 10) {
      latencyStatus = 'critical';
    } else if (latencyP95 > 2) {
      latencyStatus = 'degraded';
    }

    const pickupLatency = {
      avgSeconds: latencyRow?.avg_pickup_seconds ?? null,
      p50Seconds: latencyRow?.p50_pickup_seconds ?? null,
      p95Seconds: latencyP95,
      maxSeconds: latencyRow?.max_pickup_seconds ?? null,
      sampleCount: latencySampleCount,
      windowHours: 24,
      status: latencyStatus,
    };

    // Convert per-queue breakdown to typed object
    const queues = queueRows.map(r => ({
      name: r.name,
      pending: parseInt(r.pending ?? '0', 10),
      active: parseInt(r.active ?? '0', 10),
      failed: parseInt(r.failed ?? '0', 10),
    }));

    // Determine queue health
    let queueHealth: 'critical' | 'degraded' | 'healthy' = 'healthy';
    if (failed > 0 || failedInLast24h > 5) {
      queueHealth = 'critical';
    } else if (failedInLast24h > 0 || (oldestPendingAgeSeconds !== null && oldestPendingAgeSeconds > 300)) {
      queueHealth = 'degraded';
    }


    // ── Concurrency settings from worker_settings ──────────────────────────
    const concurrencyRows = await query<{ key: string; value: string }>(
      `SELECT key, value FROM worker_settings WHERE key IN ('queue_max_concurrent', 'run_now_max_concurrent')`,
    ).catch(() => [] as { key: string; value: string }[]);
    const concurrencyMap = Object.fromEntries(concurrencyRows.map(r => [r.key, r.value]));
    const queueMaxConcurrent = concurrencyMap['queue_max_concurrent'] ? parseInt(concurrencyMap['queue_max_concurrent'], 10) : 1;
    const runNowMaxConcurrent = concurrencyMap['run_now_max_concurrent'] ? parseInt(concurrencyMap['run_now_max_concurrent'], 10) : 3;

    // ── Per-workspace queue depths ─────────────────────────────────────────────
    const MAX_QUEUE_DEPTH = 10;
    interface WorkspaceQueueRow {
      workspace_id: string;
      queued_count: string;
      active_count: string;
    }
    const workspaceQueueRows = await query<WorkspaceQueueRow>(
      `SELECT workspace_id,
              COUNT(*) FILTER (WHERE status = 'queued')::text AS queued_count,
              COUNT(*) FILTER (WHERE status IN ('running', 'paused'))::text AS active_count
       FROM pipeline_runs
       WHERE status IN ('queued', 'running', 'paused')
       GROUP BY workspace_id`,
    ).catch(() => [] as WorkspaceQueueRow[]);

    const workspaceQueueDepths = workspaceQueueRows.map(r => ({
      workspaceId: r.workspace_id,
      queuedCount: parseInt(r.queued_count, 10),
      activeCount: parseInt(r.active_count, 10),
      maxQueueDepth: MAX_QUEUE_DEPTH,
    }));

    res.json({
      workerActive,
      workerPid: heartbeat?.pid ?? null,
      workerStartedAt: heartbeat?.started_at ?? null,
      activeChildProcesses: heartbeat?.active_jobs ?? 0,
      queueMaxConcurrent,
      runNowMaxConcurrent,
      activeJobs,
      queueDepth,
      scheduledJobs,
      dlqDepth,
      pgBossVersion,
      lastReconciliationErrors,
      queueHealth,
      workspaceQueueDepths,
      queueStats: {
        pending,
        active,
        failed,
        completed24h,
        failedInLast24h,
        failedInLast7d,
        archiveSize,
        oldestPendingAgeSeconds,
        pickupLatency,
        queues,
      },
    });
  } catch (error: unknown) {
    handleRouteError(res, error, '[Pipeline] Worker health check');
  }
});

/**
 * @swagger
 * /api/pipeline/orphan-sweep:
 *   post:
 *     summary: Trigger immediate orphan process sweep
 *     description: Scans for pipeline runs with status='running' that belong to other workers or have no worker_id (orphaned), kills their processes, and marks runs as failed. Callable from API process (currentWorkerId is undefined, sweeps ALL stale runs).
 *     tags:
 *       - Pipeline
 *     responses:
 *       200:
 *         description: Orphan sweep completed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 swept:
 *                   type: array
 *                   description: Array of swept orphan runs
 *                   items:
 *                     type: object
 *                     properties:
 *                       runId:
 *                         type: number
 *                         description: Pipeline run ID
 *                       pid:
 *                         type: number
 *                         description: Process ID that was swept (or 0 if no PID)
 *                       killed:
 *                         type: boolean
 *                         description: Whether the process was successfully terminated
 *                     required: [runId, pid, killed]
 *                 count:
 *                   type: number
 *                   description: Total number of orphan runs swept
 *               required: [swept, count]
 *       500:
 *         description: Sweep operation failed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   description: Error message
 *               required: [error]
 */
router.post('/orphan-sweep', async (req: Request, res: Response) => {
  try {
    const results = await sweepOrphanProcesses();

    res.json({
      swept: results,
      count: results.length,
    });
  } catch (error: unknown) {
    handleRouteError(res, error, '[Pipeline] Orphan sweep');
  }
});

/**
 * @swagger
 * /api/pipeline/queue/failed-jobs:
 *   get:
 *     summary: List failed pg-boss jobs
 *     description: Returns a paginated list of failed pg-boss jobs from both pgboss.job (recent unarchived failures) and pgboss.archive (archived failures within the last 30 days). Each entry is enriched with the corresponding pipeline_runs row where the job's data.runId matches.
 *     tags:
 *       - Pipeline
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number (1-indexed)
 *       - in: query
 *         name: pageSize
 *         schema:
 *           type: integer
 *           default: 20
 *           maximum: 100
 *         description: Number of items per page
 *     responses:
 *       200:
 *         description: Paginated list of failed jobs
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       jobId:
 *                         type: string
 *                         description: pg-boss job UUID
 *                       queueName:
 *                         type: string
 *                         description: Queue name (e.g. pipeline:run)
 *                       state:
 *                         type: string
 *                         description: Job state (always "failed")
 *                       failedAt:
 *                         type: string
 *                         format: date-time
 *                         description: Timestamp when the job failed (completed_on)
 *                       retryCount:
 *                         type: integer
 *                         description: Number of retries consumed
 *                       retryLimit:
 *                         type: integer
 *                         description: Maximum retries configured
 *                       errorOutput:
 *                         type: object
 *                         description: Error details from the last attempt (API keys redacted)
 *                         properties:
 *                           message:
 *                             type: string
 *                           stack:
 *                             type: string
 *                       data:
 *                         type: object
 *                         description: Original job payload
 *                       runId:
 *                         type: integer
 *                         nullable: true
 *                         description: Linked pipeline_runs.id (null if not a pipeline:run job)
 *                       runStatus:
 *                         type: string
 *                         nullable: true
 *                         description: pipeline_runs.status for the linked run
 *                       specPath:
 *                         type: string
 *                         nullable: true
 *                         description: pipeline_runs.spec_path for the linked run
 *                 total:
 *                   type: integer
 *                 page:
 *                   type: integer
 *                 pageSize:
 *                   type: integer
 *               required: [items, total, page, pageSize]
 *       500:
 *         description: Internal server error
 */
router.get('/queue/failed-jobs', async (req: Request, res: Response) => {
  try {
    const page = Math.max(parseInt(String(req.query.page ?? '1'), 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(String(req.query.pageSize ?? '20'), 10) || 20, 1), 100);
    const offset = (page - 1) * pageSize;

    // UNION of unarchived failed jobs + archived failed jobs (last 30 days)
    const unionSql = `
      SELECT id, name, data, state, retry_count, retry_limit, output, completed_on, 'job' AS source
      FROM pgboss.job
      WHERE state = 'failed'
      UNION ALL
      SELECT id, name, data, state, retry_count, retry_limit, output, completed_on, 'archive' AS source
      FROM pgboss.archive
      WHERE state = 'failed'
        AND archived_on > NOW() - INTERVAL '30 days'
    `;

    interface FailedJobRow {
      id: string;
      name: string;
      data: Record<string, unknown> | null;
      state: string;
      retry_count: number | null;
      retry_limit: number | null;
      output: Record<string, unknown> | null;
      completed_on: string | null;
      source: string;
      run_id: number | null;
      run_status: string | null;
      spec_path: string | null;
    }

    interface FailedJobCountRow { total: string }

    const [countRow, rows] = await Promise.all([
      queryOne<FailedJobCountRow>(
        `SELECT COUNT(*)::text AS total FROM (${unionSql}) AS combined`,
        [],
      ).catch(() => ({ total: '0' })),
      query<FailedJobRow>(
        `SELECT j.id, j.name, j.data, j.state, j.retry_count, j.retry_limit, j.output, j.completed_on, j.source,
                pr.id AS run_id, pr.status AS run_status, pr.spec_path
         FROM (${unionSql}) AS j
         LEFT JOIN pipeline_runs pr ON pr.id = (j.data->>'runId')::INT
         ORDER BY j.completed_on DESC NULLS LAST
         LIMIT $1 OFFSET $2`,
        [pageSize, offset],
      ).catch(() => [] as FailedJobRow[]),
    ]);

    const total = parseInt(countRow?.total ?? '0', 10);

    // Scrub API keys from error output
    const scrubSecrets = (text: string): string =>
      text
        .replace(/(sk-ant-[a-zA-Z0-9-]{10,})/g, '[REDACTED]')
        .replace(/(sk-or-[a-zA-Z0-9-]{10,})/g, '[REDACTED]')
        .replace(/(sk-[a-zA-Z0-9]{10,})/g, '[REDACTED]');

    const items = rows.map(row => {
      const rawOutput = row.output as Record<string, unknown> | null;
      const errorOutput = rawOutput
        ? {
            message: typeof rawOutput.message === 'string' ? scrubSecrets(rawOutput.message) : undefined,
            stack: typeof rawOutput.stack === 'string' ? scrubSecrets(rawOutput.stack) : undefined,
            ...Object.fromEntries(
              Object.entries(rawOutput)
                .filter(([k]) => k !== 'message' && k !== 'stack')
                .map(([k, v]) => [k, typeof v === 'string' ? scrubSecrets(v) : v]),
            ),
          }
        : null;

      return {
        jobId: row.id,
        queueName: row.name,
        state: row.state,
        failedAt: row.completed_on ?? null,
        retryCount: row.retry_count ?? 0,
        retryLimit: row.retry_limit ?? 0,
        errorOutput,
        data: row.data ?? {},
        runId: row.run_id ?? null,
        runStatus: row.run_status ?? null,
        specPath: row.spec_path ?? null,
      };
    });

    res.json({ items, total, page, pageSize });
  } catch (error: unknown) {
    handleRouteError(res, error, '[Pipeline] Failed jobs list');
  }
});

/**
 * @swagger
 * /api/pipeline/queue/failed-jobs/{jobId}/retry:
 *   post:
 *     summary: Re-enqueue a failed pg-boss job
 *     description: Reads the failed job from pgboss.archive or pgboss.job by its UUID, extracts the original queue name and payload, and re-inserts it as a fresh job via boss.send(). Used by operators to manually retry a failed job after fixing the underlying issue.
 *     tags:
 *       - Pipeline
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: pg-boss job UUID
 *     responses:
 *       200:
 *         description: Job successfully re-enqueued
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 newJobId:
 *                   type: string
 *                   description: UUID of the newly created job
 *                 message:
 *                   type: string
 *                   example: Job requeued
 *               required: [newJobId, message]
 *       404:
 *         description: Job not found in pgboss.job or pgboss.archive
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *               required: [error]
 *       500:
 *         description: Internal server error
 */
router.post('/queue/failed-jobs/:jobId/retry', async (req: Request, res: Response) => {
  const { jobId } = req.params;

  try {
    interface JobLookupRow {
      id: string;
      name: string;
      data: Record<string, unknown> | null;
    }

    // Look up in pgboss.job first (very recent failures), then pgboss.archive
    const job = await queryOne<JobLookupRow>(
      `SELECT id, name, data FROM pgboss.job WHERE id = $1 AND state = 'failed'
       UNION ALL
       SELECT id, name, data FROM pgboss.archive WHERE id = $1 AND state = 'failed'
       LIMIT 1`,
      [jobId],
    );

    if (!job) {
      throw new NotFoundError(`Failed job ${jobId} not found`);
    }

    const boss = getBoss();
    const newJobId = await boss.send(job.name, job.data ?? {});

    if (!newJobId) {
      return res.status(500).json({ error: 'boss.send() returned null — queue may not exist or boss is not running' });
    }

    logger.info({ jobId, newJobId, queueName: job.name }, '[Pipeline] failed job re-enqueued');
    res.json({ newJobId, message: 'Job requeued' });
  } catch (error: unknown) {
    handleRouteError(res, error, '[Pipeline] Failed job retry');
  }
});

// ─── GET /api/pipeline/queue/health-history — Time-series queue health snapshots ──

/**
 * @swagger
 * /api/pipeline/queue/health-history:
 *   get:
 *     tags: [Pipeline]
 *     summary: Queue health time-series data
 *     operationId: getQueueHealthHistory
 *     description: >
 *       Returns time-series snapshots from queue_health_snapshots, captured every
 *       60 seconds by the worker's monitor-states listener. Use for trend charts,
 *       alerting analysis, and queue observability dashboards.
 *     parameters:
 *       - in: query
 *         name: hours
 *         schema:
 *           type: integer
 *           enum: [1, 6, 24, 168]
 *           default: 24
 *         description: Time window in hours (1=1h, 6=6h, 24=24h, 168=1w)
 *     responses:
 *       200:
 *         description: Time-series health snapshots
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 snapshots:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       capturedAt: { type: string, format: date-time }
 *                       pending: { type: integer }
 *                       active: { type: integer }
 *                       failed: { type: integer }
 *                       completed: { type: integer }
 *                       oldestPendingSeconds: { type: integer, nullable: true }
 *                       workerId: { type: string, nullable: true }
 *                 interval:
 *                   type: string
 *                   description: Suggested chart bucket interval
 *                 totalSnapshots: { type: integer }
 *                 windowHours: { type: integer }
 */
router.get('/queue/health-history', async (req: Request, res: Response) => {
  try {
    const rawHours = parseInt(String(req.query.hours ?? '24'), 10);
    const allowedHours = [1, 6, 24, 168];
    const hours = allowedHours.includes(rawHours) ? rawHours : 24;

    // Suggest a chart bucket interval based on window size
    let interval: string;
    if (hours <= 1) {
      interval = '5m';
    } else if (hours <= 6) {
      interval = '15m';
    } else if (hours <= 24) {
      interval = '1h';
    } else {
      interval = '6h';
    }

    interface SnapshotRow {
      captured_at: string;
      total_pending: number;
      total_active: number;
      total_failed: number;
      total_completed: number;
      oldest_pending_seconds: number | null;
      worker_id: string | null;
    }

    const rows = await query<SnapshotRow>(
      `SELECT captured_at, total_pending, total_active, total_failed, total_completed,
              oldest_pending_seconds, worker_id
       FROM queue_health_snapshots
       WHERE captured_at > NOW() - ($1 || ' hours')::interval
       ORDER BY captured_at ASC`,
      [hours],
    );

    const snapshots = rows.map(r => ({
      capturedAt: r.captured_at,
      pending: r.total_pending,
      active: r.total_active,
      failed: r.total_failed,
      completed: r.total_completed,
      oldestPendingSeconds: r.oldest_pending_seconds,
      workerId: r.worker_id,
    }));

    res.json({
      snapshots,
      interval,
      totalSnapshots: snapshots.length,
      windowHours: hours,
    });
  } catch (error: unknown) {
    handleRouteError(res, error, '[Pipeline] Queue health history');
  }
});
// ─── GET /api/pipeline/queue/:workspaceId — Workspace queue state ─────────────
// IMPORTANT: Must be AFTER all static /queue/* routes (failed-jobs, health-history)
// to prevent Express matching "failed-jobs" as :workspaceId param.

/**
 * @swagger
 * /api/pipeline/queue/{workspaceId}:
 *   get:
 *     tags: [Pipeline]
 *     summary: Get queue state for a workspace
 *     operationId: getWorkspaceQueueState
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Queue state
 */
router.get('/queue/:workspaceId', async (req: Request, res: Response) => {
  try {
    const { workspaceId } = req.params;

    const MAX_QUEUE_DEPTH = 10;

    // Fetch concurrency settings
    const concurrencyRows = await query<{ key: string; value: string }>(
      `SELECT key, value FROM worker_settings WHERE key IN ('queue_max_concurrent', 'run_now_max_concurrent')`,
    ).catch(() => [] as { key: string; value: string }[]);
    const settingsMap = Object.fromEntries(concurrencyRows.map(r => [r.key, r.value]));
    const queueMaxConcurrent = settingsMap['queue_max_concurrent'] ? parseInt(settingsMap['queue_max_concurrent'], 10) : 1;
    const runNowMaxConcurrent = settingsMap['run_now_max_concurrent'] ? parseInt(settingsMap['run_now_max_concurrent'], 10) : 3;

    // Active runs for this workspace
    const activeRuns = await query<PipelineRunRow>(
      `SELECT id, spec_path, workspace_id, status, started_at, triggered_via, branch_name, worktree_path, agent_type,
              idempotency_key, task_manifest_id, task_manifest_artifacts, trigger_options
       FROM pipeline_runs
       WHERE workspace_id = $1 AND status IN ('running', 'paused', 'pi_native')
       ORDER BY started_at ASC`,
      [workspaceId],
    );

    // Queued runs for this workspace
    const queuedRuns = await query<PipelineRunRow>(
      `SELECT id, spec_path, workspace_id, status, queued_at, queue_position, triggered_via, auto_worktree,
              idempotency_key, task_manifest_id, task_manifest_artifacts, trigger_options
       FROM pipeline_runs
       WHERE workspace_id = $1 AND status = 'queued'
       ORDER BY queue_position ASC, queued_at ASC`,
      [workspaceId],
    );

    const withManifestSource = (run: PipelineRunRow) => ({
      ...run,
      ...(buildManifestSourceFromRun(run) ? { manifestSource: buildManifestSourceFromRun(run) } : {}),
    });

    res.json({
      active: activeRuns.map(withManifestSource),
      queued: queuedRuns.map(withManifestSource),
      queueDepth: queuedRuns.length,
      maxQueueDepth: MAX_QUEUE_DEPTH,
      queueMaxConcurrent,
      runNowMaxConcurrent,
    });
  } catch (err) {
    logger.error({ err }, '[Pipeline] queue state error');
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
