/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  acquireWorkspaceLock,
  atomicWriteJson,
  claimCompanionLease,
  classifyFailure,
  companionHeartbeat,
  createMemoryCheckpoint,
  createSupervisorRun,
  evaluateCompletion,
  loadSupervisorRun,
  retryDecision,
  saveSupervisorState,
  writeControl,
} from "../autonomous-supervisor-core.js";

function tempWorkspace(prefix = "rorca-supervisor-core-") {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

describe("Hermes autonomous supervisor core", () => {
  it.each([
    ["429 overloaded", "transient"],
    ["tests failed: expected 1 received 2", "test"],
    ["typecheck TS2322 build failed", "code"],
    ["requires human approval before mutation", "authority"],
    ["401 missing API key", "credential"],
    ["something unexplained happened", "unknown"],
  ])("classifies %s as %s", (message, expected) => {
    expect(classifyFailure({ message })).toBe(expected);
  });

  it("loads old runs without activity without rewriting them or inventing work evidence", () => {
    const home = tempWorkspace();
    const prepared = createSupervisorRun({ home, cwd: tempWorkspace(), runId: "old-state", task: "Implement", validationCommands: ["true"] });
    try {
      delete prepared.state.activity;
      atomicWriteJson(prepared.paths.statePath, prepared.state);
      const before = readFileSync(prepared.paths.statePath, "utf8");
      const loaded = loadSupervisorRun(home, "old-state");
      expect(loaded.state.activity).toBeNull();
      expect(loaded.state.lastEntryId).toBeNull();
      expect(loaded.state.validationResults).toEqual([]);
      expect(readFileSync(prepared.paths.statePath, "utf8")).toBe(before);
      expect(companionHeartbeat(loaded.config, loaded.state)).toEqual({ at: null, freshness: "unavailable" });
    } finally {
      prepared.lock.release();
    }
  });

  it("projects heartbeat freshness only from the matching companion lease, independently of activity", () => {
    const prepared = createSupervisorRun({ home: tempWorkspace(), cwd: tempWorkspace(), runId: "heartbeat", task: "Implement", validationCommands: ["true"], now: 1_000 });
    const { config, state, paths } = prepared;
    state.companionPid = process.pid;
    state.companionGeneration = 1;
    state.activity = { at: new Date(1_000).toISOString(), event: "turn_start", activeTool: null };
    const lease = claimCompanionLease({ lockDir: paths.lockDir, fenceToken: config.fenceToken, runId: state.runId, generation: 1, now: 2_000 });
    try {
      expect(companionHeartbeat(config, state, 2_000)).toEqual({ at: new Date(2_000).toISOString(), freshness: "fresh" });
      expect(companionHeartbeat(config, state, 2_001 + config.policy.staleLockMs).freshness).toBe("stale");
      expect(companionHeartbeat(config, { ...state, companionGeneration: 2 }, 2_000)).toEqual({ at: null, freshness: "unavailable" });
      lease.heartbeat(9_000);
      expect(companionHeartbeat(config, state, 9_000)).toEqual({ at: new Date(9_000).toISOString(), freshness: "fresh" });
      expect(state.activity.at).toBe(new Date(1_000).toISOString());
      expect(state.validationResults).toEqual([]);
    } finally {
      lease.release();
      prepared.lock.release();
    }
  });

  it("requires the exact marker and independent validation evidence", () => {
    const contract = {
      marker: "HERMES_SUPERVISOR_COMPLETION:nonce-123",
      nonceHash: "hash",
      validationCommands: ["npm test", "npm run typecheck"],
      requireCleanWorktree: false,
    };
    expect(evaluateCompletion({
      assistantText: "done",
      contract,
      validationResults: [],
    }).complete).toBe(false);

    expect(evaluateCompletion({
      assistantText: `${contract.marker} trailing`,
      contract,
      validationResults: contract.validationCommands.map((command) => ({ command, exitCode: 0, timedOut: false, durationMs: 1, passed: true })),
    }).markerPresent).toBe(false);

    expect(evaluateCompletion({
      assistantText: `Validated.\n${contract.marker}`,
      contract,
      validationResults: [
        { command: "npm test", exitCode: 0, timedOut: false, durationMs: 1, passed: true },
        { command: "npm run typecheck", exitCode: 1, timedOut: false, durationMs: 1, passed: false },
      ],
    })).toMatchObject({ complete: false, failedValidations: ["npm run typecheck"] });

    expect(evaluateCompletion({
      assistantText: contract.marker,
      contract: { ...contract, validationCommands: ["npm test", "npm run build"] },
      validationResults: [{ command: "npm test", exitCode: 1, timedOut: false, durationMs: 1, passed: false }],
    })).toMatchObject({
      complete: false,
      failedValidations: ["npm test"],
      missingValidations: ["npm run build"],
      reason: "Validation failed: npm test.",
    });

    expect(evaluateCompletion({
      assistantText: `Validated.\n${contract.marker}`,
      contract,
      validationResults: contract.validationCommands.map((command) => ({ command, exitCode: 0, timedOut: false, durationMs: 1, passed: true })),
    }).complete).toBe(true);
  });

  it("enforces per-class, unknown, total budgets and exponential backoff", () => {
    const state = { attempt: 0, classAttempts: {} } as any;
    const first = retryDecision(state, "test", { baseBackoffMs: 100, cooldownMs: 10, maxBackoffMs: 1_000, maxTotalAttempts: 3, classBudgets: { test: 2 } }, 0);
    expect(first).toMatchObject({ retry: true, delayMs: 110, nextTotal: 1, nextClass: 1 });

    expect(retryDecision({ attempt: 1, classAttempts: { unknown: 1 } } as any, "unknown", { maxUnknownAttempts: 1 }, 0)).toMatchObject({ retry: false, manual: true });
    expect(retryDecision({ attempt: 3, classAttempts: { test: 1 } } as any, "test", { maxTotalAttempts: 3 }, 0)).toMatchObject({ retry: false, manual: true });
    expect(retryDecision(state, "credential", {}, 0)).toMatchObject({ retry: false, manual: true });
    expect(retryDecision(state, "authority", {}, 0)).toMatchObject({ retry: false, manual: true });
  });

  it("prevents duplicate writers and only reclaims a stale dead owner", () => {
    const home = tempWorkspace();
    const cwd = tempWorkspace("rorca-supervisor-worktree-");
    const lockDir = path.join(home, "lock");
    const first = acquireWorkspaceLock({ lockDir, runId: "one", cwd, now: 1_000, staleMs: 100, pid: 101, pidAlive: () => true });
    expect(() => acquireWorkspaceLock({ lockDir, runId: "two", cwd, now: 2_000, staleMs: 100, pidAlive: () => true })).toThrow(/already owns/);
    first.release();

    const stale = acquireWorkspaceLock({ lockDir, runId: "stale", cwd, now: 1_000, staleMs: 100, pid: 202, pidAlive: () => false });
    stale.heartbeat(1_000, 202);
    const replacement = acquireWorkspaceLock({ lockDir, runId: "replacement", cwd, now: 2_000, staleMs: 100, pid: 303, pidAlive: () => false });
    expect(replacement.owner.runId).toBe("replacement");
    replacement.release();
  });

  it("recovers a stale malformed lock conservatively", () => {
    const home = tempWorkspace();
    const cwd = tempWorkspace("rorca-supervisor-malformed-lock-");
    const lockDir = path.join(home, "lock");
    mkdirSync(lockDir);
    writeFileSync(path.join(lockDir, "owner.json"), "{}\n");
    utimesSync(lockDir, new Date(1_000), new Date(1_000));
    const replacement = acquireWorkspaceLock({ lockDir, runId: "recovered", cwd, now: 2_000_000, staleMs: 100, pidAlive: () => false });
    expect(replacement.owner.runId).toBe("recovered");
    replacement.release();
  });

  it("uses a live companion lease to reject a second process with the same config token", () => {
    const prepared = createSupervisorRun({ home: tempWorkspace(), cwd: tempWorkspace("rorca-supervisor-lease-"), runId: "lease", task: "Implement", validationCommands: ["true"] });
    const first = claimCompanionLease({ lockDir: prepared.paths.lockDir, fenceToken: prepared.config.fenceToken, runId: "lease", pid: 111, pidAlive: (pid) => pid === 111 });
    expect(() => claimCompanionLease({ lockDir: prepared.paths.lockDir, fenceToken: prepared.config.fenceToken, runId: "lease", pid: 222, pidAlive: (pid) => pid === 111 })).toThrow(/live supervisor companion/);
    first.release();
    prepared.lock.release();
  });

  it("serializes controls and makes stop dominant", () => {
    const prepared = createSupervisorRun({ home: tempWorkspace(), cwd: tempWorkspace("rorca-supervisor-control-"), runId: "control", task: "Implement", validationCommands: ["true"] });
    const stop = writeControl(prepared.config, "stop", "stop now");
    const laterPause = writeControl(prepared.config, "pause", "too late");
    expect(stop.sequence).toBe(1);
    expect(laterPause).toMatchObject({ sequence: 2, action: "stop", reason: "stop now" });
    prepared.lock.release();
  });

  it("refuses stale takeover while persisted child or companion process evidence is live", () => {
    const prepared = createSupervisorRun({ home: tempWorkspace(), cwd: tempWorkspace("rorca-supervisor-residual-"), runId: "residual", task: "Implement", validationCommands: ["true"], now: 1_000, pid: 999_999 });
    atomicWriteJson(prepared.paths.statePath, { ...prepared.state, childPid: process.pid });
    expect(() => acquireWorkspaceLock({ lockDir: prepared.paths.lockDir, runId: "replacement", cwd: prepared.config.cwd, now: 2_000, staleMs: 100, pidAlive: (pid) => pid === process.pid })).toThrow(/residual-process-group/);
    prepared.lock.release();
  });

  it("fences state writes after lock ownership changes", () => {
    const home = tempWorkspace();
    const cwd = tempWorkspace("rorca-supervisor-fence-");
    const prepared = createSupervisorRun({
      home,
      cwd,
      runId: "fence",
      task: "Implement safely",
      validationCommands: ["true"],
      now: 1_000,
    });
    writeFileSync(prepared.config.paths.lockOwnerPath, JSON.stringify({ token: "different" }));
    expect(() => saveSupervisorState(prepared.config, prepared.state, "test", "must reject")).toThrow(/fence token mismatch/);
  });

  it("makes run ids immutable and rejects non-finite policy", () => {
    const home = tempWorkspace();
    const cwd = tempWorkspace("rorca-supervisor-run-id-");
    const first = createSupervisorRun({ home, cwd, runId: "immutable", task: "Implement", validationCommands: ["true"] });
    expect(() => createSupervisorRun({ home, cwd, runId: "immutable", task: "Overwrite", validationCommands: ["true"] })).toThrow(/immutable/);
    first.lock.release();
    expect(() => createSupervisorRun({ home, cwd, runId: "nan", task: "Implement", validationCommands: ["true"], policy: { maxTotalAttempts: Number.NaN } as any })).toThrow(/finite/);
  });

  it("rejects mutating validation commands", () => {
    const home = tempWorkspace();
    const cwd = tempWorkspace("rorca-supervisor-validation-policy-");
    expect(() => createSupervisorRun({
      home,
      cwd,
      task: "Implement",
      validationCommands: ["npm test && git push origin main"],
    })).toThrow(/Validation command rejected/);
  });

  it("rejects safety-critical Pi argument overrides", () => {
    expect(() => createSupervisorRun({ home: tempWorkspace(), cwd: tempWorkspace("rorca-supervisor-piargs-"), task: "Implement", validationCommands: ["true"], piArgs: ["--tools", "bash"] })).toThrow(/safety-critical/);
  });

  it("rejects summary-only models for implementation", () => {
    const home = tempWorkspace();
    const cwd = tempWorkspace("rorca-supervisor-model-");
    expect(() => createSupervisorRun({
      home,
      cwd,
      task: "Implement",
      validationCommands: ["true"],
      model: "openai-codex/gpt-5.6-terra",
    })).toThrow(/summary-only/);
  });

  it("creates a redacted pending-review checkpoint with exact provenance", () => {
    const home = tempWorkspace();
    const cwd = tempWorkspace("rorca-supervisor-checkpoint-");
    const prepared = createSupervisorRun({
      home,
      cwd,
      runId: "checkpoint",
      task: "Implement",
      validationCommands: ["npm test"],
      completionNonce: "fixed-nonce",
    });
    const state = {
      ...prepared.state,
      status: "completed",
      rpcSessionFile: "/tmp/session-abc.jsonl",
      lastEntryId: "entry-deadbeef",
      validationResults: [{ command: "npm test", exitCode: 0, timedOut: false, durationMs: 5, passed: true }],
      lastAssistantText: "Use Authorization: Bearer secret-token-123456789 and API_KEY=secret-value while preserving commit a6c0ac06811ae229885ce48ba6895c651c22e31f.",
    } as any;
    const checkpoint = createMemoryCheckpoint(prepared.config, state, {
      gitSha: "a6c0ac06811ae229885ce48ba6895c651c22e31f",
      relatedFiles: ["src/a.ts"],
    });
    const serialized = readFileSync(prepared.config.paths.checkpointPath, "utf8");
    expect(checkpoint).toMatchObject({ reviewStatus: "pending_review", approvalRequired: true, autoApproved: false });
    expect(serialized).not.toContain("secret-token-123456789");
    expect(serialized).not.toContain("secret-value");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("a6c0ac06811ae229885ce48ba6895c651c22e31f");
    expect(serialized).toContain("entry-deadbeef");
    prepared.lock.release();
  });
});
