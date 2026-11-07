/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { RorcaApiClient } from "./api.js";
import {
  DEFAULT_SUPERVISOR_MODEL,
  SUPERVISOR_SCHEMA_VERSION,
  TERMINAL_SUPERVISOR_STATUSES,
  canonicalWorkspacePath,
  companionHeartbeat,
  createSupervisorRun,
  loadSupervisorRun,
  pidAlive,
  readJson,
  saveSupervisorState,
  stableHash,
  supervisorHome,
  writeControl,
  type SupervisorConfig,
  type CompanionHeartbeat,
  type SupervisorState,
} from "./autonomous-supervisor-core.js";
import { detectSupervisorSandbox } from "./autonomous-supervisor-sandbox.js";
import type { ActiveAgentSession, TmuxSubagentManager } from "./tmux-subagents.js";

const SUPERVISOR_ENTRY_TYPE = "rorca-hermes-supervisor-state";
const STATUS_KEY = "hermes-supervisor";
const WIDGET_KEY = "hermes-supervisor";

type RegisterCommand = (name: string, description: string, handler: (args: string, ctx: ExtensionContext) => Promise<void>) => void;

export interface PreparedSupervisorLaunch {
  config: SupervisorConfig;
  state: SupervisorState;
  paths: SupervisorConfig["paths"];
  lock: { token: string; release(): void };
}

export interface PrepareSupervisorLaunchInput {
  task: string;
  cwd: string;
  lifecycle?: "session" | "detached";
  tmuxSession?: string;
  runId?: string;
  home?: string;
  workspaceId?: string;
  model?: string;
  provider?: string;
  validationCommands: string[];
  maxTotalAttempts?: number;
  maxRestarts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  requireCleanWorktree?: boolean;
  piCommand?: string;
  piArgs?: string[];
}

export function prepareSupervisorLaunch(input: PrepareSupervisorLaunchInput): PreparedSupervisorLaunch {
  if (!detectSupervisorSandbox()) throw new Error("Hermes supervision requires macOS sandbox-exec or Linux bubblewrap; unsandboxed execution is disabled.");
  const cwd = canonicalWorkspacePath(input.cwd);
  let gitRoot: string;
  try { gitRoot = canonicalWorkspacePath(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim()); }
  catch { throw new Error("Hermes supervision requires cwd to be the root of an existing Git worktree."); }
  if (gitRoot !== cwd) throw new Error(`Hermes supervision must fence the exact Git worktree root (${gitRoot}), not ${cwd}.`);
  const home = supervisorHome(input.home);
  const homeRelative = path.relative(cwd, home);
  if (homeRelative === "" || (!homeRelative.startsWith("..") && !path.isAbsolute(homeRelative))) throw new Error("Supervisor state home must be outside the writable Git worktree.");
  return createSupervisorRun({
    ...input,
    cwd,
    home,
    model: input.model || DEFAULT_SUPERVISOR_MODEL,
    thinking: "high",
    policy: {
      ...(input.maxTotalAttempts === undefined ? {} : { maxTotalAttempts: Math.max(1, Math.floor(input.maxTotalAttempts)) }),
      ...(input.maxRestarts === undefined ? {} : { maxRestarts: Math.max(0, Math.floor(input.maxRestarts)) }),
      ...(input.baseBackoffMs === undefined ? {} : { baseBackoffMs: Math.max(0, Math.floor(input.baseBackoffMs)) }),
      ...(input.maxBackoffMs === undefined ? {} : { maxBackoffMs: Math.max(0, Math.floor(input.maxBackoffMs)) }),
    },
  }) as PreparedSupervisorLaunch;
}

function tokenizeArgs(input: string): string[] {
  const matches = input.match(/"(?:\\"|[^"])*"|'(?:\\'|[^'])*'|\S+/g) || [];
  return matches.map((token) => {
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) return token.slice(1, -1);
    return token;
  });
}

function parseStartArgs(args: string, cwd: string): PrepareSupervisorLaunchInput {
  const tokens = tokenizeArgs(args);
  const task: string[] = [];
  const validationCommands: string[] = [];
  const input: PrepareSupervisorLaunchInput = { task: "", cwd, lifecycle: "detached", validationCommands };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const next = () => tokens[++index];
    if (token === "--validate") validationCommands.push(next() || "");
    else if (token.startsWith("--validate=")) validationCommands.push(token.slice("--validate=".length));
    else if (token === "--run-id") input.runId = next();
    else if (token.startsWith("--run-id=")) input.runId = token.slice("--run-id=".length);
    else if (token === "--workspace") input.workspaceId = next();
    else if (token.startsWith("--workspace=")) input.workspaceId = token.slice("--workspace=".length);
    else if (token === "--model") input.model = next();
    else if (token.startsWith("--model=")) input.model = token.slice("--model=".length);
    else if (token === "--provider") input.provider = next();
    else if (token.startsWith("--provider=")) input.provider = token.slice("--provider=".length);
    else if (token === "--max-attempts") input.maxTotalAttempts = Number(next());
    else if (token.startsWith("--max-attempts=")) input.maxTotalAttempts = Number(token.slice("--max-attempts=".length));
    else if (token === "--session") input.lifecycle = "session";
    else if (token === "--detached") input.lifecycle = "detached";
    else if (token === "--require-clean") input.requireCleanWorktree = true;
    else task.push(token);
  }
  input.task = task.join(" ").trim();
  input.validationCommands = validationCommands.map((item) => item.trim()).filter(Boolean);
  if (!input.task) throw new Error("Usage: /hermes-supervisor-start <task> --validate \"command\" [--validate \"command\"] [--session|--detached]");
  if (input.validationCommands.length === 0) throw new Error("Supervised completion requires at least one explicit --validate command.");
  return input;
}

function stateSummary(state: SupervisorState, config: SupervisorConfig, heartbeat = companionHeartbeat(config, state)): string[] {
  const lastValidation = state.validationResults?.at(-1);
  const failure = state.lastFailure ? `${state.lastFailure.classification}: ${state.lastFailure.summary}` : "none";
  return [
    `Hermes Supervisor ${state.runId}`,
    `Status: ${state.status}`,
    `RPC activity: ${state.activity ? `${state.activity.at} (${state.activity.event})` : "not recorded"} · active tool ${state.activity?.activeTool || "none recorded"} (not validation evidence)`,
    `Companion heartbeat: ${heartbeat.at || "unavailable"} (${heartbeat.freshness}; not work activity)`,
    `Last validation: ${lastValidation ? `${lastValidation.passed ? "PASS" : "FAIL"} ${lastValidation.command}` : "not run; independent checks await a settled assistant with the exact completion marker"}`,
    `Worktree: ${state.cwd}`,
    `Attempt: ${state.attempt}/${config.policy.maxTotalAttempts} · restarts ${state.restartCount}/${config.policy.maxRestarts} · generation ${state.generation}`,
    `Model: ${state.model} (${state.thinking})`,
    `Session/cursor: ${state.rpcSessionFile || "pending"} / ${state.lastEntryId || "pending"}`,
    `Compactions: ${state.compactionCount} · next retry ${state.nextRetryAt || "none"}`,
    `Failure: ${failure}`,
    `Memory checkpoint: ${state.memoryCheckpoint ? "pending review" : "not synthesized"}`,
    `Progress: ${config.paths.progressMarkdownPath}`,
  ];
}

function findLatestRun(home?: string): string | undefined {
  const runsDir = path.join(supervisorHome(home), "runs");
  if (!existsSync(runsDir)) return undefined;
  return readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(runsDir, entry.name, "progress.json")))
    .map((entry) => ({ name: entry.name, mtimeMs: statSync(path.join(runsDir, entry.name, "progress.json")).mtimeMs }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.name;
}

function runIdFromArgs(args: string, home?: string): string {
  const explicit = tokenizeArgs(args)[0];
  const runId = explicit || findLatestRun(home);
  if (!runId) throw new Error("No Hermes supervisor run found. Start one or pass a run id.");
  return runId;
}

function processGroupAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    if (process.platform !== "win32") process.kill(-pid, 0);
    else process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

function signalProcessGroup(pid: number | null | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    if (process.platform !== "win32") process.kill(-pid, signal);
    else process.kill(pid, signal);
  } catch { /* already dead */ }
}

async function waitForPidDead(pid: number | null | undefined, timeoutMs: number): Promise<boolean> {
  if (!pid) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && pidAlive(pid)) await new Promise((resolve) => setTimeout(resolve, 100));
  return !pidAlive(pid);
}

async function waitForGroupsDead(pids: Array<number | null | undefined>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !processGroupAlive(pid))) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return pids.every((pid) => !processGroupAlive(pid));
}

export class HermesAutonomySupervisorService {
  private sessionProcesses = new Map<string, ChildProcess>();
  private monitorTimer: ReturnType<typeof setInterval> | null = null;
  private monitoredRunId: string | null = null;
  private lastStatus: string | null = null;
  private activeContext: ExtensionContext | null = null;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly api: RorcaApiClient,
    private readonly tmux: TmuxSubagentManager,
    private readonly home = supervisorHome(),
  ) {}

  async start(input: PrepareSupervisorLaunchInput, ctx: ExtensionContext): Promise<{ config: SupervisorConfig; state: SupervisorState; session?: ActiveAgentSession }> {
    const runId = input.runId || `hermes-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
    const tmuxSession = input.lifecycle === "session" ? undefined : `rorca-supervisor-${runId}`.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 96);
    const prepared = prepareSupervisorLaunch({ ...input, home: this.home, runId, tmuxSession });
    let session: ActiveAgentSession | undefined;
    try {
      if (prepared.config.lifecycle === "detached") {
        session = await this.tmux.launch({
          sessionName: tmuxSession!,
          cwd: prepared.config.cwd,
          memory: "on",
          popup: false,
          dashboard: false,
          model: prepared.config.model,
          provider: prepared.config.provider,
          workspaceId: prepared.config.workspaceId,
          interactive: false,
          tasks: [{ name: "hermes-supervisor", task: prepared.config.task }],
          supervisorConfigPath: prepared.config.paths.configPath,
        });
      } else {
        const companionPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "autonomous-supervisor-launcher.js");
        const out = openSync(prepared.config.paths.stdoutPath, "a", 0o600);
        const err = openSync(prepared.config.paths.stderrPath, "a", 0o600);
        const child = spawn(process.execPath, [companionPath, "--config", prepared.config.paths.configPath], {
          cwd: prepared.config.cwd,
          detached: process.platform !== "win32",
          stdio: ["ignore", out, err],
          env: { ...process.env },
        });
        closeSync(out);
        closeSync(err);
        this.sessionProcesses.set(runId, child);
      }
    } catch (error) {
      saveSupervisorState(prepared.config, { ...prepared.state, status: "failed", manualTakeover: { classification: "unknown", reason: "Companion launch failed.", requiredAction: "Inspect launch logs and start a newly scoped run." } }, "launch_failed", error instanceof Error ? error.message : String(error));
      await this.stop(runId, "companion launch rollback").catch(() => undefined);
      throw error;
    }

    let readyState: SupervisorState;
    try {
      readyState = await this.waitForStatus(runId, new Set(["running", "paused", "waiting_manual", "completed", "failed"]), 10_000);
      if (readyState.status === "failed") throw new Error("Companion entered failed state during startup; inspect durable progress evidence.");
      if (["running", "completed", "waiting_manual"].includes(readyState.status) && (readyState.generation <= 0 || readyState.rpcReadyGeneration !== readyState.generation)) throw new Error("Companion reported status before generation-specific Pi RPC readiness.");
    } catch (error) {
      await this.stop(runId, "startup readiness handshake failed").catch(() => undefined);
      throw new Error(`Hermes supervisor failed its readiness handshake: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.pi.appendEntry(SUPERVISOR_ENTRY_TYPE, { runId, lifecycle: prepared.config.lifecycle, statePath: prepared.config.paths.statePath });
    this.startMonitor(runId, ctx);
    return { config: prepared.config, state: readyState, session };
  }

  status(runId: string): { config: SupervisorConfig; state: SupervisorState; heartbeat: CompanionHeartbeat; lines: string[] } {
    const { config, state } = loadSupervisorRun(this.home, runId);
    const heartbeat = companionHeartbeat(config, state);
    return { config, state, heartbeat, lines: stateSummary(state, config, heartbeat) };
  }

  async pause(runId: string, reason = "operator request"): Promise<SupervisorState> {
    const { config } = loadSupervisorRun(this.home, runId);
    writeControl(config, "pause", reason);
    return this.waitForStatus(runId, new Set(["paused", "waiting_manual", "completed", "stopped", "failed"]), 5_000);
  }

  async resume(runId: string, reason = "operator request"): Promise<SupervisorState> {
    const { config, state } = loadSupervisorRun(this.home, runId);
    if (!["paused", "waiting_manual"].includes(state.status)) throw new Error(`Run ${runId} cannot resume from ${state.status}.`);
    if (!existsSync(config.paths.lockDir)) throw new Error("Supervisor lock expired or was released; start a new run instead of bypassing fencing.");
    writeControl(config, "resume", reason);
    return this.waitForStatus(runId, new Set(["running", "backoff", "completed", "waiting_manual", "failed"]), 5_000);
  }

  async stop(runId: string, reason = "operator request"): Promise<SupervisorState> {
    const { config } = loadSupervisorRun(this.home, runId);
    writeControl(config, "stop", reason);
    const graceful = await this.waitForStatus(runId, new Set(["stopped", "completed", "failed"]), 10_000).catch(() => null);
    if (graceful && !existsSync(config.paths.lockDir)) return graceful;

    let before = readJson<SupervisorState>(config.paths.statePath, graceful || ({} as SupervisorState));
    const sessionProcess = this.sessionProcesses.get(runId);
    const launcherRecord = readJson<{ pid?: number } | null>(path.join(config.paths.runDir, "launcher.json"), null);
    const launcherPid = Number(sessionProcess?.pid || launcherRecord?.pid || 0) || null;
    signalProcessGroup(launcherPid, "SIGTERM");
    try { if (launcherPid) process.kill(launcherPid, "SIGTERM"); } catch { /* already dead */ }
    if (config.tmuxSession && await this.tmux.hasSession(config.tmuxSession)) {
      await this.tmux.killSession(config.tmuxSession, { supervisorAuthorized: true }).catch(() => undefined);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    before = readJson<SupervisorState>(config.paths.statePath, before);
    const companionPid = Number(before.companionPid || 0) || null;
    const childPid = Number(before.childPid || 0) || null;
    signalProcessGroup(companionPid, "SIGTERM");
    signalProcessGroup(childPid, "SIGTERM");
    let dead = (await waitForGroupsDead([companionPid, childPid], 3_000)) && (await waitForPidDead(launcherPid, 3_000));
    if (!dead) {
      signalProcessGroup(launcherPid, "SIGKILL");
      signalProcessGroup(companionPid, "SIGKILL");
      signalProcessGroup(childPid, "SIGKILL");
      try { if (launcherPid) process.kill(launcherPid, "SIGKILL"); } catch { /* already dead */ }
      dead = (await waitForGroupsDead([companionPid, childPid], 3_000)) && (await waitForPidDead(launcherPid, 3_000));
    }
    this.sessionProcesses.delete(runId);
    if (!dead) throw new Error(`Supervisor stop could not verify process-group termination; workspace fence retained for run ${runId}.`);

    let finalState = readJson<SupervisorState>(config.paths.statePath, before);
    if (!TERMINAL_SUPERVISOR_STATUSES.has(finalState.status) && existsSync(config.paths.lockDir)) {
      finalState = saveSupervisorState(config, {
        ...finalState,
        status: "stopped",
        childPid: null,
        companionPid: null,
        nextRetryAt: null,
      }, "stopped", "operator stop verified companion and Pi process-group termination");
    }
    const owner = readJson<{ token?: string } | null>(config.paths.lockOwnerPath, null);
    if (owner?.token === config.fenceToken) rmSync(config.paths.lockDir, { recursive: true, force: true });
    return finalState;
  }

  async submitCheckpoint(runId: string, workspaceId?: string): Promise<{ id: string; created: boolean }> {
    const { config, state } = loadSupervisorRun(this.home, runId);
    if (state.status !== "completed") throw new Error("Memory checkpoint submission requires exact completed status.");
    const checkpoint = readJson<Record<string, any> | null>(config.paths.checkpointPath, null);
    if (!checkpoint || checkpoint.reviewStatus !== "pending_review" || checkpoint.autoApproved !== false) throw new Error("A valid pending-review checkpoint artifact was not found.");
    const provenance = checkpoint.provenance || {};
    const expectedIdempotency = `hermes-supervisor:${stableHash(`${config.runId}:${state.gitSha}:${state.worktreeHash}:${state.contractHash}:${state.completionEntryId}`, 40)}`;
    const expectedEvidence = (state.validationResults || []).map((result) => ({
      command: result.command,
      passed: result.passed,
      exitCode: result.exitCode ?? null,
      timedOut: Boolean(result.timedOut),
      cancelled: Boolean(result.cancelled),
      durationMs: Number(result.durationMs || 0),
      at: result.at || null,
      outputHash: stableHash(result.output || ""),
      stderrHash: stableHash(result.stderr || ""),
    }));
    const checkpointHash = stableHash(JSON.stringify(checkpoint));
    if (checkpointHash !== state.checkpointContentHash || checkpointHash !== (state.memoryCheckpoint as any)?.contentHash || provenance.runId !== config.runId || provenance.gitSha !== state.gitSha || provenance.contractHash !== state.contractHash || provenance.worktreeHash !== state.worktreeHash || provenance.completionEntryId !== state.completionEntryId || checkpoint.idempotencyKey !== expectedIdempotency) {
      throw new Error("Checkpoint content/provenance does not match the immutable completed supervisor state; refusing submission.");
    }
    if (JSON.stringify(provenance.validationCommands) !== JSON.stringify(config.completionContract.validationCommands) || JSON.stringify(provenance.validationEvidence) !== JSON.stringify(expectedEvidence) || expectedEvidence.length !== config.completionContract.validationCommands.length || expectedEvidence.some((item) => item.passed !== true || item.exitCode !== 0 || item.timedOut || item.cancelled)) {
      throw new Error("Checkpoint validation evidence does not exactly match the completion contract/state; refusing submission.");
    }
    const targetWorkspace = workspaceId || config.workspaceId;
    if (!targetWorkspace) throw new Error("Checkpoint submission requires an explicit Rorca workspace id.");
    return this.api.submitCandidate({
      workspace_id: targetWorkspace,
      source_system: checkpoint.sourceSystem,
      category: checkpoint.category,
      title: checkpoint.title,
      rule: checkpoint.rule,
      context: checkpoint.context,
      related_files: checkpoint.relatedFiles,
      confidence: checkpoint.confidence,
      trust_tier: "unverified",
      source_ref: checkpoint.sourceRef,
      idempotency_key: checkpoint.idempotencyKey,
    });
  }

  startMonitor(runId: string, ctx: ExtensionContext): void {
    this.stopMonitor();
    this.monitoredRunId = runId;
    this.activeContext = ctx;
    const tick = () => {
      if (!this.monitoredRunId || !this.activeContext) return;
      try {
        const { config, state, lines } = this.status(this.monitoredRunId);
        this.activeContext.ui.setStatus(STATUS_KEY, `Hermes ${state.runId}: ${state.status}`);
        this.activeContext.ui.setWidget(WIDGET_KEY, lines.slice(0, 8));
        if (this.lastStatus !== state.status) {
          this.activeContext.ui.notify(`Hermes supervisor ${state.runId}: ${state.status}`, state.status === "failed" || state.status === "waiting_manual" ? "warning" : "info");
          this.lastStatus = state.status;
        }
        if (TERMINAL_SUPERVISOR_STATUSES.has(state.status)) {
          this.stopMonitor();
          this.activeContext?.ui.setStatus(STATUS_KEY, `Hermes ${state.runId}: ${state.status}`);
          this.activeContext?.ui.setWidget(WIDGET_KEY, stateSummary(state, config).slice(0, 10));
        }
      } catch (error) {
        this.activeContext?.ui.notify(`Hermes supervisor monitor: ${error instanceof Error ? error.message : String(error)}`, "warning");
        this.stopMonitor();
      }
    };
    tick();
    this.monitorTimer = setInterval(tick, 1_000);
  }

  stopMonitor(): void {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = null;
    this.monitoredRunId = null;
    this.lastStatus = null;
  }

  async shutdownSessionResources(): Promise<void> {
    this.stopMonitor();
    for (const [runId, process] of this.sessionProcesses) {
      try {
        const { config } = loadSupervisorRun(this.home, runId);
        writeControl(config, "stop", "parent Pi session_shutdown");
      } catch { /* best effort */ }
      try { process.kill("SIGTERM"); } catch { /* already exited */ }
    }
    this.sessionProcesses.clear();
  }

  private async waitForStatus(runId: string, statuses: Set<string>, timeoutMs: number): Promise<SupervisorState> {
    const started = Date.now();
    let state = this.status(runId).state;
    while (!statuses.has(state.status) && Date.now() - started < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      state = this.status(runId).state;
    }
    if (!statuses.has(state.status)) throw new Error(`Timed out waiting for ${runId} to reach ${[...statuses].join("|")}; current=${state.status}.`);
    return state;
  }
}

class SupervisorDashboard implements Component {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lines: string[] = ["Loading Hermes supervisor state…"];

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly service: HermesAutonomySupervisorService,
    private readonly runId: string,
    private readonly done: () => void,
  ) {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), 1_000);
  }

  private refresh(): void {
    try { this.lines = this.service.status(this.runId).lines; }
    catch (error) { this.lines = [error instanceof Error ? error.message : String(error)]; }
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (data === "q" || data === "\u001b" || data === "\u0003") {
      this.dispose();
      this.done();
    } else if (data === "r") this.refresh();
  }

  render(width: number): string[] {
    const border = this.theme.fg("border", "─".repeat(Math.max(20, width - 2)));
    return [
      border,
      this.theme.fg("accent", this.theme.bold(" Hermes Autonomous Supervisor ")),
      ...this.lines.map((line) => this.theme.fg(line.startsWith("Status: completed") ? "success" : line.startsWith("Status: failed") || line.startsWith("Status: waiting_manual") ? "warning" : "muted", ` ${line}`)),
      this.theme.fg("dim", " q/Esc close · r refresh"),
      border,
    ];
  }

  invalidate(): void {}
  dispose(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
}

export function registerHermesAutonomousSupervisor(
  pi: ExtensionAPI,
  api: RorcaApiClient,
  tmux: TmuxSubagentManager,
  registerCommand: RegisterCommand,
): HermesAutonomySupervisorService {
  const service = new HermesAutonomySupervisorService(pi, api, tmux);

  const startFromValues = async (values: PrepareSupervisorLaunchInput, ctx: ExtensionContext) => {
    const result = await service.start(values, ctx);
    ctx.ui.notify(`Started ${result.config.lifecycle} Hermes supervisor ${result.config.runId}.`, "success");
    ctx.ui.setWidget(WIDGET_KEY, stateSummary(result.state, result.config).slice(0, 8));
    return result;
  };

  registerCommand("hermes-supervisor-start", "Start bounded persistent Hermes autonomy", async (args, ctx) => {
    await startFromValues(parseStartArgs(args, ctx.cwd || process.cwd()), ctx);
  });
  registerCommand("hermes-supervisor-status", "Show Hermes autonomy status", async (args, ctx) => {
    const runId = runIdFromArgs(args);
    const result = service.status(runId);
    ctx.ui.notify(result.lines.join("\n"), "info");
    ctx.ui.setWidget(WIDGET_KEY, result.lines.slice(0, 10));
    if (!TERMINAL_SUPERVISOR_STATUSES.has(result.state.status)) service.startMonitor(runId, ctx);
  });
  registerCommand("hermes-supervisor-pause", "Pause a Hermes autonomy run", async (args, ctx) => {
    const runId = runIdFromArgs(args);
    const state = await service.pause(runId);
    ctx.ui.notify(`Paused ${runId}: ${state.status}`, "success");
  });
  registerCommand("hermes-supervisor-resume", "Resume a paused/manual-takeover Hermes run", async (args, ctx) => {
    const runId = runIdFromArgs(args);
    const state = await service.resume(runId);
    service.startMonitor(runId, ctx);
    ctx.ui.notify(`Resumed ${runId}: ${state.status}`, "success");
  });
  registerCommand("hermes-supervisor-stop", "Stop and clean up a Hermes autonomy run", async (args, ctx) => {
    const runId = runIdFromArgs(args);
    const state = await service.stop(runId);
    ctx.ui.notify(`Stopped ${runId}: ${state.status}`, "success");
  });
  registerCommand("hermes-supervisor-dashboard", "Open Hermes autonomy dashboard", async (args, ctx) => {
    const runId = runIdFromArgs(args);
    if ((ctx as ExtensionContext & { mode?: string }).mode !== "tui") {
      const result = service.status(runId);
      ctx.ui.setWidget(WIDGET_KEY, result.lines);
      ctx.ui.notify(result.lines.join("\n"), "info");
      return;
    }
    await ctx.ui.custom<void>((tui, theme, _keys, done) => new SupervisorDashboard(tui, theme, service, runId, done), {
      overlay: true,
      overlayOptions: { anchor: "center", width: "88%", maxHeight: "80%", margin: 1 },
    });
  });
  registerCommand("hermes-supervisor-checkpoint", "Submit completed checkpoint as a pending Rorca memory candidate", async (args, ctx) => {
    const tokens = tokenizeArgs(args);
    const workspaceIndex = tokens.findIndex((token) => token === "--workspace");
    const workspaceId = workspaceIndex >= 0 ? tokens[workspaceIndex + 1] : undefined;
    const runId = tokens.find((token, index) => !token.startsWith("--") && index !== workspaceIndex + 1) || findLatestRun();
    if (!runId) throw new Error("Pass a completed supervisor run id.");
    const result = await service.submitCheckpoint(runId, workspaceId);
    ctx.ui.notify(`Submitted pending-review memory checkpoint (${result.created ? "created" : "already exists"}) id=${result.id}.`, result.created ? "success" : "warning");
  });

  pi.registerTool({
    name: "hermes_autonomy_start",
    label: "Hermes Autonomy Start",
    description: "Start one fenced persistent Pi RPC implementation supervisor. Requires explicit machine validation commands; never merges or deploys.",
    parameters: Type.Object({
      task: Type.String(),
      validationCommands: Type.Array(Type.String(), { minItems: 1 }),
      runId: Type.Optional(Type.String()),
      cwd: Type.Optional(Type.String()),
      lifecycle: Type.Optional(Type.String({ description: "detached (tmux) or session" })),
      workspaceId: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      provider: Type.Optional(Type.String()),
      maxAttempts: Type.Optional(Type.Number()),
      maxRestarts: Type.Optional(Type.Number()),
      requireCleanWorktree: Type.Optional(Type.Boolean()),
    }),
    async execute(_id: string, params: Record<string, any>, _signal: AbortSignal, _update: unknown, ctx: ExtensionContext) {
      const result = await startFromValues({
        task: String(params.task || ""),
        validationCommands: Array.isArray(params.validationCommands) ? params.validationCommands.map(String) : [],
        runId: params.runId,
        cwd: path.resolve(params.cwd || ctx.cwd || process.cwd()),
        lifecycle: params.lifecycle === "session" ? "session" : "detached",
        workspaceId: params.workspaceId,
        model: params.model,
        provider: params.provider,
        maxTotalAttempts: params.maxAttempts,
        maxRestarts: params.maxRestarts,
        requireCleanWorktree: params.requireCleanWorktree,
      }, ctx);
      return { content: [{ type: "text", text: stateSummary(result.state, result.config).join("\n") }], details: { runId: result.config.runId, statePath: result.config.paths.statePath } };
    },
  });

  for (const action of ["status", "pause", "resume", "stop"] as const) {
    pi.registerTool({
      name: `hermes_autonomy_${action}`,
      label: `Hermes Autonomy ${action}`,
      description: `${action[0]!.toUpperCase()}${action.slice(1)} a persistent Hermes autonomy run.`,
      parameters: Type.Object({ runId: Type.Optional(Type.String()) }),
      async execute(_id: string, params: Record<string, any>, _signal: AbortSignal, _update: unknown, ctx: ExtensionContext) {
        const runId = params.runId || findLatestRun();
        if (!runId) throw new Error("No Hermes supervisor run found.");
        if (action === "pause") await service.pause(runId);
        else if (action === "resume") { await service.resume(runId); service.startMonitor(runId, ctx); }
        else if (action === "stop") await service.stop(runId);
        const result = service.status(runId);
        return { content: [{ type: "text", text: result.lines.join("\n") }], details: { runId, status: result.state.status, activity: result.state.activity, companionHeartbeat: result.heartbeat } };
      },
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx.sessionManager.getEntries();
    const latest = entries.filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === SUPERVISOR_ENTRY_TYPE).at(-1) as { data?: { runId?: string } } | undefined;
    if (!latest?.data?.runId) return;
    try {
      const { state } = service.status(latest.data.runId);
      if (!TERMINAL_SUPERVISOR_STATUSES.has(state.status)) service.startMonitor(state.runId, ctx);
    } catch { /* stale session metadata is non-fatal */ }
  });

  pi.on("session_shutdown", async () => {
    await service.shutdownSessionResources();
    // Detached tmux companions intentionally continue until explicit stop/kill.
  });

  return service;
}

export { SUPERVISOR_ENTRY_TYPE };
