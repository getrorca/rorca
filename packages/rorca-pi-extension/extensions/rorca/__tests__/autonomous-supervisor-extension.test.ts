/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerHermesAutonomousSupervisor } from "../autonomous-supervisor.js";
import * as core from "../autonomous-supervisor-core.js";
import { detectSupervisorSandbox } from "../autonomous-supervisor-sandbox.js";

function harness(cwd: string) {
  execFileSync("git", ["init", "--initial-branch=test"], { cwd, stdio: "ignore" });
  const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
  const tools = new Map<string, any>();
  const events = new Map<string, Array<(...args: any[]) => any>>();
  const entries: any[] = [];
  const pi = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    on: (name: string, handler: (...args: any[]) => any) => events.set(name, [...(events.get(name) || []), handler]),
  } as any;
  const tmux = {
    launch: vi.fn(async (options: any) => {
      const config = JSON.parse(readFileSync(options.supervisorConfigPath, "utf8"));
      const state = JSON.parse(readFileSync(config.paths.statePath, "utf8"));
      writeFileSync(config.paths.statePath, `${JSON.stringify({ ...state, status: "running", companionPid: process.pid, generation: 1, rpcReadyGeneration: 1 })}\n`);
      return { name: options.sessionName, cwd: options.cwd, startedAt: Date.now(), tasks: options.tasks, memory: options.memory };
    }),
    hasSession: vi.fn(async () => false),
    killSession: vi.fn(async () => undefined),
  } as any;
  const api = { submitCandidate: vi.fn() } as any;
  const notifications: string[] = [];
  const widgets: string[][] = [];
  const ctx = {
    cwd,
    mode: "rpc",
    ui: {
      notify: (message: string) => notifications.push(message),
      setStatus: vi.fn(),
      setWidget: (_key: string, lines?: string[]) => { if (lines) widgets.push(lines); },
      custom: vi.fn(),
    },
    sessionManager: { getEntries: () => entries, getBranch: () => entries },
    isIdle: () => true,
  } as any;
  const register = (name: string, _description: string, handler: (args: string, ctx: any) => Promise<void>) => commands.set(name, handler);
  const home = mkdtempSync(path.join(tmpdir(), "rorca-supervisor-extension-home-"));
  const service = registerHermesAutonomousSupervisor(pi, api, tmux, register);
  (service as any).home = home;
  return { pi, tmux, api, commands, tools, events, entries, ctx, notifications, widgets, service, home };
}

afterEach(() => {
  delete process.env.RORCA_PI_SUPERVISOR_HOME;
});

describe("Hermes supervisor extension surface", () => {
  it("registers start/status/pause/resume/stop tools and commands", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "rorca-supervisor-extension-"));
    process.env.RORCA_PI_SUPERVISOR_HOME = path.join(cwd, ".home");
    const h = harness(cwd);
    for (const name of ["start", "status", "pause", "resume", "stop"]) {
      expect(h.tools.has(`hermes_autonomy_${name}`)).toBe(true);
      expect(h.commands.has(`hermes-supervisor-${name}`)).toBe(true);
    }
    expect(h.commands.has("hermes-supervisor-dashboard")).toBe(true);
    expect(h.commands.has("hermes-supervisor-checkpoint")).toBe(true);
  });

  it("reports durable RPC activity separately from live companion heartbeat and pending checks", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "rorca-supervisor-extension-activity-"));
    const h = harness(cwd);
    const prepared = core.createSupervisorRun({ home: h.home, cwd, runId: "activity-status", task: "Implement", validationCommands: ["true"], now: 1_000 });
    prepared.state.status = "running";
    prepared.state.companionPid = process.pid;
    prepared.state.companionGeneration = 1;
    prepared.state.activity = { at: new Date(2_000).toISOString(), event: "tool_execution_start", activeTool: "read" };
    const lease = core.claimCompanionLease({ lockDir: prepared.paths.lockDir, fenceToken: prepared.config.fenceToken, runId: prepared.state.runId, generation: 1, now: 5_000 });
    const clock = vi.spyOn(Date, "now").mockReturnValue(5_000);
    try {
      core.saveSupervisorState(prepared.config, prepared.state);
      const status = h.service.status("activity-status");
      expect(status.heartbeat).toEqual({ at: new Date(5_000).toISOString(), freshness: "fresh" });
      expect(status.lines.join("\n")).toContain("active tool read (not validation evidence)");
      expect(status.lines.join("\n")).toContain("fresh; not work activity");
      expect(status.lines.join("\n")).toContain("not run; independent checks await a settled assistant with the exact completion marker");
      lease.heartbeat(6_000);
      clock.mockReturnValue(6_000);
      const result = await h.tools.get("hermes_autonomy_status").execute("status", { runId: "activity-status" }, new AbortController().signal, undefined, h.ctx);
      expect(result.details).toMatchObject({
        runId: "activity-status", status: "running",
        activity: { at: new Date(2_000).toISOString(), event: "tool_execution_start", activeTool: "read" },
        companionHeartbeat: { at: new Date(6_000).toISOString(), freshness: "fresh" },
      });
      lease.release();
      expect(h.service.status("activity-status").heartbeat).toEqual({ at: null, freshness: "unavailable" });
    } finally {
      clock.mockRestore();
      lease.release();
      prepared.lock.release();
    }
  });

  it.skipIf(!detectSupervisorSandbox())("starts a detached fenced run and reports structured status", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "rorca-supervisor-extension-start-"));
    process.env.RORCA_PI_SUPERVISOR_HOME = path.join(cwd, ".home");
    const h = harness(cwd);
    await h.commands.get("hermes-supervisor-start")!("Implement package --run-id extension-run --validate 'true' --detached", h.ctx);
    expect(h.tmux.launch).toHaveBeenCalledWith(expect.objectContaining({
      cwd: realpathSync(cwd),
      tasks: [{ name: "hermes-supervisor", task: "Implement package" }],
      supervisorConfigPath: expect.stringContaining("config.json"),
    }));
    expect(h.entries.at(-1)?.data).toMatchObject({ runId: "extension-run", lifecycle: "detached" });

    await h.commands.get("hermes-supervisor-status")!("extension-run", h.ctx);
    expect(h.notifications.some((message) => message.includes("Hermes Supervisor extension-run"))).toBe(true);
    expect(h.widgets.at(-1)?.join("\n")).toContain("Status: running");

    for (const handler of h.events.get("session_shutdown") || []) await handler({}, h.ctx);
    // Detached tmux ownership survives parent shutdown; only monitors/session children stop.
    expect(h.tmux.killSession).not.toHaveBeenCalled();
    // Explicitly release the fixture lock through the prepared run state.
    const loaded = h.service.status("extension-run");
    const owner = await import("../autonomous-supervisor-core.js");
    const lock = owner.readJson<any>(loaded.config.paths.lockOwnerPath, null);
    expect(lock.token).toBe(loaded.config.fenceToken);
  });

  it("rejects tampered checkpoint content before pending-candidate submission", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "rorca-supervisor-extension-checkpoint-"));
    const h = harness(cwd);
    const core = await import("../autonomous-supervisor-core.js");
    const prepared = core.createSupervisorRun({ home: h.home, cwd, runId: "checkpoint-submit", task: "Implement", validationCommands: ["true"] });
    const validation = { command: "true", exitCode: 0, timedOut: false, cancelled: false, durationMs: 1, passed: true, output: "", stderr: "", at: new Date().toISOString() };
    const state = { ...prepared.state, status: "completed", gitSha: "abc123", worktreeHash: "worktree-hash", completionEntryId: "assistant-entry", lastEntryId: "assistant-entry", validationResults: [validation] } as any;
    const checkpoint = core.createMemoryCheckpoint(prepared.config, state, { gitSha: state.gitSha, worktreeHash: state.worktreeHash, validationResults: [validation] });
    state.checkpointContentHash = core.stableHash(JSON.stringify(checkpoint));
    state.memoryCheckpoint = { contentHash: state.checkpointContentHash };
    core.atomicWriteJson(prepared.paths.statePath, state);
    core.atomicWriteJson(prepared.paths.checkpointPath, { ...checkpoint, title: "tampered" });
    await expect(h.service.submitCheckpoint("checkpoint-submit", "workspace-id")).rejects.toThrow(/does not match/);
    expect(h.api.submitCandidate).not.toHaveBeenCalled();
    prepared.lock.release();
  });

  it.skipIf(!detectSupervisorSandbox())("rejects a second writer in the same worktree", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "rorca-supervisor-extension-dupe-"));
    process.env.RORCA_PI_SUPERVISOR_HOME = path.join(cwd, ".home");
    const h = harness(cwd);
    await h.commands.get("hermes-supervisor-start")!("First --run-id first --validate 'true'", h.ctx);
    await expect(h.commands.get("hermes-supervisor-start")!("Second --run-id second --validate 'true'", h.ctx)).rejects.toThrow(/already owns/);
    for (const handler of h.events.get("session_shutdown") || []) await handler({}, h.ctx);
  });
});
