/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCaptureConfig } from "../config.js";
import { readCaptureQueue } from "../queue.js";
import {
  buildOperationalStatus,
  getCaptureCursorPath,
  readCaptureDaemonStatus,
  runDaemonScanOnce,
  stopCaptureDaemon,
} from "../daemon.js";

function tempRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), "rorca-capture-daemon-"));
  mkdirSync(path.join(repo, ".rorca"), { recursive: true });
  return repo;
}

function tokenFile(repo: string): string {
  const tokenPath = path.join(repo, "mcp-token");
  writeFileSync(tokenPath, "test-token\n", "utf8");
  chmodSync(tokenPath, 0o600);
  return tokenPath;
}

function initGitRepo(repo: string): void {
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Rorca Test"]);
  git(repo, ["config", "user.email", "rorca@example.test"]);
}

function commitFile(repo: string, filePath: string, content: string, message: string): string {
  const absolute = path.join(repo, filePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
  git(repo, ["add", filePath]);
  git(repo, ["commit", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]).trim();
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
}

function configFor(repo: string, workspaceId = "ws-daemon") {
  return resolveCaptureConfig({
    cwd: repo,
    gitRoot: repo,
    env: {
      RORCA_API_URL: "http://api.test",
      RORCA_WORKSPACE_ID: workspaceId,
      RORCA_QUEUE_PATH: path.join(repo, ".rorca", "daemon-queue.jsonl"),
    },
  });
}

function workspaceFor(repo: string, workspaceId = "ws-daemon") {
  return { id: workspaceId, path: repo, resolvedBy: "config" as const };
}

function mode(filePath: string): string {
  return (statSync(filePath).mode & 0o777).toString(8).padStart(3, "0");
}

describe("rorca-capture daemon reconciliation", () => {
  it("scan-once submits commits, persists a 0600 cursor, and skips already-accounted commits after restart", async () => {
    const repo = tempRepo();
    const homeDir = mkdtempSync(path.join(tmpdir(), "rorca-capture-home-"));
    initGitRepo(repo);
    const first = commitFile(repo, "src/one.ts", "export const one = true;\n", "feat: one");
    const second = commitFile(repo, "src/two.ts", "export const two = true;\n", "feat: two");
    const config = configFor(repo);
    const tokenPath = tokenFile(repo);
    const posted: string[] = [];

    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      const textUrl = String(url);
      if (textUrl.endsWith("/api/health")) return new Response(JSON.stringify({ status: "healthy" }), { status: 200 });
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        posted.push(body.metadata.gitSha);
        return new Response(JSON.stringify({ event: { id: body.metadata.gitSha }, created: true, idempotent: false }), { status: 201 });
      }
      return new Response(JSON.stringify({ error: `Unexpected ${textUrl}` }), { status: 500 });
    };

    const firstRun = await runDaemonScanOnce({
      config,
      workspace: workspaceFor(repo),
      tokenPath,
      fetchImpl,
      homeDir,
      maxCommitsPerScan: 10,
      maxConcurrentSubmissions: 1,
    });

    expect(firstRun.scan).toMatchObject({ planned: 2, submitted: 2, failed: 0, cursorAfter: second });
    expect(posted).toEqual([first, second]);
    const cursorPath = getCaptureCursorPath("ws-daemon", homeDir);
    expect(mode(cursorPath)).toBe("600");
    expect(JSON.parse(readFileSync(cursorPath, "utf8"))).toMatchObject({ lastReconciledSha: second });

    const secondRun = await runDaemonScanOnce({
      config,
      workspace: workspaceFor(repo),
      tokenPath,
      fetchImpl,
      homeDir,
      maxCommitsPerScan: 10,
    });

    expect(secondRun.scan.planned).toBe(0);
    expect(secondRun.cursorBefore).toBe(second);
    expect(posted).toEqual([first, second]);
  });

  it("queues while offline, advances the cursor for locally accounted commits, and flushes when health returns", async () => {
    const repo = tempRepo();
    const homeDir = mkdtempSync(path.join(tmpdir(), "rorca-capture-home-"));
    initGitRepo(repo);
    const sha = commitFile(repo, "src/offline.ts", "export const offline = true;\n", "feat: offline");
    const config = configFor(repo, "ws-offline");
    const tokenPath = tokenFile(repo);
    const now = new Date("2026-07-04T12:00:00.000Z");

    const offline = await runDaemonScanOnce({
      config,
      tokenPath,
      fetchImpl: async () => { throw new TypeError("fetch failed"); },
      homeDir,
      now,
      random: () => 0,
    });

    expect(offline.scan).toMatchObject({ planned: 1, queued: 1, failed: 0, cursorAfter: sha });
    expect(offline.lastError).toContain("fetch failed");
    expect(readCaptureQueue(config.queuePath)).toHaveLength(1);
    const statusAfterOffline = readCaptureDaemonStatus("ws-offline", homeDir);
    expect(statusAfterOffline?.backoff.active).toBe(true);
    expect(statusAfterOffline?.consecutiveErrorCount).toBe(1);
    const retryAfter = new Date(Date.parse(statusAfterOffline?.backoff.nextRetryAt ?? now.toISOString()) + 1);

    const posted: string[] = [];
    const online = await runDaemonScanOnce({
      config,
      tokenPath,
      homeDir,
      now: retryAfter,
      fetchImpl: async (url, init) => {
        const textUrl = String(url);
        if (textUrl.endsWith("/api/health")) return new Response(JSON.stringify({ status: "healthy" }), { status: 200 });
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          posted.push(body.metadata.gitSha);
          return new Response(JSON.stringify({ event: { id: "evt-online" }, created: true }), { status: 201 });
        }
        return new Response("{}", { status: 500 });
      },
    });

    expect(online.flush).toMatchObject({ submitted: 1, failed: 0, remaining: 0 });
    expect(online.scan.planned).toBe(0);
    expect(posted).toEqual([sha]);
    expect(readCaptureQueue(config.queuePath)).toHaveLength(0);
    const statusAfterOnline = readCaptureDaemonStatus("ws-offline", homeDir);
    expect(statusAfterOnline?.backoff.active).toBe(false);
    expect(statusAfterOnline?.consecutiveErrorCount).toBe(0);
    expect(statusAfterOnline?.last_error).toBeUndefined();
  });

  it("reports daemon status and can mark the recorded PID stopped", async () => {
    const repo = tempRepo();
    const homeDir = mkdtempSync(path.join(tmpdir(), "rorca-capture-home-"));
    initGitRepo(repo);
    commitFile(repo, "src/status.ts", "export const status = true;\n", "feat: status");
    const config = configFor(repo, "ws-status");
    const tokenPath = tokenFile(repo);

    await runDaemonScanOnce({
      config,
      workspace: workspaceFor(repo, "ws-status"),
      tokenPath,
      homeDir,
      fetchImpl: async (url, init) => {
        if (String(url).endsWith("/api/health")) return new Response("{}", { status: 200 });
        if (init?.method === "POST") return new Response(JSON.stringify({ event: { id: "evt" }, created: true }), { status: 201 });
        return new Response("{}", { status: 500 });
      },
    });

    const status = await buildOperationalStatus({ config, workspaceId: "ws-status", homeDir, dryRun: true });
    expect(status.daemon.running).toBe(true);
    expect(status.daemon.pid).toBe(process.pid);
    expect(status.queue.depth).toBe(0);
    expect(status.apiReachability.skipped).toBe(true);
    expect(status.cursor.lastReconciledSha).toMatch(/^[0-9a-f]{40}$/);

    const stopped = stopCaptureDaemon("ws-status", homeDir);
    expect(stopped.pid).toBe(process.pid);
    const stoppedStatus = await buildOperationalStatus({ config, workspaceId: "ws-status", homeDir, dryRun: true });
    expect(stoppedStatus.daemon.running).toBe(false);
  });

  it("dry-run scans commits without fetch calls, queue writes, or cursor advancement", async () => {
    const repo = tempRepo();
    const homeDir = mkdtempSync(path.join(tmpdir(), "rorca-capture-home-"));
    initGitRepo(repo);
    commitFile(repo, "src/dry.ts", "export const dry = true;\n", "feat: dry");
    const config = configFor(repo, "ws-dry");
    let fetchCalls = 0;

    const result = await runDaemonScanOnce({
      config,
      homeDir,
      dryRun: true,
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response("{}", { status: 500 });
      },
    });

    expect(result.scan).toMatchObject({ planned: 1, dryRun: 1, failed: 0, cursorAfter: null });
    expect(fetchCalls).toBe(0);
    expect(existsSync(getCaptureCursorPath("ws-dry", homeDir))).toBe(false);
    expect(readCaptureQueue(config.queuePath)).toHaveLength(0);
  });

  it("bounds concurrent API submissions during a scan", async () => {
    const repo = tempRepo();
    const homeDir = mkdtempSync(path.join(tmpdir(), "rorca-capture-home-"));
    initGitRepo(repo);
    for (let index = 0; index < 4; index += 1) {
      commitFile(repo, `src/${index}.ts`, `export const value${index} = ${index};\n`, `feat: ${index}`);
    }
    const config = configFor(repo, "ws-concurrency");
    const tokenPath = tokenFile(repo);
    let active = 0;
    let maxActive = 0;

    const result = await runDaemonScanOnce({
      config,
      workspace: workspaceFor(repo, "ws-concurrency"),
      tokenPath,
      homeDir,
      maxConcurrentSubmissions: 2,
      fetchImpl: async (url, init) => {
        if (String(url).endsWith("/api/health")) return new Response("{}", { status: 200 });
        if (init?.method === "POST") {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 20));
          active -= 1;
          return new Response(JSON.stringify({ event: { id: "evt" }, created: true }), { status: 201 });
        }
        return new Response("{}", { status: 500 });
      },
    });

    expect(result.scan).toMatchObject({ planned: 4, submitted: 4, failed: 0, maxConcurrentSubmissions: 2 });
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});
