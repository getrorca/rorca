/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { accessSync, constants, existsSync, mkdirSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

function executableOnPath(name, envPath = process.env.PATH || "") {
  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* keep looking */ }
  }
  return undefined;
}

/** True only when bubblewrap can actually create a user namespace on this
 * host. Some container/kernel configurations install bwrap but deny unshare;
 * detecting only the binary would make every sandboxed validation fail at
 * spawn instead of failing closed with the unsandboxed-is-disabled error. */
function bwrapCanUnshare(bwrap) {
  try {
    const probe = spawnSync(bwrap, ["--unshare-user", "--uid", "0", "--gid", "0", "--unshare-net", "--", "/bin/true"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: "ignore",
    });
    return probe.status === 0;
  } catch {
    return false;
  }
}

export function detectSupervisorSandbox() {
  if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) return { kind: "sandbox-exec", command: "/usr/bin/sandbox-exec" };
  const bwrap = executableOnPath("bwrap");
  if (bwrap && bwrapCanUnshare(bwrap)) return { kind: "bwrap", command: bwrap };
  return null;
}

function seatbeltQuote(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function macProfile(cwd, tempDir) {
  const home = os.homedir();
  const sensitive = [
    ".ssh", ".aws", ".azure", ".kube", ".docker", ".config/gh", ".config/gcloud",
    ".git-credentials", ".npmrc", "Library/Keychains",
  ].map((item) => path.join(home, item)).filter((item) => !item.startsWith(`${cwd}${path.sep}`));
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-exec process-fork)",
    "(allow file-read*)",
    ...sensitive.map((item) => `(deny file-read* (subpath \"${seatbeltQuote(item)}\"))`),
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    `(allow file-write* (subpath \"${seatbeltQuote(cwd)}\"))`,
    `(allow file-write* (subpath \"${seatbeltQuote(tempDir)}\"))`,
    "(allow file-write* (literal \"/dev/null\"))",
    "(deny network*)",
  ].join("\n");
}

export function buildSandboxedShellInvocation(command, input) {
  const cwd = realpathSync(path.resolve(input.cwd));
  const requestedTemp = path.resolve(input.tempDir || path.join(os.tmpdir(), "rorca-pi-supervisor-sandbox"));
  mkdirSync(requestedTemp, { recursive: true, mode: 0o700 });
  const tempDir = realpathSync(requestedTemp);
  const sandbox = input.sandbox || detectSupervisorSandbox();
  if (!sandbox) throw new Error("Hermes supervisor sandbox unavailable: install bubblewrap (Linux) or use macOS sandbox-exec. Unsandboxed bash/validation is disabled.");

  if (sandbox.kind === "sandbox-exec") {
    return {
      command: sandbox.command,
      args: ["-p", macProfile(cwd, tempDir), "/bin/sh", "-c", command],
      cwd,
      tempDir,
      sandbox: sandbox.kind,
    };
  }

  const bindRoots = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", path.dirname(process.execPath)]
    .filter((root, index, values) => existsSync(root) && values.indexOf(root) === index);
  const containerized = input.containerized ?? (existsSync("/.dockerenv") || existsSync("/run/.containerenv"));
  const args = ["--die-with-parent", "--unshare-user", "--uid", "0", "--gid", "0", "--unshare-net"];
  // The outer container already owns a PID namespace and Docker masks the nested /proc mount.
  if (!containerized) args.push("--unshare-pid");
  args.push("--unshare-uts", "--new-session", "--proc", "/proc", "--dev", "/dev");
  for (const root of bindRoots) args.push("--ro-bind", root, root);
  args.push("--bind", cwd, cwd, "--bind", tempDir, tempDir, "--chdir", cwd, "/bin/sh", "-c", command);
  return { command: sandbox.command, args, cwd, tempDir, sandbox: sandbox.kind };
}
