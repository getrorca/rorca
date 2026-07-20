/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  executeStoryWithAdapter,
  type StoryExecutionAdapter,
  type StoryExecutionAdapterRequest,
  type StoryExecutionAdapterResult,
} from '../lib/story-execution-adapter';
import { resolveWaveSafetyLimits, type WaveSafetyLimits } from '../lib/wave-execution-safety';

const TERMINATION_GRACE_MS = 150;
const sourceRoot = fs.existsSync(path.resolve(process.cwd(), 'backend', 'src'))
  ? path.resolve(process.cwd(), 'backend', 'src')
  : path.resolve(process.cwd(), 'src');
const FIXTURE_AGENT_PATH = path.join(sourceRoot, '__tests__', 'fixtures', 'wave-fixture-agent.mjs');
const FIXTURE_MANIFEST_PATH = path.join(sourceRoot, '__tests__', 'fixtures', 'wave-agent-scenarios.json');

export type FixtureStatus = 'passed' | 'rejected' | 'timed_out' | 'cancelled' | 'abrupt_exit' | 'restart_pending' | 'adapter_error' | 'failed';
export type FixtureHostPhase = 'hostValidation' | 'integration' | 'finalCloseout';

export interface FixtureLifecycle {
  queueClaimed: boolean;
  started: boolean;
  committed: boolean;
  signalled: boolean;
  exited: boolean;
  hostValidation: boolean;
  integration: boolean;
  finalCloseout: boolean;
}

export interface FixtureEvent {
  schemaVersion: 1;
  sequence: number;
  type: string;
  executionId: string;
  scenarioId: string;
  at: string;
  wallClockMs: number;
  [key: string]: unknown;
}

export interface FixtureExecutionInput {
  storyId: string;
  scenarioId: string;
  seed: string;
  revision: string;
  cwd: string;
  timeoutMs?: number;
  attempt?: 1 | 2;
  barrierDirectory?: string;
}

interface FixtureAdapterPayload {
  scenarioId: string;
  seed: string;
  revision: string;
  attempt: 1 | 2;
  barrierDirectory?: string;
  abortSignal?: AbortSignal;
  onEvent?: (event: Readonly<FixtureEvent>) => void;
}

export interface FixtureExecutionEvidence {
  schemaVersion: 1;
  manifestId: string;
  executionId: string;
  storyId: string;
  scenarioId: string;
  seed: string;
  revision: string;
  faultPoint: string;
  pid: number | null;
  descendantPids: number[];
  unreapedPids: number[];
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
  exitCode: number;
  exitSignal: NodeJS.Signals | null;
  status: FixtureStatus;
  timedOut: boolean;
  cancelled: boolean;
  outputBytes: number;
  stderrTail: string;
  lifecycle: FixtureLifecycle;
  events: FixtureEvent[];
  adapterError?: string;
}

interface ScenarioManifestEntry {
  behavior: string;
  faultPoint: string;
  file: string;
  commitMessage: string;
  spawnDescendant: boolean;
}

interface ScenarioManifest {
  schemaVersion: 1;
  manifestId: string;
  scenarios: Record<string, ScenarioManifestEntry>;
}

interface ActiveExecution {
  terminate(signal: NodeJS.Signals, reason: 'timeout' | 'cancel' | 'adapter-error' | 'teardown' | 'completion'): void;
  done: Promise<void>;
}

function readManifest(): ScenarioManifest {
  const parsed = JSON.parse(fs.readFileSync(FIXTURE_MANIFEST_PATH, 'utf8')) as ScenarioManifest;
  if (parsed.schemaVersion !== 1 || parsed.manifestId !== 'rorca-deterministic-wave-agent-v1') {
    throw new Error('[fixture-adapter] unsupported fixture manifest');
  }
  return parsed;
}

function strictlyContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertTemporaryFixtureRoot(requestedRoot: string): string {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const root = fs.realpathSync(requestedRoot);
  if (!strictlyContained(temporaryRoot, root)) throw new Error('[fixture-adapter] fixture root must be under the OS temporary directory');
  return root;
}

function assertOwnedDirectory(root: string, candidate: string, label: string): string {
  const real = fs.realpathSync(candidate);
  if (!strictlyContained(root, real)) throw new Error(`[fixture-adapter] ${label} escaped fixture root`);
  const stat = fs.lstatSync(real);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`[fixture-adapter] ${label} must be a real directory`);
  return real;
}

function sanitizedFixtureEnv(root: string): NodeJS.ProcessEnv {
  const home = path.join(root, '.fixture-home');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  return {
    NODE_ENV: 'test',
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    TMPDIR: root,
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '',
    RORCA_FIXTURE_ROOT: root,
  };
}

function killProcessTree(child: ChildProcess, descendantPids: ReadonlySet<number>, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (process.platform === 'win32' && pid && pid > 0) {
    // Windows has no POSIX process-group signal contract. taskkill /T reaches
    // descendants even if cancellation races their first structured event.
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])], {
      windowsHide: true,
      shell: false,
      stdio: 'ignore',
    });
    killer.unref();
  } else if (pid && pid > 0) {
    try { process.kill(-pid, signal); } catch { /* process group is already gone */ }
  }
  try { child.kill(signal); } catch { /* child is already gone */ }
  for (const descendantPid of descendantPids) {
    try { process.kill(descendantPid, signal); } catch { /* descendant is already gone */ }
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForReaping(pids: number[], cleanupMs: number): Promise<number[]> {
  const deadline = Date.now() + cleanupMs;
  let remaining = pids.filter(processExists);
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
    remaining = remaining.filter(processExists);
  }
  return remaining;
}

function statusFor(input: {
  scenarioId: string;
  code: number;
  timedOut: boolean;
  cancelled: boolean;
  adapterError?: string;
}): FixtureStatus {
  if (input.adapterError) return 'adapter_error';
  if (input.timedOut) return 'timed_out';
  if (input.cancelled) return 'cancelled';
  if (input.scenarioId === 'restart-resume' && input.code === 87) return 'restart_pending';
  if ([30, 31, 32].includes(input.code)) return 'rejected';
  if ([86, 87].includes(input.code)) return 'abrupt_exit';
  return input.code === 0 ? 'passed' : 'failed';
}

function appendBounded(current: Buffer, chunk: Buffer, maxBytes: number): { buffer: Buffer; overflow: boolean } {
  const combined = Buffer.concat([current, chunk]);
  if (combined.length <= maxBytes) return { buffer: combined, overflow: false };
  return { buffer: combined.subarray(0, maxBytes), overflow: true };
}

/**
 * Test-owned adapter for the same canonical dispatch seam as production agents.
 * Scenario behavior is looked up from the versioned manifest; request payloads
 * can never supply a command, argv, shell, environment, URL, or script.
 */
export class DeterministicFixtureHarness implements StoryExecutionAdapter<FixtureAdapterPayload, FixtureExecutionEvidence> {
  readonly name = 'deterministic-wave-fixture';
  private readonly root: string;
  private readonly manifest = readManifest();
  private readonly active = new Map<string, ActiveExecution>();
  private activeProcessCount = 0;

  constructor(fixtureRoot: string, private readonly limits: Readonly<WaveSafetyLimits> = resolveWaveSafetyLimits()) {
    this.root = assertTemporaryFixtureRoot(fixtureRoot);
    if (!fs.existsSync(FIXTURE_AGENT_PATH)) throw new Error('[fixture-adapter] fixed fixture agent entrypoint is missing');
  }

  async run(input: FixtureExecutionInput, options: {
    abortSignal?: AbortSignal;
    onEvent?: (event: Readonly<FixtureEvent>) => void;
  } = {}): Promise<FixtureExecutionEvidence> {
    const scenario = this.manifest.scenarios[input.scenarioId];
    if (!scenario) throw new Error(`[fixture-adapter] unknown versioned scenario ${input.scenarioId}`);
    const cwd = assertOwnedDirectory(this.root, input.cwd, 'repository');
    const barrierDirectory = input.barrierDirectory
      ? assertOwnedDirectory(this.root, input.barrierDirectory, 'barrier directory')
      : undefined;
    const timeoutMs = input.timeoutMs ?? 2_000;
    if (timeoutMs > this.limits.maxWaveDurationMs) {
      throw new Error(`[fixture-adapter] timeout exceeds wave duration limit ${this.limits.maxWaveDurationMs}ms`);
    }
    const executionId = `fixture:${input.scenarioId}:${randomUUID()}`;
    const result = await executeStoryWithAdapter(this, {
      executionId,
      storyId: input.storyId,
      cwd,
      timeoutMs,
      payload: {
        scenarioId: input.scenarioId,
        seed: input.seed,
        revision: input.revision,
        attempt: input.attempt ?? 1,
        barrierDirectory,
        abortSignal: options.abortSignal,
        onEvent: options.onEvent,
      },
    });
    return result.output;
  }

  async execute(request: Readonly<StoryExecutionAdapterRequest<FixtureAdapterPayload>>): Promise<StoryExecutionAdapterResult<FixtureExecutionEvidence>> {
    const scenario = this.manifest.scenarios[request.payload.scenarioId];
    if (!scenario) throw new Error('[fixture-adapter] scenario disappeared from versioned manifest');
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const lifecycle: FixtureLifecycle = {
      queueClaimed: true,
      started: false,
      committed: false,
      signalled: false,
      exited: false,
      hostValidation: false,
      integration: false,
      finalCloseout: false,
    };
    const events: FixtureEvent[] = [];
    const descendantPids = new Set<number>();
    let structuredTranscriptBytes = 0;
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let stdoutBuffer = '';
    let timedOut = false;
    let cancelled = false;
    let adapterError: string | undefined;
    let exitSignal: NodeJS.Signals | null = null;

    const childRequest = {
      executionId: request.executionId,
      storyId: request.storyId,
      scenarioId: request.payload.scenarioId,
      seed: request.payload.seed,
      revision: request.payload.revision,
      attempt: request.payload.attempt,
      ...(request.payload.barrierDirectory ? { barrierDirectory: request.payload.barrierDirectory } : {}),
    };
    const encodedRequest = Buffer.from(JSON.stringify(childRequest)).toString('base64url');
    const expectedProcessCount = 1 + (scenario.spawnDescendant ? 1 : 0);
    if (this.active.size >= this.limits.maxParallelism) throw new Error('[fixture-adapter] parallelism limit reached');
    if (this.activeProcessCount + expectedProcessCount > this.limits.maxChildProcesses) {
      throw new Error('[fixture-adapter] child-process limit reached');
    }
    this.activeProcessCount += expectedProcessCount;
    const child = spawn(process.execPath, [FIXTURE_AGENT_PATH, encodedRequest], {
      cwd: request.cwd,
      env: sanitizedFixtureEnv(this.root),
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settleDone: () => void = () => {};
    const done = new Promise<void>(resolve => { settleDone = resolve; });
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const terminate = (signal: NodeJS.Signals, reason: 'timeout' | 'cancel' | 'adapter-error' | 'teardown' | 'completion'): void => {
      if (reason !== 'completion') lifecycle.signalled = true;
      exitSignal ??= signal;
      killProcessTree(child, descendantPids, signal);
      if (signal === 'SIGTERM' && reason !== 'completion') {
        forceTimer ??= setTimeout(() => killProcessTree(child, descendantPids, 'SIGKILL'), TERMINATION_GRACE_MS);
        forceTimer.unref?.();
      }
    };
    this.active.set(request.executionId, { terminate, done });

    const acceptEvent = (event: FixtureEvent): void => {
      if (event.executionId !== request.executionId || event.scenarioId !== request.payload.scenarioId || event.schemaVersion !== 1) {
        throw new Error('fixture emitted mismatched structured identity');
      }
      if (!Number.isSafeInteger(event.sequence) || event.sequence !== events.length + 1) {
        throw new Error('fixture emitted non-monotonic event sequence');
      }
      const eventBytes = Buffer.byteLength(JSON.stringify(event));
      if (eventBytes > 4096) throw new Error('fixture event exceeded bound');
      structuredTranscriptBytes += eventBytes;
      if (structuredTranscriptBytes > this.limits.maxStructuredTranscriptBytes) {
        throw new Error(`fixture structured transcript exceeded ${this.limits.maxStructuredTranscriptBytes} byte limit`);
      }
      events.push(event);
      if (event.type === 'story-started') lifecycle.started = true;
      if (event.type === 'story-committed') lifecycle.committed = true;
      if (event.type === 'story-signalled') lifecycle.signalled = true;
      if (event.type === 'descendant-started' && Number.isSafeInteger(event.descendantPid)) {
        descendantPids.add(Number(event.descendantPid));
      }
      request.payload.onEvent?.(Object.freeze({ ...event }));
    };

    const parseStdout = (chunk: Buffer): void => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      if (Buffer.byteLength(stdoutBuffer) > this.limits.maxPendingOutputBytes) {
        throw new Error(`fixture pending output exceeded ${this.limits.maxPendingOutputBytes} byte limit`);
      }
      for (const line of lines) {
        if (!line.trim()) continue;
        acceptEvent(JSON.parse(line) as FixtureEvent);
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      try {
        const appended = appendBounded(stdout, chunk, this.limits.maxRawCaptureBytes);
        stdout = appended.buffer;
        if (appended.overflow || stdout.length + stderr.length > this.limits.maxRawCaptureBytes) {
          throw new Error(`fixture raw capture exceeded ${this.limits.maxRawCaptureBytes} byte limit`);
        }
        parseStdout(chunk);
      } catch (error) {
        adapterError = error instanceof Error ? error.message : String(error);
        terminate('SIGTERM', 'adapter-error');
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const appended = appendBounded(stderr, chunk, this.limits.maxRawCaptureBytes);
      stderr = appended.buffer;
      if ((appended.overflow || stdout.length + stderr.length > this.limits.maxRawCaptureBytes) && !adapterError) {
        adapterError = `fixture raw capture exceeded ${this.limits.maxRawCaptureBytes} byte limit`;
        terminate('SIGTERM', 'adapter-error');
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      terminate('SIGTERM', 'timeout');
    }, request.timeoutMs);
    timer.unref?.();

    const abort = (): void => {
      cancelled = true;
      terminate('SIGTERM', 'cancel');
    };
    if (request.payload.abortSignal?.aborted) abort();
    else request.payload.abortSignal?.addEventListener('abort', abort, { once: true });

    const processExit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once('error', error => {
        adapterError = error.message;
        resolve({ code: null, signal: null });
      });
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    settled = true;
    clearTimeout(timer);
    if (forceTimer) clearTimeout(forceTimer);
    request.payload.abortSignal?.removeEventListener('abort', abort);
    lifecycle.exited = true;
    exitSignal = processExit.signal ?? exitSignal;
    // Completion, rejection, abrupt exit, and launch/observer errors all share
    // the same descendant cleanup path. The direct child has already emitted
    // close (and therefore has been reaped by Node) before evidence is returned.
    killProcessTree(child, descendantPids, 'SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 30));
    killProcessTree(child, descendantPids, 'SIGKILL');
    const allPids = [...(child.pid ? [child.pid] : []), ...descendantPids];
    const unreapedPids = await waitForReaping(allPids, this.limits.maxCleanupMs);
    this.active.delete(request.executionId);
    this.activeProcessCount -= expectedProcessCount;
    settleDone();

    const rawCode = processExit.code ?? 1;
    const exitCode = adapterError ? 125 : timedOut ? 124 : cancelled ? 130 : rawCode;
    const finishedAt = new Date().toISOString();
    const evidence: FixtureExecutionEvidence = {
      schemaVersion: 1,
      manifestId: this.manifest.manifestId,
      executionId: request.executionId,
      storyId: request.storyId,
      scenarioId: request.payload.scenarioId,
      seed: request.payload.seed,
      revision: request.payload.revision,
      faultPoint: scenario.faultPoint,
      pid: child.pid ?? null,
      descendantPids: [...descendantPids],
      unreapedPids,
      startedAt,
      finishedAt,
      elapsedMs: Math.max(0, Date.now() - startedMs),
      exitCode,
      exitSignal,
      status: statusFor({ scenarioId: request.payload.scenarioId, code: rawCode, timedOut, cancelled, adapterError }),
      timedOut,
      cancelled,
      outputBytes: stdout.length + stderr.length,
      stderrTail: stderr.toString('utf8').slice(-4096),
      lifecycle,
      events,
      ...(adapterError ? { adapterError } : {}),
    };
    return {
      executionId: request.executionId,
      storyId: request.storyId,
      startedAt,
      finishedAt,
      exitCode,
      exitSignal,
      output: evidence,
    };
  }

  /** Terminate and await every active fixture process during harness teardown. */
  async dispose(): Promise<void> {
    const active = [...this.active.values()];
    for (const execution of active) execution.terminate('SIGTERM', 'teardown');
    await Promise.all(active.map(execution => execution.done));
  }
}

/** Explicit host-side lifecycle progression; absence always remains false. */
export function recordFixtureHostPhase(
  evidence: FixtureExecutionEvidence,
  phase: FixtureHostPhase,
): FixtureExecutionEvidence {
  if (phase === 'integration' && !evidence.lifecycle.hostValidation) {
    throw new Error('[fixture-adapter] integration requires explicit host validation evidence');
  }
  if (phase === 'finalCloseout' && !evidence.lifecycle.integration) {
    throw new Error('[fixture-adapter] closeout requires explicit integration evidence');
  }
  return {
    ...evidence,
    lifecycle: { ...evidence.lifecycle, [phase]: true },
  };
}

/** Normalize exactly the volatile fields documented by the fault catalog. */
export function normalizeFixtureEvidence(evidence: FixtureExecutionEvidence): Record<string, unknown> {
  return {
    schemaVersion: evidence.schemaVersion,
    manifestId: evidence.manifestId,
    storyId: evidence.storyId,
    scenarioId: evidence.scenarioId,
    seed: evidence.seed,
    revision: evidence.revision,
    faultPoint: evidence.faultPoint,
    exitCode: evidence.exitCode,
    status: evidence.status,
    timedOut: evidence.timedOut,
    cancelled: evidence.cancelled,
    lifecycle: evidence.lifecycle,
    events: evidence.events.map(({ executionId: _executionId, at: _at, wallClockMs: _wallClockMs, pid: _pid, descendantPid: _descendantPid, ...event }) => event),
  };
}
