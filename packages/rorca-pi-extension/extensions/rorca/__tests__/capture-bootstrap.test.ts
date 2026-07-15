import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderAgentAdapterConfig, renderAgentWrapperScript, runCaptureBootstrap, runCaptureTeardown, type CaptureBootstrapApiClient } from "../capture-bootstrap.js";
import { readCaptureServiceStatus } from "../capture-service.js";
import type { Workspace } from "../types.js";

const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rorca-capture-bootstrap-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeRepo(): { root: string; home: string; workspace: Workspace } {
  const root = tempDir();
  const home = tempDir();
  mkdirSync(path.join(root, ".git", "hooks"), { recursive: true });
  mkdirSync(path.join(home, ".rorca"), { recursive: true });
  const tokenPath = path.join(home, ".rorca", "mcp-token");
  writeFileSync(tokenPath, "public-token\n", "utf8");
  chmodSyncIfSupported(tokenPath, 0o600);
  return { root, home, workspace: { id: "demo", label: "Demo", path: root } };
}

function chmodSyncIfSupported(filePath: string, mode: number): void {
  if (process.platform !== "win32") {
    chmodSync(filePath, mode);
  }
}

function api(workspace: Workspace, overrides: Partial<CaptureBootstrapApiClient> = {}): CaptureBootstrapApiClient {
  return {
    baseUrl: "http://127.0.0.1:3030",
    async getHealth() {
      return { status: "ok", version: "test" };
    },
    async listWorkspaces() {
      return [workspace];
    },
    async verifyCaptureBootstrap() {
      return { ok: true, workspace, checks: [] };
    },
    ...overrides,
  };
}

describe("runCaptureBootstrap", () => {
  it("requires an explicit setup policy and does not default to silent capture", async () => {
    const { root, home, workspace } = makeRepo();

    const report = await runCaptureBootstrap({
      alwaysOn: true,
      dryRun: true,
      cwd: root,
      homeDir: home,
      apiClient: api(workspace),
      env: { SHELL: "/bin/zsh", PATH: "" },
    });

    expect(report.ok).toBe(false);
    expect(report.failed.find((item) => item.id === "capture-policy-choice")?.message).toContain("explicit --policy choice");
    expect(existsSync(path.join(root, ".rorca", "capture", "sidecar.json"))).toBe(false);
  });

  it("performs a dry-run without writing files and reports would-install steps", async () => {
    const { root, home, workspace } = makeRepo();

    const report = await runCaptureBootstrap({
      alwaysOn: true,
      policyMode: "metadata-only",
      dryRun: true,
      cwd: root,
      homeDir: home,
      apiClient: api(workspace),
      env: { SHELL: "/bin/zsh", PATH: "" },
    });

    expect(report.status).toBe("dry-run");
    expect(report.summary["would-install"]).toBeGreaterThan(0);
    expect(report.wouldInstall.length).toBe(report.summary["would-install"]);
    expect(report.skipped.every((item) => item.status === "skipped")).toBe(true);
    expect(existsSync(path.join(root, ".rorca", "capture", "sidecar.json"))).toBe(false);
    expect(report.nextActions.join("\n")).toContain("Rerun without --dry-run");
  });

  it("is idempotent and creates uninstall metadata for managed artifacts", async () => {
    const { root, home, workspace } = makeRepo();

    const first = await runCaptureBootstrap({
      alwaysOn: true,
      policyMode: "metadata-only",
      cwd: root,
      homeDir: home,
      apiClient: api(workspace),
      env: { SHELL: "/bin/bash", PATH: "" },
    });
    const second = await runCaptureBootstrap({
      alwaysOn: true,
      policyMode: "metadata-only",
      cwd: root,
      homeDir: home,
      apiClient: api(workspace),
      env: { SHELL: "/bin/bash", PATH: "" },
    });

    expect(first.summary.installed).toBeGreaterThan(0);
    expect(second.summary.installed).toBe(0);
    expect(second.summary.skipped).toBeGreaterThan(first.summary.skipped - 1);

    const uninstallPath = path.join(root, ".rorca", "capture", "uninstall.json");
    const metadata = JSON.parse(readFileSync(uninstallPath, "utf8")) as { rorcaManaged: string; command: string; removes: string[] };
    expect(metadata.rorcaManaged).toBe("v1");
    expect(metadata.command).toBe("rorca capture teardown");
    expect(metadata.removes).toContain(path.join(root, ".rorca-captureignore"));
    const postCommitHook = readFileSync(path.join(root, ".git", "hooks", "post-commit"), "utf8");
    expect(postCommitHook).toContain("rorca-managed: v1");
    expect(postCommitHook).toContain('git rev-parse --verify HEAD');
    expect(postCommitHook).toContain('"gitSha":"%s"');
    expect(postCommitHook).toContain('tail -n 1000');
  });

  it("propagates an explicit policy change to local status and generated agent wrappers", async () => {
    const { root, home, workspace } = makeRepo();
    const options = { alwaysOn: true, cwd: root, homeDir: home, apiClient: api(workspace), env: { SHELL: "/bin/zsh", PATH: "" } };
    const wrapperPath = path.join(root, ".rorca", "capture", "adapters", "codex", "rorca-codex-wrapper.sh");

    await runCaptureBootstrap({ ...options, policyMode: "metadata-only" });
    expect(readCaptureServiceStatus(workspace).capturePolicy.mode).toBe("metadata-only");
    expect(readFileSync(wrapperPath, "utf8")).toContain("--policy 'metadata-only'");

    await runCaptureBootstrap({ ...options, policyMode: "repo-and-command" });
    expect(readCaptureServiceStatus(workspace).capturePolicy.mode).toBe("repo-and-command");
    expect(readFileSync(wrapperPath, "utf8")).toContain("--policy 'repo-and-command'");
  });

  it("uses backend-assisted verification with the planned workspace-scoped paths", async () => {
    const { root, home, workspace } = makeRepo();
    const observed: unknown[] = [];

    const report = await runCaptureBootstrap({
      alwaysOn: true,
      policyMode: "metadata-only",
      cwd: root,
      homeDir: home,
      apiClient: api(workspace, {
        async verifyCaptureBootstrap(input) {
          observed.push(input);
          return { ok: true, workspace, checks: [] };
        },
      }),
      env: { SHELL: "/bin/bash", PATH: "" },
    });

    expect(report.failed).toEqual([]);
    expect(observed).toEqual([{
      workspaceId: "demo",
      workspacePath: root,
      queuePath: path.join(root, ".rorca", "capture", "queue"),
      redactionConfigPath: path.join(root, ".rorca", "capture", "redaction.json"),
      captureIgnorePath: path.join(root, ".rorca-captureignore"),
      policyMode: "metadata-only",
    }]);
  });

  it("blocks file writes when backend-assisted verification fails", async () => {
    const { root, home, workspace } = makeRepo();

    const report = await runCaptureBootstrap({
      alwaysOn: true,
      policyMode: "metadata-only",
      cwd: root,
      homeDir: home,
      apiClient: api(workspace, {
        async verifyCaptureBootstrap() {
          throw new Error("redactionConfigPath must be canonical");
        },
      }),
    });

    expect(report.ok).toBe(false);
    expect(report.failed.map((item) => item.id)).toContain("backend-assisted-onboarding");
    expect(existsSync(path.join(root, ".rorca", "capture", "sidecar.json"))).toBe(false);
  });

  it("tears down only sentinel-managed artifacts from uninstall metadata", async () => {
    const { root, home, workspace } = makeRepo();
    await runCaptureBootstrap({
      alwaysOn: true,
      policyMode: "metadata-only",
      cwd: root,
      homeDir: home,
      apiClient: api(workspace),
      env: { SHELL: "/bin/zsh", PATH: "" },
    });

    const protectedFile = path.join(root, ".rorca", "capture", "protected.txt");
    writeFileSync(protectedFile, "user file", "utf8");
    const uninstallPath = path.join(root, ".rorca", "capture", "uninstall.json");
    const metadata = JSON.parse(readFileSync(uninstallPath, "utf8")) as { removes: string[] };
    metadata.removes.push(protectedFile);
    writeFileSync(uninstallPath, JSON.stringify({ rorcaManaged: "v1", uninstall: "rorca capture teardown", ...metadata }, null, 2), "utf8");

    const dryRun = runCaptureTeardown({ dryRun: true, cwd: root, homeDir: home, env: { SHELL: "/bin/zsh" } });
    expect(dryRun.steps.some((item) => item.status === "would-install" && item.path === path.join(root, ".rorca-captureignore"))).toBe(true);
    expect(existsSync(path.join(root, ".rorca-captureignore"))).toBe(true);

    const teardown = runCaptureTeardown({ cwd: root, homeDir: home, env: { SHELL: "/bin/zsh" } });
    expect(teardown.ok).toBe(true);
    expect(existsSync(path.join(root, ".rorca-captureignore"))).toBe(false);
    expect(existsSync(path.join(root, ".git", "hooks", "post-commit"))).toBe(false);
    expect(existsSync(uninstallPath)).toBe(false);
    expect(readFileSync(protectedFile, "utf8")).toBe("user file");
    expect(teardown.steps.find((item) => item.path === protectedFile)?.status).toBe("degraded");
  });

  it("reports partial capability detection as degraded when IDE support is unavailable", async () => {
    const { root, home, workspace } = makeRepo();
    const oldPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const report = await runCaptureBootstrap({
        alwaysOn: true,
        policyMode: "metadata-only",
        cwd: root,
        homeDir: home,
        apiClient: api(workspace),
        env: { SHELL: "/bin/zsh", PATH: "" },
      });

      const ide = report.steps.find((item) => item.id === "ide-adapter");
      expect(ide?.status).toBe("degraded");
      expect(ide?.details?.fallbackSources).toContain("gitHook");
      expect(report.status).toBe("degraded");
    } finally {
      process.env.PATH = oldPath;
    }
  });

  it("fails safely when the MCP token path is missing", async () => {
    const root = tempDir();
    const home = tempDir();
    mkdirSync(path.join(root, ".git", "hooks"), { recursive: true });
    const workspace = { id: "demo", label: "Demo", path: root };

    const report = await runCaptureBootstrap({
      alwaysOn: true,
      policyMode: "metadata-only",
      cwd: root,
      homeDir: home,
      apiClient: api(workspace),
    });

    expect(report.ok).toBe(false);
    expect(report.failed.map((item) => item.id)).toContain("mcp-token");
    expect(existsSync(path.join(root, ".rorca", "capture", "queue"))).toBe(false);
  });

  it("fails safely when API reachability or backend-assisted verification fails", async () => {
    const { root, home, workspace } = makeRepo();

    const report = await runCaptureBootstrap({
      alwaysOn: true,
      policyMode: "metadata-only",
      cwd: root,
      homeDir: home,
      apiClient: api(workspace, {
        async getHealth() {
          throw new Error("connection refused");
        },
      }),
    });

    expect(report.ok).toBe(false);
    expect(report.failed.map((item) => item.id)).toContain("api-reachability");
    expect(existsSync(path.join(root, ".rorca", "capture", "sidecar.json"))).toBe(false);
  });

  it("verifies token file permissions", async () => {
    if (process.platform === "win32") return;
    const { root, home, workspace } = makeRepo();
    const tokenPath = path.join(home, ".rorca", "mcp-token");
    chmodSyncIfSupported(tokenPath, 0o644);

    const report = await runCaptureBootstrap({
      alwaysOn: true,
      policyMode: "metadata-only",
      cwd: root,
      homeDir: home,
      apiClient: api(workspace),
    });

    expect(report.ok).toBe(false);
    expect(report.failed.find((item) => item.id === "mcp-token")?.message).toContain("expected 600");
    expect((statSync(tokenPath).mode & 0o777).toString(8)).toBe("644");
  });

  it("renders agent adapter configs with metadata and without token leakage", async () => {
    const { root, home, workspace } = makeRepo();
    const report = await runCaptureBootstrap({
      alwaysOn: true,
      policyMode: "metadata-only",
      cwd: root,
      homeDir: home,
      apiClient: api(workspace),
      env: { SHELL: "/bin/zsh", PATH: "" },
    });

    expect(report.steps.map((item) => item.id)).toContain("agent-adapter:claude-code");
    const artifacts = [
      path.join(root, ".pi", "extensions", "rorca", "capture-command.json"),
      path.join(root, ".rorca", "capture", "adapters", "claude-code", "slash-commands.json"),
      path.join(root, ".rorca", "capture", "adapters", "codex", "adapter.json"),
      path.join(root, ".rorca", "capture", "adapters", "opencode", "adapter.json"),
    ];
    const expectedSourceSystemByArtifact = new Map([
      [artifacts[0], "pi"],
      [artifacts[1], "claude_code"],
      [artifacts[2], "codex"],
      [artifacts[3], "opencode"],
    ]);
    for (const artifact of artifacts) {
      const content = readFileSync(artifact, "utf8");
      const config = JSON.parse(content) as { metadata: { source_system: string; tool_name: string; session_id: string }; rememberCommand: string; tokenFile: string };
      expect(content).toContain("source_system");
      expect(content).toContain("tool_name");
      expect(content).toContain("session_id");
      expect(content).toContain("rorca-capture remember");
      expect(content).toContain("~/.rorca/mcp-token");
      expect(config.metadata.source_system).toBe(expectedSourceSystemByArtifact.get(artifact));
      expect(config.metadata.tool_name).toBeTruthy();
      expect(config.metadata.session_id).toMatch(/\$\{.+:-manual\}/);
      expect(config.rememberCommand).toContain("--source-system");
      expect(config.rememberCommand).toContain("--session-id");
      expect(config.tokenFile).toBe("~/.rorca/mcp-token");
      expect(content).not.toContain("public-token");
      expect(content).not.toMatch(/Bearer\s+[A-Za-z0-9._~+/-]+=*/);
      expect(content).not.toMatch(/(?:api[_-]?key|secret|password)\s*[:=]\s*[A-Za-z0-9._~+/-]{16,}/i);
    }
  });

  it("documents Claude Code slash/MCP commands without embedding bearer tokens", () => {
    const { workspace } = makeRepo();
    const config = renderAgentAdapterConfig("claude-code", workspace, "http://127.0.0.1:3030");
    expect(config).toContain("/rorca-remember");
    expect(config).toContain("bearer-token-file");
    expect(config).toContain("~/.rorca/mcp-token");
    expect(config).toContain("source_system");
    expect(config).not.toContain("Bearer ");
    expect(config).not.toMatch(/[A-Za-z0-9_=-]{32,}/);
  });

  it("renders Codex/OpenCode wrappers that preserve tool exit codes", () => {
    if (process.platform === "win32") return;
    const { workspace } = makeRepo();
    const dir = tempDir();
    const fakeTool = path.join(dir, "codex-real");
    const fakeCapture = path.join(dir, "rorca-capture");
    const wrapper = path.join(dir, "rorca-codex-wrapper.sh");
    writeFileSync(fakeTool, "#!/bin/sh\necho native-tool \"$@\"\nexit 42\n", "utf8");
    writeFileSync(fakeCapture, "#!/bin/sh\nexit 0\n", "utf8");
    writeFileSync(wrapper, renderAgentWrapperScript("codex", workspace, fakeCapture), "utf8");
    chmodSync(fakeTool, 0o755);
    chmodSync(fakeCapture, 0o755);
    chmodSync(wrapper, 0o755);

    const result = spawnSync(wrapper, ["exec", "--dangerously-bypass-approvals-and-sandbox", "-m", "gpt-5"], {
      env: { ...process.env, RORCA_CODEX_BIN: fakeTool, CODEX_SESSION_ID: "session-1" },
      encoding: "utf8",
    });

    expect(result.status).toBe(42);
    expect(result.stdout).toContain("native-tool exec --dangerously-bypass-approvals-and-sandbox -m gpt-5");
  });

  it("renders wrapper fallback mode when the native tool binary is missing", () => {
    if (process.platform === "win32") return;
    const { workspace } = makeRepo();
    const dir = tempDir();
    const wrapper = path.join(dir, "rorca-opencode-wrapper.sh");
    writeFileSync(wrapper, renderAgentWrapperScript("opencode", workspace, "rorca-capture"), "utf8");
    chmodSync(wrapper, 0o755);

    const result = spawnSync(wrapper, ["run"], { env: { PATH: "" }, encoding: "utf8" });

    expect(result.status).toBe(127);
    expect(result.stderr).toContain("binary not found");
    expect(result.stderr).toContain("rorca-capture remember");
  });
});
