import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HELP_TEXT, runCli } from "../cli.js";
import { buildCaptureStatus, formatStatusText } from "../status.js";
import { resolveCaptureConfig } from "../config.js";

function tempRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), "rorca-capture-cli-"));
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

describe("rorca-capture CLI", () => {
  it("exposes MVP commands in help", async () => {
    for (const command of ["remember", "ingest-commit", "ingest-git", "install-hooks", "daemon", "status", "flush"]) {
      expect(HELP_TEXT).toContain(command);
    }
    expect(HELP_TEXT).toContain("rorca capture <command>");
    expect(HELP_TEXT).toContain("API-only");

    const output = captureIO();
    await expect(runCli(["--help"], { io: output.io })).resolves.toBe(0);
    expect(output.stdout).toContain("MVP commands");
    expect(output.stderr).toBe("");
  });

  it("prints status output with config, workspace, token, and command shape", async () => {
    const repo = tempRepo();
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
    expect(output.stdout).toContain("API-only: yes");
    expect(output.stdout).toContain("Commands: remember, ingest-commit, ingest-git, install-hooks, daemon, status, flush");
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
    expect(parsed.commands).toEqual(["remember", "ingest-commit", "ingest-git", "install-hooks", "daemon", "status", "flush"]);
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
});
