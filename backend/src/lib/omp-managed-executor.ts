/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

// ─── OmpManagedExecutor (W5-007) ────────────────────────────────────────────
// Oh My Pi (omp) as the primary execution shim, at behavior parity with
// RorcaManagedExecutor (ROR-28). The same ExecutionAdapter surface is backed
// by an omp JSONL-RPC child process instead of the current execution-engine
// entrypoint:
//
//   omp --mode rpc --profile rorca --cwd <worktree> --model <resolved>
//       --thinking <level> --max-time <seconds> @<story-message-file>
//
// with a `--mode text -p/--print --no-pty` fallback for environments where the
// rpc profile is unavailable. Capability-snapshot admission is reused from
// ROR-28 unchanged (normalizeManagedEngineRequest). The omp version probe is
// surfaced at construction and pinned into the launch process identity, which
// is bound into the managed-executor store and therefore into recovery records
// and host-observation evidence.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { governedHash } from './governed-contracts';
import { shouldResolvePiRpcStory } from './agent-completion-protocol';
import { requireOmp, type OmpStatus } from './omp-detector';
import type { Wave3AImplementationGate } from './wave3a-managed-executor-gate';
import { prepareAutonomousSandboxLaunch } from './autonomous-sandbox';
import { PgOrchestrationEventWriter, type OrchestrationEventWriter } from './omp-orchestration-events';
import {
  runOmpProviderFallback,
  type ExecutorFallbackInput,
} from './provider-fallback-policy';
import {
  MANAGED_EXECUTION_ADAPTER,
  ManagedAdmissionError,
  RORCA_MANAGED_EXECUTOR_VERSION,
  normalizeManagedEngineRequest,
  type CurrentExecutionEngineBridge,
  type ExecutionAdapter,
  type ManagedExecutorCanonicalInput,
  type ManagedExecutorStore,
  type ManagedHostObservation,
  type ManagedPreparation,
  type ManagedRecoveryRecord,
  type ManagedResultProposal,
} from './rorca-managed-executor';

/** Managed-agent kinds accepted by the ROR-28 admission layer. */
export type ManagedAgent = import('./rorca-managed-executor').ManagedAgent;
/**
 * Explicit minimal environment ALLOWLIST for the tool-capable omp story child.
 * The child crosses the central autonomous sandbox (prepareAutonomousSandboxLaunch
 * with modelCredentials: true), which brokers only the selected provider
 * credential. Every other worker variable — tenant/provider secrets, ambient
 * profile overrides, CLI state, test control — is absent by construction
 * instead of removed after inheritance.
 */
const OMP_CHILD_ENV_ALLOW: ReadonlySet<string> = new Set([
  // Locale/terminal (non-secret)
  'PATH', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM',
  'NO_COLOR', 'FORCE_COLOR', 'CI', 'TZ', 'DEVELOPER_DIR',
  // Git identity/config (non-secret)
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
  'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_TERMINAL_PROMPT', 'GIT_ASKPASS',
  'GIT_SSH_COMMAND', 'GCM_INTERACTIVE', 'GH_CONFIG_DIR',
  // Worker-issued ordinary-local runtime authority. HOME is source-only: the
  // shared sandbox rewrites it to the private runtime before child spawn.
  'HOME', 'PI_BIN', 'RORCA_ORDINARY_LOCAL_PI_PROFILE',
  'RORCA_AUTONOMOUS_ISOLATION', 'RORCA_AUTONOMOUS_GIT_STATE_ROOT',
  'RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS', 'RORCA_AUTONOMOUS_EGRESS_SOCKET',
  'RORCA_AUTONOMOUS_EGRESS_RUN_ID', 'RORCA_AUTONOMOUS_EGRESS_AUTHORITY_HASH',
  'RORCA_AUTONOMOUS_EGRESS_IDENTITY_HASH',
  // omp/pi runtime flags (non-secret)
  'PI_OFFLINE', 'PI_SKIP_VERSION_CHECK', 'PI_TELEMETRY',
  // Broker-eligible model credentials (provider keys only)
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY',
  // Managed-executor launch evidence metadata (non-secret request identity)
  'RORCA_PROCESS_ROLE', 'RORCA_WORKSPACE_ID',
  'RORCA_MANAGED_REQUEST_HASH', 'RORCA_MANAGED_ATTEMPT_ID', 'RORCA_MANAGED_GENERATION',
  'RORCA_MANAGED_LEASE_ID', 'RORCA_MANAGED_FENCING_TOKEN',
  'RORCA_MANAGED_CAPABILITY_SNAPSHOT_HASH', 'RORCA_MANAGED_QUOTA_RESERVATION_ID',
]);

/**
 * Build the explicit child environment: only allowlisted non-secret keys from
 * the trusted worker env plus the request's managed-executor evidence metadata.
 * No worker secret (GITHUB_TOKEN, activation keys, tenant credentials) ever
 * enters the child namespace.
 */
export function buildOmpChildEnv(
  trustedEnvironment: Readonly<NodeJS.ProcessEnv>,
  request: Readonly<Partial<{
    workspaceId: string; requestHash: string; attemptId: string; generation: number;
    leaseId: string; fencingToken: number; capabilitySnapshotHash: string; quotaReservationId: string;
  }>> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of OMP_CHILD_ENV_ALLOW) {
    const value = trustedEnvironment[key];
    if (value !== undefined) env[key] = value;
  }
  env.RORCA_PROCESS_ROLE = 'omp-managed-engine';
  if (request.workspaceId !== undefined) env.RORCA_WORKSPACE_ID = request.workspaceId;
  if (request.requestHash !== undefined) env.RORCA_MANAGED_REQUEST_HASH = request.requestHash;
  if (request.attemptId !== undefined) env.RORCA_MANAGED_ATTEMPT_ID = request.attemptId;
  if (request.generation !== undefined) env.RORCA_MANAGED_GENERATION = String(request.generation);
  if (request.leaseId !== undefined) env.RORCA_MANAGED_LEASE_ID = request.leaseId;
  if (request.fencingToken !== undefined) env.RORCA_MANAGED_FENCING_TOKEN = String(request.fencingToken);
  if (request.capabilitySnapshotHash !== undefined) env.RORCA_MANAGED_CAPABILITY_SNAPSHOT_HASH = request.capabilitySnapshotHash;
  if (request.quotaReservationId !== undefined) env.RORCA_MANAGED_QUOTA_RESERVATION_ID = request.quotaReservationId;
  return env;
}

export const OMP_MANAGED_PROFILE = 'rorca' as const;
export const OMP_DEFAULT_THINKING_LEVEL = 'high' as const;

interface PendingRpcRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

interface OmpRpcSession {
  readonly process: ChildProcess;
  requestId: number;
  readonly pending: Map<string, PendingRpcRequest>;
  readonly eventListeners: Array<(event: unknown) => void>;
  readonly outputHash: crypto.Hash;
  readonly detachedProcessGroup: boolean;
  stderr: string;
  ready: boolean;
  /** Protocol settlement (agent_settled / rpc error) — NOT OS-process death. */
  settled: boolean;
  /** Observed OS-process death: the child 'close' event after exit. */
  closed: boolean;
  /** Durable death receipt hash once OS death is observed or probed. */
  deathReceiptHash: string | null;
  /** Monotonic host timestamp of the observed death. */
  deathObservedAt: number | null;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  diagnosticCode: string | null;
}

/**
 * Authoritative process-identity liveness probe: the kernel reports ESRCH only
 * when the pid is genuinely gone. Used after TERM and KILL to prove quiescence
 * when the close event has not yet been observed.
 */
export function processIdentityAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function serializeJsonLine(value: unknown): string {
  return JSON.stringify(value) + '\n';
}

/** Compact JSONL reader for the omp RPC stream (execution-engine owns the shared one). */
function attachJsonlLineReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void): () => void {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  const handleData = (chunk: Buffer | string): void => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      onLine(line);
      newlineIndex = buffer.indexOf('\n');
    }
  };
  const handleEnd = (): void => {
    buffer += decoder.end();
    if (buffer.length > 0) onLine(buffer);
  };
  stream.on('data', handleData);
  stream.on('end', handleEnd);
  return () => {
    stream.off('data', handleData);
    stream.off('end', handleEnd);
  };
}
export interface OmpManagedLaunchOptions {
  /** Absolute path of the omp binary (probe result). */
  readonly bin: string;
  /** omp version pinned into launch evidence (probe result). */
  readonly ompVersion: string | null;
  /** Environment trusted for the child (worker process env). */
  readonly trustedEnvironment: Readonly<NodeJS.ProcessEnv>;
  /** omp --thinking level; defaults to OMP_DEFAULT_THINKING_LEVEL. */
  readonly thinkingLevel?: string;
  /** Seconds to wait for a managed launch acknowledgement. */
  readonly startupTimeoutMs?: number;
  /** SIGTERM → SIGKILL grace for cancellation. */
  readonly terminationGraceMs?: number;
  /** Extra wait after SIGKILL before declaring quiescence unproven. */
  readonly killProofTimeoutMs?: number;
  /** Durable OMP JSONL projector; injectable for instrumented RPC tests. */
  readonly orchestrationEvents?: OrchestrationEventWriter;
}

interface OwnedOmpProcess {
  readonly session: OmpRpcSession;
  readonly processIdentity: string;
  readonly requestHash: string;
  readonly messageFile: string;
  readonly worktreePath: string;
  readonly cleanup: () => void;
}

function buildStoryMessage(request: {
  storyId: string; missionId: string; missionRevision: number; workPackageId: string; workPackageRevision: number;
  attemptId: string; generation: number; runId: number | string; canonicalSpecPath: string;
  worktreePath: string; branchName: string; model: string | null;
}): string {
  return [
    `Rorca managed story execution (attempt ${request.attemptId}, generation ${request.generation}).`,
    `Story: ${request.storyId}`,
    `Mission: ${request.missionId} (revision ${request.missionRevision})`,
    `Work package: ${request.workPackageId} (revision ${request.workPackageRevision})`,
    `Run: ${String(request.runId)}`,
    `Canonical spec: ${request.canonicalSpecPath}`,
    `Branch: ${request.branchName}`,
    '',
    'Implement the story end to end inside this worktree: plan, edit, validate, fix, and report. ' +
    'Work only inside the given worktree. Never commit, never push, never merge, never deploy. ' +
    'If you end the turn without code changes, report a concrete blocker with file-level evidence.',
  ].join('\n');
}

/**
 * Process bridge around the omp CLI rpc profile. It does not implement provider
 * logic, lifecycle decisions, release, merge, or deploy — parity with
 * CurrentEngineManagedBridge.
 */
export class OmpManagedProcessBridge implements CurrentExecutionEngineBridge {
  private readonly processes = new Map<string, OwnedOmpProcess>();

  constructor(private readonly options: OmpManagedLaunchOptions) {}

  private persistLaunchFailure(messageFile: string, request: Parameters<CurrentExecutionEngineBridge['launch']>[0], error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error));
    const payload = {
      schemaVersion: 'rorca.omp-launch-failure.v1',
      code: 'omp_sandbox_launch_failed',
      requestHash: request.requestHash,
      attemptId: request.attemptId,
      generation: request.generation,
      recordedAt: new Date().toISOString(),
      errorName: failure.name.slice(0, 120),
      message: failure.message.slice(0, 2_000),
    };
    try {
      fs.writeFileSync(`${messageFile}.launch-failure.json`, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    } catch {
      // Never weaken confinement or fall back to a raw spawn because writing
      // the diagnostic failed; the managed store still records a lost launch.
    }
  }

  async launch(request: Parameters<CurrentExecutionEngineBridge['launch']>[0], launchToken: string): Promise<{ processIdentity: string }> {
    if (this.processes.has(request.requestHash)) throw new Error('Managed omp request already owns a process');
    const runId = typeof request.runId === 'number' ? String(request.runId) : request.runId;
    const sessionDirectory = this.prepareSessionDirectory(request.worktreePath, runId, request.storyId);
    const messageFile = path.join(sessionDirectory, `${runId}-${request.storyId}-${request.attemptId}-g${request.generation}.md`);
    fs.writeFileSync(messageFile, buildStoryMessage(request), { mode: 0o600 });

    const args = [
      '--mode', 'rpc',
      '--profile', OMP_MANAGED_PROFILE,
      '--cwd', request.worktreePath,
      '--no-extensions',
      ...(request.model ? ['--model', request.model] : []),
      '--thinking', this.options.thinkingLevel ?? OMP_DEFAULT_THINKING_LEVEL,
      ...(request.timeoutMs > 0 ? ['--max-time', String(Math.max(1, Math.floor(request.timeoutMs / 1000)))] : []),
      `@${messageFile}`,
    ];

    // Explicit minimal allowlist environment — no worker secret survives; the
    // sandbox additionally brokers only the selected model credential.
    const env = buildOmpChildEnv(this.options.trustedEnvironment, request);

    // Use the exact run-owned sandbox path used by the Pi child. On Darwin the
    // worker-issued ordinary-local profile supplies private runtime/auth state,
    // Seatbelt, and its run-bound egress relay. On Linux this selects bwrap and
    // the same run-bound broker socket. Preparation failure is terminal: there
    // is deliberately no raw-spawn fallback.
    let launch;
    try {
      launch = prepareAutonomousSandboxLaunch({
        command: this.options.bin,
        args,
        cwd: request.worktreePath,
        env,
        modelCredentials: true,
      });
    } catch (error) {
      this.persistLaunchFailure(messageFile, request, error);
      throw error;
    }

    const detachedProcessGroup = process.platform !== 'win32';
    let child: ChildProcess;
    try {
      child = spawn(launch.command, launch.args, {
        cwd: launch.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: launch.env,
        detached: detachedProcessGroup,
      });
    } catch (error) {
      this.persistLaunchFailure(messageFile, request, error);
      throw error;
    }
    const versionLabel = this.options.ompVersion ? `v${this.options.ompVersion}` : 'unknown';
    const processIdentity = `managed-omp:${versionLabel}:${child.pid ?? 'pending'}:${crypto.createHash('sha256').update(`${request.requestHash}:${launchToken}`).digest('hex')}`;

    const session: OmpRpcSession = {
      process: child, requestId: 0, pending: new Map(), eventListeners: [],
      outputHash: crypto.createHash('sha256'), detachedProcessGroup,
      stderr: '', ready: false, settled: false, closed: false,
      deathReceiptHash: null, deathObservedAt: null,
      exitCode: null, exitSignal: null, diagnosticCode: null,
    };

    // Preserve source order even though PostgreSQL persistence is asynchronous.
    // RPC responses are consumed by handleJsonlLine and never enter this event
    // listener; every other actual stdout JSONL object is projected, including
    // unknown future OMP vocabulary.
    if (this.options.orchestrationEvents) {
      let sourceOrdinal = 0;
      let ingestion = Promise.resolve();
      session.eventListeners.push((event) => {
        const ordinal = ++sourceOrdinal;
        ingestion = ingestion.then(async () => {
          await this.options.orchestrationEvents!.append({
            request, processIdentity, sourceOrdinal: ordinal, event, observedAt: new Date().toISOString(),
          });
        }).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          session.stderr += `\n[omp-orchestration] ${message.slice(0, 1000)}`;
          session.diagnosticCode = session.diagnosticCode ?? 'omp_orchestration_ingest_failed';
        });
      });
    }

    const detachStdout = child.stdout ? attachJsonlLineReader(child.stdout, (line) => this.handleJsonlLine(session, line, 'stdout')) : () => {};
    const detachStderr = child.stderr ? attachJsonlLineReader(child.stderr, (line) => this.handleJsonlLine(session, line, 'stderr')) : () => {};
    child.stdout?.on('data', (chunk: Buffer | string) => session.outputHash.update(chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => session.outputHash.update(chunk));

    const cleanup = (): void => {
      detachStdout();
      detachStderr();
      session.eventListeners.length = 0;
      try { fs.rmSync(sessionDirectory, { recursive: true, force: true }); } catch { /* best effort */ }
    };

    const owned: OwnedOmpProcess = { session, processIdentity, requestHash: request.requestHash, messageFile, worktreePath: request.worktreePath, cleanup };
    this.processes.set(request.requestHash, owned);

    child.once('error', (error) => {
      session.diagnosticCode = `omp_spawn:${error.name}`;
      session.settled = true;
    });
    child.once('close', (code, signal) => {
      session.exitCode = code;
      session.exitSignal = signal as NodeJS.Signals | null;
      session.settled = true;
      session.closed = true;
      session.deathObservedAt = Date.now();
      session.deathReceiptHash = governedHash('rorca.omp-process-group-death.v1', {
        processIdentity,
        pid: child.pid ?? null,
        exitCode: code,
        exitSignal: signal ?? null,
      } as never);
      if (code !== 0 && !session.diagnosticCode) session.diagnosticCode = 'omp_nonzero_exit';
    });

    const settleListener = (event: unknown): void => {
      const data = typeof event === 'object' && event !== null ? event as Record<string, unknown> : null;
      if (!data) return;
      const eventType = typeof data.type === 'string' ? data.type : '';
      if (eventType === 'error' && !session.settled) {
        session.settled = true;
        session.diagnosticCode = typeof data.message === 'string' ? data.message.slice(0, 240) : 'omp_rpc_error';
        void this.quiesce(session, 'omp_rpc_error');
        return;
      }
      if (shouldResolvePiRpcStory(eventType) && !session.settled) {
        session.settled = true;
        session.diagnosticCode = 'omp_story_settled';
        // The story finished; quiesce the RPC server so a settled result can be
        // proposed (parity with stopPiRpcServer after a settled story).
        void this.quiesce(session, 'omp_story_settled');
      }
    };
    session.eventListeners.push(settleListener);

    try {
      await this.handshake(session);
    } catch (error) {
      session.eventListeners.length = 0;
      this.persistLaunchFailure(messageFile, request, error);
      // Prove process-group death before relinquishing ownership. If proof
      // fails, retain the owned process so the executor's terminate path can
      // fence it and mark the generation conflicting rather than lost.
      await this.quiesce(session, 'omp_launch_failed');
      if (session.closed || (child.pid !== undefined && !processIdentityAlive(child.pid))) {
        this.processes.delete(request.requestHash);
        // Preserve story input and diagnostic, but detach completed readers.
        detachStdout();
        detachStderr();
      }
      throw error;
    }
    return { processIdentity };
  }

  private prepareSessionDirectory(worktreePath: string, runId: string, storyId: string): string {
    const insideWorktree = path.join(worktreePath, '.rorca', 'omp-managed');
    try {
      fs.mkdirSync(insideWorktree, { recursive: true, mode: 0o700 });
      return insideWorktree;
    } catch {
      const fallback = fs.mkdtempSync(path.join(os.tmpdir(), `rorca-omp-managed-${runId}-${storyId}-`));
      fs.chmodSync(fallback, 0o700);
      return fallback;
    }
  }

  private handleJsonlLine(session: OmpRpcSession, line: string, stream: 'stdout' | 'stderr'): void {
    const trimmed = line.endsWith('\r') ? line.slice(0, -1).trim() : line.trim();
    if (!trimmed) return;
    let data: unknown;
    try {
      data = JSON.parse(trimmed);
    } catch {
      session.stderr += `\n[omp-rpc] Invalid JSONL from ${stream}: ${trimmed.slice(0, 500)}`;
      return;
    }
    if (stream === 'stderr') {
      session.stderr += trimmed.slice(0, 2000) + '\n';
      return;
    }
    if (typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'response'
        && typeof (data as { id?: unknown }).id === 'string') {
      const response = data as { id: string; success?: unknown; error?: unknown; command?: unknown };
      const pending = session.pending.get(response.id);
      if (pending) {
        session.pending.delete(response.id);
        if (response.success === false) {
          const message = typeof response.error === 'string'
            ? response.error
            : `omp RPC command failed (${String(response.command ?? 'unknown')})`;
          pending.reject(new Error(message));
        } else {
          pending.resolve(data);
        }
        return;
      }
      session.stderr += `\n[omp-rpc] Unmatched response id ${response.id}`;
      return;
    }
    for (const listener of [...session.eventListeners]) {
      try { listener(data); } catch { /* listener errors are non-fatal */ }
    }
  }

  private sendCommand(session: OmpRpcSession, command: object): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = `req_${++session.requestId}`;
      const timeout = setTimeout(() => {
        session.pending.delete(id);
        reject(new Error(`omp RPC command timed out after 30000ms (id=${id}). stderr tail:\n${session.stderr.slice(-4096)}`));
      }, 30_000);
      session.pending.set(id, {
        resolve: (result) => { clearTimeout(timeout); resolve(result); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      try {
        session.process.stdin?.write(serializeJsonLine({ ...command, id }));
      } catch (error) {
        session.pending.delete(id);
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async handshake(session: OmpRpcSession): Promise<void> {
    const timeout = this.options.startupTimeoutMs ?? 10_000;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.diagnosticCode = 'omp_launch_ack_timeout';
        this.killGroup(session.process, 'SIGTERM');
        reject(new Error('omp did not acknowledge the managed launch gate'));
      }, timeout);
      timer.unref();
      const cleanup = (): void => { clearTimeout(timer); session.process.off('error', onError); session.process.off('close', onClose); };
      const onError = (error: Error): void => { cleanup(); reject(error); };
      const onClose = (): void => { cleanup(); reject(new Error('omp closed before managed launch acknowledgement')); };
      session.process.once('error', onError);
      session.process.once('close', onClose);
      // The managed launch gate is the completed rpc session bootstrap:
      // new_session + get_state prove the omp rpc profile is ready to run the
      // story delivered through the positional @message file.
      this.bootstrapSession(session).then(() => {
        cleanup();
        resolve();
      }).catch((error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
    session.ready = true;
  }

  private async bootstrapSession(session: OmpRpcSession): Promise<void> {
    await this.sendCommand(session, { type: 'new_session' });
    await this.sendCommand(session, { type: 'get_state' });
  }


  private killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
    try {
      if (child.pid) {
        if (this.processGroup(child)) process.kill(-child.pid, signal);
        else child.kill(signal);
      }
    } catch { /* already gone */ }
  }

  private processGroup(child: ChildProcess): boolean {
    // Detached groups are killed as a unit so extension/tool children die too.
    return Boolean(child.pid) && process.platform !== 'win32';
  }

  /**
   * OS-process death proof. Returns true ONLY on an observed close/exit event
   * or an authoritative process-identity liveness probe (ESRCH). Protocol
   * settlement (agent_settled) is NEVER treated as death — a settled RPC
   * server may still be running.
   */
  private async waitForDeath(session: OmpRpcSession, timeoutMs: number): Promise<boolean> {
    if (session.closed) return true;
    const pid = session.process.pid;
    if (pid === undefined) return session.closed;
    return new Promise((resolve) => {
      let finished = false;
      const finish = (dead: boolean): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        session.process.off('close', onClose);
        resolve(dead);
      };
      const onClose = (): void => finish(true);
      const timer = setTimeout(() => finish(!processIdentityAlive(pid)), timeoutMs);
      timer.unref();
      session.process.once('close', onClose);
    });
  }

  private async quiesce(session: OmpRpcSession, reasonCode: string): Promise<void> {
    if (session.closed || session.exitCode !== null) return;
    session.diagnosticCode = session.diagnosticCode ?? reasonCode;
    this.killGroup(session.process, 'SIGTERM');
    const terminated = await this.waitForDeath(session, this.options.terminationGraceMs ?? 5_000);
    if (!terminated && !session.closed) {
      this.killGroup(session.process, 'SIGKILL');
      const killed = await this.waitForDeath(session, this.options.killProofTimeoutMs ?? 5_000);
      if (!killed && !session.closed) {
        session.diagnosticCode = `quiescence_unproven:${reasonCode}`;
      }
    }
  }


  async cancel(request: Parameters<CurrentExecutionEngineBridge['cancel']>[0], reasonCode: string): Promise<ManagedHostObservation> {
    const owned = this.processes.get(request.requestHash);
    if (!owned) {
      return Object.freeze({ live: false, processIdentity: null, exitCode: null, exitSignal: null, outputHash: null, diagnosticCode: 'process_not_found' });
    }
    owned.session.diagnosticCode = `cancelled:${reasonCode}`;
    await this.quiesce(owned.session, `cancelled:${reasonCode}`);
    return this.observe(request);
  }

  async terminate(request: Parameters<CurrentExecutionEngineBridge['terminate']>[0], reasonCode: string): Promise<ManagedHostObservation> {
    return this.cancel(request, `fenced:${reasonCode}`);
  }

  async observe(request: Parameters<CurrentExecutionEngineBridge['observe']>[0]): Promise<ManagedHostObservation> {
    const owned = this.processes.get(request.requestHash);
    if (!owned) {
      return Object.freeze({ live: false, processIdentity: null, exitCode: null, exitSignal: null, outputHash: null, deathReceiptHash: null, diagnosticCode: 'process_not_found' });
    }
    const { session, processIdentity } = owned;
    return Object.freeze({
      live: !session.closed && session.exitCode === null,
      processIdentity,
      exitCode: session.exitCode,
      exitSignal: session.exitSignal,
      outputHash: session.closed ? `sha256:${session.outputHash.copy().digest('hex')}` : null,
      deathReceiptHash: session.deathReceiptHash,
      diagnosticCode: session.diagnosticCode,
    });
  }
}

/**
 * OmpManagedExecutor — same ExecutionAdapter surface as RorcaManagedExecutor
 * with behavior parity. Admission reuses the ROR-28 capability-snapshot
 * machinery unchanged; only the process bridge and the omp probe differ.
 */
export class OmpManagedExecutor implements ExecutionAdapter {
  readonly [MANAGED_EXECUTION_ADAPTER] = true as const;
  readonly name = 'OmpManagedExecutor' as const;
  readonly version = RORCA_MANAGED_EXECUTOR_VERSION;

  constructor(
    private readonly store: ManagedExecutorStore,
    private readonly engine: CurrentExecutionEngineBridge,
    private readonly implementationGate: Wave3AImplementationGate,
    /** Probe result surfaced at construction and pinned into launch evidence. */
    readonly ompProbe: OmpStatus,
    private readonly now: () => number = Date.now,
  ) {}

  async prepare(input: ManagedExecutorCanonicalInput): Promise<ManagedPreparation> {
    if (!this.implementationGate.accepted || this.implementationGate.executionAuthority !== 'none') {
      throw new ManagedAdmissionError('invalid_contract', 'Wave 3A exact prerequisite gate is not accepted');
    }
    return this.store.prepare(normalizeManagedEngineRequest(input, this.now()));
  }

  /** Apply Rorca's named chain within this OMP-owned story session. */
  applyProviderFallback<T>(input: ExecutorFallbackInput<T>): Promise<T> {
    return runOmpProviderFallback(input);
  }

  async launch(preparation: ManagedPreparation): Promise<{ processIdentity: string }> {
    if (!preparation.released) throw new ManagedAdmissionError('duplicate_launch', 'preparation has no released launch token');
    await this.store.revalidate(preparation.request, 'launch');
    if (!await this.store.transition(preparation.request.requestHash, ['released'], 'running')) {
      throw new ManagedAdmissionError('duplicate_launch', 'managed generation is already launched or fenced');
    }
    try {
      const launched = await this.engine.launch(preparation.request, preparation.launchToken);
      await this.store.bindProcess(preparation.request.requestHash, launched.processIdentity);
      return launched;
    } catch (error) {
      let observation: ManagedHostObservation;
      try {
        observation = await this.engine.terminate(preparation.request, 'launch_or_process_binding_failed');
      } catch {
        await this.store.transition(preparation.request.requestHash, ['running'], 'conflicting');
        throw new ManagedAdmissionError('fence_lost', 'managed omp launch failed and process quiescence could not be proven');
      }
      if (observation.live) {
        await this.store.transition(preparation.request.requestHash, ['running'], 'conflicting', observation.outputHash ?? undefined);
        throw new ManagedAdmissionError('fence_lost', 'managed omp launch failed while a child may still be live');
      }
      await this.store.transition(preparation.request.requestHash, ['running'], 'lost', observation.outputHash ?? undefined);
      throw error;
    }
  }

  private async exactRecord(requestHash: string): Promise<ManagedRecoveryRecord> {
    const record = await this.store.load(requestHash);
    if (!record || record.request.requestHash !== requestHash) throw new ManagedAdmissionError('fence_lost', 'managed attempt identity is unavailable');
    return record;
  }

  async cancel(requestHash: string, reasonCode: string): Promise<ManagedHostObservation> {
    const record = await this.exactRecord(requestHash);
    const observation = await this.engine.cancel(record.request, reasonCode);
    if (observation.live) {
      await this.store.transition(requestHash, ['prepared', 'released', 'running', 'lost'], 'conflicting', observation.outputHash ?? undefined);
      throw new ManagedAdmissionError('fence_lost', 'managed omp cancellation could not prove process quiescence');
    }
    await this.store.transition(requestHash, ['prepared', 'released', 'running', 'lost'], 'cancelled', observation.outputHash ?? undefined);
    return observation;
  }

  async observe(requestHash: string): Promise<ManagedHostObservation> {
    return this.engine.observe((await this.exactRecord(requestHash)).request);
  }

  async revalidateMutation(requestHash: string, phase: 'commit' | 'closeout'): Promise<void> {
    const record = await this.exactRecord(requestHash);
    await this.store.revalidate(record.request, phase);
  }

  async proposeResult(requestHash: string, status: ManagedResultProposal['status'], evidenceHash: string): Promise<ManagedResultProposal> {
    const record = await this.exactRecord(requestHash);
    await this.store.revalidate(record.request, 'result');
    const observation = await this.engine.observe(record.request);
    if (record.state === 'cancelled' || record.state === 'expired' || record.state === 'conflicting' || record.state === 'quarantined') {
      throw new ManagedAdmissionError('fence_lost', 'fenced generation cannot propose a result');
    }
    if (observation.live) throw new ManagedAdmissionError('fence_lost', 'live omp process cannot propose a settled result');
    const hostObservationHash = governedHash('rorca.managed-host-observation.v1', observation as never);
    const proposal: ManagedResultProposal = Object.freeze({
      schemaVersion: 'rorca.managed-result-proposal.v1', requestHash, attemptId: record.request.attemptId,
      generation: record.request.generation, leaseId: record.request.leaseId, fencingToken: record.request.fencingToken,
      status, evidenceHash, hostObservationHash, closeoutAuthority: 'none', storyLifecycleAuthority: 'none',
      mergeAuthority: 'none', deploymentAuthority: 'none',
    });
    await this.store.persistResult(proposal);
    await this.store.transition(requestHash, ['running', 'lost'], 'result_persisted', evidenceHash);
    return proposal;
  }

  async recover(limit = 100): Promise<readonly Readonly<{ requestHash: string; action: string }>[]> {
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const actions: Array<Readonly<{ requestHash: string; action: string }>> = [];
    for (const record of await this.store.listRecoverable(boundedLimit)) {
      const requestHash = record.request.requestHash;
      if (record.quarantined || record.state === 'conflicting') { actions.push({ requestHash, action: 'blocked_for_reconciliation' }); continue; }
      if (record.state === 'result_persisted' || record.state === 'closeout_pending') { actions.push({ requestHash, action: 'resume_idempotent_closeout' }); continue; }
      if (record.state === 'prepared') { actions.push({ requestHash, action: 'prepared_not_released' }); continue; }
      if (record.state === 'cancelled' || record.state === 'expired') { actions.push({ requestHash, action: 'terminal_no_relaunch' }); continue; }
      const observation = await this.engine.observe(record.request);
      if (record.state === 'running' && observation.live && record.processIdentity !== null && observation.processIdentity === record.processIdentity) {
        actions.push({ requestHash, action: 'observe_live' });
      } else if (record.state === 'running' || record.state === 'lost') {
        if (observation.live) await this.engine.terminate(record.request, 'stale_or_ambiguous_generation');
        await this.store.transition(requestHash, ['running', 'lost'], 'expired', observation.outputHash ?? undefined);
        actions.push({ requestHash, action: 'expire_preserve_evidence' });
      }
    }
    return Object.freeze(actions);
  }
}

/**
 * Fail-closed construction: probe omp, require the gate, and hand back a ready
 * OmpManagedExecutor bound to a fresh bridge. Throws when omp is missing or
 * below v17 — managed dispatch stays fail closed, mirroring requirePi.
 */
export function createOmpManagedExecutor(
  store: ManagedExecutorStore,
  implementationGate: Wave3AImplementationGate,
  trustedEnvironment: Readonly<NodeJS.ProcessEnv> = process.env,
  now: () => number = Date.now,
): OmpManagedExecutor {
  const probe = requireOmp();
  const bridge = new OmpManagedProcessBridge({
    bin: probe.ompBinPath!,
    ompVersion: probe.ompVersion,
    trustedEnvironment,
    orchestrationEvents: new PgOrchestrationEventWriter(),
  });
  return new OmpManagedExecutor(store, bridge, implementationGate, probe, now);
}
