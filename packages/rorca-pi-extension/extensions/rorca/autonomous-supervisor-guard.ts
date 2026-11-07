/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { boundedText, unsafeCommandReason } from "./autonomous-supervisor-core.js";
import { buildSandboxedShellInvocation } from "./autonomous-supervisor-sandbox.js";

function canonical(value: string): string {
  const resolved = path.resolve(value);
  if (existsSync(resolved)) return realpathSync(resolved);
  const suffix: string[] = [];
  let ancestor = resolved;
  while (!existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return resolved;
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  return path.join(realpathSync(ancestor), ...suffix);
}

async function runSandboxedTool(command: string, cwd: string, signal: AbortSignal, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; sandbox: string }> {
  const invocation = buildSandboxedShellInvocation(command, { cwd, tempDir: path.join(cwd, ".rorca-supervisor-tmp") });
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, { cwd: invocation.cwd, env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: invocation.tempDir, TMPDIR: invocation.tempDir, CI: process.env.CI || "1", TERM: process.env.TERM || "dumb", LANG: process.env.LANG || "C" }, stdio: ["ignore", "pipe", "pipe"], detached: false });
    let stdout = "";
    let stderr = "";
    let finished = false;
    child.stdout.on("data", (chunk) => { stdout = boundedText(stdout + chunk.toString(), 32 * 1024); });
    child.stderr.on("data", (chunk) => { stderr = boundedText(stderr + chunk.toString(), 32 * 1024); });
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const kill = () => {
      try { child.kill("SIGTERM"); } catch { /* already dead */ }
      if (!escalation) { escalation = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already dead */ } }, 1_500); escalation.unref?.(); }
    };
    const onAbort = () => kill();
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(kill, timeoutMs);
    child.once("error", (error) => { if (!finished) { finished = true; clearTimeout(timer); if (escalation) clearTimeout(escalation); signal.removeEventListener("abort", onAbort); reject(error); } });
    child.once("exit", (code) => { if (!finished) { finished = true; clearTimeout(timer); if (escalation) clearTimeout(escalation); signal.removeEventListener("abort", onAbort); resolve({ code, stdout, stderr, sandbox: invocation.sandbox }); } });
  });
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function supervisorGuardReason(toolName: string, input: Record<string, unknown>, cwd: string): string | undefined {
  if (toolName === "bash" || toolName === "supervised_bash") {
    const command = String(input.command || "");
    const unsafe = unsafeCommandReason(command);
    if (unsafe) return `Hermes supervisor blocked command: ${unsafe}.`;
  }

  if (["read", "write", "edit", "grep", "find", "ls"].includes(toolName)) {
    const rawPath = typeof input.path === "string" ? input.path.replace(/^@/, "") : "";
    if (!rawPath) return undefined;
    const root = canonical(cwd);
    const target = canonical(path.isAbsolute(rawPath) ? rawPath : path.resolve(root, rawPath));
    const progressPath = process.env.RORCA_PI_SUPERVISOR_PROGRESS ? canonical(process.env.RORCA_PI_SUPERVISOR_PROGRESS) : undefined;
    if (toolName === "read" && progressPath && target === progressPath) return undefined;
    if (!within(root, target)) return `Hermes supervisor blocked ${toolName} outside the fenced worktree: ${rawPath}`;
  }

  return undefined;
}

export default function hermesAutonomousSupervisorGuard(pi: ExtensionAPI): void {
  // Incremental implementation turns must not reserve a model's entire output
  // window (some providers charge admission against that reservation).
  pi.on("before_provider_request", (event) => {
    if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return;
    const payload = event.payload as Record<string, unknown>;
    let bounded: Record<string, unknown> | undefined;
    for (const key of ["max_tokens", "max_output_tokens", "max_completion_tokens"]) {
      if (typeof payload[key] === "number" && payload[key] > 32_768) {
        bounded ??= { ...payload };
        bounded[key] = 32_768;
      }
    }
    return bounded;
  });

  pi.registerTool({
    name: "supervised_bash",
    label: "Sandboxed Bash",
    description: "Run a local shell command with network disabled, writes confined to the fenced worktree/temp directory, and common credential paths unreadable. Unsandboxed execution fails closed.",
    parameters: Type.Object({
      command: Type.String({ description: "Local command to execute inside the supervisor OS sandbox." }),
      timeoutMs: Type.Optional(Type.Number({ minimum: 1_000, maximum: 600_000 })),
    }),
    async execute(_id: string, input: { command: string; timeoutMs?: number }, signal: AbortSignal, _onUpdate: unknown, ctx: ExtensionContext) {
      const unsafe = unsafeCommandReason(input.command);
      if (unsafe) throw new Error(`Hermes supervisor blocked command: ${unsafe}.`);
      const result = await runSandboxedTool(input.command, ctx.cwd || process.cwd(), signal, input.timeoutMs || 120_000);
      const text = boundedText([result.stdout, result.stderr].filter(Boolean).join("\n"), 32 * 1024);
      if (result.code !== 0) throw new Error(text || `Sandboxed command exited ${result.code}.`);
      return {
        content: [{ type: "text", text: text || `(exit ${result.code})` }],
        details: { exitCode: result.code, sandbox: result.sandbox },
      };
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    const input = event.input && typeof event.input === "object" ? event.input as Record<string, unknown> : {};
    const reason = supervisorGuardReason(event.toolName, input, ctx.cwd || process.cwd());
    if (reason) return { block: true, reason };
  });
}
