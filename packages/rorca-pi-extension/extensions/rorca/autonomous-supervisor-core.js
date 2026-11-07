/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

export const SUPERVISOR_SCHEMA_VERSION = "rorca.hermes-pi-supervisor.v1";
export const DEFAULT_SUPERVISOR_MODEL = "openai-codex/gpt-5.6-sol";
export const DEFAULT_THINKING_LEVEL = "high";
export const SUMMARY_ONLY_MODELS = ["openai-codex/gpt-5.6-terra", "openai-codex/gpt-5.6-luna"];
export const TERMINAL_SUPERVISOR_STATUSES = new Set(["completed", "failed", "stopped"]);
export const RECOVERABLE_FAILURE_CLASSES = new Set(["transient", "test", "code", "unknown"]);

export const DEFAULT_SUPERVISOR_POLICY = Object.freeze({
  maxTotalAttempts: 8,
  maxRestarts: 3,
  maxCompanionRestarts: 2,
  maxUnknownAttempts: 1,
  classBudgets: Object.freeze({ transient: 4, test: 3, code: 3, unknown: 1 }),
  baseBackoffMs: 2_000,
  maxBackoffMs: 60_000,
  cooldownMs: 1_000,
  staleLockMs: 90_000,
  heartbeatMs: 2_000,
  controlPollMs: 500,
  validationTimeoutMs: 10 * 60_000,
  turnTimeoutMs: 30 * 60_000,
  outputLimitBytes: 32 * 1024,
  maxHistory: 40,
});

const FORBIDDEN_COMMAND_PATTERNS = [
  [/\bgit\b[^;&|\n]*\b(?:push|merge|rebase|worktree\s+(?:add|remove|move|prune)|reset\s+--hard|clean\s+-[a-z]*f|stash)\b/i, "remote/merge/worktree/destructive Git mutation"],
  [/\bgh\s+(?:pr\s+(?:merge|create|close|reopen|ready)|release\s+create)\b/i, "GitHub publication or merge mutation"],
  [/\b(?:kubectl\s+(?:apply|delete|rollout)|helm\s+(?:install|upgrade|uninstall)|terraform\s+(?:apply|destroy)|ansible-playbook|coolify)\b/i, "deployment or infrastructure mutation"],
  [/\b(?:npm|pnpm|yarn|bun)\s+(?:(?:run\s+)?deploy|publish)\b/i, "deployment or package publication"],
  [/\bcurl\b[^\n]*(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)\b/i, "network mutation without a governed client"],
  [/\b(?:psql|mysql|mongosh|redis-cli)\b/i, "direct database access"],
  [/\b(?:sudo|security\s+add-generic-password|gh\s+auth\s+login|npm\s+login)\b/i, "credential or privilege mutation"],
  [/(?:^|[;&|]\s*)(?:pi|codex|claude|opencode)(?:\s|$)/i, "sibling coding-agent launch"],
  [/\btmux\s+(?:new-session|split-window|new-window)\b/i, "sibling pane/writer launch"],
  [/\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i, "recursive forced deletion"],
  [/(?:^|[^&<>])&(?:[^&>]|$)|\b(?:nohup|setsid|disown|daemonize|start-stop-daemon)\b/i, "background or detached process escape"],
];

const SECRET_PATTERNS = [
  /(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi,
  /(bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi,
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*[:=]\s*)[^\s,"']+/gi,
  /\b(?:sk|ghp|github_pat|xox[baprs]|AIza)[-_A-Za-z0-9]{12,}\b/g,
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
];

function isoNow(now = Date.now()) {
  return new Date(now).toISOString();
}

export function stableHash(value, length = 64) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, length);
}

export function sanitizeRunId(value) {
  const clean = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return clean || `hermes-${Date.now()}-${randomBytes(3).toString("hex")}`;
}

export function canonicalWorkspacePath(cwd) {
  const resolved = path.resolve(cwd);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function supervisorHome(explicitHome) {
  return path.resolve(explicitHome || process.env.RORCA_PI_SUPERVISOR_HOME || path.join(os.homedir(), ".rorca", "pi-supervisor"));
}

export function supervisorPaths(homeInput, runId, cwd) {
  const home = supervisorHome(homeInput);
  const safeRunId = sanitizeRunId(runId);
  const workspace = canonicalWorkspacePath(cwd);
  const workspaceKey = stableHash(workspace, 24);
  const runDir = path.join(home, "runs", safeRunId);
  return {
    home,
    runId: safeRunId,
    workspace,
    workspaceKey,
    runDir,
    configPath: path.join(runDir, "config.json"),
    statePath: path.join(runDir, "progress.json"),
    progressMarkdownPath: path.join(runDir, "progress.md"),
    controlPath: path.join(runDir, "control.json"),
    eventLogPath: path.join(runDir, "events.jsonl"),
    checkpointPath: path.join(runDir, "memory-checkpoint.json"),
    checkpointMarkdownPath: path.join(runDir, "memory-checkpoint.md"),
    stdoutPath: path.join(runDir, "companion.stdout.log"),
    stderrPath: path.join(runDir, "companion.stderr.log"),
    lockDir: path.join(home, "locks", `${workspaceKey}.lock`),
    lockOwnerPath: path.join(home, "locks", `${workspaceKey}.lock`, "owner.json"),
    companionLeasePath: path.join(home, "locks", `${workspaceKey}.lock`, "companion.json"),
  };
}

export function unsafeCommandReason(command) {
  const value = String(command || "");
  for (const [pattern, reason] of FORBIDDEN_COMMAND_PATTERNS) {
    if (pattern.test(value)) return reason;
  }
  return undefined;
}

export function redactSecrets(value) {
  let result = String(value ?? "");
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (_match, prefix) => `${typeof prefix === "string" ? prefix : ""}[REDACTED]`);
  }
  return result;
}

export function boundedText(value, maxBytes = DEFAULT_SUPERVISOR_POLICY.outputLimitBytes, tail = true) {
  const redacted = redactSecrets(value);
  if (Buffer.byteLength(redacted, "utf8") <= maxBytes) return redacted;
  let result = tail ? redacted.slice(-maxBytes) : redacted.slice(0, maxBytes);
  while (Buffer.byteLength(result, "utf8") > maxBytes) result = tail ? result.slice(1) : result.slice(0, -1);
  return `${tail ? "[earlier output omitted]\n" : ""}${result}${tail ? "" : "\n[later output omitted]"}`;
}

export function atomicWriteJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tempPath, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    closeSync(fd);
  }
  renameSync(tempPath, filePath);
}

export function readJson(filePath, fallback) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && typeof error === "object" && error.code === "EPERM";
  }
}

function processGroupAliveForLock(pid, fallbackPidAlive) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    if (process.platform !== "win32") process.kill(-Number(pid), 0);
    else process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EPERM") return true;
    return fallbackPidAlive(Number(pid));
  }
}

export function acquireWorkspaceLock(input) {
  const now = input.now ?? Date.now();
  const staleMs = input.staleMs ?? DEFAULT_SUPERVISOR_POLICY.staleLockMs;
  const isPidAlive = input.pidAlive ?? pidAlive;
  const token = input.token || randomUUID();
  const owner = {
    schemaVersion: SUPERVISOR_SCHEMA_VERSION,
    token,
    runId: sanitizeRunId(input.runId),
    workspace: canonicalWorkspacePath(input.cwd),
    pid: input.pid ?? process.pid,
    createdAt: isoNow(now),
    heartbeatAt: isoNow(now),
  };
  mkdirSync(path.dirname(input.lockDir), { recursive: true });

  const create = () => {
    mkdirSync(input.lockDir);
    try {
      atomicWriteJson(path.join(input.lockDir, "owner.json"), owner);
    } catch (error) {
      rmSync(input.lockDir, { recursive: true, force: true });
      throw error;
    }
  };

  try {
    create();
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "EEXIST") throw error;
    const recoveryDir = `${input.lockDir}.recovery`;
    try { mkdirSync(recoveryDir); }
    catch {
      const recoveryAge = (() => { try { return now - statSync(recoveryDir).mtimeMs; } catch { return 0; } })();
      if (recoveryAge <= staleMs) throw new Error("Another controller is inspecting stale ownership; refusing concurrent lock recovery.");
      rmSync(recoveryDir, { recursive: true, force: true });
      try { mkdirSync(recoveryDir); } catch { throw new Error("Recovery mutex changed during stale cleanup; refusing concurrent lock recovery."); }
    }
    try {
      const ownerPath = path.join(input.lockDir, "owner.json");
      const parsed = readJson(ownerPath, null);
      const heartbeat = Date.parse(parsed?.heartbeatAt || parsed?.createdAt || "");
      const validExisting = Boolean(parsed && typeof parsed.token === "string" && parsed.token && Number.isInteger(Number(parsed.pid)) && Number.isFinite(heartbeat));
      const existing = validExisting ? parsed : null;
      const directoryAge = (() => { try { return now - statSync(input.lockDir).mtimeMs; } catch { return 0; } })();
      const stale = existing ? now - heartbeat > staleMs : directoryAge > staleMs;
      const alive = existing ? isPidAlive(Number(existing.pid)) : false;
      const priorState = existing?.runId ? readJson(path.join(path.dirname(path.dirname(input.lockDir)), "runs", sanitizeRunId(existing.runId), "progress.json"), null) : null;
      const residualWriter = [priorState?.childPid, priorState?.companionPid].some((pid) => processGroupAliveForLock(pid, isPidAlive));
      if (!stale || alive || residualWriter) {
        const detail = existing ? `run=${existing.runId} pid=${existing.pid} heartbeat=${existing.heartbeatAt}${residualWriter ? " residual-process-group=live" : ""}` : `${input.lockDir} (malformed, age=${Math.max(0, Math.floor(directoryAge))}ms)`;
        throw new Error(`A supervised writer already owns this worktree (${detail}). Stop it or wait for explicit stale-lock recovery.`);
      }

      const confirm = readJson(ownerPath, null);
      if (existing && (!confirm || confirm.token !== existing.token || confirm.heartbeatAt !== existing.heartbeatAt)) throw new Error("Workspace lock changed during stale-lock inspection; refusing recovery.");
      if (!existing && JSON.stringify(confirm) !== JSON.stringify(parsed)) throw new Error("Workspace lock changed during malformed-lock inspection; refusing recovery.");
      const quarantine = `${input.lockDir}.stale.${now}.${stableHash(existing?.token || "malformed", 8)}`;
      renameSync(input.lockDir, quarantine);
      const quarantined = readJson(path.join(quarantine, "owner.json"), null);
      if (JSON.stringify(quarantined) !== JSON.stringify(confirm)) {
        if (!existsSync(input.lockDir)) renameSync(quarantine, input.lockDir);
        throw new Error("Quarantined lock content did not match the inspected owner; refusing recovery.");
      }
      try {
        create();
      } catch (createError) {
        if (!existsSync(input.lockDir) && existsSync(quarantine)) renameSync(quarantine, input.lockDir);
        throw createError;
      }
      rmSync(quarantine, { recursive: true, force: true });
    } finally {
      rmSync(recoveryDir, { recursive: true, force: true });
    }
  }

  let released = false;
  return {
    token,
    owner,
    heartbeat(at = Date.now(), pid = owner.pid) {
      if (released) throw new Error("Cannot heartbeat a released workspace lock.");
      const current = readJson(path.join(input.lockDir, "owner.json"), null);
      if (!current || current.token !== token) throw new Error("Workspace lock fence token no longer matches.");
      owner.pid = pid;
      owner.heartbeatAt = isoNow(at);
      atomicWriteJson(path.join(input.lockDir, "owner.json"), owner);
    },
    release() {
      if (released) return;
      const current = readJson(path.join(input.lockDir, "owner.json"), null);
      if (!current || current.token !== token) throw new Error("Refusing to release a workspace lock owned by another fence token.");
      released = true;
      rmSync(input.lockDir, { recursive: true, force: true });
    },
  };
}

export function assertFence(lockDir, token) {
  const owner = readJson(path.join(lockDir, "owner.json"), null);
  if (!owner || owner.token !== token) throw new Error("Supervisor state write rejected: workspace fence token mismatch.");
  return owner;
}

export function claimCompanionLease(input) {
  assertFence(input.lockDir, input.fenceToken);
  const leasePath = path.join(input.lockDir, "companion.json");
  const token = randomUUID();
  const now = input.now ?? Date.now();
  const isPidAlive = input.pidAlive ?? pidAlive;
  const lease = {
    schemaVersion: SUPERVISOR_SCHEMA_VERSION,
    token,
    fenceToken: input.fenceToken,
    runId: sanitizeRunId(input.runId),
    pid: input.pid ?? process.pid,
    generation: Number(input.generation || 1),
    createdAt: isoNow(now),
    heartbeatAt: isoNow(now),
  };
  const create = () => {
    const fd = openSync(leasePath, "wx", 0o600);
    try { writeFileSync(fd, `${JSON.stringify(lease, null, 2)}\n`, "utf8"); } finally { closeSync(fd); }
  };
  try {
    create();
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "EEXIST") throw error;
    const existing = readJson(leasePath, null);
    if (!existing) throw new Error("Companion lease is malformed; refusing automatic takeover while the workspace fence is active.");
    if (existing.fenceToken !== input.fenceToken) throw new Error("Companion lease fence token does not match the workspace owner.");
    if (isPidAlive(Number(existing.pid))) throw new Error(`A live supervisor companion already owns this run (pid=${existing.pid}, generation=${existing.generation}).`);
    const confirm = readJson(leasePath, null);
    if (!confirm || confirm.token !== existing.token || confirm.pid !== existing.pid) throw new Error("Companion lease changed during dead-owner inspection; refusing takeover.");
    const quarantine = `${leasePath}.dead.${now}.${stableHash(existing.token, 8)}`;
    renameSync(leasePath, quarantine);
    try { create(); } catch (createError) {
      if (!existsSync(leasePath) && existsSync(quarantine)) renameSync(quarantine, leasePath);
      throw createError;
    }
    rmSync(quarantine, { force: true });
  }
  let released = false;
  return {
    token,
    lease,
    assert() {
      const current = readJson(leasePath, null);
      if (released || !current || current.token !== token || current.pid !== lease.pid) throw new Error("Supervisor companion lease no longer matches; refusing state mutation.");
      assertFence(input.lockDir, input.fenceToken);
      return current;
    },
    heartbeat(at = Date.now()) {
      this.assert();
      lease.heartbeatAt = isoNow(at);
      atomicWriteJson(leasePath, lease);
    },
    release() {
      if (released) return;
      this.assert();
      released = true;
      rmSync(leasePath, { force: true });
    },
  };
}

function mergePolicy(input = {}) {
  const policy = {
    ...DEFAULT_SUPERVISOR_POLICY,
    ...input,
    classBudgets: { ...DEFAULT_SUPERVISOR_POLICY.classBudgets, ...(input.classBudgets || {}) },
  };
  for (const key of ["maxTotalAttempts", "maxRestarts", "maxCompanionRestarts", "maxUnknownAttempts", "baseBackoffMs", "maxBackoffMs", "cooldownMs", "staleLockMs", "heartbeatMs", "controlPollMs", "validationTimeoutMs", "turnTimeoutMs", "outputLimitBytes", "maxHistory"]) {
    if (!Number.isFinite(policy[key]) || policy[key] < 0) throw new Error(`Supervisor policy ${key} must be a finite non-negative number.`);
    policy[key] = Math.floor(policy[key]);
  }
  for (const [key, value] of Object.entries(policy.classBudgets)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`Supervisor class budget ${key} must be a finite non-negative number.`);
    policy.classBudgets[key] = Math.floor(value);
  }
  if (policy.maxBackoffMs < policy.baseBackoffMs) throw new Error("Supervisor maxBackoffMs must be greater than or equal to baseBackoffMs.");
  return policy;
}

export function createSupervisorRun(input) {
  if (!String(input.task || "").trim()) throw new Error("A non-empty autonomous task is required.");
  const runId = sanitizeRunId(input.runId);
  const paths = supervisorPaths(input.home, runId, input.cwd);
  const homeRelative = path.relative(paths.workspace, paths.home);
  if (homeRelative === "" || (!homeRelative.startsWith("..") && !path.isAbsolute(homeRelative))) throw new Error("Supervisor state home must be outside the writable worktree.");
  const policy = mergePolicy(input.policy);
  const contractNonce = input.completionNonce || randomBytes(16).toString("hex");
  const validationCommands = [...new Set((input.validationCommands || []).map((item) => String(item).trim()).filter(Boolean))];
  if (validationCommands.length === 0) throw new Error("At least one machine-run validation command is required.");
  for (const command of validationCommands) {
    const unsafe = unsafeCommandReason(command);
    if (unsafe) throw new Error(`Validation command rejected (${unsafe}): ${command}`);
  }
  const model = input.model || DEFAULT_SUPERVISOR_MODEL;
  if (SUMMARY_ONLY_MODELS.includes(model)) throw new Error(`${model} is summary-only; autonomous implementation/review must use ${DEFAULT_SUPERVISOR_MODEL}.`);
  const piArgs = Array.isArray(input.piArgs) ? input.piArgs.map(String) : [];
  const safePiArgs = new Set(["--no-context-files", "--no-skills", "--no-prompt-templates"]);
  if (piArgs.some((arg) => !safePiArgs.has(arg))) throw new Error("Supervisor piArgs may contain only --no-context-files, --no-skills, or --no-prompt-templates; safety-critical mode/tools/extensions/session flags cannot be overridden.");
  const now = input.now ?? Date.now();
  mkdirSync(path.dirname(paths.runDir), { recursive: true });
  try {
    mkdirSync(paths.runDir);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EEXIST") throw new Error(`Supervisor run id ${runId} already exists; run evidence is immutable and cannot be overwritten.`);
    throw error;
  }
  let lock;
  try {
    lock = acquireWorkspaceLock({
      lockDir: paths.lockDir,
      runId,
      cwd: paths.workspace,
      staleMs: policy.staleLockMs,
      now,
      token: input.fenceToken,
      pid: input.pid,
      pidAlive: input.pidAlive,
    });
  } catch (error) {
    rmSync(paths.runDir, { recursive: true, force: true });
    throw error;
  }
  const completionMarker = `HERMES_SUPERVISOR_COMPLETION:${contractNonce}`;
  const config = {
    schemaVersion: SUPERVISOR_SCHEMA_VERSION,
    runId,
    task: String(input.task).trim(),
    cwd: paths.workspace,
    home: paths.home,
    lifecycle: input.lifecycle === "session" ? "session" : "detached",
    parentPid: input.lifecycle === "session" ? (input.pid ?? process.pid) : null,
    tmuxSession: input.tmuxSession,
    model,
    provider: input.provider,
    thinking: input.thinking || DEFAULT_THINKING_LEVEL,
    piCommand: input.piCommand || "pi",
    piArgs,
    policy,
    completionContract: {
      marker: completionMarker,
      nonceHash: stableHash(contractNonce),
      validationCommands,
      requireCleanWorktree: Boolean(input.requireCleanWorktree),
    },
    workspaceId: input.workspaceId,
    memoryCheckpoint: input.memoryCheckpoint || "file-pending-review",
    createdAt: isoNow(now),
    paths,
    fenceToken: lock.token,
  };
  const state = {
    schemaVersion: SUPERVISOR_SCHEMA_VERSION,
    runId,
    cwd: paths.workspace,
    status: "starting",
    lifecycle: config.lifecycle,
    model,
    thinking: config.thinking,
    contractHash: stableHash(JSON.stringify(config.completionContract)),
    fenceToken: lock.token,
    createdAt: isoNow(now),
    updatedAt: isoNow(now),
    heartbeatAt: isoNow(now),
    activity: null,
    attempt: 0,
    restartCount: 0,
    generation: 0,
    rpcReadyGeneration: 0,
    classAttempts: {},
    compactionCount: 0,
    lastEntryId: null,
    rpcSessionFile: null,
    childPid: null,
    companionPid: null,
    companionGeneration: 0,
    nextRetryAt: null,
    lastFailure: null,
    lastAssistantText: "",
    validationResults: [],
    history: [{ at: isoNow(now), event: "prepared", detail: `model=${model} thinking=${config.thinking}` }],
    memoryCheckpoint: null,
    manualTakeover: null,
    tmuxSession: config.tmuxSession || null,
  };
  try {
    atomicWriteJson(paths.configPath, config);
    atomicWriteJson(paths.statePath, state);
    atomicWriteJson(paths.controlPath, { schemaVersion: SUPERVISOR_SCHEMA_VERSION, action: "none", sequence: 0, at: isoNow(now) });
    writeProgressMarkdown(state, config);
    return { config, state, paths, lock };
  } catch (error) {
    try { lock.release(); } catch { /* preserve original preparation error */ }
    rmSync(paths.runDir, { recursive: true, force: true });
    throw error;
  }
}

export function loadSupervisorRun(home, runId) {
  const root = supervisorHome(home);
  const runDir = path.join(root, "runs", sanitizeRunId(runId));
  const config = readJson(path.join(runDir, "config.json"), null);
  const state = readJson(path.join(runDir, "progress.json"), null);
  if (!config || !state || config.schemaVersion !== SUPERVISOR_SCHEMA_VERSION || state.schemaVersion !== SUPERVISOR_SCHEMA_VERSION) {
    throw new Error(`Supervisor run ${runId} was not found or has an unsupported schema.`);
  }
  state.activity ??= null;
  return { config, state, paths: config.paths };
}

export function appendStateHistory(state, event, detail, now = Date.now(), max = DEFAULT_SUPERVISOR_POLICY.maxHistory) {
  return {
    ...state,
    updatedAt: isoNow(now),
    history: [...(state.history || []), { at: isoNow(now), event, detail: boundedText(detail, 2_000, false) }].slice(-max),
  };
}

export function saveSupervisorState(config, state, event, detail, now = Date.now()) {
  assertFence(config.paths.lockDir, config.fenceToken);
  const next = event ? appendStateHistory(state, event, detail, now, config.policy.maxHistory) : { ...state, updatedAt: isoNow(now) };
  atomicWriteJson(config.paths.statePath, next);
  writeProgressMarkdown(next, config);
  return next;
}

export function companionHeartbeat(config, state, now = Date.now()) {
  const owner = readJson(config.paths.lockOwnerPath, null);
  const lease = readJson(config.paths.companionLeasePath, null);
  const at = lease?.heartbeatAt;
  const timestamp = typeof at === "string" ? Date.parse(at) : NaN;
  if (owner?.token !== config.fenceToken || lease?.fenceToken !== config.fenceToken ||
      lease?.runId !== state.runId || lease?.pid !== state.companionPid ||
      lease?.generation !== state.companionGeneration || !Number.isFinite(timestamp)) {
    return { at: null, freshness: "unavailable" };
  }
  const ageMs = now - timestamp;
  return { at, freshness: ageMs >= 0 && ageMs <= config.policy.staleLockMs ? "fresh" : "stale" };
}

export function writeProgressMarkdown(state, config) {
  const validations = (state.validationResults || []).slice(-10).map((item) => `- ${item.passed ? "PASS" : "FAIL"} \`${item.command}\` (${item.durationMs}ms, exit=${item.exitCode ?? "null"}${item.timedOut ? ", timeout" : ""})`).join("\n") || "- Not run yet; independent checks await a settled assistant with the exact completion marker.";
  const history = (state.history || []).slice(-15).map((item) => `- ${item.at} **${item.event}** — ${item.detail}`).join("\n") || "- None";
  const failure = state.lastFailure ? `${state.lastFailure.classification}: ${state.lastFailure.summary}` : "None";
  const takeover = state.manualTakeover ? `${state.manualTakeover.reason} (smallest action: ${state.manualTakeover.requiredAction})` : "None";
  const heartbeat = companionHeartbeat(config, state);
  const activity = state.activity;
  const content = `# Hermes Pi Supervisor Progress\n\n` +
    `## Identity\n- Run: ${state.runId}\n- Worktree: ${state.cwd}\n- Model: ${state.model}\n- Thinking: ${state.thinking}\n- Contract hash: ${state.contractHash}\n\n` +
    `## Status\n- State: ${state.status}\n- Attempt: ${state.attempt}/${config.policy.maxTotalAttempts}\n- Restarts: ${state.restartCount}/${config.policy.maxRestarts}\n- Generation: ${state.generation}\n- Compactions: ${state.compactionCount}\n- Session: ${state.rpcSessionFile || "pending"}\n- Cursor: ${state.lastEntryId || "pending"}\n- Updated: ${state.updatedAt}\n\n` +
    `## Activity (metadata only; not validation evidence)\n- Last RPC activity: ${activity ? `${activity.at} (${activity.event})` : "not recorded"}\n- Active tool: ${activity?.activeTool || "none recorded"}\n- Companion heartbeat snapshot: ${heartbeat.at || "unavailable"} (${heartbeat.freshness}; not work activity)\n- Heartbeat freshness is recomputed by live status; this file is a checkpoint snapshot.\n- The cursor remains at the pre-prompt boundary until canonical settlement.\n\n` +
    `## Completion contract\n- Exact marker hash: ${config.completionContract.nonceHash}\n- Required validations: ${config.completionContract.validationCommands.length}\n- Process exit alone is never completion.\n\n` +
    `## Last failure\n${failure}\n\n## Manual takeover\n${takeover}\n\n` +
    `## Validation evidence\n${validations}\n\n## Recent history\n${history}\n`;
  mkdirSync(path.dirname(config.paths.progressMarkdownPath), { recursive: true });
  writeFileSync(config.paths.progressMarkdownPath, content, { encoding: "utf8", mode: 0o600 });
}

export function writeControl(config, action, reason = "operator request", now = Date.now()) {
  if (!["pause", "resume", "stop", "none"].includes(action)) throw new Error(`Unsupported supervisor control action: ${action}`);
  const lockDir = `${config.paths.controlPath}.lock`;
  const deadline = Date.now() + 2_000;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try { mkdirSync(lockDir); break; }
    catch (error) {
      if (!error || typeof error !== "object" || error.code !== "EEXIST") throw error;
      const age = (() => { try { return Date.now() - statSync(lockDir).mtimeMs; } catch { return 0; } })();
      if (age > 5_000) { try { rmSync(lockDir, { recursive: true }); } catch { /* another controller recovered it */ } continue; }
      if (Date.now() >= deadline) throw new Error("Timed out serializing supervisor control update.");
      Atomics.wait(sleeper, 0, 0, 10);
    }
  }
  try {
    const current = readJson(config.paths.controlPath, { sequence: 0, action: "none" });
    const effectiveAction = current.action === "stop" && action !== "stop" ? "stop" : action;
    const next = {
      schemaVersion: SUPERVISOR_SCHEMA_VERSION,
      action: effectiveAction,
      reason: boundedText(effectiveAction === action ? reason : current.reason || "prior stop request", 500, false),
      sequence: Number(current.sequence || 0) + 1,
      at: isoNow(now),
    };
    atomicWriteJson(config.paths.controlPath, next);
    return next;
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

export function classifyFailure(input) {
  const text = `${input?.kind || ""}\n${input?.message || ""}\n${input?.output || ""}`.toLowerCase();
  if (/credential|api key|api_key|access token|oauth|login required|not authenticated|authentication failed|\b401\b|invalid token|missing auth/.test(text)) return "credential";
  if (/approval|human confirmation|authority|permission denied|not authorized|forbidden|\b403\b|policy block|readiness blocker|requires operator|supervisor blocked|sandbox unavailable/.test(text)) return "authority";
  if (/\b429\b|rate.?limit|overloaded|temporar(?:y|ily)|econnreset|econnrefused|socket hang up|\b50[02349]\b|service unavailable|timed? out|timeout|process crash|connection reset/.test(text)) return "transient";
  if (/typecheck|type error|compile|build failed|lint failed|syntaxerror|referenceerror|cannot find module|ts\d{4}/.test(text)) return "code";
  if (/test(?:s| suite)? failed|failing test|assertion|expected .* received|vitest|jest|pytest|\bnot ok\b|validation failed/.test(text)) return "test";
  return "unknown";
}

export function computeBackoffMs(attempt, policyInput = {}) {
  const policy = mergePolicy(policyInput);
  const exponent = Math.max(0, Number(attempt || 1) - 1);
  return Math.min(policy.maxBackoffMs, policy.baseBackoffMs * (2 ** exponent)) + policy.cooldownMs;
}

export function retryDecision(state, classification, policyInput = {}, now = Date.now()) {
  const policy = mergePolicy(policyInput);
  const nextTotal = Number(state.attempt || 0) + 1;
  const priorClass = Number(state.classAttempts?.[classification] || 0);
  const nextClass = priorClass + 1;
  if (classification === "authority" || classification === "credential") {
    return { retry: false, manual: true, reason: `${classification} failures require operator action and are never automatically bypassed.` };
  }
  if (!RECOVERABLE_FAILURE_CLASSES.has(classification)) {
    return { retry: false, manual: true, reason: "Failure class is not recoverable." };
  }
  if (nextTotal > policy.maxTotalAttempts) {
    return { retry: false, manual: true, reason: `Total retry budget exhausted (${state.attempt}/${policy.maxTotalAttempts}).` };
  }
  const classBudget = classification === "unknown" ? policy.maxUnknownAttempts : Number(policy.classBudgets[classification] ?? 0);
  if (nextClass > classBudget) {
    return { retry: false, manual: true, reason: `${classification} retry budget exhausted (${priorClass}/${classBudget}).` };
  }
  const delayMs = computeBackoffMs(nextClass, policy);
  return { retry: true, manual: false, delayMs, nextRetryAt: isoNow(now + delayMs), nextTotal, nextClass };
}

function exactMarkerPresent(text, marker) {
  return String(text || "").split(/\r?\n/).some((line) => line.trim() === marker);
}

export function evaluateCompletion(input) {
  const markerPresent = exactMarkerPresent(input.assistantText, input.contract.marker);
  const validations = input.validationResults || [];
  const expected = input.contract.validationCommands || [];
  const validationMap = new Map(validations.map((item) => [item.command, item]));
  const missing = expected.filter((command) => !validationMap.has(command));
  const failed = expected.filter((command) => {
    const result = validationMap.get(command);
    return result && (!result.passed || result.exitCode !== 0 || result.timedOut);
  });
  const cleanSatisfied = !input.contract.requireCleanWorktree || input.worktreeClean === true;
  const complete = markerPresent && missing.length === 0 && failed.length === 0 && cleanSatisfied;
  return {
    complete,
    markerPresent,
    missingValidations: missing,
    failedValidations: failed,
    cleanSatisfied,
    reason: complete
      ? "Exact completion marker and all independent validations passed."
      : !markerPresent
        ? "Exact completion marker is absent."
        : failed.length > 0
          ? `Validation failed: ${failed.join(", ")}.`
          : missing.length > 0
            ? `Validation evidence missing: ${missing.join(", ")}.`
            : "Worktree cleanliness requirement is not satisfied.",
  };
}

export function buildInitialPrompt(config) {
  return [
    "You are the implementation worker inside the Hermes Pi autonomous supervisor precursor.",
    `Use ${DEFAULT_SUPERVISOR_MODEL} with high reasoning for implementation and review. Terra/Luna are allowed only for compaction/checkpoint summaries and must preserve exact IDs and SHAs.`,
    "Operate continuously but bounded: plan -> implement one focused batch -> validate -> self-review -> repair.",
    `Reload the compact progress record before each major step: ${config.paths.progressMarkdownPath}`,
    "You are the sole source writer in this worktree. Never launch another writer or mutate another worktree.",
    "Never push, merge, deploy, fabricate evidence, bypass approval/authority/credentials, or treat process exit as completion.",
    "Use supervised_bash (never unrestricted bash) for local commands; it is OS-sandboxed with network disabled and writes confined to this worktree.",
    "If authority or credentials block work, report the exact blocker and smallest required operator action; do not retry it.",
    "Completion requires the supervisor's independent validation commands to pass.",
    `Only after the task is fully implemented and self-reviewed, emit this exact marker on its own line: ${config.completionContract.marker}`,
    "Do not emit the marker speculatively or from a failing command.",
    "",
    "Task:",
    config.task,
    "",
    "Independent validation commands:",
    ...config.completionContract.validationCommands.map((command) => `- ${command}`),
  ].join("\n");
}

export function buildRepairPrompt(config, state, failure, validationResults = []) {
  const validationSummary = validationResults.map((item) => `${item.passed ? "PASS" : "FAIL"} ${item.command}: ${boundedText(item.output || item.stderr || "", 2_000)}`).join("\n");
  return [
    "Continue the bounded Hermes supervisor loop. Do not restart the task from scratch.",
    `Reload progress first: ${config.paths.progressMarkdownPath}`,
    `Failure classification: ${failure.classification}`,
    `Failure summary: ${failure.summary}`,
    `Attempt: ${state.attempt}/${config.policy.maxTotalAttempts}`,
    validationSummary ? `Controller validation evidence:\n${validationSummary}` : "No independent validation output was produced in this cycle.",
    "Diagnose the root cause, make the smallest safe repair, rerun relevant checks, and self-review for races, leaks, false completion, and security.",
    `Emit ${config.completionContract.marker} on its own line only when the complete task and all required validations are truly ready.`,
    "Authority/credential blockers must be reported, never bypassed.",
  ].join("\n\n");
}

export function assistantTextFromMessage(message) {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content.filter((item) => item?.type === "text" && typeof item.text === "string").map((item) => item.text).join("\n");
}

export function createMemoryCheckpoint(config, state, input = {}, now = Date.now()) {
  const gitSha = String(input.gitSha || "unknown");
  const summarySource = String(input.summary || state.lastAssistantText || "Autonomous implementation completed with independent validation evidence.")
    .split(/\r?\n/)
    .filter((line) => line.trim() && line.trim() !== config.completionContract.marker)
    .slice(0, 12)
    .join(" ");
  const relatedFiles = [...new Set((input.relatedFiles || state.modifiedFiles || []).map(String).filter(Boolean))].slice(0, 50);
  const worktreeHash = String(input.worktreeHash || "unknown");
  const validationEvidence = (input.validationResults || state.validationResults || []).map((result) => ({
    command: String(result.command),
    passed: Boolean(result.passed),
    exitCode: result.exitCode ?? null,
    timedOut: Boolean(result.timedOut),
    cancelled: Boolean(result.cancelled),
    durationMs: Number(result.durationMs || 0),
    at: result.at || null,
    outputHash: stableHash(result.output || ""),
    stderrHash: stableHash(result.stderr || ""),
  }));
  const checkpoint = {
    schemaVersion: SUPERVISOR_SCHEMA_VERSION,
    artifact: "rorca.memory-candidate-checkpoint",
    reviewStatus: "pending_review",
    approvalRequired: true,
    autoApproved: false,
    workspaceId: config.workspaceId || null,
    category: input.category || "Pattern",
    title: redactSecrets(input.title || `Hermes supervised implementation checkpoint: ${config.runId}`).slice(0, 160),
    rule: boundedText(summarySource || "See validation and provenance evidence for this supervised run.", 2_500, false),
    context: boundedText(`Generated only after exact completion contract verification. Contract=${state.contractHash}; validations=${(state.validationResults || []).filter((item) => item.passed).length}/${config.completionContract.validationCommands.length}. Human review is required before promotion.`, 2_000, false),
    relatedFiles,
    confidence: "high",
    trustTier: "agent_observation",
    sourceSystem: "rorca-pi-hermes-supervisor",
    sourceRef: `run:${config.runId}@${gitSha}`,
    idempotencyKey: `hermes-supervisor:${stableHash(`${config.runId}:${gitSha}:${worktreeHash}:${state.contractHash}:${state.completionEntryId || state.lastEntryId}`, 40)}`,
    provenance: {
      runId: config.runId,
      gitSha,
      worktreeHash,
      contractHash: state.contractHash,
      model: state.model,
      thinking: state.thinking,
      sessionFile: state.rpcSessionFile,
      lastEntryId: state.lastEntryId,
      completionEntryId: state.completionEntryId || state.lastEntryId,
      completedAt: isoNow(now),
      validationCommands: config.completionContract.validationCommands,
      validationEvidence,
    },
  };
  atomicWriteJson(config.paths.checkpointPath, checkpoint);
  writeFileSync(config.paths.checkpointMarkdownPath, `# Pending Rorca Memory Checkpoint\n\n- Status: pending human review\n- Run: ${checkpoint.provenance.runId}\n- Git SHA: ${checkpoint.provenance.gitSha}\n- Contract: ${checkpoint.provenance.contractHash}\n- Source: ${checkpoint.sourceRef}\n\n## Title\n${checkpoint.title}\n\n## Rule\n${checkpoint.rule}\n\n## Context\n${checkpoint.context}\n`, { encoding: "utf8", mode: 0o600 });
  return checkpoint;
}

export function safeFileStat(filePath) {
  try {
    const stat = statSync(filePath);
    return { exists: true, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return { exists: false, size: 0, mtimeMs: 0 };
  }
}
