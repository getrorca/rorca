import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { inspectMcpToken, readMcpToken } from "../api.js";
import { resolveCaptureConfig } from "../config.js";
import {
  readCaptureQueue,
  enqueueCaptureQueueEntry,
  mutateCaptureQueueAtomic,
} from "../queue.js";
import {
  readCaptureDaemonStatus,
  stopCaptureDaemon,
  writeCaptureDaemonStatus,
  type CaptureDaemonStatusFile,
} from "../daemon.js";
import { setupAlwaysOnCapture, teardownAlwaysOnCapture } from "../always-on.js";
import { runCli } from "../cli.js";

function tempRoot(name: string): string {
  return mkdtempSync(path.join(tmpdir(), `${name}-`));
}

function config(repo: string) {
  return resolveCaptureConfig({ cwd: repo, gitRoot: repo, overrides: { repoPath: repo, queuePath: path.join(repo, ".rorca-capture-queue.jsonl") } });
}

function queueInput(id: string) {
  return { operation: "context-event" as const, endpoint: "/api/context-events", payload: { id }, eventType: "test", contentFingerprint: id };
}

describe("capture shared-host security hardening", () => {
  it("uses randomized exclusive queue temp files and leaves a planted predictable symlink untouched", () => {
    const repo = tempRoot("rorca-secure-queue");
    const queuePath = path.join(repo, ".rorca-capture-queue.jsonl");
    const victim = path.join(repo, "victim.txt");
    writeFileSync(victim, "unchanged\n", "utf8");
    symlinkSync(victim, `${queuePath}.tmp`);

    enqueueCaptureQueueEntry(queuePath, config(repo), queueInput("one"));

    expect(readFileSync(victim, "utf8")).toBe("unchanged\n");
    expect(readCaptureQueue(queuePath)).toHaveLength(1);
  });

  it("preserves entries added after a flush snapshot through a locked key mutation", () => {
    const repo = tempRoot("rorca-queue-integrity");
    const queuePath = path.join(repo, ".rorca-capture-queue.jsonl");
    const cfg = config(repo);
    const first = enqueueCaptureQueueEntry(queuePath, cfg, queueInput("first")).entry;
    const snapshot = readCaptureQueue(queuePath);
    expect(snapshot.map((entry) => entry.key)).toEqual([first.key]);

    const late = enqueueCaptureQueueEntry(queuePath, cfg, queueInput("late")).entry;
    mutateCaptureQueueAtomic(queuePath, (entries) => entries.filter((entry) => entry.key !== first.key));

    expect(readCaptureQueue(queuePath).map((entry) => entry.key)).toEqual([late.key]);
  });

  it("rejects group/world-writable custom queue parents", () => {
    if (process.platform === "win32") return;
    const repo = tempRoot("rorca-custom-queue");
    const shared = path.join(repo, "shared");
    mkdirSync(shared, { mode: 0o777 });
    chmodSync(shared, 0o777);
    expect(() => resolveCaptureConfig({ cwd: repo, gitRoot: repo, overrides: { repoPath: repo, queuePath: path.join(shared, "queue.jsonl") } })).toThrow(/Unsafe capture queue path/);
  });

  it("rejects symlink token files without reading their target", () => {
    const home = tempRoot("rorca-token-symlink");
    const secureDir = path.join(home, ".rorca");
    mkdirSync(secureDir, { mode: 0o700 });
    const victim = path.join(home, "victim-token");
    writeFileSync(victim, "do-not-read\n", { mode: 0o600 });
    const tokenPath = path.join(secureDir, "mcp-token");
    symlinkSync(victim, tokenPath);

    expect(inspectMcpToken(tokenPath)).toMatchObject({ exists: true, modeOk: false });
    expect(() => readMcpToken(tokenPath)).toThrow(/non-symlink regular file/);
  });

  it("refuses a mismatched PID identity without invoking the signal runtime", () => {
    const home = tempRoot("rorca-pid-identity");
    const workspaceId = "pid-test";
    const status: CaptureDaemonStatusFile = {
      version: 1,
      worker_id: "rorca-capture:pid-test",
      workspaceId,
      repoPath: home,
      apiUrl: "http://127.0.0.1:3030",
      queuePath: path.join(home, "queue"),
      pid: 424242,
      hostname: "test",
      running: true,
      last_seen: new Date().toISOString(),
      intervalMs: 30_000,
      maxCommitsPerScan: 50,
      dryRun: false,
      apiReachable: null,
      queueDepth: 0,
      cursor: { path: path.join(home, "cursor"), lastReconciledSha: null },
      hookState: { path: path.join(home, "hook"), installed: false, managed: false },
      consecutiveErrorCount: 0,
      backoff: { active: false, consecutiveErrorCount: 0 },
      processIdentity: { nonce: "recorded", startMarker: "old-start", commandHash: "old-command" },
    };
    writeCaptureDaemonStatus(workspaceId, status, home);
    const signal = vi.fn();

    const result = stopCaptureDaemon(workspaceId, home, {
      inspectProcess: () => ({ startMarker: "new-start", commandHash: "new-command" }),
      signal,
    });

    expect(result.stopped).toBe(false);
    expect(result.message).toMatch(/Refusing to signal/);
    expect(signal).not.toHaveBeenCalled();
    expect(readCaptureDaemonStatus(workspaceId, home)?.running).toBe(true);
  });

  it("preserves queue/state on legacy --all teardown and rejects symlink managed artifacts", () => {
    const repo = tempRoot("rorca-teardown");
    mkdirSync(path.join(repo, ".git", "hooks"), { recursive: true });
    const setup = setupAlwaysOnCapture({ workspace: { id: "secure", path: repo, resolvedBy: "path" }, apiUrl: "http://127.0.0.1:3030", policyMode: "metadata-only" });
    expect(setup.ok).toBe(true);
    const queuePath = path.join(repo, ".rorca-capture-queue.jsonl");
    const statePath = path.join(repo, ".rorca", "capture", "state.json");
    writeFileSync(queuePath, "preserve queue\n", { mode: 0o600 });
    writeFileSync(statePath, "preserve state\n", { mode: 0o600 });

    teardownAlwaysOnCapture(repo, { all: true });
    expect(readFileSync(queuePath, "utf8")).toBe("preserve queue\n");
    expect(readFileSync(statePath, "utf8")).toBe("preserve state\n");
  });

  it("fails closed when a post-commit hook is a symlink", async () => {
    const repo = tempRoot("rorca-hook-symlink");
    mkdirSync(path.join(repo, ".git", "hooks"), { recursive: true });
    const victim = path.join(repo, "victim-hook");
    writeFileSync(victim, "#!/bin/sh\necho victim\n", "utf8");
    symlinkSync(victim, path.join(repo, ".git", "hooks", "post-commit"));
    const tokenPath = path.join(repo, "token");
    writeFileSync(tokenPath, "test-token\n", { mode: 0o600 });
    const output = { stdout: "", stderr: "" };
    const io = {
      stdout: { write: (value: string) => { output.stdout += value; return true; } },
      stderr: { write: (value: string) => { output.stderr += value; return true; } },
    };
    const fetchImpl: typeof fetch = async (url) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/api/workspaces") return new Response(JSON.stringify({ items: [{ id: "hook", path: repo }] }), { status: 200 });
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    };

    const code = await runCli(["install-hooks", "--workspace", "hook"], { cwd: repo, gitRoot: repo, tokenPath, env: {}, io, fetchImpl });

    expect(code).toBe(1);
    expect(readFileSync(victim, "utf8")).toContain("victim");
    expect(output.stderr).toMatch(/ELOOP|symlink|non-symlink|Secure file/i);
    expect(existsSync(path.join(repo, ".git", "hooks", "post-commit.pre-rorca"))).toBe(false);
  });
});
