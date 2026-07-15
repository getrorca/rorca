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
import { HELP_TEXT, runCli } from "../cli.js";
import { buildCaptureStatus, formatStatusText, MVP_COMMANDS } from "../status.js";
import { resolveCaptureConfig } from "../config.js";

function tempRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), "rorca-capture-cli-"));
  mkdirSync(path.join(repo, ".rorca"), { recursive: true });
  return repo;
}

function tempHookRepo(): string {
  const repo = tempRepo();
  mkdirSync(path.join(repo, ".git", "hooks"), { recursive: true });
  return repo;
}

function hookMode(filePath: string): string {
  return (statSync(filePath).mode & 0o777).toString(8).padStart(3, "0");
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

function commitFile(repo: string, filePath: string, content: string, message: string, isoDate?: string): string {
  const absolute = path.join(repo, filePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
  git(repo, ["add", filePath]);
  git(repo, ["commit", "-m", message], isoDate ? { GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate } : undefined);
  return git(repo, ["rev-parse", "HEAD"]).trim();
}

function git(repo: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
}

function workspaceFetch(repo: string, workspaceId: string, onPost?: (url: string, body: any) => Response): CaptureFetchMock {
  return async (url, init) => {
    const textUrl = String(url);
    if (textUrl.endsWith("/api/workspaces")) {
      return new Response(JSON.stringify({ items: [{ id: workspaceId, label: "Workspace", path: repo }] }), { status: 200 });
    }
    if (init?.method === "POST" && onPost) {
      return onPost(textUrl, init.body ? JSON.parse(String(init.body)) : undefined);
    }
    return new Response(JSON.stringify({ error: `Unexpected ${init?.method ?? "GET"} ${textUrl}` }), { status: 500 });
  };
}

type CaptureFetchMock = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

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

function repoRoot(): string {
  let current = process.cwd();
  while (true) {
    if (existsSync(path.join(current, "docs", "rorca-capture-sidecar-operator-guide.md"))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error("Could not resolve repository root for docs assertions");
    current = parent;
  }
}

describe("rorca-capture CLI", () => {
  it("exposes MVP commands in help", async () => {
    for (const command of ["remember", "import-duckbrain", "ingest-pr", "ingest-commit", "ingest-git", "install-hooks", "daemon", "status", "flush"]) {
      expect(HELP_TEXT).toContain(command);
    }
    expect(HELP_TEXT).toContain("rorca capture <command>");
    expect(HELP_TEXT).toContain("API-only");

    const output = captureIO();
    await expect(runCli(["--help"], { io: output.io })).resolves.toBe(0);
    expect(output.stdout).toContain("MVP commands");
    expect(output.stderr).toBe("");
  });

  it("keeps operator docs aligned with sidecar commands and stable API boundaries", () => {
    const docs = [
      "docs/rorca-capture-sidecar-operator-guide.md",
      "docs/rorca-capture-sidecar-contract.md",
      "packages/rorca-capture/README.md",
    ].map((docPath) => readFileSync(path.join(repoRoot(), docPath), "utf8")).join("\n");

    for (const phrase of [
      "rorca-capture install-hooks",
      "rorca-capture daemon --status",
      "rorca-capture flush --force",
      "RORCA_OPTIONAL_WORKER=true npm run dev:worker:optional",
      "GET /api/context-candidates/retrieval",
      "GET /api/pipeline/worker/health",
      "backend/src/lib/context-safety.ts",
      "rorca mcp setup-claude",
      "rorca mcp rotate-token",
      "x-rorca-public-api: true",
      "x-rorca-tier: public",
      "never writes directly to the Rorca database",
      "Direct DB writes",
    ]) {
      expect(docs).toContain(phrase);
    }
  });

  it("prints status output with config, workspace, token, and command shape", async () => {
    const repo = tempRepo();
    writeFileSync(path.join(repo, ".rorca-captureignore"), "generated/**\n", "utf8");
    const tokenPath = tokenFile(repo);
    const output = captureIO();

    const code = await runCli(["status"], {
      cwd: repo,
      gitRoot: repo,
      tokenPath,
      env: { RORCA_API_URL: "http://localhost:3030" },
      io: output.io,
      fetchImpl: async () => new Response(JSON.stringify({
        items: [{ id: "ws-1", label: "Workspace", path: repo }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    });

    expect(code).toBe(0);
    expect(output.stdout).toContain("Rorca Capture Status");
    expect(output.stdout).toContain("API URL: http://localhost:3030");
    expect(output.stdout).toContain("Workspace: ws-1 (path)");
    expect(output.stdout).toContain("Queue path:");
    expect(output.stdout).toContain("Capture ignore:");
    expect(output.stdout).toContain("API-only: yes");
    expect(output.stdout).toContain(`Commands: ${MVP_COMMANDS.join(", ")}`);
  });

  it("runs daemon scan/status/stop through the CLI with configurable bounds", async () => {
    const repo = tempRepo();
    const homeDir = mkdtempSync(path.join(tmpdir(), "rorca-capture-cli-home-"));
    initGitRepo(repo);
    const sha = commitFile(repo, "src/daemon.ts", "export const daemon = true;\n", "feat: daemon cli");
    const tokenPath = tokenFile(repo);
    const queuePath = path.join(repo, ".rorca", "cli-daemon-queue.jsonl");
    const scanOutput = captureIO();
    const posted: string[] = [];
    const fetchImpl: CaptureFetchMock = async (url, init) => {
      const textUrl = String(url);
      if (textUrl.endsWith("/api/health")) return new Response(JSON.stringify({ status: "healthy" }), { status: 200 });
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        posted.push(body.metadata.gitSha);
        return new Response(JSON.stringify({ event: { id: "evt-cli" }, created: true }), { status: 201 });
      }
      return new Response(JSON.stringify({ error: `Unexpected ${textUrl}` }), { status: 500 });
    };

    const scanCode = await runCli([
      "daemon",
      "--scan-once",
      "--workspace",
      "ws-cli-daemon",
      "--queue-path",
      queuePath,
      "--interval",
      "1",
      "--max-commits-per-scan",
      "1",
      "--max-concurrency",
      "1",
      "--json",
    ], {
      cwd: repo,
      gitRoot: repo,
      tokenPath,
      env: { HOME: homeDir, RORCA_API_URL: "http://api.test" },
      io: scanOutput.io,
      fetchImpl,
    });

    expect(scanCode).toBe(0);
    expect(posted).toEqual([sha]);
    const scan = JSON.parse(scanOutput.stdout) as { scan: { planned: number; submitted: number }; queuePath: string };
    expect(scan.scan).toMatchObject({ planned: 1, submitted: 1 });
    expect(scan.queuePath).toBe(queuePath);

    const statusOutput = captureIO();
    const statusCode = await runCli(["daemon", "--status", "--workspace", "ws-cli-daemon", "--queue-path", queuePath, "--json"], {
      cwd: repo,
      gitRoot: repo,
      env: { HOME: homeDir, RORCA_API_URL: "http://api.test" },
      io: statusOutput.io,
      fetchImpl,
    });
    expect(statusCode).toBe(0);
    const status = JSON.parse(statusOutput.stdout) as { queue: { depth: number }; daemon: { running: boolean; pid: number | null } };
    expect(status.queue.depth).toBe(0);
    expect(status.daemon.running).toBe(true);
    expect(status.daemon.pid).toBe(process.pid);

    const stopOutput = captureIO();
    const stopCode = await runCli(["daemon", "--stop", "--workspace", "ws-cli-daemon", "--queue-path", queuePath], {
      cwd: repo,
      gitRoot: repo,
      env: { HOME: homeDir, RORCA_API_URL: "http://api.test" },
      io: stopOutput.io,
    });
    expect(stopCode).toBe(0);
    expect(stopOutput.stdout).toContain("Stopped daemon pid");
  });

  it("supports JSON status output shape", async () => {
    const repo = tempRepo();
    const tokenPath = tokenFile(repo);
    const output = captureIO();

    const code = await runCli(["status", "--json"], {
      cwd: repo,
      gitRoot: repo,
      tokenPath,
      env: { RORCA_API_URL: "http://localhost:3030", RORCA_WORKSPACE_ID: "ws-2" },
      io: output.io,
      fetchImpl: async () => new Response(JSON.stringify({
        items: [{ id: "ws-2", label: "Workspace", path: repo }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    });

    expect(code).toBe(0);
    const parsed = JSON.parse(output.stdout) as { ok: boolean; workspaceId: string; apiOnly: boolean; commands: string[] };
    expect(parsed).toMatchObject({ ok: true, workspaceId: "ws-2", apiOnly: true });
    expect(parsed.commands).toEqual(MVP_COMMANDS);
  });

  it("formats status text without invoking the API", () => {
    const repo = tempRepo();
    const config = resolveCaptureConfig({ cwd: repo, gitRoot: repo, env: { RORCA_API_URL: "http://localhost:3030" } });
    const status = buildCaptureStatus({
      config,
      workspace: { id: "ws", path: repo, resolvedBy: "path" },
      token: { path: path.join(repo, "token"), exists: true, modeOk: true, mode: "600" },
    });

    expect(formatStatusText(status)).toContain("Safety contract: rorca-context-safety/v1");
  });

  it("submits ingest-pr metadata from flags as a pending memory candidate", async () => {
    const repo = tempRepo();
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "app.ts"), "export const app = true;\n", "utf8");
    const tokenPath = tokenFile(repo);
    const output = captureIO();
    let endpoint = "";
    let posted: any;

    const code = await runCli([
      "ingest-pr",
      "--workspace", "ws-pr",
      "--api-url", "http://api.test",
      "--json",
      "--provider", "github",
      "--repo", "owner/repo",
      "--pr-number", "42",
      "--pr-url", "https://github.com/owner/repo/pull/42",
      "--merge-sha", "abc1234",
      "--author", "alice",
      "--title", "Ship capture",
      "--body", "No secrets here",
      "--changed-files", "src/app.ts",
      "--ci-run-id", "run-42",
      "--ci-workflow", "ci",
    ], {
      cwd: repo,
      gitRoot: repo,
      tokenPath,
      env: {},
      io: output.io,
      fetchImpl: workspaceFetch(repo, "ws-pr", (url, body) => {
        endpoint = url;
        posted = body;
        return new Response(JSON.stringify({ candidate: { id: "pr-1", reviewStatus: "pending" }, created: true }), { status: 201 });
      }),
    });

    expect(code).toBe(0);
    expect(endpoint).toBe("http://api.test/api/memory/candidates");
    expect(posted).toMatchObject({
      workspaceId: "ws-pr",
      eventType: "pr_merge",
      sourceSystem: "rorca-capture",
      suggestedCategory: "Decision",
      confidence: "low",
      trustTier: "agent_observation",
      relatedFiles: ["src/app.ts"],
      requiresReview: true,
    });
    expect(posted.metadata.review).toMatchObject({ pendingByDefault: true, autoApproved: false });
    expect(posted.metadata.pr).toMatchObject({ provider: "github", repo: "owner/repo", number: 42, mergeSha: "abc1234" });
    expect(posted.metadata.ci).toMatchObject({ provider: "github", runId: "run-42", workflow: "ci" });
    expect(posted.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    const parsed = JSON.parse(output.stdout) as { status: string; candidateId: string; pendingReview: boolean; relatedFiles: string[] };
    expect(parsed).toMatchObject({ status: "submitted", candidateId: "pr-1", pendingReview: true, relatedFiles: ["src/app.ts"] });
  });

  it("loads ingest-pr metadata from a JSON file", async () => {
    const repo = tempRepo();
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "json.ts"), "export const json = true;\n", "utf8");
    const inputPath = path.join(repo, "pr.json");
    writeFileSync(inputPath, JSON.stringify({
      provider: "gitlab",
      repo: "group/project",
      prNumber: 7,
      prUrl: "https://gitlab.example/group/project/-/merge_requests/7",
      mergeSha: "feedbee",
      author: "json-author",
      title: "JSON supplied PR",
      body: "JSON body",
      changedFiles: ["src/json.ts"],
      ci: { provider: "gitlab", runId: "pipeline-7", runUrl: "https://ci.example/7" },
    }), "utf8");
    const tokenPath = tokenFile(repo);
    const output = captureIO();
    let posted: any;

    const code = await runCli(["ingest-pr", "--workspace", "ws-json", "--api-url", "http://api.test", "--json", "--input", inputPath], {
      cwd: repo,
      gitRoot: repo,
      tokenPath,
      env: {},
      io: output.io,
      fetchImpl: workspaceFetch(repo, "ws-json", (_url, body) => {
        posted = body;
        return new Response(JSON.stringify({ candidate: { id: "json-7" }, created: true }), { status: 201 });
      }),
    });

    expect(code).toBe(0);
    expect(posted.metadata.pr).toMatchObject({ provider: "gitlab", repo: "group/project", number: 7, mergeSha: "feedbee" });
    expect(posted.metadata.ci).toMatchObject({ provider: "gitlab", runId: "pipeline-7", runUrl: "https://ci.example/7" });
    expect(posted.provenance.jsonFile).toBe("[WORKSPACE]/pr.json");
  });

  it("loads ingest-pr metadata from CI environment variables", async () => {
    const repo = tempRepo();
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "env.ts"), "export const env = true;\n", "utf8");
    const tokenPath = tokenFile(repo);
    const output = captureIO();
    let posted: any;

    const code = await runCli(["ingest-pr", "--ci", "--json"], {
      cwd: repo,
      gitRoot: repo,
      tokenPath,
      env: {
        RORCA_API_URL: "http://api.test",
        RORCA_WORKSPACE_ID: "ws-env",
        RORCA_PR_PROVIDER: "github",
        RORCA_PR_REPO: "env/repo",
        RORCA_PR_NUMBER: "9",
        RORCA_PR_MERGE_SHA: "decaf00",
        RORCA_PR_AUTHOR: "envbot",
        RORCA_PR_TITLE: "Env supplied PR",
        RORCA_PR_BODY: "Env body",
        RORCA_PR_CHANGED_FILES: "src/env.ts",
        RORCA_CI_RUN_ID: "run-env-9",
        GITHUB_ACTIONS: "true",
      },
      io: output.io,
      fetchImpl: workspaceFetch(repo, "ws-env", (_url, body) => {
        posted = body;
        return new Response(JSON.stringify({ candidate: { id: "env-9" }, created: true }), { status: 201 });
      }),
    });

    expect(code).toBe(0);
    expect(posted.metadata.pr).toMatchObject({ provider: "github", repo: "env/repo", number: 9, mergeSha: "decaf00" });
    expect(posted.metadata.ci).toMatchObject({ provider: "github", runId: "run-env-9" });
  });

  it("returns a clear nonzero error for missing ingest-pr metadata", async () => {
    const repo = tempRepo();
    const tokenPath = tokenFile(repo);
    const output = captureIO();

    const code = await runCli(["ingest-pr", "--workspace", "ws-missing", "--api-url", "http://api.test", "--provider", "github", "--repo", "owner/repo"], {
      cwd: repo,
      gitRoot: repo,
      tokenPath,
      env: {},
      io: output.io,
      fetchImpl: workspaceFetch(repo, "ws-missing"),
    });

    expect(code).toBe(1);
    expect(output.stderr).toContain("PR_REQUIRED_FIELD_MISSING");
    expect(output.stderr).toContain("prNumber");
  });

  it("returns exit code 2 for duplicate ingest-pr submissions", async () => {
    const repo = tempRepo();
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "dupe.ts"), "export const dupe = true;\n", "utf8");
    const tokenPath = tokenFile(repo);
    const output = captureIO();

    const code = await runCli([
      "ingest-pr",
      "--workspace", "ws-dupe-pr",
      "--api-url", "http://api.test",
      "--json",
      "--provider", "github",
      "--repo", "owner/repo",
      "--pr-number", "42",
      "--merge-sha", "abc1234",
      "--author", "alice",
      "--title", "Duplicate capture",
      "--changed-files", "src/dupe.ts",
      "--ci-run-id", "run-42",
    ], {
      cwd: repo,
      gitRoot: repo,
      tokenPath,
      env: {},
      io: output.io,
      fetchImpl: workspaceFetch(repo, "ws-dupe-pr", () => new Response(JSON.stringify({
        candidate: { id: "dupe-pr", reviewStatus: "pending" },
        created: false,
        idempotent: true,
      }), { status: 200 })),
    });

    expect(code).toBe(2);
    const parsed = JSON.parse(output.stdout) as { status: string; candidateId: string; idempotent: boolean };
    expect(parsed).toMatchObject({ status: "duplicate", candidateId: "dupe-pr", idempotent: true });
  });

  it("installs a managed best-effort hook in the resolved workspace path", async () => {
    const repo = tempHookRepo();
    const otherCwd = mkdtempSync(path.join(tmpdir(), "rorca-capture-other-cwd-"));
    const tokenPath = tokenFile(repo);
    const output = captureIO();

    const code = await runCli(["install-hooks", "--workspace", "ws-hook", "--api-url", "http://api.test"], {
      cwd: otherCwd,
      gitRoot: null,
      tokenPath,
      env: {},
      io: output.io,
      fetchImpl: workspaceFetch(repo, "ws-hook"),
    });

    const hookPath = path.join(repo, ".git", "hooks", "post-commit");
    const hook = readFileSync(hookPath, "utf8");
    expect(code).toBe(0);
    expect(output.stderr).toBe("");
    expect(output.stdout).toContain("best-effort");
    expect(hookMode(hookPath)).toBe("755");
    expect(hook).toContain("# RORCA MANAGED HOOK");
    expect(hook).toContain("# RORCA_PREV_HOOK:");
    expect(hook).toContain("rorca-capture ingest-commit HEAD");
    expect(hook).toContain(`--repo-path '${repo}'`);
    expect(hook).toContain("--workspace 'ws-hook'");
    expect(hook).toContain("--api-url 'http://api.test'");
    expect(hook).toContain("$HOME/.rorca/mcp-token");
    expect(hook).toContain("|| true");
    expect(hook).not.toContain("test-token");
    expect(existsSync(path.join(otherCwd, ".git", "hooks", "post-commit"))).toBe(false);
  });

  it("preserves and chains an existing post-commit hook", async () => {
    const repo = tempHookRepo();
    const tokenPath = tokenFile(repo);
    const originalHook = "#!/bin/sh\necho user hook\n";
    const hookPath = path.join(repo, ".git", "hooks", "post-commit");
    const backupPath = path.join(repo, ".git", "hooks", "post-commit.pre-rorca");
    writeFileSync(hookPath, originalHook, "utf8");
    chmodSync(hookPath, 0o644);
    const output = captureIO();

    const code = await runCli(["install-hooks", "--workspace", "ws-hook"], {
      cwd: repo,
      gitRoot: repo,
      tokenPath,
      env: {},
      io: output.io,
      fetchImpl: workspaceFetch(repo, "ws-hook"),
    });

    const hook = readFileSync(hookPath, "utf8");
    expect(code).toBe(0);
    expect(readFileSync(backupPath, "utf8")).toBe(originalHook);
    expect(hookMode(backupPath)).toBe("755");
    expect(hook).toContain("# RORCA_PREV_HOOK: ./post-commit.pre-rorca");
    expect(hook).toContain('PREV_HOOK="$HOOK_DIR/post-commit.pre-rorca"');
    expect(hook).toContain('"$PREV_HOOK" "$@"');
    expect(hook).toContain("|| true");
  });

  it("updates an existing managed hook and generates strict-mode commands explicitly", async () => {
    const repo = tempHookRepo();
    const tokenPath = tokenFile(repo);
    const initial = captureIO();
    await expect(runCli(["install-hooks", "--workspace", "ws-strict"], {
      cwd: repo,
      gitRoot: repo,
      tokenPath,
      env: {},
      io: initial.io,
      fetchImpl: workspaceFetch(repo, "ws-strict"),
    })).resolves.toBe(0);

    const output = captureIO();
    const code = await runCli(["install-hooks", "--workspace", "ws-strict", "--strict"], {
      cwd: repo,
      gitRoot: repo,
      tokenPath,
      env: {},
      io: output.io,
      fetchImpl: workspaceFetch(repo, "ws-strict"),
    });

    const hookPath = path.join(repo, ".git", "hooks", "post-commit");
    const hook = readFileSync(hookPath, "utf8");
    expect(code).toBe(0);
    expect(output.stdout).toContain("strict");
    expect(output.stderr).toContain("strict rorca-capture hook mode enabled");
    expect(hook).toContain("# RORCA_HOOK_MODE: strict");
    expect(hook).toContain("rorca-capture ingest-commit HEAD");
    expect(hook).not.toContain("|| true");
    expect(existsSync(path.join(repo, ".git", "hooks", "post-commit.pre-rorca"))).toBe(false);
  });

  it("uninstalls a managed hook and restores the preserved prior hook", async () => {
    const repo = tempHookRepo();
    const tokenPath = tokenFile(repo);
    const originalHook = "#!/bin/sh\necho restore me\n";
    const hookPath = path.join(repo, ".git", "hooks", "post-commit");
    const backupPath = path.join(repo, ".git", "hooks", "post-commit.pre-rorca");
    writeFileSync(hookPath, originalHook, "utf8");
    const installOutput = captureIO();
    await expect(runCli(["install-hooks", "--workspace", "ws-restore"], {
      cwd: repo,
      gitRoot: repo,
      tokenPath,
      env: {},
      io: installOutput.io,
      fetchImpl: workspaceFetch(repo, "ws-restore"),
    })).resolves.toBe(0);

    const output = captureIO();
    const code = await runCli(["install-hooks", "--workspace", "ws-restore", "--uninstall"], {
      cwd: repo,
      gitRoot: repo,
      tokenPath,
      env: {},
      io: output.io,
      fetchImpl: workspaceFetch(repo, "ws-restore"),
    });

    expect(code).toBe(0);
    expect(output.stdout).toContain("restored previous hook");
    expect(readFileSync(hookPath, "utf8")).toBe(originalHook);
    expect(hookMode(hookPath)).toBe("755");
    expect(existsSync(backupPath)).toBe(false);
  });

  it("uninstalls a managed hook cleanly when no prior hook existed", async () => {
    const repo = tempHookRepo();
    const tokenPath = tokenFile(repo);
    const hookPath = path.join(repo, ".git", "hooks", "post-commit");
    const installOutput = captureIO();
    await expect(runCli(["install-hooks", "--workspace", "ws-remove"], {
      cwd: repo,
      gitRoot: repo,
      tokenPath,
      env: {},
      io: installOutput.io,
      fetchImpl: workspaceFetch(repo, "ws-remove"),
    })).resolves.toBe(0);

    const output = captureIO();
    const code = await runCli(["install-hooks", "--workspace", "ws-remove", "--uninstall"], {
      cwd: repo,
      gitRoot: repo,
      tokenPath,
      env: {},
      io: output.io,
      fetchImpl: workspaceFetch(repo, "ws-remove"),
    });

    expect(code).toBe(0);
    expect(output.stdout).toContain("removed managed hook");
    expect(existsSync(hookPath)).toBe(false);
  });

  it("submits a redacted pending memory candidate with remember flags", async () => {
    const repo = tempRepo();
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "example.ts"), "export const ok = true;\n", "utf8");
    const tokenPath = tokenFile(repo);
    const output = captureIO();
    const calls: Array<{ url: string; init?: RequestInit; body?: any }> = [];

    const code = await runCli([
      "remember",
      "API_TOKEN=secret",
      "--category", "Decision",
      "--title", "Capture API token handling",
      "--files", "src/example.ts",
      "--source", "story:CCS-004",
      "--confidence", "medium",
      "--trust", "engineering_decision",
      "--workspace", "ws-remember",
      "--api-url", "http://api.test",
    ], {
      cwd: repo,
      gitRoot: repo,
      tokenPath,
      env: {},
      io: output.io,
      fetchImpl: async (url, init) => {
        const call = { url: String(url), init, body: init?.body ? JSON.parse(String(init.body)) : undefined };
        calls.push(call);
        if (String(url).endsWith("/api/workspaces")) {
          return new Response(JSON.stringify({ items: [{ id: "ws-remember", label: "Workspace", path: repo }] }), { status: 200 });
        }
        expect(String(url)).toBe("http://api.test/api/memory/candidates");
        return new Response(JSON.stringify({ candidate: { id: "301", reviewStatus: "pending" }, created: true }), { status: 201 });
      },
    });

    expect(code).toBe(0);
    expect(output.stderr).toBe("");
    expect(output.stdout).toContain("pending");
    const submit = calls.find((call) => call.url.endsWith("/api/memory/candidates"));
    expect(submit?.init?.headers).toMatchObject({ Authorization: "Bearer test-token" });
    expect(submit?.body).toMatchObject({
      workspaceId: "ws-remember",
      suggestedCategory: "Decision",
      title: "Capture API token handling",
      relatedFiles: ["src/example.ts"],
      sourceRef: "story:CCS-004",
      confidence: "medium",
      trustTier: "engineering_decision",
      requiresReview: true,
    });
    expect(submit?.body.rule).toBe("[REDACTED_SECRET_ASSIGNMENT]");
    expect(submit?.body.idempotencyKey).toMatch(/^memory-candidate:ws-remember:source:/);
  });

  it("rejects invalid remember categories before network access", async () => {
    const repo = tempRepo();
    const output = captureIO();
    let called = false;

    const code = await runCli(["remember", "Use candidates", "--category", "Bad"], {
      cwd: repo,
      gitRoot: repo,
      env: {},
      io: output.io,
      fetchImpl: async () => {
        called = true;
        return new Response("{}", { status: 200 });
      },
    });

    expect(code).toBe(1);
    expect(output.stderr).toContain("category must be one of");
    expect(called).toBe(false);
  });

  it("rejects ignored and missing related files before network access", async () => {
    const repo = tempRepo();
    writeFileSync(path.join(repo, ".env"), "SECRET=value\n", "utf8");
    let called = false;

    const ignored = captureIO();
    const ignoredCode = await runCli(["remember", "Do not capture env", "--files", ".env"], {
      cwd: repo,
      gitRoot: repo,
      env: {},
      io: ignored.io,
      fetchImpl: async () => {
        called = true;
        return new Response("{}", { status: 200 });
      },
    });

    expect(ignoredCode).toBe(1);
    expect(ignored.stderr).toContain("ignored by capture safety rules");
    expect(called).toBe(false);

    const missing = captureIO();
    const missingCode = await runCli(["remember", "Missing file", "--files", "missing.ts"], {
      cwd: repo,
      gitRoot: repo,
      env: {},
      io: missing.io,
      fetchImpl: async () => {
        called = true;
        return new Response("{}", { status: 200 });
      },
    });

    expect(missingCode).toBe(1);
    expect(missing.stderr).toContain("Related file not found");
    expect(called).toBe(false);
  });

  it("applies .rorca-captureignore to manual file refs in CI mode before network access", async () => {
    const repo = tempRepo();
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "blocked.ts"), "export const blocked = true;\n", "utf8");
    writeFileSync(path.join(repo, ".rorca-captureignore"), "src/blocked.ts\n", "utf8");
    const output = captureIO();
    let called = false;

    const code = await runCli(["remember", "Do not capture blocked file", "--files", "src/blocked.ts", "--ci"], {
      cwd: repo,
      gitRoot: repo,
      env: { RORCA_API_URL: "http://api.test", RORCA_WORKSPACE_ID: "ws-ci" },
      io: output.io,
      fetchImpl: async () => {
        called = true;
        return new Response("{}", { status: 200 });
      },
    });

    expect(code).toBe(1);
    expect(output.stderr).toContain("ignored by capture safety rules");
    expect(called).toBe(false);
  });

  it("queues remember candidates when the API is offline", async () => {
    const repo = tempRepo();
    const tokenPath = tokenFile(repo);
    const output = captureIO();
    const queuePath = path.join(repo, ".rorca", "offline.ndjson");

    const code = await runCli(["remember", "Queue this", "--workspace", "ws-offline", "--queue-path", queuePath], {
      cwd: repo,
      gitRoot: repo,
      tokenPath,
      env: {},
      io: output.io,
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });

    expect(code).toBe(0);
    expect(output.stdout).toContain("queued memory candidate");
    const queued = JSON.parse(readFileSync(queuePath, "utf8").trim()) as { endpoint: string; payload: any; attempts: number; retryable: boolean; key: string };
    expect(queued.endpoint).toBe("/api/memory/candidates");
    expect(queued.attempts).toBe(0);
    expect(queued.retryable).toBe(true);
    expect(queued.key).toMatch(/^capture:/);
    expect(queued.payload.workspaceId).toBe("ws-offline");
    expect(queued.payload.idempotencyKey).toMatch(/^memory-candidate:ws-offline:content:/);
  });

  it("uses deterministic source and content idempotency keys", async () => {
    const repo = tempRepo();
    const tokenPath = tokenFile(repo);
    const bodies: any[] = [];

    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/api/workspaces")) {
        return new Response(JSON.stringify({ items: [{ id: "ws-idem", path: repo }] }), { status: 200 });
      }
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ candidate: { id: String(bodies.length), reviewStatus: "pending" }, created: true }), { status: 201 });
    };

    for (const argv of [
      ["remember", "First content", "--source", "ticket-1", "--workspace", "ws-idem"],
      ["remember", "Changed content", "--source", "ticket-1", "--workspace", "ws-idem"],
      ["remember", "Same content", "--workspace", "ws-idem"],
      ["remember", "Same content", "--workspace", "ws-idem"],
    ]) {
      const output = captureIO();
      await expect(runCli(argv, { cwd: repo, gitRoot: repo, tokenPath, env: {}, io: output.io, fetchImpl })).resolves.toBe(0);
    }

    expect(bodies[0].idempotencyKey).toBe(bodies[1].idempotencyKey);
    expect(bodies[2].idempotencyKey).toBe(bodies[3].idempotencyKey);
    expect(bodies[0].idempotencyKey).toMatch(/^memory-candidate:ws-idem:source:/);
    expect(bodies[2].idempotencyKey).toMatch(/^memory-candidate:ws-idem:content:/);
  });

  it("approves only when --approve is requested and operator auto-approval is configured", async () => {
    const repo = tempRepo();
    writeFileSync(path.join(repo, ".rorca", "capture.json"), JSON.stringify({ operatorAutoApprove: true }), "utf8");
    const tokenPath = tokenFile(repo);
    const output = captureIO();
    const calls: string[] = [];

    const code = await runCli(["remember", "Approved note", "--approve", "--workspace", "ws-approve"], {
      cwd: repo,
      gitRoot: repo,
      tokenPath,
      env: {},
      io: output.io,
      fetchImpl: async (url, init) => {
        calls.push(String(url));
        if (String(url).endsWith("/api/workspaces")) {
          return new Response(JSON.stringify({ items: [{ id: "ws-approve", path: repo }] }), { status: 200 });
        }
        if (String(url).endsWith("/api/memory/candidates/901/approve")) {
          return new Response(JSON.stringify({ approved: true, candidate: { id: "901", reviewStatus: "approved" } }), { status: 200 });
        }
        expect(init?.method).toBe("POST");
        return new Response(JSON.stringify({ candidate: { id: "901", reviewStatus: "pending" }, created: true }), { status: 201 });
      },
    });

    expect(code).toBe(0);
    expect(output.stdout).toContain("approved");
    expect(calls).toContain("http://localhost:3030/api/memory/candidates");
    expect(calls).toContain("http://localhost:3030/api/memory/candidates/901/approve");
  });

  it("rejects --approve when operator auto-approval is not configured", async () => {
    const repo = tempRepo();
    const output = captureIO();
    let called = false;

    const code = await runCli(["remember", "No implicit approval", "--approve", "--workspace", "ws"], {
      cwd: repo,
      gitRoot: repo,
      env: {},
      io: output.io,
      fetchImpl: async () => {
        called = true;
        return new Response("{}", { status: 200 });
      },
    });

    expect(code).toBe(1);
    expect(output.stderr).toContain("operatorAutoApprove=true");
    expect(called).toBe(false);
  });

  it("refuses to auto-approve regulated-domain remember candidates by default", async () => {
    const repo = tempRepo();
    writeFileSync(path.join(repo, ".rorca", "capture.json"), JSON.stringify({ operatorAutoApprove: true }), "utf8");
    const tokenPath = tokenFile(repo);
    const output = captureIO();
    let posted = false;

    const code = await runCli(["remember", "HIPAA patient records must be reviewed", "--approve", "--workspace", "ws-regulated"], {
      cwd: repo,
      gitRoot: repo,
      tokenPath,
      env: {},
      io: output.io,
      fetchImpl: async (url) => {
        if (String(url).endsWith("/api/workspaces")) {
          return new Response(JSON.stringify({ items: [{ id: "ws-regulated", path: repo }] }), { status: 200 });
        }
        posted = true;
        return new Response("{}", { status: 500 });
      },
    });

    expect(code).toBe(1);
    expect(output.stderr).toContain("Regulated-domain");
    expect(posted).toBe(false);
  });

  it("dry-runs import-duckbrain JSONL without API writes or auth", async () => {
    const repo = tempRepo();
    const inputPath = path.join(repo, "duckbrain.jsonl");
    writeFileSync(inputPath, JSON.stringify({
      namespace: "cli",
      key: "memory-1",
      content: "CLI DuckBrain memory",
      created_at: "2026-01-02T03:04:05.000Z",
      tags: ["cli", "duckbrain"],
      metadata: { source: "test" },
    }), "utf8");
    const output = captureIO();
    let called = false;

    const code = await runCli(["import-duckbrain", inputPath, "--dry-run", "--json", "--workspace", "ws-duck"], {
      cwd: repo,
      gitRoot: repo,
      env: {},
      io: output.io,
      fetchImpl: async () => {
        called = true;
        return new Response("{}", { status: 500 });
      },
    });

    expect(code).toBe(0);
    expect(called).toBe(false);
    expect(output.stderr).toBe("");
    const parsed = JSON.parse(output.stdout) as { imported: number; skipped: number; dryRun: boolean; candidates: Array<{ namespace: string; key: string; entryHash: string; reviewStatus: string }> };
    expect(parsed).toMatchObject({ dryRun: true, imported: 1, skipped: 0 });
    expect(parsed.candidates[0]).toMatchObject({ namespace: "cli", key: "memory-1", reviewStatus: "pending" });
    expect(parsed.candidates[0].entryHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("submits import-duckbrain candidates through the memory candidate API and reports duplicates", async () => {
    const repo = tempRepo();
    const inputPath = path.join(repo, "duckbrain-live.jsonl");
    writeFileSync(inputPath, JSON.stringify({
      namespace: "cli-live",
      key: "memory-2",
      content: "Live DuckBrain memory",
      tags: ["live"],
      metadata: { source: "test" },
    }), "utf8");
    const tokenPath = tokenFile(repo);
    const output = captureIO();
    let posted: any;

    const code = await runCli(["import-duckbrain", "--path", inputPath, "--json", "--workspace", "ws-duck", "--api-url", "http://api.test"], {
      cwd: repo,
      gitRoot: repo,
      tokenPath,
      env: {},
      io: output.io,
      fetchImpl: workspaceFetch(repo, "ws-duck", (url, body) => {
        expect(url).toBe("http://api.test/api/memory/candidates");
        posted = body;
        return new Response(JSON.stringify({ candidate: { id: "duck-1", reviewStatus: "pending" }, created: false, idempotent: true }), { status: 200 });
      }),
    });

    expect(code).toBe(0);
    expect(posted).toMatchObject({
      workspaceId: "ws-duck",
      eventType: "duckbrain_import",
      sourceSystem: "duckbrain",
      sourceRef: "duckbrain:cli-live:memory-2",
      status: "pending",
      reviewStatus: "pending",
      trustTier: "working_note",
      requiresReview: true,
    });
    expect(posted.provenance).toMatchObject({ namespace: "cli-live", key: "memory-2", originalTags: ["live"], pendingByDefault: true });
    expect(posted.metadata).toMatchObject({ review: { status: "pending", pendingByDefault: true, autoApproved: false } });
    const parsed = JSON.parse(output.stdout) as { imported: number; duplicate: number; candidates: Array<{ candidateId: string; status: string }> };
    expect(parsed).toMatchObject({ imported: 0, duplicate: 1 });
    expect(parsed.candidates[0]).toMatchObject({ candidateId: "duck-1", status: "duplicate" });
  });

  it("dry-runs ingest-commit without POST writes, queue entries, or API auth", async () => {
    const repo = tempRepo();
    initGitRepo(repo);
    const sha = commitFile(repo, "src/app.ts", "export const app = true;\n", "feat: add app");
    const output = captureIO();
    const posts: string[] = [];

    const code = await runCli(["ingest-commit", sha, "--dry-run", "--json", "--workspace", "ws-git"], {
      cwd: repo,
      gitRoot: repo,
      env: {},
      io: output.io,
      fetchImpl: workspaceFetch(repo, "ws-git", (url) => {
        posts.push(url);
        return new Response("{}", { status: 500 });
      }),
    });

    expect(code).toBe(0);
    expect(output.stderr).toBe("");
    expect(posts).toEqual([]);
    const parsed = JSON.parse(output.stdout) as { dryRun: boolean; submitted: number; queued: number; items: Array<{ status: string; sha: string }> };
    expect(parsed.dryRun).toBe(true);
    expect(parsed.submitted).toBe(0);
    expect(parsed.queued).toBe(0);
    expect(parsed.items).toEqual([expect.objectContaining({ status: "dry-run", sha })]);
  });

  it("emits parseable JSON for ingest-commit submissions", async () => {
    const repo = tempRepo();
    initGitRepo(repo);
    const sha = commitFile(repo, "src/feature.ts", "export const feature = 1;\n", "feat: capture feature");
    const tokenPath = tokenFile(repo);
    const output = captureIO();
    const bodies: any[] = [];

    const code = await runCli(["ingest-commit", sha, "--json", "--workspace", "ws-git-json", "--api-url", "http://api.test"], {
      cwd: repo,
      gitRoot: repo,
      tokenPath,
      env: {},
      io: output.io,
      fetchImpl: workspaceFetch(repo, "ws-git-json", (url, body) => {
        expect(url).toBe("http://api.test/api/context-events");
        bodies.push(body);
        return new Response(JSON.stringify({ event: { id: "501" }, created: true, idempotent: false }), { status: 201 });
      }),
    });

    expect(code).toBe(0);
    expect(output.stderr).toBe("");
    const parsed = JSON.parse(output.stdout) as { submitted: number; queued: number; skippedNoise: number; duplicate: number; items: Array<{ status: string }> };
    expect(parsed).toMatchObject({ submitted: 1, queued: 0, skippedNoise: 0, duplicate: 0 });
    expect(parsed.items[0]).toMatchObject({ status: "submitted" });
    expect(bodies[0]).toMatchObject({
      workspaceId: "ws-git-json",
      eventType: "git_commit",
      sourceSystem: "rorca-capture",
      sourceRef: `git:${sha}`,
      relatedFiles: ["src/feature.ts"],
      trustTier: "agent_observation",
    });
    expect(bodies[0].idempotencyKey).toMatch(/^context-event:ws-git-json:git_commit:/);
    expect(bodies[0].metadata.gitSha).toBe(sha);
  });

  it("queues ingest-commit submissions when the API is offline", async () => {
    const repo = tempRepo();
    initGitRepo(repo);
    const sha = commitFile(repo, "src/offline.ts", "export const offline = true;\n", "feat: offline capture");
    const tokenPath = tokenFile(repo);
    const queuePath = path.join(repo, ".rorca", "git-offline.ndjson");
    const output = captureIO();

    const code = await runCli(["ingest-commit", sha, "--workspace", "ws-offline-git", "--queue-path", queuePath, "--json"], {
      cwd: repo,
      gitRoot: repo,
      tokenPath,
      env: {},
      io: output.io,
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });

    expect(code).toBe(0);
    const parsed = JSON.parse(output.stdout) as { queued: number; duplicate: number; items: Array<{ status: string }> };
    expect(parsed).toMatchObject({ queued: 1, duplicate: 0 });
    expect(parsed.items[0].status).toBe("queued");
    const queued = JSON.parse(readFileSync(queuePath, "utf8").trim()) as { endpoint: string; eventType: string; payload: any; key: string };
    expect(queued.endpoint).toBe("/api/context-events");
    expect(queued.eventType).toBe("git_commit");
    expect(queued.payload.workspaceId).toBe("ws-offline-git");
    expect(queued.payload.metadata.gitSha).toBe(sha);
  });

  it("reports duplicate ingest-commit submissions without inserting again", async () => {
    const repo = tempRepo();
    initGitRepo(repo);
    const sha = commitFile(repo, "src/duplicate.ts", "export const duplicate = true;\n", "feat: duplicate capture");
    const tokenPath = tokenFile(repo);
    const output = captureIO();

    const code = await runCli(["ingest-commit", sha, "--json", "--workspace", "ws-dupe"], {
      cwd: repo,
      gitRoot: repo,
      tokenPath,
      env: {},
      io: output.io,
      fetchImpl: workspaceFetch(repo, "ws-dupe", () => new Response(JSON.stringify({ event: { id: "already" }, created: false, idempotent: true }), { status: 200 })),
    });

    expect(code).toBe(0);
    const parsed = JSON.parse(output.stdout) as { submitted: number; duplicate: number; items: Array<{ status: string; eventId: string }> };
    expect(parsed.submitted).toBe(0);
    expect(parsed.duplicate).toBe(1);
    expect(parsed.items[0]).toMatchObject({ status: "duplicate", eventId: "already" });
  });

  it("skips noisy commits using context-safety path filters", async () => {
    const repo = tempRepo();
    initGitRepo(repo);
    const sha = commitFile(repo, ".env", "SECRET_TOKEN=value\n", "chore: local env noise");
    const tokenPath = tokenFile(repo);
    const output = captureIO();
    const posts: string[] = [];

    const code = await runCli(["ingest-commit", sha, "--json", "--workspace", "ws-noise"], {
      cwd: repo,
      gitRoot: repo,
      tokenPath,
      env: {},
      io: output.io,
      fetchImpl: workspaceFetch(repo, "ws-noise", (url) => {
        posts.push(url);
        return new Response("{}", { status: 500 });
      }),
    });

    expect(code).toBe(0);
    expect(posts).toEqual([]);
    const parsed = JSON.parse(output.stdout) as { skippedNoise: number; items: Array<{ status: string; noiseReason: string }> };
    expect(parsed.skippedNoise).toBe(1);
    expect(parsed.items[0]).toMatchObject({ status: "skipped-noise", noiseReason: "all-changed-paths-ignored" });
  });

  it("skips commits ignored by .rorca-captureignore using the same context-safety filter", async () => {
    const repo = tempRepo();
    initGitRepo(repo);
    writeFileSync(path.join(repo, ".rorca-captureignore"), "generated/**\n", "utf8");
    const sha = commitFile(repo, "generated/out.ts", "export const generated = true;\n", "chore: generated output");
    const tokenPath = tokenFile(repo);
    const output = captureIO();
    const posts: string[] = [];

    const code = await runCli(["ingest-commit", sha, "--json", "--workspace", "ws-ignore-file"], {
      cwd: repo,
      gitRoot: repo,
      tokenPath,
      env: {},
      io: output.io,
      fetchImpl: workspaceFetch(repo, "ws-ignore-file", (url) => {
        posts.push(url);
        return new Response("{}", { status: 500 });
      }),
    });

    expect(code).toBe(0);
    expect(posts).toEqual([]);
    const parsed = JSON.parse(output.stdout) as { skippedNoise: number; items: Array<{ status: string; noiseReason: string }> };
    expect(parsed.skippedNoise).toBe(1);
    expect(parsed.items[0]).toMatchObject({ status: "skipped-noise", noiseReason: "all-changed-paths-ignored" });
  });

  it("ingest-git scans ranges oldest-first and counts submitted, skipped, and duplicates", async () => {
    const repo = tempRepo();
    initGitRepo(repo);
    const base = commitFile(repo, "src/base.ts", "export const base = true;\n", "feat: base");
    const noisy = commitFile(repo, ".env", "SECRET_TOKEN=value\n", "chore: env noise");
    const useful = commitFile(repo, "src/useful.ts", "export const useful = true;\n", "feat: useful");
    const tokenPath = tokenFile(repo);
    const output = captureIO();
    const submittedShas: string[] = [];

    const code = await runCli(["ingest-git", "--since", base, "--json", "--workspace", "ws-range"], {
      cwd: repo,
      gitRoot: repo,
      tokenPath,
      env: {},
      io: output.io,
      fetchImpl: workspaceFetch(repo, "ws-range", (_url, body) => {
        submittedShas.push(body.metadata.gitSha);
        const duplicate = body.metadata.gitSha === useful;
        return new Response(JSON.stringify({ event: { id: duplicate ? "existing" : "created" }, created: !duplicate, idempotent: duplicate }), { status: duplicate ? 200 : 201 });
      }),
    });

    expect(code).toBe(0);
    expect(submittedShas).toEqual([useful]);
    expect(noisy).toMatch(/^[0-9a-f]{40}$/);
    const parsed = JSON.parse(output.stdout) as { total: number; submitted: number; skippedNoise: number; duplicate: number; items: Array<{ sha: string; status: string }> };
    expect(parsed).toMatchObject({ total: 2, submitted: 0, skippedNoise: 1, duplicate: 1 });
    expect(parsed.items.map((item) => item.sha)).toEqual([noisy, useful]);
    expect(parsed.items.map((item) => item.status)).toEqual(["skipped-noise", "duplicate"]);
  });

  it("resolves --since last-rorca-run through the API pointer", async () => {
    const repo = tempRepo();
    initGitRepo(repo);
    const before = commitFile(repo, "src/before.ts", "export const before = true;\n", "feat: before", "2026-01-01T00:00:00Z");
    const after = commitFile(repo, "src/after.ts", "export const after = true;\n", "feat: after", "2026-01-02T00:00:00Z");
    const tokenPath = tokenFile(repo);
    const output = captureIO();
    const posted: string[] = [];

    const code = await runCli(["ingest-git", "--since", "last-rorca-run", "--json", "--workspace", "ws-last"], {
      cwd: repo,
      gitRoot: repo,
      tokenPath,
      env: {},
      io: output.io,
      fetchImpl: async (url, init) => {
        const textUrl = String(url);
        if (textUrl.endsWith("/api/workspaces")) {
          return new Response(JSON.stringify({ items: [{ id: "ws-last", path: repo }] }), { status: 200 });
        }
        if (textUrl.endsWith("/api/workspaces/ws-last/capture/last-rorca-run")) {
          return new Response(JSON.stringify({ workspaceId: "ws-last", finishedAt: "2026-01-01T12:00:00.000Z" }), { status: 200 });
        }
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          posted.push(body.metadata.gitSha);
          return new Response(JSON.stringify({ event: { id: "601" }, created: true }), { status: 201 });
        }
        return new Response("{}", { status: 500 });
      },
    });

    expect(code).toBe(0);
    expect(before).toMatch(/^[0-9a-f]{40}$/);
    expect(posted).toEqual([after]);
    const parsed = JSON.parse(output.stdout) as { resolvedSince: string; submitted: number; items: Array<{ sha: string }> };
    expect(parsed.resolvedSince).toBe(before);
    expect(parsed.submitted).toBe(1);
    expect(parsed.items[0].sha).toBe(after);
  });

  it("returns an actionable error when --since last-rorca-run has no pointer", async () => {
    const repo = tempRepo();
    initGitRepo(repo);
    commitFile(repo, "src/app.ts", "export const app = true;\n", "feat: app");
    const tokenPath = tokenFile(repo);
    const output = captureIO();

    const code = await runCli(["ingest-git", "--since", "last-rorca-run", "--workspace", "ws-empty"], {
      cwd: repo,
      gitRoot: repo,
      tokenPath,
      env: {},
      io: output.io,
      fetchImpl: async (url) => {
        const textUrl = String(url);
        if (textUrl.endsWith("/api/workspaces")) {
          return new Response(JSON.stringify({ items: [{ id: "ws-empty", path: repo }] }), { status: 200 });
        }
        if (textUrl.endsWith("/api/workspaces/ws-empty/capture/last-rorca-run")) {
          return new Response(JSON.stringify({ error: "No completed Rorca pipeline run found for workspace 'ws-empty'. Run a pipeline successfully first or pass --since <git-ref>.", code: "CAPTURE_POINTER_NOT_FOUND" }), { status: 422 });
        }
        return new Response("{}", { status: 500 });
      },
    });

    expect(code).toBe(1);
    expect(output.stdout).toBe("");
    expect(output.stderr).toContain("No completed Rorca pipeline run found");
    expect(output.stderr).toContain("pass --since <git-ref>");
  });
});
