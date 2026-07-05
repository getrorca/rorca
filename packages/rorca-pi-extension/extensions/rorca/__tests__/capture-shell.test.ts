import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildShellCaptureEvent,
  detectAgentBinary,
  enqueueShellCaptureEvent,
  installManagedShellBlock,
  managedSourceBlock,
  renderShellSnippet,
  shellStartupFile,
  uninstallManagedShellBlock,
  type CaptureShell,
} from "../capture-shell.js";
import { runCaptureTeardown } from "../capture-bootstrap.js";
import type { Workspace } from "../types.js";

const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rorca-capture-shell-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): Workspace {
  const root = tempDir();
  mkdirSync(path.join(root, ".git"), { recursive: true });
  return { id: "demo", label: "Demo", path: root };
}

describe("shell snippet generation", () => {
  it("renders zsh, bash, fish, and PowerShell snippets with clear sentinels and emit hooks", () => {
    const ws = workspace();
    for (const shell of ["zsh", "bash", "fish", "powershell"] as CaptureShell[]) {
      const snippet = renderShellSnippet(shell, { workspace: ws, command: "rorca-capture" });
      expect(snippet).toContain(">>> rorca-capture always-on");
      expect(snippet).toContain("<<< rorca-capture always-on");
      expect(snippet).toContain("emit shell");
      expect(snippet).toContain("--phase");
      expect(snippet).toContain("--command");
    }
  });

  it("installs idempotent startup blocks and uninstalls only the managed sentinel block", () => {
    const home = tempDir();
    const profile = shellStartupFile("zsh", home);
    mkdirSync(path.dirname(profile), { recursive: true });
    const original = "export USER_CONFIG=1\n";
    const block = managedSourceBlock("zsh", "/tmp/rorca-capture.zsh.sh");
    expect(installManagedShellBlock(profile, block)).toBe("installed");
    expect(installManagedShellBlock(profile, block)).toBe("skipped");
    const withUserConfig = `${original}${readFileSync(profile, "utf8")}`;
    expect(withUserConfig).toContain("USER_CONFIG");
    expect(uninstallManagedShellBlock(profile)).toBe("removed");
    expect(readFileSync(profile, "utf8")).not.toContain("rorca-capture always-on");
  });

  it("runCaptureTeardown removes managed shell startup blocks", () => {
    const home = tempDir();
    const profile = shellStartupFile("bash", home);
    installManagedShellBlock(profile, managedSourceBlock("bash", "/tmp/rorca.sh"));
    const result = runCaptureTeardown({ homeDir: home, cwd: tempDir(), shells: ["bash"] });
    expect(result.ok).toBe(true);
    expect(readFileSync(profile, "utf8")).not.toContain("rorca-capture always-on");
  });
});

describe("command capture normalization and safety", () => {
  it("redacts env assignments, tokens, capture-ignored paths, and flags regulated signals before queueing", () => {
    const ws = workspace();
    const event = buildShellCaptureEvent({
      workspaceId: ws.id,
      workspacePath: ws.path,
      cwd: ws.path,
      policyMode: "command-summary",
      command: "API_KEY=super-secret claude --file secrets/token.txt --note 123-45-6789",
      exitCode: 2,
      captureIgnorePatterns: ["secrets/"],
    });
    expect(event).not.toBeNull();
    expect(event?.payload.command_summary).toContain("[REDACTED]");
    expect(event?.payload.command_summary).toContain("[REDACTED_PATH]");
    expect(event?.payload.exit_code).toBe(2);
    expect(event?.payload.agent.binary).toBe("claude");
    expect(event?.payload.source_system).toBe("shell");
    expect(event?.payload.tool_name).toBe("claude");
    expect(event?.payload.session_id).toBe("shell");
    expect(event?.payload.regulated_signals).toContain("possible_ssn");
    expect(event?.payload.payload_schema_version).toBe("2026-07-ucc-007.v1");
    expect(event?.payload.idempotency_key).toMatch(/^sha256:/);
    expect(JSON.stringify(event)).not.toContain("super-secret");
    expect(JSON.stringify(event)).not.toContain("secrets/token.txt");
  });

  it("records unknown commands at metadata-only level when policy allows", () => {
    const ws = workspace();
    const event = buildShellCaptureEvent({ workspaceId: ws.id, workspacePath: ws.path, cwd: ws.path, command: "make deploy SECRET=abc", policyMode: "metadata-only", sessionId: "session-123" });
    expect(event?.payload.eventType).toBe("shell_command");
    expect(event?.payload.source_system).toBe("shell");
    expect(event?.payload.tool_name).toBe("shell");
    expect(event?.payload.session_id).toBe("session-123");
    expect(event?.payload.command_summary).toBeNull();
    expect(event?.payload.agent.binary).toBe("unknown");
  });

  it("detects built-in and custom agent binaries", () => {
    for (const binary of ["claude", "codex", "opencode", "pi", "aider", "cursor"]) {
      expect(detectAgentBinary(`${binary} run`).binary).toBe(binary);
    }
    expect(detectAgentBinary("my-agent do work", ["my-agent"]).binary).toBe("custom");
  });

  it("queues shell events to offline.ndjson when backend posting is unavailable", () => {
    const ws = workspace();
    const queuePath = path.join(ws.path, ".rorca", "capture", "queue");
    const event = buildShellCaptureEvent({ workspaceId: ws.id, workspacePath: ws.path, cwd: ws.path, command: "opencode run", policyMode: "command-summary" });
    expect(event).not.toBeNull();
    enqueueShellCaptureEvent(queuePath, event!);
    expect(existsSync(path.join(queuePath, "offline.ndjson"))).toBe(true);
    expect(readFileSync(path.join(queuePath, "offline.ndjson"), "utf8")).toContain("agent_cli_session");
  });
});
