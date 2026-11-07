/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractApiErrorMessage, RorcaApiClient } from "../api.js";

const originalPiWorkspaceId = process.env.RORCA_PI_WORKSPACE_ID;
const repositoryRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const runtimeGenerator = fileURLToPath(
  new URL("../../../../../scripts/generate-pi-runtime.mjs", import.meta.url),
);

afterEach(() => {
  vi.restoreAllMocks();
  if (originalPiWorkspaceId === undefined) delete process.env.RORCA_PI_WORKSPACE_ID;
  else process.env.RORCA_PI_WORKSPACE_ID = originalPiWorkspaceId;
});

describe("RorcaApiClient", () => {
  it("keeps the shipped JavaScript runtime generated from the complete TypeScript source", () => {
    expect(() => execFileSync(process.execPath, [runtimeGenerator], {
      cwd: repositoryRoot, stdio: "pipe",
    })).not.toThrow();
  });

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

  it("reads bounded local review bundles without provider or mutation inputs", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ items: [{ bundleId: `lrb-${"a".repeat(64)}` }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const client = new RorcaApiClient("http://localhost:3030");

    const bundles = await client.listLocalReviewBundles("workspace-one", 42, 5);

    expect(bundles).toHaveLength(1);
    const request = fetchMock.mock.calls[0];
    expect(request?.[0]).toBe("http://localhost:3030/api/delivery/review-bundles?workspaceId=workspace-one&limit=5&runId=42");
    expect((request?.[1] as RequestInit).method).toBeUndefined();
    expect(request?.[1]).not.toHaveProperty("body");
  });

  it("rejects invalid local review bundle limits instead of clamping", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const client = new RorcaApiClient("http://localhost:3030");
    await expect(client.listLocalReviewBundles("workspace-one", 42, 0)).rejects.toThrow(/integer from 1 to 100/);
    await expect(client.listLocalReviewBundles("workspace-one", 42, 101)).rejects.toThrow(/integer from 1 to 100/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("triggers ordinary Pi runs with the safe local execution profile", async () => {
    const previewHash = `sha256:${"a".repeat(64)}`;
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ preview: { previewHash, expiresAt: "2026-08-06T20:00:00.000Z" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ ok: true, runId: 91 }),
        { status: 200, headers: { "content-type": "application/json" } },
      ));
    const client = new RorcaApiClient("http://localhost:3030");

    await client.triggerRun({ specSlug: "oauth-login", workspaceId: "cashflow" });

    const preflightRequest = fetchMock.mock.calls[0];
    expect(preflightRequest?.[0]).toBe("http://localhost:3030/api/pipeline/preflight");
    const request = fetchMock.mock.calls[1];
    expect(request?.[0]).toBe("http://localhost:3030/api/pipeline/trigger");
    const init = request?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      specPath: "forge/specs/approved/oauth-login.json",
      workspaceId: "cashflow",
      autoWorktree: true,
      autoMerge: false,
      mergeStrategy: "branch-only",
      terminal_mode: "ansi-html",
      forceSequential: true,
      idempotencyKey: `pi-extension:cashflow:${"a".repeat(64)}`,
      previewHash,
      previewExpiresAt: "2026-08-06T20:00:00.000Z",
    });
    expect(new Headers(init.headers).get("Idempotency-Key"))
      .toBe(`pi-extension:cashflow:${"a".repeat(64)}`);
    fetchMock.mockRestore();
  });
});
