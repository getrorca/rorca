/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SupervisorCompanion, runValidationCommand } from "../autonomous-supervisor-companion.js";
import { createSupervisorRun, readJson, type SupervisorState } from "../autonomous-supervisor-core.js";
import { detectSupervisorSandbox } from "../autonomous-supervisor-sandbox.js";

const FAKE_PI = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const progress = process.env.RORCA_PI_SUPERVISOR_PROGRESS;
const config = JSON.parse(readFileSync(path.join(path.dirname(progress), 'config.json'), 'utf8'));
const scenario = process.env.FAKE_PI_SCENARIO || 'success';
const counterFile = process.env.FAKE_PI_COUNTER;
const argsFile = process.env.FAKE_PI_ARGS;
const cleanupFile = process.env.FAKE_PI_CLEANUP;
appendFileSync(argsFile, JSON.stringify(process.argv.slice(2)) + '\\n');
let buffer = '';
let lastText = '';
let lastErrorMessage = null;
function countPrompt() {
  const prior = existsSync(counterFile) ? Number(readFileSync(counterFile, 'utf8')) : 0;
  const next = prior + 1;
  writeFileSync(counterFile, String(next));
  return next;
}
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
function complete(text, compaction = false) {
  lastText = text;
  if (compaction) send({ type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: false, result: { summary: 'compact' } });
  send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' } });
  send({ type: 'agent_settled' });
}
function line(raw) {
  if (!raw.trim()) return;
  const cmd = JSON.parse(raw);
  if (cmd.type === 'get_state') return send({ id: cmd.id, type: 'response', command: cmd.type, success: true, data: { sessionFile: '/tmp/fake-session.jsonl', isStreaming: false } });
  if (cmd.type === 'get_entries') {
    const id = 'entry-' + (existsSync(counterFile) ? readFileSync(counterFile, 'utf8') : '0');
    const entries = scenario === 'stale-entry' ? [{ type: 'message', id, message: { role: 'user', content: [{ type: 'text', text: 'not an assistant completion' }] } }] : lastErrorMessage ? [
      { type: 'message', id: id + '-prior', message: { role: 'assistant', content: [{ type: 'text', text: config.completionContract.marker }] } },
      { type: 'message', id, message: lastErrorMessage },
    ] : lastText ? [{ type: 'message', id, message: { role: 'assistant', content: [{ type: 'text', text: lastText }] } }] : [];
    return send({ id: cmd.id, type: 'response', command: cmd.type, success: true, data: { entries, leafId: id } });
  }
  if (cmd.type === 'get_last_assistant_text') return send({ id: cmd.id, type: 'response', command: cmd.type, success: true, data: { text: lastText } });
  if (cmd.type === 'abort') return send({ id: cmd.id, type: 'response', command: cmd.type, success: true, data: {} });
  if (cmd.type === 'prompt') {
    const n = countPrompt();
    send({ id: cmd.id, type: 'response', command: cmd.type, success: true, data: {} });
    if ((scenario === 'crash-first' && n === 1) || scenario === 'crash-always') return setTimeout(() => process.exit(17), 5);
    if ((scenario === 'hang-first' && n === 1) || scenario === 'hang-always') return;
    if (scenario === 'active-first-turn') {
      send({ type: 'turn_start' });
      send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: config.completionContract.marker + '\\nPRIVATE_ACTIVITY_CONTENT' }] } });
      send({ type: 'compaction_end', result: { summary: 'PRIVATE_ACTIVITY_CONTENT' } });
      send({ type: 'tool_execution_start', toolName: 'read', args: { path: 'PRIVATE_ACTIVITY_CONTENT' } });
      return;
    }
    if (scenario === 'authority') return setTimeout(() => complete('This requires explicit human approval before mutation.'), 5);
    if (scenario === 'credential') return setTimeout(() => complete('401 missing API key; operator login required.'), 5);
    if (scenario === 'credential-empty' || scenario === 'credential-marker') return setImmediate(() => {
      lastErrorMessage = {
        role: 'assistant', stopReason: 'error',
        content: scenario === 'credential-marker' ? [{ type: 'text', text: config.completionContract.marker }] : [],
        errorMessage: 'OAuth refresh failed (401): refresh_token_reused',
      };
      send({ type: 'message_end', message: lastErrorMessage });
      send({ type: 'agent_settled' });
    });
    if (scenario === 'unknown') return setTimeout(() => complete('Unmapped blocker without actionable evidence.'), 5);
    if (scenario === 'tool-failure') return setTimeout(() => {
      send({ type: 'tool_execution_end', toolName: 'bash', isError: true, result: { content: [{ type: 'text', text: 'Hermes supervisor blocked command: deployment forbidden.' }] } });
      complete('Claimed done.\\n' + config.completionContract.marker);
    }, 5);
    return setTimeout(() => complete('Validated independently.\\n' + config.completionContract.marker, scenario === 'compaction'), 5);
  }
}
process.stdin.on('data', chunk => {
  buffer += chunk.toString();
  for (;;) {
    const index = buffer.indexOf('\\n');
    if (index < 0) break;
    const raw = buffer.slice(0, index).replace(/\\r$/, '');
    buffer = buffer.slice(index + 1);
    line(raw);
  }
});
process.on('SIGTERM', () => { appendFileSync(cleanupFile, 'SIGTERM\\n'); process.exit(0); });
`;

function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (predicate()) { clearInterval(timer); resolve(); }
      else if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error("waitFor timed out")); }
    }, 10);
  });
}

function fixture(scenario: string) {
  const root = mkdtempSync(path.join(tmpdir(), "rorca-supervisor-companion-"));
  const cwd = path.join(root, "workspace");
  const fakePi = path.join(root, "fake-pi");
  const counter = path.join(root, "counter");
  const args = path.join(root, "args.jsonl");
  const cleanup = path.join(root, "cleanup.log");
  writeFileSync(fakePi, FAKE_PI);
  chmodSync(fakePi, 0o700);
  writeFileSync(args, "");
  writeFileSync(cleanup, "");
  mkdirSync(cwd);
  const prepared = createSupervisorRun({
    home: path.join(root, "home"),
    cwd,
    runId: scenario,
    task: "Implement and validate",
    validationCommands: ["fake-test"],
    completionNonce: `nonce-${scenario}`,
    piCommand: fakePi,
    policy: {
      maxTotalAttempts: 3,
      maxRestarts: 2,
      maxUnknownAttempts: 1,
      classBudgets: { transient: 2, test: 2, code: 2, unknown: 1 },
      baseBackoffMs: 0,
      maxBackoffMs: 0,
      cooldownMs: 0,
      heartbeatMs: 20,
      controlPollMs: 20,
      validationTimeoutMs: 1_000,
    },
  });
  process.env.FAKE_PI_SCENARIO = scenario;
  process.env.FAKE_PI_COUNTER = counter;
  process.env.FAKE_PI_ARGS = args;
  process.env.FAKE_PI_CLEANUP = cleanup;
  return { root, cwd, fakePi, counter, args, cleanup, prepared };
}

function passValidation(command: string) {
  return Promise.resolve({ command, exitCode: 0, timedOut: false, durationMs: 1, passed: true, output: "pass", stderr: "", at: new Date().toISOString() });
}

afterEach(() => {
  delete process.env.FAKE_PI_SCENARIO;
  delete process.env.FAKE_PI_COUNTER;
  delete process.env.FAKE_PI_ARGS;
  delete process.env.FAKE_PI_CLEANUP;
});

describe.sequential("Hermes supervisor companion integration", () => {
  it("checkpoints an active first prompt without advancing its cursor or running checks", async () => {
    const f = fixture("active-first-turn");
    const validation = vi.fn(passValidation);
    const companion = new SupervisorCompanion(f.prepared.config, { runValidation: validation });
    const running = companion.start();
    try {
      await waitFor(() => companion.state.activity?.activeTool === "read");
      const durable = readJson<SupervisorState>(f.prepared.paths.statePath, f.prepared.state);
      expect(durable).toMatchObject({
        status: "running", attempt: 0, lastEntryId: "entry-0",
        compactionCount: 1, lastAssistantText: "", validationResults: [],
        activity: { event: "tool_execution_start", activeTool: "read" },
      });
      expect(durable.completionEntryId).toBeUndefined();
      expect(validation).not.toHaveBeenCalled();
      const progress = readFileSync(f.prepared.paths.progressMarkdownPath, "utf8");
      expect(progress).toContain("tool_execution_start");
      expect(progress).toContain("independent checks await a settled assistant");
      for (const file of [f.prepared.paths.statePath, f.prepared.paths.progressMarkdownPath, f.prepared.paths.eventLogPath]) {
        expect(readFileSync(file, "utf8")).not.toContain("PRIVATE_ACTIVITY_CONTENT");
      }
    } finally {
      await companion.stop("test cleanup");
      await running;
    }
    const stopped = readFileSync(f.prepared.paths.statePath, "utf8");
    companion.onRpcEvent({ type: "tool_execution_start", toolName: "write" });
    expect(readFileSync(f.prepared.paths.statePath, "utf8")).toBe(stopped);
    expect(companion.state.status).toBe("stopped");
    expect(companion.state.activity?.activeTool).toBeNull();
    expect(existsSync(f.prepared.paths.lockDir)).toBe(false);
  });

  it("coalesces streaming checkpoints and flushes trailing activity without confusing heartbeats with work", () => {
    const f = fixture("bounded-activity");
    let now = 10_000;
    const companion = new SupervisorCompanion(f.prepared.config, { now: () => now });
    try {
      companion.onRpcEvent({ type: "tool_execution_start", toolName: "read", args: { secret: "PRIVATE_DELTA" } });
      const initial = readFileSync(f.prepared.paths.statePath, "utf8");
      for (let delta = 1; delta <= 1_000; delta++) {
        now = 10_000 + delta;
        companion.onRpcEvent({ type: delta % 2 ? "message_update" : "tool_execution_update", toolName: "read", message: "PRIVATE_DELTA", args: "PRIVATE_DELTA", partialResult: "PRIVATE_DELTA" });
      }
      now = 14_999;
      companion.heartbeat();
      expect(readFileSync(f.prepared.paths.statePath, "utf8")).toBe(initial);
      now = 15_000;
      companion.heartbeat();
      const checkpoint = readJson<SupervisorState>(f.prepared.paths.statePath, f.prepared.state);
      expect(checkpoint.activity).toEqual({ at: new Date(11_000).toISOString(), event: "tool_execution_update", activeTool: "read" });
      expect(checkpoint.heartbeatAt).toBe(new Date(15_000).toISOString());
      expect(checkpoint.lastEntryId).toBeNull();
      expect(checkpoint.validationResults).toEqual([]);
      expect(readFileSync(f.prepared.paths.eventLogPath, "utf8").trim().split("\n")).toHaveLength(2);
      const flushed = readFileSync(f.prepared.paths.statePath, "utf8");
      now = 20_000;
      companion.heartbeat();
      expect(readFileSync(f.prepared.paths.statePath, "utf8")).toBe(flushed);
      for (const file of [f.prepared.paths.statePath, f.prepared.paths.progressMarkdownPath, f.prepared.paths.eventLogPath]) {
        expect(readFileSync(file, "utf8")).not.toContain("PRIVATE_DELTA");
      }
    } finally {
      f.prepared.lock.release();
    }
  });

  it("keeps only bounded safe lifecycle metadata through compaction and reload", () => {
    const f = fixture("activity-milestones");
    f.prepared.config.policy.maxHistory = 4;
    let now = 1_000;
    const companion = new SupervisorCompanion(f.prepared.config, { now: () => now });
    try {
      companion.state.lastEntryId = "pre-prompt";
      const events = [
        { type: "turn_start" },
        { type: "tool_execution_start", toolName: "read" },
        { type: "tool_execution_start", toolName: "read" },
        { type: "tool_execution_start", toolName: "write" },
        { type: "tool_execution_end", toolName: "write", result: "PRIVATE_PAYLOAD" },
        { type: "tool_execution_end", toolName: "read", result: "PRIVATE_PAYLOAD" },
      ];
      for (const event of events) {
        now++;
        companion.onRpcEvent(event);
        expect(readJson<SupervisorState>(f.prepared.paths.statePath, f.prepared.state).activity?.event).toBe(event.type);
      }
      expect(companion.state.activity?.activeTool).toBe("read");
      companion.onRpcEvent({ type: "tool_execution_end", toolName: "read", isError: true, result: { content: [{ text: "PRIVATE_PAYLOAD" }] } });
      expect(companion.state.activity?.activeTool).toBeNull();
      companion.onRpcEvent({ type: "tool_execution_start", toolName: "PRIVATE_PAYLOAD", args: "PRIVATE_PAYLOAD" });
      expect(companion.state.activity?.activeTool).toBe("unknown");
      companion.onRpcEvent({ type: "turn_end", message: "PRIVATE_PAYLOAD", toolResults: "PRIVATE_PAYLOAD" });
      companion.onRpcEvent({ type: "compaction_start", reason: "PRIVATE_PAYLOAD" });
      now++;
      companion.onRpcEvent({ type: "compaction_end", reason: "PRIVATE_PAYLOAD", result: { summary: "PRIVATE_PAYLOAD" } });
      const restored = new SupervisorCompanion(f.prepared.config);
      expect(restored.state).toMatchObject({
        lastEntryId: "pre-prompt", compactionCount: 1, validationResults: [],
        activity: { event: "compaction_end", at: new Date(now).toISOString(), activeTool: null },
      });
      expect(restored.state.history).toHaveLength(4);
      for (const file of [f.prepared.paths.statePath, f.prepared.paths.progressMarkdownPath, f.prepared.paths.eventLogPath]) {
        expect(readFileSync(file, "utf8")).not.toContain("PRIVATE_PAYLOAD");
      }
      writeFileSync(f.prepared.paths.lockOwnerPath, JSON.stringify({ token: "other-owner" }));
      const before = readFileSync(f.prepared.paths.statePath, "utf8");
      expect(() => companion.onRpcEvent({ type: "turn_start" })).toThrow(/fence token mismatch/);
      expect(readFileSync(f.prepared.paths.statePath, "utf8")).toBe(before);
    } finally {
      // Restore only this fixture's owner so its lock can be released.
      writeFileSync(f.prepared.paths.lockOwnerPath, JSON.stringify(f.prepared.lock.owner));
      f.prepared.lock.release();
    }
  });

  it.skipIf(!detectSupervisorSandbox())("aborts and cleans up a long validation process on pause signal", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "rorca-supervisor-validation-abort-"));
    const controller = new AbortController();
    const started = Date.now();
    const pending = runValidationCommand("sleep 30", { cwd, timeoutMs: 60_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const result = await pending;
    expect(result).toMatchObject({ passed: false, cancelled: true, timedOut: false });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("completes only after exact marker plus controller validation", async () => {
    const f = fixture("success");
    const companion = new SupervisorCompanion(f.prepared.config, { runValidation: passValidation });
    await companion.start();
    expect(companion.state.status).toBe("completed");
    expect(companion.state.validationResults).toMatchObject([{ command: "fake-test", passed: true }]);
    expect(companion.state.lastEntryId).toBe("entry-1");
    expect(companion.state.memoryCheckpoint).toMatchObject({ reviewStatus: "pending_review" });
    expect(existsSync(f.prepared.config.paths.lockDir)).toBe(false);
  });

  it("rejects a second companion process using the same config while the first lease is live", async () => {
    const f = fixture("hang-first");
    const first = new SupervisorCompanion(f.prepared.config, { runValidation: passValidation });
    const running = first.start();
    await waitFor(() => first.state.status === "running" && Boolean(first.state.childPid));
    const second = new SupervisorCompanion(f.prepared.config, { runValidation: passValidation });
    await expect(second.start()).rejects.toThrow(/live supervisor companion/);
    await first.stop("test cleanup");
    await running;
  });

  it("restarts a crashed Pi RPC child and resumes the persisted session", async () => {
    const f = fixture("crash-first");
    const companion = new SupervisorCompanion(f.prepared.config, { runValidation: passValidation });
    await companion.start();
    expect(companion.state.status).toBe("completed");
    expect(companion.state.restartCount).toBe(1);
    expect(companion.state.generation).toBe(2);
    const invocations = readFileSync(f.args, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(invocations[1]).toContain("--session");
    expect(invocations[1]).toContain("/tmp/fake-session.jsonl");
  });

  it("never exceeds the hard Pi restart budget", async () => {
    const f = fixture("crash-always");
    f.prepared.config.policy.maxRestarts = 0;
    const companion = new SupervisorCompanion(f.prepared.config, { runValidation: passValidation });
    await companion.start();
    expect(companion.state.status).toBe("waiting_manual");
    expect(companion.state.restartCount).toBe(0);
    expect(companion.state.attempt).toBe(0);
    expect(Number(readFileSync(f.counter, "utf8"))).toBe(1);
    await companion.stop("test cleanup");
  });

  it("never binds a stale assistant marker to a non-assistant generation leaf", async () => {
    const f = fixture("stale-entry");
    const companion = new SupervisorCompanion(f.prepared.config, { runValidation: passValidation });
    await companion.start();
    expect(companion.state.status).toBe("waiting_manual");
    expect(companion.state.completionEntryId).toBeUndefined();
    expect(companion.state.validationResults).toEqual([]);
    await companion.stop("test cleanup");
  });

  it("persists compaction count and durable entry cursor", async () => {
    const f = fixture("compaction");
    const companion = new SupervisorCompanion(f.prepared.config, { runValidation: passValidation });
    await companion.start();
    const durable = readJson<any>(f.prepared.config.paths.statePath, null);
    expect(durable.compactionCount).toBe(1);
    expect(durable.lastEntryId).toBe("entry-1");
    expect(durable.rpcSessionFile).toBe("/tmp/fake-session.jsonl");
  });

  it("retries failed npm test despite credential fixtures and an unrun build check", async () => {
    const f = fixture("failed-tests");
    f.prepared.config.completionContract.validationCommands = ["npm test", "npm run build"];
    let validations = 0;
    const runValidation = vi.fn(async (command: string) => {
      validations += 1;
      return validations === 1
        ? { command, exitCode: 1, timedOut: false, durationMs: 1, passed: false, output: "FAIL credential.test.ts > rejects 401 OAuth refresh_token_reused\nAssertionError: expected 1 received 2", stderr: "", at: new Date().toISOString() }
        : { command, exitCode: 0, timedOut: false, durationMs: 1, passed: true, output: "pass", stderr: "", at: new Date().toISOString() };
    });
    const companion = new SupervisorCompanion(f.prepared.config, { runValidation });
    await companion.start();
    expect(companion.state.status).toBe("completed");
    expect(companion.state.attempt).toBe(1);
    expect(companion.state.classAttempts.test).toBe(1);
    expect(companion.state.classAttempts.credential).toBeUndefined();
    expect(companion.state.manualTakeover).toBeNull();
    expect(companion.state.lastFailure).toMatchObject({ classification: "test", summary: "Validation failed: npm test." });
    expect(runValidation.mock.calls.map(([command]) => command)).toEqual(["npm test", "npm test", "npm run build"]);
    expect(companion.state.validationResults.map((result) => result.command)).toEqual(["npm test", "npm run build"]);
    expect(Number(readFileSync(f.counter, "utf8"))).toBe(2);
  });

  it("keeps validation sandbox startup failures blocked on authority", async () => {
    const f = fixture("validation-sandbox");
    const runValidation = vi.fn(async (command: string) => ({
      command, exitCode: null, timedOut: false, durationMs: 1, passed: false,
      output: "", stderr: "Supervisor sandbox unavailable", at: new Date().toISOString(),
    }));
    const companion = new SupervisorCompanion(f.prepared.config, { runValidation });
    try {
      await companion.start();
      expect(companion.state.status).toBe("waiting_manual");
      expect(companion.state.manualTakeover?.classification).toBe("authority");
      expect(companion.state.attempt).toBe(0);
      expect(runValidation).toHaveBeenCalledTimes(1);
    } finally {
      await companion.stop("test cleanup");
    }
  });

  it.each(["authority", "credential"])("fails closed without retry for %s blockers", async (scenario) => {
    const f = fixture(scenario);
    const companion = new SupervisorCompanion(f.prepared.config, { runValidation: passValidation });
    await companion.start();
    expect(companion.state.status).toBe("waiting_manual");
    expect(companion.state.attempt).toBe(0);
    expect(companion.state.manualTakeover?.classification).toBe(scenario);
    expect(Number(readFileSync(f.counter, "utf8"))).toBe(1);
    await companion.stop("test cleanup");
    expect(companion.state.status).toBe("stopped");
  });

  it.each(["credential-empty", "credential-marker"])("classifies the current %s provider error without retry or stale completion", async (scenario) => {
    const f = fixture(scenario);
    const validation = vi.fn(passValidation);
    const companion = new SupervisorCompanion(f.prepared.config, { runValidation: validation });
    try {
      await companion.start();
      expect(companion.state.status).toBe("waiting_manual");
      expect(companion.state.manualTakeover?.classification).toBe("credential");
      expect(companion.state.lastFailure?.summary).toContain("refresh_token_reused");
      expect(companion.state.attempt).toBe(0);
      expect(companion.state.completionEntryId).toBeUndefined();
      expect(validation).not.toHaveBeenCalled();
      expect(Number(readFileSync(f.counter, "utf8"))).toBe(1);
    } finally {
      await companion.stop("test cleanup");
    }
  });

  it("rejects a completion marker when a blocked tool failure remains", async () => {
    const f = fixture("tool-failure");
    const companion = new SupervisorCompanion(f.prepared.config, { runValidation: passValidation });
    await companion.start();
    expect(companion.state.status).toBe("waiting_manual");
    expect(companion.state.manualTakeover?.classification).toBe("authority");
    expect(companion.state.attempt).toBe(0);
    await companion.stop("test cleanup");
  });

  it("retries an unknown blocker once and then requires manual takeover", async () => {
    const f = fixture("unknown");
    const companion = new SupervisorCompanion(f.prepared.config, { runValidation: passValidation });
    await companion.start();
    expect(companion.state.status).toBe("waiting_manual");
    expect(companion.state.attempt).toBe(1);
    expect(companion.state.classAttempts.unknown).toBe(1);
    expect(Number(readFileSync(f.counter, "utf8"))).toBe(2);
    await companion.stop("test cleanup");
  });

  it("accepts stop immediately after resume without waiting for the resumed generation", async () => {
    const f = fixture("hang-always");
    const companion = new SupervisorCompanion(f.prepared.config, { runValidation: passValidation });
    const starting = companion.start();
    await waitFor(() => companion.state.status === "running" && Boolean(companion.state.childPid));
    await companion.pause("test pause");
    await starting;
    await companion.resume("test resume");
    await companion.stop("stop resumed generation");
    expect(companion.state.status).toBe("stopped");
    expect(existsSync(f.prepared.config.paths.lockDir)).toBe(false);
  }, 15_000);

  it("pauses, cleans up the active process, resumes the same session, and completes", async () => {
    const f = fixture("hang-first");
    const companion = new SupervisorCompanion(f.prepared.config, { runValidation: passValidation });
    const starting = companion.start();
    await waitFor(() => companion.state.status === "running" && Boolean(companion.state.childPid));
    await companion.pause("test pause");
    await starting;
    expect(companion.state.status).toBe("paused");
    expect(companion.state.childPid).toBeNull();
    expect(readFileSync(f.cleanup, "utf8")).toContain("SIGTERM");
    await companion.resume("test resume");
    await waitFor(() => companion.state.status === "completed");
    expect(companion.state.status).toBe("completed");
    expect(companion.state.generation).toBe(2);
  }, 15_000);
});
