/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCaptureBootstrap, runCaptureTeardown, type CaptureBootstrapApiClient } from "../capture-bootstrap.js";
import { resolveCaptureServicePaths, runManagedCaptureDaemon } from "../capture-service.js";
import type { Workspace } from "../types.js";
import { distillContextEventToCandidate, isCandidateVisibleInDefaultRetrieval, type MemoryCandidateDraft, type MemoryCandidateStatus } from "../../../../../backend/src/lib/context-distillation.js";
import { renderMemoryMd, type MemoryProjectionRow } from "../../../../../backend/src/lib/memory-projection.js";
import type { UnifiedContextEventPayloadType } from "../../../../../backend/src/lib/pg-boss-schemas.js";

const temps: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function createFreshWorkspace(): Workspace {
  const root = tempDir("rorca-capture-e2e-");
  runGit(root, ["init"]);
  runGit(root, ["config", "user.email", "capture-e2e@example.test"]);
  runGit(root, ["config", "user.name", "Rorca Capture E2E"]);
  writeFileSync(path.join(root, "README.md"), "# Capture E2E\n", "utf8");
  runGit(root, ["add", "README.md"]);
  runGit(root, ["commit", "-m", "Convention: always restore search_path after AGE graph queries"]);
  return { id: `capture-${path.basename(root)}`, label: "Capture E2E", path: root };
}

function createHomeWithToken(): string {
  const home = tempDir("rorca-capture-home-");
  const tokenDir = path.join(home, ".rorca");
  mkdirSync(tokenDir, { recursive: true });
  const tokenPath = path.join(tokenDir, "mcp-token");
  writeFileSync(tokenPath, "local-test-token\n", { encoding: "utf8", mode: 0o600 });
  try { spawnSync("chmod", ["600", tokenPath]); } catch { /* Windows ignores POSIX mode check. */ }
  return home;
}

function apiClientFor(workspace: Workspace): CaptureBootstrapApiClient {
  return {
    baseUrl: "http://127.0.0.1:3030",
    async getHealth() { return { status: "ok", version: "test", mcp: { enabled: true, status: "healthy", url: "http://127.0.0.1:3030/mcp", sessions: 0 } }; },
    async listWorkspaces() { return [workspace]; },
    async verifyCaptureBootstrap(input) {
      expect(input.workspaceId).toBe(workspace.id);
      expect(input.queuePath).toBe(path.join(workspace.path, ".rorca", "capture", "queue"));
      return { ok: true };
    },
    async configureCapturePolicy(input) {
      expect(input.policyMode).toBe("repo-and-command");
      return { ok: true };
    },
  };
}

const baseIdentity = (workspace: Workspace) => ({
  payload_schema_version: "2026-07-ucc-007.v1" as const,
  source_identity: {
    source_system: "pi" as const,
    tool_name: "pi",
    host_application: null,
    session_id: "pi-session-1",
    workspace_id: workspace.id,
    repo_path_hash: "sha256:repo",
  },
  source_system: "pi" as const,
  tool_name: "pi",
  host_application: null,
  session_id: "pi-session-1",
  workspace_id: workspace.id,
  repo_path_hash: "sha256:repo",
  git_branch: "main",
  git_sha: "abc1234",
  related_files: [{ path: "backend/src/db/index.ts", role: "mentioned" as const, hash: null }],
  capture_policy: { policy_version: "2026-07-ucc-007", mode: "repo-and-command", raw_content: "summary" },
  trust_tier: "local" as const,
  idempotency_key: `sha256:${"a".repeat(64)}`,
  provenance: {
    capture_source: "agentAdapter" as const,
    source_event_id: "agent-command-1",
    adapter_version: "test",
    emitted_at: "2026-07-06T00:00:00.000Z",
    received_at: "2026-07-06T00:00:01.000Z",
    local_only: true,
  },
});

function agentCommandEvent(workspace: Workspace): UnifiedContextEventPayloadType {
  return {
    ...baseIdentity(workspace),
    eventType: "agent_cli_session",
    phase: "end",
    policyMode: "repo-and-command",
    command_summary: "Gotcha: pg-boss queue creation must precede send to avoid silent null jobs.",
    command_hash: "cmd-hash-1".padEnd(16, "0"),
    cwd: workspace.path,
    exit_code: 0,
    duration_ms: 123,
    agent: { recognized: true, binary: "pi", matchedPattern: "pi" },
    regulated_signals: [],
  } as UnifiedContextEventPayloadType;
}

function ideEvent(workspace: Workspace): UnifiedContextEventPayloadType {
  return {
    ...baseIdentity(workspace),
    eventType: "editor_activity",
    source_system: "ide",
    tool_name: "rorca-vscode-extension",
    host_application: "vscode",
    source_identity: { ...baseIdentity(workspace).source_identity, source_system: "ide", tool_name: "rorca-vscode-extension", host_application: "vscode" },
    activity_type: "diagnostic",
    document_uri_hash: "doc-hash-1",
    language_id: "typescript",
    summary: "Architecture: VS Code forks are degraded when extension APIs are unavailable; shell and git fallback capture remains active.",
    provenance: { ...baseIdentity(workspace).provenance, capture_source: "vscodeExtension", source_event_id: "ide-event-1" },
  } as UnifiedContextEventPayloadType;
}

function candidateFrom(payload: UnifiedContextEventPayloadType, eventId: number): MemoryCandidateDraft {
  const candidate = distillContextEventToCandidate({ eventId, occurredAt: "2026-07-06T00:00:00.000Z", payload, safetyContentHash: `hash-${eventId}` });
  if (!candidate) throw new Error(`Expected candidate for ${payload.eventType}`);
  return candidate;
}

describe("UCC-012 compatibility lab E2E harness", () => {
  it("runs setup through capture, distillation, approval, MEMORY.md projection, retrieval gating, and uninstall without spawned daemons", async () => {
    const workspace = createFreshWorkspace();
    const home = createHomeWithToken();

    const setup = await runCaptureBootstrap({
      alwaysOn: true,
      dryRun: false,
      cwd: workspace.path,
      homeDir: home,
      workspaceId: workspace.id,
      apiClient: apiClientFor(workspace),
      env: { SHELL: "/bin/zsh", PATH: process.env.PATH },
      policyMode: "repo-and-command",
    });
    expect(setup.ok).toBe(true);
    expect(setup.steps.map((step) => step.id)).toContain("agent-adapter:pi");
    expect(existsSync(path.join(workspace.path, ".pi", "extensions", "rorca", "capture-command.json"))).toBe(true);

    const posted: Array<{ id: string; payload: UnifiedContextEventPayloadType }> = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/health")) return new Response("{}", { status: 200 });
      posted.push(JSON.parse(String(init?.body)) as { id: string; payload: UnifiedContextEventPayloadType });
      return new Response("{}", { status: 200 });
    };

    await runManagedCaptureDaemon({ workspace, once: true, fetchImpl });
    expect(posted.some((event) => event.payload.eventType === "git_commit")).toBe(true);
    expect(readFileSync(resolveCaptureServicePaths(workspace).statusFile, "utf8")).toContain("repoDaemon");

    const gitPayload = posted.find((event) => event.payload.eventType === "git_commit")?.payload;
    if (!gitPayload) throw new Error("Expected a git commit payload");
    const candidates = [candidateFrom(gitPayload, 1), candidateFrom(agentCommandEvent(workspace), 2), candidateFrom(ideEvent(workspace), 3)];
    expect(candidates.map((candidate) => candidate.provenance.sourceEventType)).toEqual(["git_commit", "agent_cli_session", "editor_activity"]);
    expect(candidates.every((candidate) => candidate.defaultRetrievalEligible === false)).toBe(true);

    const statuses = new Map<number, MemoryCandidateStatus>([
      [0, "approved"],
      [1, "rejected"],
      [2, "pending"],
    ]);
    const approved = candidates[0];
    const durableMemories: MemoryProjectionRow[] = [{
      category: approved.category,
      content: approved.content,
      confidence: approved.confidence,
      source_story_id: "UCC-012",
      created_at: new Date("2026-07-06T00:00:00.000Z"),
    }];
    const memoryMd = renderMemoryMd(durableMemories);
    writeFileSync(path.join(workspace.path, "MEMORY.md"), memoryMd, "utf8");

    const defaultRetrieval = candidates.filter((_candidate, index) => isCandidateVisibleInDefaultRetrieval(statuses.get(index)!));
    expect(defaultRetrieval).toEqual([approved]);
    expect(memoryMd).toContain(approved.content);
    expect(memoryMd).not.toContain(candidates[1].content);
    expect(memoryMd).not.toContain(candidates[2].content);

    const teardown = runCaptureTeardown({ cwd: workspace.path, homeDir: home, shells: ["zsh", "bash", "fish", "powershell"], all: true });
    expect(teardown.ok).toBe(true);
    expect(existsSync(path.join(workspace.path, ".rorca", "capture", "service.pid"))).toBe(false);
    expect(existsSync(path.join(workspace.path, ".rorca", "capture", "queue"))).toBe(false);
  });

  it("documents compatibility smoke coverage for agent CLIs, shells, VS Code forks, and proprietary IDE caveats", () => {
    const docs = readFileSync(path.join(process.cwd(), "docs", "universal-context-capture.md"), "utf8");
    for (const required of ["Pi", "Claude Code", "Codex", "OpenCode", "zsh", "bash", "fish", "PowerShell", "VS Code", "VSCodium", "Cursor", "Windsurf"]) {
      expect(docs).toContain(required);
    }
    expect(docs).toContain("Proprietary chat panes cannot be scraped");
    expect(docs).toContain("fallback layers continue to capture repo, shell, and git context");
    expect(docs).toContain("npm run test:capture");
  });
});
