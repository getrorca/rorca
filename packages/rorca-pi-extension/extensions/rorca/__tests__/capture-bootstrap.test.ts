import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCaptureBootstrap, type CaptureBootstrapApiClient } from "../capture-bootstrap.js";
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
  it("performs a dry-run without writing files and reports would-install steps", async () => {
    const { root, home, workspace } = makeRepo();

    const report = await runCaptureBootstrap({
      alwaysOn: true,
      dryRun: true,
      cwd: root,
      homeDir: home,
      apiClient: api(workspace),
      env: { SHELL: "/bin/zsh", PATH: "" },
    });

    expect(report.status).toBe("dry-run");
    expect(report.summary["would-install"]).toBeGreaterThan(0);
    expect(existsSync(path.join(root, ".rorca", "capture", "sidecar.json"))).toBe(false);
    expect(report.nextActions.join("\n")).toContain("Rerun without --dry-run");
  });

  it("is idempotent and creates uninstall metadata for managed artifacts", async () => {
    const { root, home, workspace } = makeRepo();

    const first = await runCaptureBootstrap({
      alwaysOn: true,
      cwd: root,
      homeDir: home,
      apiClient: api(workspace),
      env: { SHELL: "/bin/bash", PATH: "" },
    });
    const second = await runCaptureBootstrap({
      alwaysOn: true,
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
    expect(readFileSync(path.join(root, ".git", "hooks", "post-commit"), "utf8")).toContain("rorca-managed: v1");
  });

  it("reports partial capability detection as degraded when IDE support is unavailable", async () => {
    const { root, home, workspace } = makeRepo();
    const oldPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const report = await runCaptureBootstrap({
        alwaysOn: true,
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
      cwd: root,
      homeDir: home,
      apiClient: api(workspace),
    });

    expect(report.ok).toBe(false);
    expect(report.failed.find((item) => item.id === "mcp-token")?.message).toContain("expected 600");
    expect((statSync(tokenPath).mode & 0o777).toString(8)).toBe("644");
  });
});
