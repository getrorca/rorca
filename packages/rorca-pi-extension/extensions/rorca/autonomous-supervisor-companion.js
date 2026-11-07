#!/usr/bin/env node
/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { spawn } from "node:child_process";
import { appendFileSync, lstatSync, mkdirSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { buildSandboxedShellInvocation } from "./autonomous-supervisor-sandbox.js";
import {
  SUPERVISOR_SCHEMA_VERSION,
  TERMINAL_SUPERVISOR_STATUSES,
  assistantTextFromMessage,
  assertFence,
  claimCompanionLease,
  atomicWriteJson,
  boundedText,
  buildInitialPrompt,
  buildRepairPrompt,
  classifyFailure,
  createMemoryCheckpoint,
  evaluateCompletion,
  readJson,
  redactSecrets,
  retryDecision,
  saveSupervisorState,
  stableHash,
} from "./autonomous-supervisor-core.js";

const ACTIVITY_CHECKPOINT_MS = 5_000;
const ACTIVITY_EVENTS = new Set([
  "agent_start", "agent_settled", "turn_start", "turn_end",
  "message_start", "message_update", "message_end",
  "tool_execution_start", "tool_execution_update", "tool_execution_end",
  "compaction_start", "compaction_end",
]);
const STREAMING_ACTIVITY_EVENTS = new Set(["message_update", "tool_execution_update"]);
// This child has a fixed tool surface. Never persist arbitrary provider strings
// as tool names, nor any event payload (arguments, output, text or tokens).
const ACTIVITY_TOOL_NAMES = new Set(["read", "edit", "write", "grep", "find", "ls", "supervised_bash"]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendEvent(config, event) {
  mkdirSync(path.dirname(config.paths.eventLogPath), { recursive: true });
  const safe = JSON.parse(redactSecrets(JSON.stringify({ at: new Date().toISOString(), ...event })));
  appendFileSync(config.paths.eventLogPath, `${JSON.stringify(safe)}\n`, { encoding: "utf8", mode: 0o600 });
}

function processGroupAlive(pid) {
  if (!pid) return false;
  try {
    if (process.platform !== "win32") process.kill(-pid, 0);
    else process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && error.code === "EPERM");
  }
}

function killProcessTree(child, signal = "SIGTERM") {
  if (!child?.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

export class JsonlRpcClient {
  constructor(child, options = {}) {
    this.child = child;
    this.timeoutMs = options.timeoutMs || 30_000;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.buffer = "";
    this.decoder = new StringDecoder("utf8");
    child.stdout.on("data", (chunk) => this.consume(chunk));
    child.stdout.on("end", () => {
      this.buffer += this.decoder.end();
      if (this.buffer) this.processLine(this.buffer.replace(/\r$/, ""));
      this.buffer = "";
    });
    child.on("exit", (code, signal) => this.rejectAll(new Error(`Pi RPC exited code=${code ?? "null"} signal=${signal ?? "none"}`)));
    child.on("error", (error) => this.rejectAll(error));
  }

  consume(chunk) {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.processLine(line);
    }
  }

  processLine(line) {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.type === "response" && message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.success) pending.resolve(message.data ?? {});
      else pending.reject(new Error(message.error || `${message.command || "RPC command"} failed`));
      return;
    }
    for (const listener of this.listeners) listener(message);
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  request(command, timeoutMs = this.timeoutMs) {
    if (!this.child.stdin.writable) return Promise.reject(new Error("Pi RPC stdin is not writable."));
    const id = `supervisor-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi RPC ${command.type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
    });
  }

  waitForSettled(signal, timeoutMs = 30 * 60_000) {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        unsubscribe();
        this.child.off("exit", onExit);
        signal?.removeEventListener("abort", onAbort);
      };
      const unsubscribe = this.onEvent((event) => {
        if (event.type === "agent_settled") {
          cleanup();
          resolve(event);
        }
      });
      const onExit = (code, childSignal) => {
        cleanup();
        reject(new Error(`Pi RPC process crash before agent_settled (code=${code ?? "null"}, signal=${childSignal ?? "none"}).`));
      };
      const onAbort = () => {
        cleanup();
        reject(new Error("Supervisor wait aborted."));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Pi RPC turn timed out before agent_settled after ${timeoutMs}ms.`));
      }, timeoutMs);
      timer.unref?.();
      this.child.once("exit", onExit);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export async function runValidationCommand(command, input = {}) {
  const startedAt = Date.now();
  const timeoutMs = input.timeoutMs || 10 * 60_000;
  const outputLimit = input.outputLimit || 32 * 1024;
  return new Promise((resolve) => {
    let invocation;
    try {
      invocation = buildSandboxedShellInvocation(command, {
        cwd: input.cwd,
        tempDir: path.join(path.resolve(input.cwd), ".rorca-supervisor-validation-tmp"),
      });
    } catch (error) {
      resolve({ command, exitCode: null, timedOut: false, cancelled: false, durationMs: Date.now() - startedAt, passed: false, output: "", stderr: String(error.message || error), at: new Date().toISOString() });
      return;
    }
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: invocation.tempDir, TMPDIR: invocation.tempDir, CI: process.env.CI || "1", TERM: process.env.TERM || "dumb", LANG: process.env.LANG || "C", ...(input.env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let escalationTimer;
    let resolved = false;
    child.stdout.on("data", (chunk) => { stdout = boundedText(stdout + chunk.toString(), outputLimit); });
    child.stderr.on("data", (chunk) => { stderr = boundedText(stderr + chunk.toString(), outputLimit); });
    const terminate = () => {
      killProcessTree(child, "SIGTERM");
      if (!escalationTimer) {
        escalationTimer = setTimeout(() => killProcessTree(child, "SIGKILL"), 1_500);
        escalationTimer.unref();
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    const onAbort = () => {
      cancelled = true;
      terminate();
    };
    if (input.signal?.aborted) onAbort();
    else input.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (escalationTimer) clearTimeout(escalationTimer);
      input.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    child.on("error", (error) => {
      finish({ command, exitCode: null, timedOut, cancelled, durationMs: Date.now() - startedAt, passed: false, output: boundedText(stdout), stderr: boundedText(`${stderr}\n${error.message}`), at: new Date().toISOString() });
    });
    child.on("exit", async (code) => {
      if (processGroupAlive(child.pid)) {
        killProcessTree(child, "SIGTERM");
        for (let attempt = 0; attempt < 10 && processGroupAlive(child.pid); attempt++) await sleep(100);
        if (processGroupAlive(child.pid)) killProcessTree(child, "SIGKILL");
        for (let attempt = 0; attempt < 10 && processGroupAlive(child.pid); attempt++) await sleep(100);
      }
      if (processGroupAlive(child.pid)) stderr = boundedText(`${stderr}\nValidation process group ${child.pid} survived cleanup.`, outputLimit);
      finish({ command, exitCode: code, timedOut, cancelled, durationMs: Date.now() - startedAt, passed: code === 0 && !timedOut && !cancelled && !processGroupAlive(child.pid), output: boundedText(stdout), stderr: boundedText(stderr), at: new Date().toISOString() });
    });
  });
}

async function gitSnapshot(cwd) {
  const [head, status] = await Promise.all([
    runValidationCommand("git rev-parse HEAD", { cwd, timeoutMs: 10_000, outputLimit: 2_000 }),
    runValidationCommand("git status --porcelain=v1", { cwd, timeoutMs: 10_000, outputLimit: 16_000 }),
  ]);
  const lines = String(status.output || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const modifiedFiles = lines.map((line) => line.replace(/^[ MARCUD?!]{1,2}\s+/, "").split(" -> ").at(-1)).filter(Boolean);
  const fileHashes = modifiedFiles.map((file) => {
    try {
      const absolute = path.resolve(cwd, file);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) return [file, `symlink:${readlinkSync(absolute)}`];
      if (!stat.isFile()) return [file, `type:${stat.mode}`];
      return [file, stableHash(readFileSync(absolute))];
    } catch { return [file, "missing"]; }
  });
  return {
    gitSha: head.passed ? String(head.output || "unknown").trim().split(/\s/)[0] : "unknown",
    clean: status.passed && lines.length === 0,
    modifiedFiles,
    worktreeHash: stableHash(JSON.stringify({ status: lines, files: fileHashes })),
  };
}

export class SupervisorCompanion {
  constructor(config, options = {}) {
    if (!config || config.schemaVersion !== SUPERVISOR_SCHEMA_VERSION) throw new Error("Unsupported or missing supervisor config.");
    this.config = config;
    this.spawnImpl = options.spawn || spawn;
    this.runValidation = options.runValidation || runValidationCommand;
    this.sleep = options.sleep || sleep;
    this.now = options.now || (() => Date.now());
    this.child = null;
    this.rpc = null;
    this.stopping = false;
    this.pauseRequested = false;
    this.controlSequence = 0;
    this.controlInFlight = false;
    this.toolFailures = [];
    this.abortController = null;
    this.validationAbortController = null;
    this.activeValidationPromise = null;
    this.heartbeatTimer = null;
    this.controlTimer = null;
    this.lease = null;
    this.currentAssistantText = "";
    this.currentAssistantEntryId = null;
    this.activityDirty = false;
    this.lastActivityPersistAt = -Infinity;
    this.activeTools = new Map();
    this.state = readJson(config.paths.statePath, null);
    if (!this.state || this.state.fenceToken !== config.fenceToken) throw new Error("Supervisor state is missing or fence token does not match config.");
    this.state.activity ??= null;
  }

  persist(event, detail) {
    this.lease?.assert();
    this.state = saveSupervisorState(this.config, this.state, event, detail, this.now());
    this.activityDirty = false;
    this.lastActivityPersistAt = this.now();
    appendEvent(this.config, { event, detail, status: this.state.status, attempt: this.state.attempt, generation: this.state.generation });
  }

  heartbeat() {
    this.lease?.heartbeat(this.now());
    const owner = assertFence(this.config.paths.lockDir, this.config.fenceToken);
    owner.pid = process.pid;
    owner.heartbeatAt = new Date(this.now()).toISOString();
    // Heartbeats update lock evidence independently of work activity. A fresh
    // companion does not imply the provider or its tools are making progress.
    const core = readJson(this.config.paths.lockOwnerPath, owner);
    core.pid = process.pid;
    core.heartbeatAt = owner.heartbeatAt;
    atomicWriteJson(this.config.paths.lockOwnerPath, core);
    this.state.heartbeatAt = owner.heartbeatAt;
    if (!this.stopping && !this.pauseRequested && this.activityDirty && this.now() - this.lastActivityPersistAt >= ACTIVITY_CHECKPOINT_MS) {
      this.persistActivity();
    }
  }

  async start() {
    this.lease = claimCompanionLease({
      lockDir: this.config.paths.lockDir,
      fenceToken: this.config.fenceToken,
      runId: this.config.runId,
      pid: process.pid,
      generation: Number(this.state.companionGeneration || 0) + 1,
      now: this.now(),
    });
    this.state.companionGeneration = Number(this.state.companionGeneration || 0) + 1;
    this.state.companionPid = process.pid;
    this.heartbeat();
    await this.reconcilePersistedChild();
    this.heartbeatTimer = setInterval(() => {
      try { this.heartbeat(); } catch (error) { void this.failClosed(`Workspace fence lost: ${error.message}`); }
    }, this.config.policy.heartbeatMs);
    this.controlTimer = setInterval(() => void this.pollControl(), this.config.policy.controlPollMs);
    this.heartbeatTimer.unref?.();
    this.controlTimer.unref?.();

    const existingControl = readJson(this.config.paths.controlPath, { sequence: 0, action: "none" });
    this.controlSequence = Number(existingControl.sequence || 0);
    if (existingControl.action === "stop") return this.stop(existingControl.reason || "pre-existing stop request");
    if (existingControl.action === "pause" || this.state.status === "paused") {
      this.state.status = "paused";
      this.persist("paused", existingControl.reason || "restored paused state");
      return;
    }
    if (this.state.status === "waiting_manual") {
      this.persist("manual_takeover_restored", "Companion restarted without bypassing the explicit resume requirement.");
      return;
    }
    await this.runGeneration(this.state.attempt === 0 ? buildInitialPrompt(this.config) : buildRepairPrompt(this.config, this.state, this.state.lastFailure || { classification: "transient", summary: "Companion resumed after restart." }, this.state.validationResults));
  }

  async reconcilePersistedChild() {
    const pid = Number(this.state.childPid || 0);
    if (!pid) return;
    const persisted = { pid, kill: (signal) => { try { process.kill(pid, signal); } catch { /* already dead */ } } };
    if (processGroupAlive(pid)) {
      killProcessTree(persisted, "SIGTERM");
      for (let attempt = 0; attempt < 20 && processGroupAlive(pid); attempt++) await this.sleep(100);
      if (processGroupAlive(pid)) killProcessTree(persisted, "SIGKILL");
      for (let attempt = 0; attempt < 20 && processGroupAlive(pid); attempt++) await this.sleep(100);
    }
    if (processGroupAlive(pid)) throw new Error(`Persisted Pi process group ${pid} survived companion recovery; refusing a second writer.`);
    this.state.childPid = null;
    this.persist("orphan_reconciled", `verified prior Pi process group ${pid} is dead before companion generation start`);
  }

  childArgs() {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const sessionsDir = path.join(this.config.paths.runDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const args = [
      "--mode", "rpc",
      "--session-dir", sessionsDir,
      "--model", this.config.model,
      "--thinking", this.config.thinking,
      "--no-extensions",
      "-e", path.join(here, "autonomous-supervisor-guard.ts"),
      "--tools", "read,edit,write,grep,find,ls,supervised_bash",
      "--name", `Hermes supervisor ${this.config.runId}`,
      "--approve",
      ...(this.config.piArgs || []),
    ];
    if (this.config.provider) args.push("--provider", this.config.provider);
    if (this.state.rpcSessionFile) args.push("--session", this.state.rpcSessionFile);
    return args;
  }

  spawnChild() {
    const child = this.spawnImpl(this.config.piCommand, this.childArgs(), {
      cwd: this.config.cwd,
      env: {
        ...process.env,
        RORCA_PI_AUTONOMOUS_RUN_ID: this.config.runId,
        RORCA_PI_SUPERVISOR_CWD: this.config.cwd,
        RORCA_PI_SUPERVISOR_PROGRESS: this.config.paths.progressMarkdownPath,
      },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = boundedText(stderr + chunk.toString(), this.config.policy.outputLimitBytes);
      appendFileSync(this.config.paths.stderrPath, boundedText(chunk.toString(), 8_000), { encoding: "utf8", mode: 0o600 });
    });
    child.__stderr = () => stderr;
    this.child = child;
    this.rpc = new JsonlRpcClient(child, { timeoutMs: 30_000 });
    this.rpc.onEvent((event) => {
      try { this.onRpcEvent(event); } catch (error) { void this.failClosed(`Activity checkpoint failed: ${error.message}`); }
    });
    this.state.childPid = child.pid || null;
    this.state.generation += 1;
    this.state.status = "starting";
    this.persist("child_started", `generation=${this.state.generation} pid=${child.pid || "unknown"}`);
    return child;
  }

  persistActivity() {
    const activity = this.state.activity;
    this.persist("activity", `${activity.event} activeTool=${activity.activeTool || "none"}`);
  }

  checkpointActivity(event) {
    if (!ACTIVITY_EVENTS.has(event.type)) return;
    let activeTool = this.state.activity?.activeTool || null;
    const toolName = ACTIVITY_TOOL_NAMES.has(event.toolName) ? event.toolName : "unknown";
    if (event.type === "tool_execution_start") {
      this.activeTools.set(toolName, (this.activeTools.get(toolName) || 0) + 1);
      activeTool = toolName;
    } else if (event.type === "tool_execution_update") {
      activeTool = toolName;
    } else if (event.type === "tool_execution_end") {
      const remaining = (this.activeTools.get(toolName) || 0) - 1;
      if (remaining > 0) this.activeTools.set(toolName, remaining);
      else this.activeTools.delete(toolName);
      if (!this.activeTools.has(activeTool)) {
        activeTool = null;
        for (const name of this.activeTools.keys()) activeTool = name;
      }
    } else if (event.type === "turn_end" || event.type === "agent_settled") {
      this.activeTools.clear();
      activeTool = null;
    }
    this.state.activity = { at: new Date(this.now()).toISOString(), event: event.type, activeTool };
    this.activityDirty = true;
    // Milestones are durable immediately; token/tool deltas share one cadence.
    // The heartbeat flushes a trailing delta even if the provider goes silent.
    if (!STREAMING_ACTIVITY_EVENTS.has(event.type) || this.now() - this.lastActivityPersistAt >= ACTIVITY_CHECKPOINT_MS) {
      this.persistActivity();
    }
  }

  onRpcEvent(event) {
    if (this.stopping || this.pauseRequested || TERMINAL_SUPERVISOR_STATUSES.has(this.state.status)) return;
    if (event.type === "compaction_end") {
      this.state.compactionCount += 1;
    } else if (event.type === "auto_retry_start") {
      this.persist("pi_auto_retry", `attempt=${event.attempt}/${event.maxAttempts} delayMs=${event.delayMs}`);
    } else if (event.type === "tool_execution_end" && event.isError) {
      const output = Array.isArray(event.result?.content) ? event.result.content.map((item) => item?.text || "").join("\n") : "";
      this.toolFailures.push({ toolName: event.toolName, output: boundedText(output, 6_000) });
      // Failure content remains in memory for existing settlement classification.
    } else if (event.type === "extension_error") {
      this.toolFailures.push({ toolName: "extension", output: boundedText(event.error || "extension error", 6_000) });
    }
    // Recover assistant content only from the canonical settled cursor, never
    // from streaming messages whose contents could leak through activity saves.
    this.checkpointActivity(event);
  }

  async awaitReady() {
    let lastError;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const state = await this.rpc.request({ type: "get_state" }, 5_000);
        this.state.rpcSessionFile = state.sessionFile || this.state.rpcSessionFile;
        this.state.rpcReadyGeneration = this.state.generation;
        this.state.status = "running";
        this.persist("rpc_ready", `session=${this.state.rpcSessionFile || "pending"}`);
        return;
      } catch (error) {
        lastError = error;
        if (this.child?.exitCode !== null) break;
        await this.sleep(100);
      }
    }
    throw lastError || new Error("Pi RPC did not become ready.");
  }

  async runGeneration(prompt) {
    if (this.stopping || this.pauseRequested || this.state.status === "paused") return;
    this.toolFailures = [];
    this.currentAssistantText = "";
    this.currentAssistantEntryId = null;
    if (this.state.activity) this.state.activity = { ...this.state.activity, activeTool: null };
    this.activeTools.clear();
    this.abortController = new AbortController();
    try {
      if (!this.child || this.child.exitCode !== null) this.spawnChild();
      await this.awaitReady();
      const boundary = await this.rpc.request({ type: "get_entries", ...(this.state.lastEntryId ? { since: this.state.lastEntryId } : {}) });
      if (boundary.leafId) this.state.lastEntryId = boundary.leafId;
      this.persist("generation_boundary", `generation=${this.state.generation} prePromptLeaf=${this.state.lastEntryId || "none"}`);
      const settled = this.rpc.waitForSettled(this.abortController.signal, this.config.policy.turnTimeoutMs);
      try {
        await Promise.all([
          this.rpc.request({ type: "prompt", message: prompt }),
          settled,
        ]);
      } catch (error) {
        this.abortController.abort();
        await settled.catch(() => undefined);
        throw error;
      }
      if (this.stopping || this.pauseRequested) return;
      await this.handleSettled();
    } catch (error) {
      if (this.stopping || this.pauseRequested) return;
      await this.handleCrash(error);
    }
  }

  async updateCursor() {
    const previousEntryId = this.state.lastEntryId;
    const current = await this.rpc.request({ type: "get_state" });
    this.state.rpcSessionFile = current.sessionFile || this.state.rpcSessionFile;
    const entries = await this.rpc.request({ type: "get_entries", ...(previousEntryId ? { since: previousEntryId } : {}) });
    const newEntries = Array.isArray(entries.entries) ? entries.entries : [];
    const assistantEntry = newEntries.findLast((entry) => entry?.type === "message" && entry?.message?.role === "assistant");
    if (!entries.leafId || entries.leafId === previousEntryId || !assistantEntry?.id || assistantEntry.id === previousEntryId) {
      throw new Error("Pi RPC cursor did not yield a new, non-empty assistant entry for the current generation.");
    }
    if (assistantEntry.message.stopReason === "error" || assistantEntry.message.errorMessage) {
      const message = String(assistantEntry.message.errorMessage || "Pi assistant ended with stopReason=error.");
      return {
        classification: classifyFailure({ kind: "Pi assistant error", message }),
        summary: `Pi assistant failed: ${boundedText(message, 1_000, false)}`,
      };
    }
    if (!assistantTextFromMessage(assistantEntry.message).trim()) {
      throw new Error("Pi RPC cursor did not yield a new, non-empty assistant entry for the current generation.");
    }
    this.state.lastEntryId = entries.leafId;
    this.currentAssistantEntryId = assistantEntry.id;
    this.currentAssistantText = boundedText(assistantTextFromMessage(assistantEntry.message), this.config.policy.outputLimitBytes);
    this.state.lastAssistantText = this.currentAssistantText;
    this.persist("cursor", `entry=${this.state.lastEntryId} session=${this.state.rpcSessionFile || "none"}`);
  }

  async handleSettled() {
    try {
      const failure = await this.updateCursor();
      if (failure) return this.handleFailure(failure.classification, failure.summary);
    } catch (error) {
      return this.handleFailure("transient", `Current-generation cursor retrieval failed: ${boundedText(error.message, 1_000, false)}`);
    }
    if (this.stopping || this.pauseRequested) return;
    const assistantText = this.currentAssistantText;
    const markerPresent = assistantText.split(/\r?\n/).some((line) => line.trim() === this.config.completionContract.marker);
    let validations = [];
    if (markerPresent) {
      for (const command of this.config.completionContract.validationCommands) {
        if (this.stopping || this.pauseRequested) return;
        this.validationAbortController = new AbortController();
        this.activeValidationPromise = this.runValidation(command, {
          cwd: this.config.cwd,
          timeoutMs: this.config.policy.validationTimeoutMs,
          outputLimit: this.config.policy.outputLimitBytes,
          signal: this.validationAbortController.signal,
        });
        const result = await this.activeValidationPromise;
        this.activeValidationPromise = null;
        this.validationAbortController = null;
        if (this.stopping || this.pauseRequested) return;
        validations.push(result);
        this.state.validationResults = validations;
        this.persist("validation", `${result.passed ? "PASS" : "FAIL"} ${command}`);
        if (!result.passed) break;
      }
    }
    if (this.stopping || this.pauseRequested) return;
    const git = await gitSnapshot(this.config.cwd);
    if (this.stopping || this.pauseRequested) return;
    this.state.modifiedFiles = git.modifiedFiles;
    this.state.worktreeHash = git.worktreeHash;
    let completion = evaluateCompletion({
      assistantText,
      contract: this.config.completionContract,
      validationResults: validations,
      worktreeClean: git.clean,
    });
    const blockingToolFailures = this.toolFailures.filter((item) => item.toolName === "extension" || /Hermes supervisor blocked/i.test(item.output));
    if (completion.complete && blockingToolFailures.length > 0) {
      completion = {
        ...completion,
        complete: false,
        reason: `Supervisor policy/extension failures remain unresolved: ${blockingToolFailures.map((item) => item.toolName).join(", ")}.`,
      };
    }
    if (completion.complete) {
      if (this.stopping || this.pauseRequested || !this.currentAssistantEntryId) return;
      this.lease?.assert();
      await this.shutdownChild();
      if (this.stopping || this.pauseRequested) return;
      this.lease?.assert();
      this.state.status = "completed";
      this.state.companionPid = null;
      this.state.gitSha = git.gitSha;
      this.state.completionEntryId = this.currentAssistantEntryId;
      this.state.childPid = null;
      const checkpoint = createMemoryCheckpoint(this.config, this.state, {
        gitSha: git.gitSha,
        worktreeHash: git.worktreeHash,
        validationResults: validations,
        relatedFiles: git.modifiedFiles,
        summary: assistantText,
      }, this.now());
      this.state.checkpointContentHash = stableHash(JSON.stringify(checkpoint));
      this.state.memoryCheckpoint = { path: this.config.paths.checkpointPath, reviewStatus: checkpoint.reviewStatus, idempotencyKey: checkpoint.idempotencyKey, contentHash: this.state.checkpointContentHash };
      this.persist("completed", completion.reason);
      await this.releaseLock();
      this.clearTimers();
      return;
    }

    const validationFailure = validations.find((item) => !item.passed);
    const combinedToolFailures = this.toolFailures.map((item) => `${item.toolName}: ${item.output}`).join("\n");
    const failureText = validationFailure
      ? `${validationFailure.command}\n${validationFailure.output || ""}\n${validationFailure.stderr || ""}`
      : `${assistantText}\n${combinedToolFailures}\n${completion.reason}`;
    // A completed check's output may contain credential/policy test fixtures.
    // Its typed exit/timeout evidence wins over prose classification. Preserve
    // startup failures (e.g. sandbox unavailable) as explicit runtime blockers.
    const classification = validationFailure
      ? validationFailure.timedOut
        ? "transient"
        : validationFailure.exitCode !== null
          ? "test"
          : classifyFailure({ kind: "validation failed", message: validationFailure.command, output: failureText })
      : classifyFailure({ kind: "agent settled incomplete", message: completion.reason, output: failureText });
    await this.handleFailure(classification, completion.reason, validations);
  }

  async handleFailure(classification, summary, validations = []) {
    const decision = retryDecision(this.state, classification, this.config.policy, this.now());
    this.state.lastFailure = { classification, summary: boundedText(summary, 2_000, false), at: new Date(this.now()).toISOString() };
    if (!decision.retry) {
      this.state.status = "waiting_manual";
      this.state.nextRetryAt = null;
      this.state.manualTakeover = {
        classification,
        reason: decision.reason,
        requiredAction: classification === "credential"
          ? "Configure the missing credential outside the agent, then explicitly resume."
          : classification === "authority"
            ? "Provide the required human/provider authority through the canonical approval surface, then explicitly resume."
            : "Inspect the progress/evidence record, repair the blocker or narrow the task, then explicitly resume.",
      };
      this.persist("manual_takeover", decision.reason);
      await this.shutdownChild();
      return;
    }

    this.state.attempt = decision.nextTotal;
    this.state.classAttempts[classification] = decision.nextClass;
    this.state.status = "backoff";
    this.state.nextRetryAt = decision.nextRetryAt;
    this.persist("backoff", `${classification} delayMs=${decision.delayMs} next=${decision.nextRetryAt}`);
    await this.sleep(decision.delayMs);
    if (this.stopping || this.pauseRequested || this.state.status === "paused") return;
    this.state.status = "running";
    this.state.nextRetryAt = null;
    this.persist("retry", `${classification} attempt=${this.state.attempt}`);
    await this.runGeneration(buildRepairPrompt(this.config, this.state, this.state.lastFailure, validations));
  }

  async handleCrash(error) {
    const stderr = typeof this.child?.__stderr === "function" ? this.child.__stderr() : "";
    await this.shutdownChild();
    if (this.state.restartCount >= this.config.policy.maxRestarts) {
      const summary = `Pi RPC restart budget exhausted after crash: ${boundedText(`${error.message}\n${stderr}`, 2_000)}`;
      this.state.lastFailure = { classification: "transient", summary, at: new Date(this.now()).toISOString() };
      this.state.status = "waiting_manual";
      this.state.nextRetryAt = null;
      this.state.manualTakeover = {
        classification: "transient",
        reason: `Restart budget exhausted (${this.state.restartCount}/${this.config.policy.maxRestarts}).`,
        requiredAction: "Inspect the Pi/runtime crash, then explicitly resume or start a new run.",
      };
      this.persist("manual_takeover", this.state.manualTakeover.reason);
      return;
    }
    this.state.restartCount += 1;
    this.state.status = "backoff";
    const delay = Math.min(this.config.policy.maxBackoffMs, this.config.policy.baseBackoffMs * (2 ** (this.state.restartCount - 1))) + this.config.policy.cooldownMs;
    this.state.nextRetryAt = new Date(this.now() + delay).toISOString();
    this.persist("child_crash", `restart=${this.state.restartCount}/${this.config.policy.maxRestarts} delayMs=${delay}: ${boundedText(`${error.message}\n${stderr}`, 2_000)}`);
    await this.sleep(delay);
    if (this.stopping || this.pauseRequested) return;
    this.state.nextRetryAt = null;
    await this.runGeneration(buildRepairPrompt(this.config, this.state, { classification: "transient", summary: "Pi RPC child crashed and resumed from the persisted session/cursor." }, []));
  }

  async pollControl() {
    if (this.controlInFlight) return;
    const control = readJson(this.config.paths.controlPath, null);
    if (!control || Number(control.sequence || 0) <= this.controlSequence) return;
    this.controlInFlight = true;
    try {
      this.controlSequence = Number(control.sequence || 0);
      if (control.action === "pause") await this.pause(control.reason || "operator request");
      else if (control.action === "resume") await this.resume(control.reason || "operator request");
      else if (control.action === "stop") await this.stop(control.reason || "operator request");
    } finally {
      this.controlInFlight = false;
    }
  }

  async pause(reason) {
    if (this.stopping || TERMINAL_SUPERVISOR_STATUSES.has(this.state.status)) return;
    this.pauseRequested = true;
    this.abortController?.abort();
    this.validationAbortController?.abort();
    if (this.activeValidationPromise) await this.activeValidationPromise.catch(() => undefined);
    try { await this.rpc?.request({ type: "abort" }, 2_000); } catch { /* best effort */ }
    await this.shutdownChild();
    this.state.status = "paused";
    this.state.childPid = null;
    this.state.nextRetryAt = null;
    this.persist("paused", reason);
  }

  async resume(reason) {
    if (this.stopping || !["paused", "waiting_manual"].includes(this.state.status)) return;
    this.pauseRequested = false;
    this.state.status = "running";
    this.state.manualTakeover = null;
    this.persist("resumed", reason);
    void this.runGeneration(buildRepairPrompt(this.config, this.state, this.state.lastFailure || { classification: "transient", summary: "Explicit operator resume." }, this.state.validationResults))
      .catch((error) => this.failClosed(`Resumed generation failed: ${error.message}`));
  }

  async stop(reason = "operator request") {
    if (this.stopping) return;
    this.stopping = true;
    this.abortController?.abort();
    this.validationAbortController?.abort();
    if (this.activeValidationPromise) await this.activeValidationPromise.catch(() => undefined);
    try { await this.rpc?.request({ type: "abort" }, 2_000); } catch { /* best effort */ }
    await this.shutdownChild();
    if (this.state.status !== "completed") {
      this.state.status = "stopped";
      this.state.childPid = null;
      this.state.companionPid = null;
      this.state.nextRetryAt = null;
      this.persist("stopped", reason);
    }
    await this.releaseLock();
    this.clearTimers();
  }

  async failClosed(reason) {
    if (this.stopping) return;
    this.stopping = true;
    await this.shutdownChild();
    this.state.status = "failed";
    this.state.manualTakeover = { classification: "unknown", reason, requiredAction: "Inspect the lock/state integrity failure and explicitly start a new supervised run." };
    try { this.persist("failed", reason); } catch { /* fence already lost; do not overwrite */ }
    this.clearTimers();
  }

  async shutdownChild() {
    const child = this.child;
    this.activeTools.clear();
    if (this.state.activity) this.state.activity = { ...this.state.activity, activeTool: null };
    if (!child?.pid) {
      this.child = null;
      this.rpc = null;
      return;
    }
    killProcessTree(child, "SIGTERM");
    for (let attempt = 0; attempt < 20 && processGroupAlive(child.pid); attempt++) await this.sleep(100);
    if (processGroupAlive(child.pid)) {
      killProcessTree(child, "SIGKILL");
      for (let attempt = 0; attempt < 20 && processGroupAlive(child.pid); attempt++) await this.sleep(100);
    }
    if (processGroupAlive(child.pid)) throw new Error(`Pi process group ${child.pid} did not terminate; retaining workspace fence.`);
    this.child = null;
    this.rpc = null;
  }

  async releaseLock() {
    this.lease?.release();
    this.lease = null;
    const owner = readJson(this.config.paths.lockOwnerPath, null);
    if (owner?.token !== this.config.fenceToken) return;
    const { rmSync } = await import("node:fs");
    rmSync(this.config.paths.lockDir, { recursive: true, force: true });
  }

  clearTimers() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.controlTimer) clearInterval(this.controlTimer);
    this.heartbeatTimer = null;
    this.controlTimer = null;
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === "--config") parsed.config = argv[++index];
    else if (value?.startsWith("--config=")) parsed.config = value.slice("--config=".length);
    else if (value === "--help" || value === "-h") parsed.help = true;
  }
  return parsed;
}

function usage() {
  return "Usage: rorca-pi-supervisor --config <absolute-config.json>";
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (!args.config) throw new Error(usage());
  const config = readJson(path.resolve(args.config), null);
  const companion = new SupervisorCompanion(config);
  const onSignal = (signal) => { void companion.stop(`received ${signal}`).finally(() => process.exit(0)); };
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));
  process.once("SIGHUP", () => {
    if (config.lifecycle === "session") onSignal("SIGHUP");
    // Detached/tmux companions intentionally survive parent terminal SIGHUP.
  });
  await companion.start();
  while (!TERMINAL_SUPERVISOR_STATUSES.has(companion.state.status) && !companion.stopping) await sleep(250);
  return companion.state.status === "completed" ? 0 : companion.state.status === "stopped" ? 0 : 1;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`Hermes Pi supervisor companion failed: ${redactSecrets(error instanceof Error ? error.stack || error.message : String(error))}\n`);
    process.exitCode = 1;
  });
}
