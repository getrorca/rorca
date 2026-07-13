import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { applyMemoryCandidateGovernance, enqueueCaptureEvent, queuePathForWorkspace, readQueuedCaptureEvents, RorcaCaptureClient } from "../src/client.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Rorca VS Code capture client", () => {
  test("redacts through backend context-safety and queues when API is unavailable", async () => {
    const workspacePath = mkdtempSync(path.join(os.tmpdir(), "rorca-vscode-client-"));
    tmpDirs.push(workspacePath);
    const client = new RorcaCaptureClient({
      apiBaseUrl: "http://127.0.0.1:3030",
      queuePath: queuePathForWorkspace(workspacePath),
      queueMaxSize: 10,
      fetchImpl: async () => ({ ok: false }) as Response,
    });

    const result = await client.submit({
      workspaceId: "ws",
      workspacePath,
      eventType: "explicit_memory",
      policyMode: "command-summary",
      occurredAt: "2026-07-05T00:00:00.000Z",
      payload: { memory_summary: "password=hunter2 token=abcdefghijklmnopqrstuvwxyz1234567890", category: "Decision", requested_by: "human" },
    });

    expect(result.queued).toBe(true);
    expect(JSON.stringify(result.event.payload)).not.toContain("hunter2");
    expect(result.event.payload).toMatchObject({ eventType: "explicit_memory", source_event_id: result.event.id });
    expect(result.event.safety.contextSafetyModule).toBe("backend/src/lib/context-safety.ts");
    expect(readQueuedCaptureEvents(queuePathForWorkspace(workspacePath))).toHaveLength(1);
  });

  test("applies .rorca-captureignore path redaction before queueing", async () => {
    const workspacePath = mkdtempSync(path.join(os.tmpdir(), "rorca-vscode-ignore-"));
    tmpDirs.push(workspacePath);
    mkdirSync(path.join(workspacePath, "secrets"), { recursive: true });
    writeFileSync(path.join(workspacePath, ".rorca-captureignore"), "secrets/\n", "utf8");
    const client = new RorcaCaptureClient({
      apiBaseUrl: "http://127.0.0.1:3030",
      queuePath: queuePathForWorkspace(workspacePath),
      queueMaxSize: 10,
      fetchImpl: async () => ({ ok: false }) as Response,
    });

    const result = await client.submit({
      workspaceId: "ws",
      workspacePath,
      eventType: "editor_activity",
      policyMode: "metadata-only",
      occurredAt: "2026-07-05T00:00:00.000Z",
      payload: { activity_type: "save", related_files: [{ path: path.join(workspacePath, "secrets", "token.txt"), role: "saved" }] },
    });

    expect(JSON.stringify(result.event.payload)).not.toContain("token.txt");
    expect(result.event.payload).toMatchObject({ related_files: [{ path: "[REDACTED_PATH]" }] });
    expect(result.event.safety.ignoredPathCount).toBe(1);
  });

  test("keeps queue fallback idempotent and bounded", () => {
    const workspacePath = mkdtempSync(path.join(os.tmpdir(), "rorca-vscode-queue-"));
    tmpDirs.push(workspacePath);
    const client = new RorcaCaptureClient({ apiBaseUrl: "http://127.0.0.1:3030", queuePath: queuePathForWorkspace(workspacePath), queueMaxSize: 1, fetchImpl: async () => ({ ok: false }) as Response });
    const one = client.buildEvent({ workspaceId: "ws", workspacePath, eventType: "file_saved", policyMode: "metadata-only", occurredAt: "2026-07-05T00:00:00.000Z", payload: { filePath: "a.ts" } });
    const same = client.buildEvent({ workspaceId: "ws", workspacePath, eventType: "file_saved", policyMode: "metadata-only", occurredAt: "2026-07-05T00:00:00.000Z", payload: { filePath: "a.ts" } });
    const two = client.buildEvent({ workspaceId: "ws", workspacePath, eventType: "file_saved", policyMode: "metadata-only", occurredAt: "2026-07-05T00:00:01.000Z", payload: { filePath: "b.ts" } });

    expect(one.id).toBe(same.id);
    const queuePath = queuePathForWorkspace(workspacePath);
    void client;
    enqueueCaptureEvent(queuePath, one, 1);
    enqueueCaptureEvent(queuePath, same, 1);
    enqueueCaptureEvent(queuePath, two, 1);
    expect(readQueuedCaptureEvents(queuePath).map((event) => event.id)).toEqual([two.id]);
  });

  test("applies default-on memory candidate count and token governance", () => {
    const candidates = Array.from({ length: 5 }, (_, index) => ({ category: "Decision" as const, title: `C${index}`, rule: "x".repeat(80), source: "test" }));
    const governed = applyMemoryCandidateGovernance(candidates, { memoryCandidateMaxCount: 2, memoryCandidateTokenCap: 1_000 });
    expect(governed.candidates).toHaveLength(2);
    expect(governed.governance).toMatchObject({ enabled: true, maxCandidates: 2, droppedCandidates: 3 });

    const tokenBound = applyMemoryCandidateGovernance(candidates, { memoryCandidateMaxCount: 5, memoryCandidateTokenCap: 100 });
    expect(tokenBound.governance.submittedTokens).toBeLessThanOrEqual(100);
    expect(tokenBound.governance.droppedCandidates).toBeGreaterThan(0);
  });
});
