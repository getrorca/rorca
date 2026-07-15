/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, expect, test } from "vitest";
import { RORCA_COMMANDS, RORCA_COMMAND_TITLES, registerRorcaCommands, submitRememberSelection } from "../src/commands.js";
import type { RorcaCaptureClient } from "../src/client.js";

describe("Rorca VS Code command registration", () => {
  test("registers all required commands", () => {
    const registered: string[] = [];
    const disposables = registerRorcaCommands({
      registry: { registerCommand: (command) => { registered.push(command); return { dispose: () => undefined }; } },
      handlers: Object.fromEntries(Object.values(RORCA_COMMANDS).map((command) => [command, () => undefined])) as never,
    });

    expect(registered).toEqual(Object.values(RORCA_COMMANDS));
    expect(registered.map((command) => RORCA_COMMAND_TITLES[command as keyof typeof RORCA_COMMAND_TITLES])).toEqual([
      "Rorca: Capture Session Summary",
      "Rorca: Remember Selection",
      "Rorca: Pause Capture",
      "Rorca: Show Capture Status",
      "Rorca: Review Candidates",
    ]);
    expect(disposables).toHaveLength(5);
  });

  test("Remember Selection submits governed memory candidates for review", async () => {
    const submissions: unknown[] = [];
    const client = { submit: async (input: unknown) => { submissions.push(input); return { queued: true }; } } as RorcaCaptureClient;

    const result = await submitRememberSelection({
      client,
      config: { enabled: true, apiBaseUrl: "http://127.0.0.1:3030", policyMode: "metadata-only", queueMaxSize: 100, memoryCandidateMaxCount: 1, memoryCandidateTokenCap: 500 },
      workspaceId: "ws",
      workspacePath: "/repo",
      selectionText: "Use apiFetch for frontend API calls.",
      filePath: "/repo/src/lib/api.ts",
      languageId: "typescript",
    });

    expect(result.queued).toBe(true);
    expect(result.governance.submittedCandidates).toBe(1);
    expect(submissions[0]).toMatchObject({
      eventType: "explicit_memory",
      workspaceId: "ws",
      payload: {
        memory_summary: "Use apiFetch for frontend API calls.",
        category: "Decision",
        requested_by: "human",
        reviewRequired: true,
      },
    });
  });

  test("Remember Selection does not bypass governance when the selection exceeds token caps", async () => {
    const submissions: Array<{ payload?: { memory_summary?: string; governance?: { submittedCandidates: number; droppedCandidates: number } } }> = [];
    const client = { submit: async (input: never) => { submissions.push(input); return { queued: false }; } } as RorcaCaptureClient;

    await submitRememberSelection({
      client,
      config: { enabled: true, apiBaseUrl: "http://127.0.0.1:3030", policyMode: "metadata-only", queueMaxSize: 100, memoryCandidateMaxCount: 1, memoryCandidateTokenCap: 100 },
      workspaceId: "ws",
      workspacePath: "/repo",
      selectionText: "x".repeat(1000),
      filePath: "/repo/src/large.ts",
      languageId: "typescript",
    });

    expect(submissions[0]?.payload?.governance).toMatchObject({ submittedCandidates: 0, droppedCandidates: 1 });
    expect(submissions[0]?.payload?.memory_summary).toBe("Memory candidate omitted because it exceeded Rorca governance caps.");
    expect(submissions[0]?.payload?.memory_summary).not.toContain("xxx");
  });
});
