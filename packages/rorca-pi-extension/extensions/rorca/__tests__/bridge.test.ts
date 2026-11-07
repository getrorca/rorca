/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { RorcaMcpBridge } from "../bridge.js";

describe("RorcaMcpBridge", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("sends the MCP accept header required by the backend", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: (key: string) => key === "mcp-session-id" ? "session-1" : null },
        json: async () => ({ result: {} }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: (key: string) => key === "mcp-session-id" ? "session-1" : null },
        json: async () => ({ result: { tools: [] } }),
      });

    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const bridge = new RorcaMcpBridge("http://localhost:3030/mcp");
    const toolCount = await bridge.register({ registerTool: vi.fn() } as any, {
      ui: { setStatus: vi.fn() },
    } as any);

    expect(toolCount).toBe(0);
    expect(fetchMock).toHaveBeenCalled();
    const initHeaders = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(initHeaders.Accept).toBe("application/json, text/event-stream");
  });

  it("registers the exact MCP input schema in Pi without weakening constraints", async () => {
    const inputSchema = {
      type: "object",
      additionalProperties: false,
      required: ["workspaceId", "decision"],
      properties: {
        workspaceId: { type: "string", minLength: 1, maxLength: 128 },
        decision: { type: "string", enum: ["approve", "deny"] },
      },
      $defs: { receipt: { type: "string", pattern: "^receipt:" } },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: (key: string) => key === "mcp-session-id" ? "session-2" : null },
        json: async () => ({ result: {} }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: (key: string) => key === "mcp-session-id" ? "session-2" : null },
        json: async () => ({ result: { tools: [{ name: "rorca_contracts_bounty_presentation", inputSchema }] } }),
      });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const registerTool = vi.fn();

    await new RorcaMcpBridge("http://localhost:3030/mcp", { authToken: "test-token" }).register(
      { registerTool } as any,
      { ui: { setStatus: vi.fn() } } as any,
    );

    expect(registerTool).toHaveBeenCalledOnce();
    expect(registerTool.mock.calls[0][0].parameters).toEqual(inputSchema);
    expect(registerTool.mock.calls[0][0].parameters).not.toBe(inputSchema);
  });
});
