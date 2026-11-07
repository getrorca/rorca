/* Copyright (c) 2026 Rorca Inc. SPDX-License-Identifier: Apache-2.0 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSandboxedShellInvocation, detectSupervisorSandbox } from "../autonomous-supervisor-sandbox.js";

const sandbox = detectSupervisorSandbox();

describe("Hermes supervisor bubblewrap invocation", () => {
  it("uses rootless isolation and delegates PID isolation only to an outer container", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "rorca-supervisor-bwrap-cwd-"));
    const hostArgs = buildSandboxedShellInvocation("true", {
      cwd,
      tempDir: path.join(cwd, ".tmp"),
      sandbox: { kind: "bwrap", command: "/usr/bin/bwrap" },
      containerized: false,
    }).args;
    const containerArgs = buildSandboxedShellInvocation("true", {
      cwd,
      tempDir: path.join(cwd, ".tmp"),
      sandbox: { kind: "bwrap", command: "/usr/bin/bwrap" },
      containerized: true,
    }).args;
    expect(hostArgs).toEqual(expect.arrayContaining(["--unshare-user", "--uid", "0", "--gid", "0", "--unshare-net", "--unshare-pid"]));
    expect(hostArgs.indexOf("--unshare-user")).toBeLessThan(hostArgs.indexOf("--unshare-net"));
    expect(containerArgs).toEqual(expect.arrayContaining(["--unshare-user", "--uid", "0", "--gid", "0", "--unshare-net"]));
    expect(containerArgs).not.toContain("--unshare-pid");
  });
});

describe.skipIf(!sandbox)("Hermes supervisor OS sandbox", () => {
  it("permits worktree writes but denies network and out-of-worktree writes", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "rorca-supervisor-sandbox-cwd-"));
    const outside = path.join(tmpdir(), `rorca-supervisor-sandbox-forbidden-${process.pid}`);
    const invocation = buildSandboxedShellInvocation(`printf ok > local.txt; printf forbidden > ${JSON.stringify(outside)}; curl -fsS --max-time 2 https://example.com`, {
      cwd,
      tempDir: path.join(cwd, ".tmp"),
      sandbox: sandbox!,
    });
    const result = spawnSync(invocation.command, invocation.args, { cwd: invocation.cwd, encoding: "utf8", timeout: 10_000 });
    expect(existsSync(path.join(cwd, "local.txt")), result.stderr).toBe(true);
    expect(readFileSync(path.join(cwd, "local.txt"), "utf8")).toBe("ok");
    expect(existsSync(outside)).toBe(false);
    expect(result.status).not.toBe(0);
  });
});
