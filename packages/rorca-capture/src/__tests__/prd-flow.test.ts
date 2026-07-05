import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import { resolveCaptureConfig } from "../config.js";
import { getCaptureCursorPath, runDaemonScanOnce } from "../daemon.js";
import { readCaptureQueue } from "../queue.js";

function tempRepo(prefix = "rorca-capture-prd-"): string {
  const repo = mkdtempSync(path.join(tmpdir(), prefix));
  mkdirSync(path.join(repo, ".rorca"), { recursive: true });
  return repo;
}

function tokenFile(repo: string): string {
  const tokenPath = path.join(repo, "mcp-token");
  writeFileSync(tokenPath, "test-token\n", "utf8");
  chmodSync(tokenPath, 0o600);
  return tokenPath;
}

function captureIO() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: { write: (chunk: string | Uint8Array) => { stdout += chunk.toString(); return true; } },
      stderr: { write: (chunk: string | Uint8Array) => { stderr += chunk.toString(); return true; } },
    },
    get stdout() { return stdout; },
    get stderr() { return stderr; },
  };
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

type FetchMock = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

describe("rorca-capture PRD flow regression fixtures", () => {
  it("proves manual remember creates a pending candidate by default and durable memory only with configured approval", async () => {
    const repo = tempRepo();
    const tokenPath = tokenFile(repo);
    writeFileSync(path.join(repo, ".rorca", "capture.json"), JSON.stringify({ operatorAutoApprove: true }), "utf8");
    const candidates = new Map<string, { id: string; reviewStatus: "pending" | "approved"; payload: Record<string, unknown>; promotedMemoryId?: string }>();
    const durableMemories: Array<{ id: string; candidateId: string }> = [];
    let nextCandidateId = 1;

    const fetchImpl: FetchMock = async (url, init) => {
      const textUrl = String(url);
      if (textUrl.endsWith("/api/workspaces")) {
        return new Response(JSON.stringify({ items: [{ id: "ws-manual", label: "Manual", path: repo }] }), { status: 200 });
      }

      const approveMatch = textUrl.match(/\/api\/memory\/candidates\/([^/]+)\/approve$/u);
      if (init?.method === "POST" && approveMatch) {
        const candidate = [...candidates.values()].find((item) => item.id === approveMatch[1]);
        if (!candidate) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
        if (candidate.reviewStatus === "approved" && candidate.promotedMemoryId) {
          return new Response(JSON.stringify({ approved: true, alreadyApproved: true, candidate, memory: { id: candidate.promotedMemoryId } }), { status: 200 });
        }
        const memoryId = `mem-${durableMemories.length + 1}`;
        candidate.reviewStatus = "approved";
        candidate.promotedMemoryId = memoryId;
        durableMemories.push({ id: memoryId, candidateId: candidate.id });
        return new Response(JSON.stringify({ approved: true, alreadyApproved: false, candidate, memory: { id: memoryId } }), { status: 200 });
      }

      if (init?.method === "POST" && textUrl.endsWith("/api/memory/candidates")) {
        const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
        const idempotencyKey = String(payload.idempotencyKey);
        const existing = candidates.get(idempotencyKey);
        if (existing) {
          return new Response(JSON.stringify({ candidate: existing, created: false, idempotent: true }), { status: 200 });
        }
        const candidate = { id: String(nextCandidateId++), reviewStatus: "pending" as const, payload };
        candidates.set(idempotencyKey, candidate);
        return new Response(JSON.stringify({ candidate, created: true, idempotent: false }), { status: 201 });
      }

      return new Response(JSON.stringify({ error: `Unexpected ${init?.method ?? "GET"} ${textUrl}` }), { status: 500 });
    };

    const pendingOutput = captureIO();
    const pendingCode = await runCli(["remember", "Prefer pending candidate review", "--workspace", "ws-manual", "--api-url", "http://api.test"], {
      cwd: repo,
      gitRoot: repo,
      tokenPath,
      env: {},
      io: pendingOutput.io,
      fetchImpl,
    });

    expect(pendingCode).toBe(0);
    expect(pendingOutput.stdout).toContain("pending");
    const pendingCandidate = [...candidates.values()][0];
    expect(pendingCandidate).toMatchObject({ reviewStatus: "pending" });
    expect(pendingCandidate.payload).toMatchObject({
      workspaceId: "ws-manual",
      eventType: "manual_cli_note",
      sourceSystem: "rorca-capture",
      requiresReview: true,
    });
    expect(durableMemories).toHaveLength(0);

    const approvedOutput = captureIO();
    const approvedCode = await runCli(["remember", "Approved operator memory", "--approve", "--workspace", "ws-manual", "--api-url", "http://api.test"], {
      cwd: repo,
      gitRoot: repo,
      tokenPath,
      env: {},
      io: approvedOutput.io,
      fetchImpl,
    });

    expect(approvedCode).toBe(0);
    expect(approvedOutput.stdout).toContain("approved");
    expect(durableMemories).toHaveLength(1);
    expect([...candidates.values()].filter((candidate) => candidate.reviewStatus === "approved")).toHaveLength(1);
  });

  it("proves CI PR ingestion is idempotent, pending-by-default, and safely deduplicated in the offline queue", async () => {
    const repo = tempRepo();
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "app.ts"), "export const app = true;\n", "utf8");
    const tokenPath = tokenFile(repo);
    const candidates = new Map<string, Record<string, unknown>>();
    let nextCandidateId = 1;
    const prArgs = [
      "ingest-pr",
      "--ci",
      "--json",
      "--workspace", "ws-ci-pr",
      "--api-url", "http://api.test",
      "--provider", "github",
      "--repo", "owner/repo",
      "--pr-number", "42",
      "--merge-sha", "abc1234",
      "--author", "alice",
      "--title", "Ship capture sidecar",
      "--body", "No secrets here",
      "--changed-files", "src/app.ts",
      "--ci-run-id", "run-42",
      "--ci-workflow", "ci",
    ];

    const onlineFetch: FetchMock = async (url, init) => {
      const textUrl = String(url);
      if (textUrl.endsWith("/api/workspaces")) {
        return new Response(JSON.stringify({ items: [{ id: "ws-ci-pr", path: repo }] }), { status: 200 });
      }
      if (init?.method === "POST" && textUrl.endsWith("/api/memory/candidates")) {
        const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
        const idempotencyKey = String(payload.idempotencyKey);
        const existing = candidates.get(idempotencyKey);
        if (existing) {
          return new Response(JSON.stringify({ candidate: existing, created: false, idempotent: true }), { status: 200 });
        }
        const candidate = { id: String(nextCandidateId++), reviewStatus: "pending", payload };
        candidates.set(idempotencyKey, candidate);
        return new Response(JSON.stringify({ candidate, created: true, idempotent: false }), { status: 201 });
      }
      return new Response(JSON.stringify({ error: `Unexpected ${textUrl}` }), { status: 500 });
    };

    const firstOutput = captureIO();
    const firstCode = await runCli(prArgs, { cwd: repo, gitRoot: repo, tokenPath, env: {}, io: firstOutput.io, fetchImpl: onlineFetch });
    const secondOutput = captureIO();
    const secondCode = await runCli(prArgs, { cwd: repo, gitRoot: repo, tokenPath, env: {}, io: secondOutput.io, fetchImpl: onlineFetch });

    expect(firstCode).toBe(0);
    expect(secondCode).toBe(2);
    expect(candidates.size).toBe(1);
    const candidate = [...candidates.values()][0] as { reviewStatus: string; payload: { metadata: { review: { pendingByDefault: boolean; autoApproved: boolean } }; requiresReview: boolean } };
    expect(candidate.reviewStatus).toBe("pending");
    expect(candidate.payload.requiresReview).toBe(true);
    expect(candidate.payload.metadata.review).toMatchObject({ pendingByDefault: true, autoApproved: false });
    expect(JSON.parse(firstOutput.stdout)).toMatchObject({ status: "submitted", pendingReview: true });
    expect(JSON.parse(secondOutput.stdout)).toMatchObject({ status: "duplicate", idempotent: true });

    const queuePath = path.join(repo, ".rorca", "ci-pr-offline.ndjson");
    const offlineArgs = [...prArgs, "--queue-path", queuePath];
    const offlineFetch: FetchMock = async () => { throw new TypeError("fetch failed"); };
    const offlineFirst = captureIO();
    const offlineSecond = captureIO();

    expect(await runCli(offlineArgs, { cwd: repo, gitRoot: repo, tokenPath, env: {}, io: offlineFirst.io, fetchImpl: offlineFetch })).toBe(0);
    expect(await runCli(offlineArgs, { cwd: repo, gitRoot: repo, tokenPath, env: {}, io: offlineSecond.io, fetchImpl: offlineFetch })).toBe(2);

    const queued = readCaptureQueue(queuePath);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ operation: "memory-candidate", endpoint: "/api/memory/candidates", eventType: "pr_merge" });
    expect(queued[0].payload).toMatchObject({ workspaceId: "ws-ci-pr", requiresReview: true });
    expect((queued[0].payload as { metadata: { review: { pendingByDefault: boolean } } }).metadata.review.pendingByDefault).toBe(true);
  });

  it("proves offline git ingestion and daemon reconciliation share commit-SHA idempotency and do not duplicate queue entries", async () => {
    const repo = tempRepo();
    initGitRepo(repo);
    const sha = commitFile(repo, "src/offline.ts", "export const offline = true;\n", "feat: offline capture");
    const tokenPath = tokenFile(repo);
    const queuePath = path.join(repo, ".rorca", "git-offline.ndjson");
    const offlineFetch: FetchMock = async () => { throw new TypeError("fetch failed"); };
    const ingestArgs = ["ingest-commit", sha, "--workspace", "ws-git", "--api-url", "http://api.test", "--queue-path", queuePath, "--json"];

    const firstOutput = captureIO();
    const secondOutput = captureIO();
    expect(await runCli(ingestArgs, { cwd: repo, gitRoot: repo, tokenPath, env: {}, io: firstOutput.io, fetchImpl: offlineFetch })).toBe(0);
    expect(await runCli(ingestArgs, { cwd: repo, gitRoot: repo, tokenPath, env: {}, io: secondOutput.io, fetchImpl: offlineFetch })).toBe(0);

    let queued = readCaptureQueue(queuePath);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ operation: "context-event", endpoint: "/api/context-events", eventType: "git_commit" });
    expect(queued[0].payload).toMatchObject({ workspaceId: "ws-git", metadata: { gitSha: sha } });
    expect(JSON.parse(firstOutput.stdout)).toMatchObject({ queued: 1, duplicate: 0 });
    expect(JSON.parse(secondOutput.stdout)).toMatchObject({ queued: 0, duplicate: 1 });

    const homeDir = mkdtempSync(path.join(tmpdir(), "rorca-capture-daemon-prd-home-"));
    const config = resolveCaptureConfig({
      cwd: repo,
      gitRoot: repo,
      env: { RORCA_API_URL: "http://api.test", RORCA_WORKSPACE_ID: "ws-git", RORCA_QUEUE_PATH: queuePath },
    });
    const daemon = await runDaemonScanOnce({ config, tokenPath, fetchImpl: offlineFetch, homeDir, random: () => 0 });

    queued = readCaptureQueue(queuePath);
    expect(daemon.scan).toMatchObject({ planned: 1, queued: 0, duplicate: 1, failed: 0, cursorAfter: sha });
    expect(queued).toHaveLength(1);
    expect(JSON.parse(readFileSync(getCaptureCursorPath("ws-git", homeDir), "utf8"))).toMatchObject({ lastReconciledSha: sha });
  });
});
