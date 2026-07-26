/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { extractApiErrorMessage, RorcaApiClient } from "../api.js";

const originalPiWorkspaceId = process.env.RORCA_PI_WORKSPACE_ID;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalPiWorkspaceId === undefined) delete process.env.RORCA_PI_WORKSPACE_ID;
  else process.env.RORCA_PI_WORKSPACE_ID = originalPiWorkspaceId;
});

describe("RorcaApiClient", () => {
  it("prefers explicit workspace ids", async () => {
    const client = new RorcaApiClient("http://localhost:3030");
    client.listWorkspaces = async () => [
      { id: "one", label: "One", path: "/tmp/one" },
      { id: "two", label: "Two", path: "/tmp/two" },
    ];

    await expect(client.resolveWorkspace("two")).resolves.toMatchObject({ id: "two" });
  });

  it("falls back to chooser when multiple workspaces exist", async () => {
    // The chooser path is intentionally independent from an operator's shell
    // default, which may be set by a real Pi/Rorca installation.
    delete process.env.RORCA_PI_WORKSPACE_ID;
    const client = new RorcaApiClient("http://localhost:3030");
    client.listWorkspaces = async () => [
      { id: "one", label: "One", path: "/tmp/one" },
      { id: "two", label: "Two", path: "/tmp/two" },
    ];

    const workspace = await client.resolveWorkspace(undefined, async () => "two");
    expect(workspace.id).toBe("two");
  });

  it("extracts API error messages from structured payloads", () => {
    expect(extractApiErrorMessage(409, { error: "Workspace busy" })).toBe("Workspace busy");
    expect(extractApiErrorMessage(500, {})).toBe("Rorca API request failed (500)");
  });

  it("triggers ordinary Pi runs with the safe local execution profile", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ ok: true, runId: 91 }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const client = new RorcaApiClient("http://localhost:3030");

    await client.triggerRun({ specSlug: "oauth-login", workspaceId: "cashflow" });

    const request = fetchMock.mock.calls[0];
    expect(request?.[0]).toBe("http://localhost:3030/api/pipeline/trigger");
    const body = JSON.parse(String((request?.[1] as RequestInit).body));
    expect(body).toMatchObject({
      specPath: "forge/specs/approved/oauth-login.json",
      workspaceId: "cashflow",
      autoWorktree: true,
      autoMerge: false,
      mergeStrategy: "branch-only",
      terminal_mode: "ansi-html",
      forceSequential: true,
    });
    fetchMock.mockRestore();
  });
});
