import { mkdirSync, mkdtempSync, writeFileSync, chmodSync } from "node:fs";
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
    for (const command of ["remember", "ingest-commit", "ingest-git", "install-hooks", "daemon", "status"]) {
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
    expect(output.stdout).toContain("Commands: remember, ingest-commit, ingest-git, install-hooks, daemon, status");
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
    expect(parsed.commands).toEqual(["remember", "ingest-commit", "ingest-git", "install-hooks", "daemon", "status"]);
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
});
