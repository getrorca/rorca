#!/usr/bin/env node
/* Copyright (c) 2026 Rorca Inc. SPDX-License-Identifier: Apache-2.0 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteJson, pidAlive, readJson, redactSecrets, saveSupervisorState, SUPERVISOR_SCHEMA_VERSION, TERMINAL_SUPERVISOR_STATUSES } from "./autonomous-supervisor-core.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function groupAlive(pid) {
  if (!pid) return false;
  try { if (process.platform !== "win32") process.kill(-pid, 0); else process.kill(pid, 0); return true; }
  catch (error) { return Boolean(error && typeof error === "object" && error.code === "EPERM"); }
}

async function terminateGroup(pid) {
  if (!pid) return true;
  try { if (process.platform !== "win32") process.kill(-pid, "SIGTERM"); else process.kill(pid, "SIGTERM"); } catch { /* dead */ }
  for (let attempt = 0; attempt < 20 && groupAlive(pid); attempt++) await sleep(100);
  if (groupAlive(pid)) { try { if (process.platform !== "win32") process.kill(-pid, "SIGKILL"); else process.kill(pid, "SIGKILL"); } catch { /* dead */ } }
  for (let attempt = 0; attempt < 20 && groupAlive(pid); attempt++) await sleep(100);
  return !groupAlive(pid);
}

function parseArgs(argv) {
  const index = argv.findIndex((value) => value === "--config" || value.startsWith("--config="));
  if (index < 0) return undefined;
  return argv[index].includes("=") ? argv[index].slice(argv[index].indexOf("=") + 1) : argv[index + 1];
}

export async function launchPersistentCompanion(configPath, options = {}) {
  const absoluteConfig = path.resolve(configPath);
  const config = readJson(absoluteConfig, null);
  if (!config || config.schemaVersion !== SUPERVISOR_SCHEMA_VERSION) throw new Error("Unsupported or missing supervisor config.");
  const companionPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "autonomous-supervisor-companion.js");
  const spawnImpl = options.spawn || spawn;
  const maxRestarts = Number(config.policy.maxCompanionRestarts ?? 2);
  let child = null;
  let stopping = false;
  const forward = (signal) => {
    stopping = true;
    try { child?.kill(signal); } catch { /* already dead */ }
  };
  const onTerm = () => forward("SIGTERM");
  const onInt = () => forward("SIGINT");
  const onHup = () => forward("SIGTERM");
  const parentTimer = config.lifecycle === "session" && config.parentPid
    ? setInterval(() => { if (!pidAlive(config.parentPid)) forward("SIGTERM"); }, 500)
    : null;
  parentTimer?.unref?.();
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  process.on("SIGHUP", onHup);
  try {
    for (let restart = 0; restart <= maxRestarts; restart++) {
      atomicWriteJson(path.join(config.paths.runDir, "launcher.json"), { schemaVersion: SUPERVISOR_SCHEMA_VERSION, pid: process.pid, restart, maxRestarts, at: new Date().toISOString() });
      const result = await new Promise((resolve, reject) => {
        child = spawnImpl(process.execPath, [companionPath, "--config", absoluteConfig], { cwd: config.cwd, env: { ...process.env }, stdio: "inherit", detached: process.platform !== "win32" });
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      child = null;
      const state = readJson(config.paths.statePath, null);
      if (stopping || TERMINAL_SUPERVISOR_STATUSES.has(state?.status)) return state?.status === "completed" || state?.status === "stopped" ? 0 : 1;
      if (restart >= maxRestarts) {
        const childDead = await terminateGroup(Number(state?.childPid || 0));
        const companionDead = await terminateGroup(Number(state?.companionPid || 0));
        const failure = { schemaVersion: SUPERVISOR_SCHEMA_VERSION, pid: process.pid, restart, result, at: new Date().toISOString(), childDead, companionDead, action: "Explicit operator stop/recovery required; fence retained." };
        atomicWriteJson(path.join(config.paths.runDir, "launcher-failure.json"), failure);
        if (state && childDead && companionDead) {
          saveSupervisorState(config, { ...state, status: "failed", childPid: null, companionPid: null, nextRetryAt: null, manualTakeover: { classification: "transient", reason: "Outer companion restart budget exhausted.", requiredAction: "Inspect launcher/runtime evidence, then explicitly stop and start a newly scoped run." } }, "launcher_failed", `companion restarts exhausted ${restart}/${maxRestarts}`);
        }
        return 1;
      }
      await (options.sleep || sleep)(Math.min(5_000, 500 * (2 ** restart)));
    }
    return 1;
  } finally {
    if (parentTimer) clearInterval(parentTimer);
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
    process.off("SIGHUP", onHup);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const configPath = parseArgs(argv);
  if (!configPath) throw new Error("Usage: rorca-pi-supervisor --config <absolute-config.json>");
  return launchPersistentCompanion(configPath);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main().then((code) => { process.exitCode = code; }).catch((error) => {
  process.stderr.write(`Hermes Pi supervisor launcher failed: ${redactSecrets(error instanceof Error ? error.stack || error.message : String(error))}\n`);
  process.exitCode = 1;
});
