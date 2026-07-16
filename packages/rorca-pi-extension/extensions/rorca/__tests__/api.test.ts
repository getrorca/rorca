/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { afterEach, describe, expect, it } from "vitest";
import { extractApiErrorMessage, RorcaApiClient } from "../api.js";

const originalPiWorkspaceId = process.env.RORCA_PI_WORKSPACE_ID;

afterEach(() => {
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
});
