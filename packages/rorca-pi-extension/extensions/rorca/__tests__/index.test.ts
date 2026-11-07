/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import rorcaPiExtension from "../index.js";

// These optional process/TUI integrations are outside MCP transport ownership.
vi.mock("../tmux-subagents.js", () => ({
  TmuxSubagentManager: class {},
  registerTmuxSubagents: vi.fn(),
}));
vi.mock("../autonomous-supervisor.js", () => ({ registerHermesAutonomousSupervisor: vi.fn() }));

function harness(nativeMcp: boolean) {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  const tools: Array<{ name: string }> = [];
  const pi = {
    ...(nativeMcp ? { pi: { settings: {} } } : {}),
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => handlers.set(name, handler),
    registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => commands.set(name, command),
    registerTool: (tool: { name: string }) => tools.push(tool),
  };
  const ctx = {
    sessionManager: { getEntries: () => [] },
    ui: { notify: vi.fn(), setStatus: vi.fn() },
  };
  // The harness implements only the registration and session-start surface.
  rorcaPiExtension(pi as unknown as ExtensionAPI);
  return { handlers, commands, tools, ctx: ctx as unknown as ExtensionContext };
}

describe("Rorca extension MCP ownership", () => {
  beforeEach(() => {
    vi.stubEnv("RORCA_PI_API_URL", "http://127.0.0.1:3030");
    vi.stubEnv("RORCA_PI_MCP_URL", "");
    vi.stubEnv("RORCA_PI_MCP_TOKEN", "fixture-token");
    vi.stubEnv("RORCA_PI_PLAYWRIGHT_MCP_URL", "");
    vi.stubEnv("RORCA_PI_CHROME_MCP_URL", "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function mockBackend() {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/health")) {
        return new Response(JSON.stringify({ status: "healthy", mcp: { enabled: true, url: "http://127.0.0.1:3030/mcp" } }));
      }
      const request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ result: request.method === "tools/list" ? {
        tools: [{ name: url.includes(":4040") ? "browser_navigate" : "rorca_list_workspaces", inputSchema: { type: "object", properties: {} } }],
      } : {} }), { headers: { "mcp-session-id": "fixture-session" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("leaves Rorca MCP connections and tools to OMP while retaining REST commands", async () => {
    const fetchMock = mockBackend();
    const h = harness(true);
    await h.handlers.get("session_start")!({}, h.ctx);
    await h.commands.get("rorca-mcp-status")!.handler("", h.ctx);

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(["http://127.0.0.1:3030/api/health"]);
    expect(h.tools).toEqual([]);
    expect(h.commands.has("rorca-create-spec")).toBe(true);
    expect(h.ctx.ui.setStatus).toHaveBeenCalledWith("rorca-api", "Rorca API: healthy");
  });

  it("continues registering HTTP MCP tools in legacy Pi", async () => {
    mockBackend();
    const h = harness(false);
    await h.handlers.get("session_start")!({}, h.ctx);

    expect(h.tools.map((tool) => tool.name)).toEqual(["rorca_list_workspaces"]);
  });

  it("retains explicitly configured browser bridges in OMP", async () => {
    vi.stubEnv("RORCA_PI_PLAYWRIGHT_MCP_URL", "http://127.0.0.1:4040/mcp");
    const fetchMock = mockBackend();
    const h = harness(true);
    await h.handlers.get("session_start")!({}, h.ctx);

    expect(h.tools.map((tool) => tool.name)).toEqual(["browser_navigate"]);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain("http://127.0.0.1:3030/mcp");
  });
});
