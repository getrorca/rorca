/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { query, queryOne } from '../db/index';
import { WORKER_HEARTBEAT_STALE_MS } from './worker-heartbeat';

export const SSDLC_LIVENESS_SIGNAL_LIMIT = 32;
export const SSDLC_LIVENESS_STORY_LIMIT = 100;
export const SSDLC_LIVENESS_LOOKBACK_MS = 24 * 60 * 60 * 1_000;

export type SSDLCLivenessState = 'active' | 'quiet_active' | 'stalled' | 'blocked' | 'completed' | 'unknown';
export type SSDLCLivenessAction =
  | 'wait'
  | 'inspect evidence'
  | 'retry smallest scope'
  | 'refresh worktree'
  | 'request approval'
  | 'preserve/commit'
  | 'cancel'
  | 'none';
export type SSDLCLivenessBlockerType =
  | 'credential'
  | 'environment'
  | 'policy_approval'
  | 'worktree'
  | 'validation'
  | 'retry_scope';
export type EvidenceSource =
  | 'database'
  | 'wal'
  | 'log'
  | 'pty'
  | 'process'
  | 'worker'
  | 'git'
  | 'completion_packet'
  | 'retry';

export interface LivenessEvidenceReference {
  source: EvidenceSource;
  reference: string;
  observedAt: string | null;
  available: boolean;
  meaningful: boolean;
  detail: string;
}

export interface LivenessBlocker {
  type: SSDLCLivenessBlockerType;
  code: string;
  summary: string;
  remediation: string;
  evidenceReference: string;
  observedAt: string | null;
}

export interface LivenessNextSafeAction {
  action: SSDLCLivenessAction;
  explanation: string;
}

export interface SSDLCLivenessReport {
  state: SSDLCLivenessState;
  evaluatedAt: string;
  lastMeaningfulActivity: string | null;
  confidence: number;
  evidence: LivenessEvidenceReference[];
  blocker: LivenessBlocker | null;
  nextSafeAction: LivenessNextSafeAction;
  policy: {
    inactivityThresholdMs: number;
    lookbackMs: number;
    evidenceLimit: number;
  };
}

export interface LivenessBlockerSignal {
  text: string;
  code?: string;
  observedAt?: string | null;
  evidenceReference: string;
}

export interface SSDLCLivenessSignals {
  runId: number;
  workspaceId: string;
  dbStatus: string;
  startedAt: string;
  finishedAt?: string | null;
  process: { available: boolean; alive: boolean | null; owned: boolean | null; pid?: number | null };
  worker?: { available: boolean; lastSeen: string | null; fresh: boolean };
  activities: LivenessEvidenceReference[];
  completion: {
    available: boolean;
    packetPresent: boolean;
    packetValidated: boolean;
    allStoriesTerminal: boolean;
    truncated: boolean;
    observedAt: string | null;
    reference: string;
  };
  blockers: LivenessBlockerSignal[];
  git?: { available: boolean; dirty: boolean | null; commitAt: string | null; reference: string };
}

export interface ClassifierOptions {
  now?: () => Date;
  inactivityThresholdMs?: number;
  lookbackMs?: number;
  evidenceLimit?: number;
}

const SUCCESS_STATUS = new Set(['done']);
const TERMINAL_STATUS = new Set(['done', 'failed', 'partial_failure', 'cancelled']);
const FAILURE_STATUS = new Set(['failed', 'partial_failure']);

function validDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function mostRecent(references: readonly LivenessEvidenceReference[]): Date | null {
  let latest: Date | null = null;
  for (const reference of references) {
    if (!reference.meaningful) continue;
    const observed = validDate(reference.observedAt);
    if (observed && (!latest || observed > latest)) latest = observed;
  }
  return latest;
}

function inferBlocker(signal: LivenessBlockerSignal): LivenessBlocker | null {
  const text = `${signal.code ?? ''} ${signal.text}`.toLowerCase();
  let type: SSDLCLivenessBlockerType | null = null;
  let remediation = '';

  if (/retry[_ -]?(scope|preview)|scope[_ -]?(mismatch|refused|unauthorized)/.test(text)) {
    type = 'retry_scope';
    remediation = 'Regenerate the retry preview and retry only the smallest validated failed scope.';
  } else if (/approval|policy|permission|review[_ -]?blocked|denied|human[_ -]?in[_ -]?the[_ -]?loop/.test(text)) {
    type = 'policy_approval';
    remediation = 'Request the required human or policy approval before resuming execution.';
  } else if (/credential|unauthori[sz]ed|api[_ -]?key|auth(?:entication)?[_ -]?(?:failed|required)|token[_ -]?(?:missing|expired|invalid)/.test(text)) {
    type = 'credential';
    remediation = 'Refresh the required credential, then retry the smallest affected scope.';
  } else if (/worktree|merge[_ -]?(?:conflict|failed)|branch[_ -]?(?:stale|missing|mismatch)/.test(text)) {
    type = 'worktree';
    remediation = 'Refresh or repair the run worktree and preserve any uncommitted changes before retrying.';
  } else if (/validation|test[_ -]?failed|lint[_ -]?failed|typecheck|build[_ -]?failed|acceptance[_ -]?(?:failed|missing)/.test(text)) {
    type = 'validation';
    remediation = 'Inspect the failing validation evidence, fix it, and retry only the affected story.';
  } else if (/environment|missing[_ -]?(?:tool|binary|dependency)|command[_ -]?not[_ -]?found|enoent|rate[_ -]?limit|service[_ -]?unavailable/.test(text)) {
    type = 'environment';
    remediation = 'Restore the required tool, dependency, or service, then retry the smallest affected scope.';
  }

  if (!type) return null;
  return {
    type,
    code: signal.code || type.toUpperCase(),
    summary: signal.text.slice(0, 500),
    remediation,
    evidenceReference: signal.evidenceReference,
    observedAt: validDate(signal.observedAt)?.toISOString() ?? null,
  };
}

function actionForBlocker(blocker: LivenessBlocker): LivenessNextSafeAction {
  if (blocker.type === 'policy_approval') {
    return { action: 'request approval', explanation: blocker.remediation };
  }
  if (blocker.type === 'worktree') {
    return { action: 'refresh worktree', explanation: blocker.remediation };
  }
  if (blocker.type === 'retry_scope') {
    return { action: 'retry smallest scope', explanation: blocker.remediation };
  }
  return { action: 'inspect evidence', explanation: blocker.remediation };
}

function report(
  state: SSDLCLivenessState,
  evaluatedAt: Date,
  lastActivity: Date | null,
  confidence: number,
  evidence: LivenessEvidenceReference[],
  blocker: LivenessBlocker | null,
  nextSafeAction: LivenessNextSafeAction,
  options: Required<Pick<ClassifierOptions, 'inactivityThresholdMs' | 'lookbackMs' | 'evidenceLimit'>>,
): SSDLCLivenessReport {
  return {
    state,
    evaluatedAt: evaluatedAt.toISOString(),
    lastMeaningfulActivity: lastActivity?.toISOString() ?? null,
    confidence: Math.max(0, Math.min(1, confidence)),
    evidence: evidence.slice(0, options.evidenceLimit),
    blocker,
    nextSafeAction,
    policy: {
      inactivityThresholdMs: options.inactivityThresholdMs,
      lookbackMs: options.lookbackMs,
      evidenceLimit: options.evidenceLimit,
    },
  };
}

/** Deterministic, side-effect-free reduction of bounded runtime evidence. */
export function classifySSDLCLiveness(
  signals: SSDLCLivenessSignals,
  classifierOptions: ClassifierOptions = {},
): SSDLCLivenessReport {
  const now = classifierOptions.now?.() ?? new Date();
  const options = {
    inactivityThresholdMs: classifierOptions.inactivityThresholdMs ?? WORKER_HEARTBEAT_STALE_MS,
    lookbackMs: classifierOptions.lookbackMs ?? SSDLC_LIVENESS_LOOKBACK_MS,
    evidenceLimit: Math.max(1, Math.min(classifierOptions.evidenceLimit ?? SSDLC_LIVENESS_SIGNAL_LIMIT, SSDLC_LIVENESS_SIGNAL_LIMIT)),
  };
  const evidence = signals.activities
    .filter((item) => item.available || item.detail.length > 0)
    .sort((a, b) => (validDate(b.observedAt)?.getTime() ?? 0) - (validDate(a.observedAt)?.getTime() ?? 0));
  const lastActivity = mostRecent(evidence);
  const activityAge = lastActivity ? now.getTime() - lastActivity.getTime() : Number.POSITIVE_INFINITY;
  const startedAge = now.getTime() - (validDate(signals.startedAt)?.getTime() ?? 0);
  const recentMeaningfulActivity = activityAge <= options.inactivityThresholdMs;
  const terminal = TERMINAL_STATUS.has(signals.dbStatus);
  const processAlive = signals.process.available && signals.process.alive === true && signals.process.owned !== false;
  const processDead = signals.process.available && signals.process.alive === false;
  const inferredBlockers = signals.blockers
    .map(inferBlocker)
    .filter((item): item is LivenessBlocker => item !== null)
    .sort((a, b) => (validDate(b.observedAt)?.getTime() ?? 0) - (validDate(a.observedAt)?.getTime() ?? 0));
  const blocker = inferredBlockers[0] ?? null;
  const blockerAt = validDate(blocker?.observedAt);
  const unresolvedBlocker = blocker && (
    FAILURE_STATUS.has(signals.dbStatus)
    || signals.dbStatus === 'paused'
    || !lastActivity
    || !blockerAt
    || blockerAt.getTime() >= lastActivity.getTime()
  ) ? blocker : null;

  if (unresolvedBlocker) {
    return report('blocked', now, lastActivity, 0.92, evidence, unresolvedBlocker, actionForBlocker(unresolvedBlocker), options);
  }

  if (SUCCESS_STATUS.has(signals.dbStatus)
    && signals.completion.available
    && signals.completion.packetPresent
    && signals.completion.packetValidated
    && signals.completion.allStoriesTerminal
    && !signals.completion.truncated
    && processDead) {
    return report('completed', now, lastActivity, 0.99, evidence, null, {
      action: 'none',
      explanation: 'Terminal database state, accepted completion evidence, and process exit agree.',
    }, options);
  }

  if (terminal && (processAlive || recentMeaningfulActivity)) {
    return report('unknown', now, lastActivity, 0.45, evidence, null, {
      action: signals.git?.dirty ? 'preserve/commit' : 'inspect evidence',
      explanation: 'Terminal database state contradicts live or recent runtime activity; preserve work and reconcile evidence.',
    }, options);
  }

  if (recentMeaningfulActivity) {
    if (processDead) {
      return report('unknown', now, lastActivity, 0.5, evidence, null, {
        action: 'inspect evidence',
        explanation: 'Recent meaningful activity contradicts an exited process; inspect the scoped evidence before retrying.',
      }, options);
    }
    return report('active', now, lastActivity, processAlive ? 0.95 : 0.78, evidence, null, {
      action: 'wait',
      explanation: 'Recent run-scoped WAL, token, output, PTY, log, packet, or commit activity shows progress.',
    }, options);
  }

  if (signals.dbStatus === 'running' && processAlive) {
    if (startedAge <= options.inactivityThresholdMs) {
      return report('quiet_active', now, lastActivity, 0.78, evidence, null, {
        action: 'wait',
        explanation: 'The owned process is live and still within the existing inactivity grace period, but has not emitted meaningful activity yet.',
      }, options);
    }
    return report('stalled', now, lastActivity, 0.9, evidence, null, {
      action: 'inspect evidence',
      explanation: `The process is live but no meaningful activity was observed within ${options.inactivityThresholdMs}ms; CPU level was not used.`,
    }, options);
  }

  if (signals.dbStatus === 'running' && processDead) {
    if (startedAge > options.inactivityThresholdMs || lastActivity) {
      return report('stalled', now, lastActivity, 0.94, evidence, null, {
        action: 'retry smallest scope',
        explanation: 'The database says running, but its recorded process has exited; retry only the smallest incomplete scope.',
      }, options);
    }
    return report('unknown', now, lastActivity, 0.55, evidence, null, {
      action: 'inspect evidence',
      explanation: 'A newly started run has no live recorded process; inspect worker handoff evidence before intervening.',
    }, options);
  }

  if (FAILURE_STATUS.has(signals.dbStatus)) {
    const fallbackBlocker: LivenessBlocker = {
      type: 'validation',
      code: 'TERMINAL_FAILURE',
      summary: `Run ended with database status ${signals.dbStatus}.`,
      remediation: 'Inspect failure evidence and retry only the smallest failed story scope.',
      evidenceReference: `pipeline-run:${signals.runId}`,
      observedAt: validDate(signals.finishedAt)?.toISOString() ?? null,
    };
    return report('blocked', now, lastActivity, 0.82, evidence, fallbackBlocker, {
      action: 'retry smallest scope',
      explanation: fallbackBlocker.remediation,
    }, options);
  }

  if (SUCCESS_STATUS.has(signals.dbStatus) && signals.git?.dirty) {
    return report('unknown', now, lastActivity, 0.65, evidence, null, {
      action: 'preserve/commit',
      explanation: 'The run is terminal but validated completion evidence is incomplete; preserve the scoped worktree changes first.',
    }, options);
  }

  return report('unknown', now, lastActivity, 0.35, evidence, null, {
    action: signals.dbStatus === 'queued' ? 'wait' : 'inspect evidence',
    explanation: signals.dbStatus === 'queued'
      ? 'The run is queued and has not acquired a process yet.'
      : 'Available scoped signals are insufficient or unavailable; absence of an optional signal is not treated as a stall.',
  }, options);
}

interface RunEvidenceRow {
  id: number;
  workspace_id: string;
  status: string;
  pid: number | null;
  started_at: string;
  finished_at: string | null;
  log_path: string | null;
  worktree_path: string | null;
  branch_name: string | null;
  merge_error: string | null;
  workspace_path: string;
  worker_last_seen: string | null;
}

interface WalEvidenceRow {
  id: number;
  ts: string;
  event_type: string;
  story_id: string | null;
  payload: unknown;
}

interface CompletionEvidenceRow {
  id: number;
  story_id: string;
  status: string;
  finished_at: string | null;
  completion_packet: unknown;
  blocked_by: string | null;
  closeout_status: string | null;
  closeout_decision_id: string | null;
  closeout_payload: unknown;
}

export interface ProcessProbeResult {
  available: boolean;
  alive: boolean | null;
  owned: boolean | null;
}

export interface GitProbeResult {
  available: boolean;
  dirty: boolean | null;
  commitAt: string | null;
  detail: string;
}

export interface LivenessCollectorDependencies {
  query: typeof query;
  queryOne: typeof queryOne;
  processProbe: (pid: number | null) => ProcessProbeResult;
  statMtime: (filePath: string) => Promise<string | null>;
  gitProbe: (directory: string, branchName?: string | null) => Promise<GitProbeResult>;
}

const DEFAULT_PROCESS_PROBE = (pid: number | null): ProcessProbeResult => {
  if (!pid || pid <= 0) return { available: false, alive: null, owned: null };
  try {
    process.kill(pid, 0);
    return { available: true, alive: true, owned: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return { available: true, alive: true, owned: false };
    if (code === 'ESRCH') return { available: true, alive: false, owned: null };
    return { available: false, alive: null, owned: null };
  }
};

function runGit(directory: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', directory, ...args], { timeout: 1_500, maxBuffer: 128 * 1_024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

const DEFAULT_GIT_PROBE = async (directory: string, branchName?: string | null): Promise<GitProbeResult> => {
  try {
    const [status, commitAt, currentBranch] = await Promise.all([
      runGit(directory, ['status', '--porcelain', '--untracked-files=normal']),
      runGit(directory, ['log', '-1', '--format=%cI', branchName || 'HEAD']),
      runGit(directory, ['rev-parse', '--abbrev-ref', 'HEAD']),
    ]);
    const branchMatches = !branchName || currentBranch === branchName;
    return {
      available: true,
      dirty: branchMatches ? status.length > 0 : null,
      commitAt: validDate(commitAt)?.toISOString() ?? null,
      detail: !branchMatches
        ? `Run branch ${branchName} is not checked out in the scoped worktree.`
        : status.length > 0 ? 'Scoped worktree changes are not committed.' : 'Scoped worktree is clean.',
    };
  } catch {
    return { available: false, dirty: null, commitAt: null, detail: 'Git evidence unavailable.' };
  }
};

const DEFAULT_DEPENDENCIES: LivenessCollectorDependencies = {
  query,
  queryOne,
  processProbe: DEFAULT_PROCESS_PROBE,
  statMtime: async (filePath) => {
    try {
      return (await fs.promises.stat(filePath)).mtime.toISOString();
    } catch {
      return null;
    }
  },
  gitProbe: DEFAULT_GIT_PROBE,
};

function objectPayload(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) return payload as Record<string, unknown>;
  if (typeof payload === 'string') {
    try {
      const parsed: unknown = JSON.parse(payload);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* malformed historical payload */ }
  }
  return {};
}

function blockerText(row: WalEvidenceRow): string {
  const payload = objectPayload(row.payload);
  return [row.event_type, payload.reason, payload.error, payload.blocker_reason, payload.blocked_by, payload.summary]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .slice(0, 1_000);
}

function walIsMeaningful(row: WalEvidenceRow): boolean {
  return !/^(?:worker_heartbeat|run_heartbeat)$/.test(row.event_type);
}

function processEvidence(pid: number | null, probe: ProcessProbeResult): LivenessEvidenceReference {
  const detail = !probe.available
    ? 'Process evidence unavailable.'
    : probe.alive
      ? probe.owned === false ? 'PID exists but is not owned by this service user.' : 'Recorded PID is live and signalable.'
      : 'Recorded PID has exited.';
  return {
    source: 'process',
    reference: pid ? `pid:${pid}` : 'pid:unavailable',
    observedAt: null,
    available: probe.available,
    meaningful: false,
    detail,
  };
}

/**
 * Collect and classify one run. Every database lookup is workspace/run scoped,
 * time/count bounded where the underlying stream can grow, and independently
 * optional. This function performs no writes.
 */
export async function classifyRunLiveness(
  runId: number,
  collectorOptions: ClassifierOptions & { workspaceId?: string; storyId?: string } = {},
  dependencies: Partial<LivenessCollectorDependencies> = {},
): Promise<SSDLCLivenessReport | null> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const now = collectorOptions.now?.() ?? new Date();
  const lookbackMs = collectorOptions.lookbackMs ?? SSDLC_LIVENESS_LOOKBACK_MS;
  const cutoff = new Date(now.getTime() - lookbackMs).toISOString();
  const run = await deps.queryOne<RunEvidenceRow>(
    `SELECT pr.id, pr.workspace_id, pr.status, pr.pid, pr.started_at, pr.finished_at,
            pr.log_path, pr.worktree_path, pr.branch_name, pr.merge_error,
            w.path AS workspace_path, wh.last_seen AS worker_last_seen
       FROM pipeline_runs pr
       JOIN workspaces w ON w.id = pr.workspace_id
       LEFT JOIN worker_heartbeat wh ON wh.worker_id = pr.worker_id
      WHERE pr.id = $1
        AND ($2::text IS NULL OR pr.workspace_id = $2)`,
    [runId, collectorOptions.workspaceId ?? null],
  );
  if (!run) return null;

  const activities: LivenessEvidenceReference[] = [{
    source: 'database',
    reference: `pipeline-run:${run.id}`,
    observedAt: run.finished_at ?? run.started_at,
    available: true,
    meaningful: false,
    detail: `Database status is ${run.status}.`,
  }];
  const process = deps.processProbe(run.pid);
  activities.push(processEvidence(run.pid, process));

  let walRows: WalEvidenceRow[] = [];
  try {
    walRows = await deps.query<WalEvidenceRow>(
      `SELECT id, ts, event_type, story_id, payload
         FROM wal_events
        WHERE workspace_id = $1
          AND payload->>'run_id' = $2::text
          AND ts > $3
          AND ($4::text IS NULL OR story_id = $4 OR story_id IS NULL)
        ORDER BY ts DESC
        LIMIT $5`,
      [run.workspace_id, run.id, cutoff, collectorOptions.storyId ?? null, SSDLC_LIVENESS_SIGNAL_LIMIT],
    );
    activities.push(...walRows.map((row) => ({
      source: 'wal' as const,
      reference: `wal:${row.id}`,
      observedAt: validDate(row.ts)?.toISOString() ?? null,
      available: true,
      meaningful: walIsMeaningful(row),
      detail: `${row.event_type}${row.story_id ? ` (${row.story_id})` : ''}`,
    })));
  } catch {
    activities.push({ source: 'wal', reference: 'wal:unavailable', observedAt: null, available: false, meaningful: false, detail: 'Run-scoped WAL evidence unavailable.' });
  }

  try {
    const output = await deps.queryOne<{ created_at: string }>(
      `SELECT created_at
         FROM run_output_chunks
        WHERE run_id = $1
          AND created_at > $2
        ORDER BY sequence DESC
        LIMIT 1`,
      [run.id, cutoff],
    );
    if (output && validDate(output.created_at)?.getTime()) {
      activities.push({ source: 'log', reference: `run-output:${run.id}`, observedAt: new Date(output.created_at).toISOString(), available: true, meaningful: true, detail: 'Recent bounded terminal output chunk.' });
    } else {
      activities.push({ source: 'log', reference: `run-output:${run.id}`, observedAt: output?.created_at ?? null, available: true, meaningful: false, detail: 'No recent terminal output chunk.' });
    }
  } catch {
    activities.push({ source: 'log', reference: 'run-output:unavailable', observedAt: null, available: false, meaningful: false, detail: 'Terminal output evidence unavailable.' });
  }

  if (run.log_path) {
    const resolvedLogPath = path.isAbsolute(run.log_path) ? run.log_path : path.resolve(run.worktree_path || run.workspace_path, run.log_path);
    const logMtime = await deps.statMtime(resolvedLogPath);
    activities.push({
      source: 'log',
      reference: `log-file:${resolvedLogPath}`,
      observedAt: logMtime,
      available: logMtime !== null,
      meaningful: Boolean(logMtime && new Date(logMtime) > new Date(cutoff)),
      detail: logMtime ? 'Run log modification time.' : 'Run log unavailable.',
    });
  }

  try {
    const pty = await deps.queryOne<{ status: string; last_output_at: string; exited_at: string | null; exit_code: number | null; total_output_bytes: string | number }>(
      `SELECT status, last_output_at, exited_at, exit_code, total_output_bytes
         FROM run_pty_sessions
        WHERE run_id = $1 AND workspace_id = $2`,
      [run.id, run.workspace_id],
    );
    activities.push({
      source: 'pty',
      reference: `pty:${run.id}`,
      observedAt: pty?.last_output_at ?? pty?.exited_at ?? null,
      available: Boolean(pty),
      meaningful: Boolean(pty?.last_output_at && Number(pty.total_output_bytes) > 0 && new Date(pty.last_output_at) > new Date(cutoff)),
      detail: pty ? `PTY status ${pty.status}, ${pty.total_output_bytes} output bytes${pty.exit_code === null ? '' : `, exit ${pty.exit_code}`}.` : 'No PTY session; PTY is optional.',
    });
  } catch {
    activities.push({ source: 'pty', reference: 'pty:unavailable', observedAt: null, available: false, meaningful: false, detail: 'PTY evidence unavailable; this does not imply a stall.' });
  }

  let completionRows: CompletionEvidenceRow[] = [];
  let completionAvailable = true;
  try {
    completionRows = await deps.query<CompletionEvidenceRow>(
      `SELECT sr.id, sr.story_id, sr.status, sr.finished_at, sr.completion_packet,
              sr.blocked_by, scd.status AS closeout_status,
              scd.decision_id AS closeout_decision_id, scd.payload AS closeout_payload
         FROM (
           SELECT DISTINCT ON (story_id) id, story_id, status, finished_at,
                  completion_packet, blocked_by, closeout_decision_id
             FROM story_results
            WHERE run_id = $1
              AND ($2::text IS NULL OR story_id = $2)
            ORDER BY story_id, id DESC
            LIMIT $3
         ) sr
         LEFT JOIN story_closeout_decisions scd ON scd.decision_id = sr.closeout_decision_id
        ORDER BY sr.id DESC`,
      [run.id, collectorOptions.storyId ?? null, SSDLC_LIVENESS_STORY_LIMIT + 1],
    );
  } catch {
    completionAvailable = false;
  }
  const completionTruncated = completionRows.length > SSDLC_LIVENESS_STORY_LIMIT;
  const boundedCompletionRows = completionRows.slice(0, SSDLC_LIVENESS_STORY_LIMIT);
  const completionObservedAt = boundedCompletionRows
    .map((row) => validDate(row.finished_at))
    .filter((date): date is Date => date !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const packetPresent = boundedCompletionRows.length > 0 && boundedCompletionRows.every((row) => row.status === 'skip' || row.status === 'excluded' || Boolean(row.completion_packet));
  const packetValidated = packetPresent && boundedCompletionRows.every((row) => row.status === 'skip' || row.status === 'excluded' || (row.closeout_status === 'accepted' && Boolean(row.closeout_decision_id)));
  const allStoriesTerminal = boundedCompletionRows.length > 0 && boundedCompletionRows.every((row) => ['pass', 'skip', 'excluded'].includes(row.status));
  activities.push({
    source: 'completion_packet',
    reference: boundedCompletionRows[0]?.closeout_decision_id ? `closeout:${boundedCompletionRows[0].closeout_decision_id}` : `completion:${run.id}`,
    observedAt: completionObservedAt?.toISOString() ?? null,
    available: completionAvailable,
    meaningful: Boolean(completionObservedAt && completionObservedAt > new Date(cutoff)),
    detail: completionAvailable
      ? packetValidated ? 'Latest story completion packets have accepted host closeout decisions.' : 'Validated completion packet evidence is incomplete.'
      : 'Completion evidence unavailable.',
  });

  const gitRoot = run.worktree_path || run.workspace_path;
  const git = await deps.gitProbe(gitRoot, run.branch_name);
  activities.push({
    source: 'git',
    reference: `git:${gitRoot}`,
    observedAt: git.commitAt,
    available: git.available,
    meaningful: Boolean(git.commitAt && new Date(git.commitAt) >= new Date(run.started_at) && new Date(git.commitAt) > new Date(cutoff)),
    detail: git.detail,
  });

  if (run.worker_last_seen) {
    activities.push({
      source: 'worker',
      reference: `worker:${run.id}`,
      observedAt: run.worker_last_seen,
      available: true,
      meaningful: false,
      detail: now.getTime() - new Date(run.worker_last_seen).getTime() <= WORKER_HEARTBEAT_STALE_MS ? 'Owning worker heartbeat is fresh.' : 'Owning worker heartbeat is stale.',
    });
  }

  const blockers: LivenessBlockerSignal[] = walRows.map((row) => ({
    text: blockerText(row),
    code: row.event_type,
    observedAt: row.ts,
    evidenceReference: `wal:${row.id}`,
  }));
  for (const row of boundedCompletionRows) {
    if (row.blocked_by) {
      blockers.push({ text: row.blocked_by, observedAt: row.finished_at, evidenceReference: `story-result:${row.id}` });
    }
    if (row.closeout_status === 'blocked') {
      const payload = objectPayload(row.closeout_payload);
      const reasonCodes = Array.isArray(payload.reasonCodes)
        ? payload.reasonCodes.filter((value): value is string => typeof value === 'string').join(' ')
        : '';
      blockers.push({
        text: `closeout blocked ${reasonCodes}`,
        code: 'closeout_blocked',
        observedAt: row.finished_at,
        evidenceReference: row.closeout_decision_id ? `closeout:${row.closeout_decision_id}` : `story-result:${row.id}`,
      });
    }
    const packet = objectPayload(row.completion_packet);
    const packetBlocker = [packet.blocker, packet.blockerReason, packet.blocker_reason, packet.failureReason]
      .find((value): value is string => typeof value === 'string');
    if (packetBlocker) {
      blockers.push({ text: packetBlocker, observedAt: row.finished_at, evidenceReference: `story-result:${row.id}` });
    }
  }
  if (run.merge_error) {
    blockers.push({ text: run.merge_error, observedAt: run.finished_at, evidenceReference: `pipeline-run:${run.id}` });
  }

  return classifySSDLCLiveness({
    runId: run.id,
    workspaceId: run.workspace_id,
    dbStatus: run.status,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    process: { ...process, pid: run.pid },
    worker: run.worker_last_seen ? {
      available: true,
      lastSeen: run.worker_last_seen,
      fresh: now.getTime() - new Date(run.worker_last_seen).getTime() <= WORKER_HEARTBEAT_STALE_MS,
    } : { available: false, lastSeen: null, fresh: false },
    activities,
    completion: {
      available: completionAvailable,
      packetPresent,
      packetValidated,
      allStoriesTerminal,
      truncated: completionTruncated,
      observedAt: completionObservedAt?.toISOString() ?? null,
      reference: boundedCompletionRows[0]?.closeout_decision_id ? `closeout:${boundedCompletionRows[0].closeout_decision_id}` : `completion:${run.id}`,
    },
    blockers,
    git: { available: git.available, dirty: git.dirty, commitAt: git.commitAt, reference: `git:${gitRoot}` },
  }, { ...collectorOptions, now: () => now, lookbackMs });
}
