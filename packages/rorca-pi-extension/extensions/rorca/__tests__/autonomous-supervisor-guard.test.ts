/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import hermesAutonomousSupervisorGuard, { supervisorGuardReason } from "../autonomous-supervisor-guard.js";

describe("Hermes autonomous child guard", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "rorca-supervisor-guard-"));

  it.each([
    "git push origin feature",
    "git merge main",
    "gh pr merge 42",
    "npm run deploy",
    "kubectl apply -f production.yml",
    "psql postgres://prod -c 'delete from runs'",
    "sudo security add-generic-password",
    "pi 'launch a sibling writer'",
    "tmux new-session -d pi",
    "git reset --hard HEAD~1",
    "git -C . reset --hard HEAD~1",
    "curl -X POST https://example.invalid/deploy",
    "rm -rf dist",
    "nohup npm test &",
    "setsid node worker.js",
    "npm test 2>&1 &",
    "npm test 2>&1&",
    "npm test &>test.log &",
    "npm test <&0 & echo detached",
  ])("blocks forbidden shell authority: %s", (command) => {
    expect(supervisorGuardReason("bash", { command }, cwd)).toMatch(/blocked/i);
  });

  it("allows ordinary local implementation and validation commands", () => {
    expect(supervisorGuardReason("bash", { command: "npm test && npm run typecheck" }, cwd)).toBeUndefined();
    expect(supervisorGuardReason("bash", { command: "git status --short && git diff --check" }, cwd)).toBeUndefined();
  });

  it.each([
    "npm run typecheck 2>&1",
    "npm run typecheck 2>&1 | head -80",
    "node check.js >&2",
    "node check.js <&0",
    "npm test &>test.log",
    "npm test &>>test.log",
  ])("allows foreground descriptor redirection without treating it as detachment: %s", (command) => {
    expect(supervisorGuardReason("supervised_bash", { command }, cwd)).toBeUndefined();
  });

  it("allows only the controller-designated progress file as an external read", () => {
    const progress = path.join(path.dirname(cwd), "progress.md");
    process.env.RORCA_PI_SUPERVISOR_PROGRESS = progress;
    expect(supervisorGuardReason("read", { path: progress }, cwd)).toBeUndefined();
    expect(supervisorGuardReason("read", { path: `${progress}.other` }, cwd)).toMatch(/outside/);
    delete process.env.RORCA_PI_SUPERVISOR_PROGRESS;
  });

  it("blocks write/edit outside the fenced worktree, including nonexistent paths below symlinks", () => {
    const outside = mkdtempSync(path.join(tmpdir(), "rorca-supervisor-guard-outside-"));
    symlinkSync(outside, path.join(cwd, "escape"));
    expect(supervisorGuardReason("read", { path: path.join(path.dirname(cwd), "secret.txt") }, cwd)).toMatch(/outside/);
    expect(supervisorGuardReason("write", { path: path.join(path.dirname(cwd), "other-worktree", "file.ts") }, cwd)).toMatch(/outside/);
    expect(supervisorGuardReason("write", { path: "escape/new-file.ts" }, cwd)).toMatch(/outside/);
    expect(supervisorGuardReason("edit", { path: "src/local.ts" }, cwd)).toBeUndefined();
  });

  it.each(["max_tokens", "max_output_tokens", "max_completion_tokens"])("bounds %s reservations without changing the request or widening smaller limits", (key) => {
    const handlers = new Map<string, (event: { payload: unknown }) => unknown>();
    hermesAutonomousSupervisorGuard({
      registerTool: vi.fn(),
      on: (name: string, handler: (event: { payload: unknown }) => unknown) => handlers.set(name, handler),
    } as unknown as ExtensionAPI);
    const bound = handlers.get("before_provider_request")!;
    const original = Object.freeze({ [key]: 128_000, model: "configured-model", messages: [] });
    expect(bound({ payload: original })).toEqual({ ...original, [key]: 32_768 });
    expect(original[key]).toBe(128_000);
    expect(bound({ payload: { [key]: 8_192 } })).toBeUndefined();
    expect(bound({ payload: { model: "configured-model" } })).toBeUndefined();
  });
});
