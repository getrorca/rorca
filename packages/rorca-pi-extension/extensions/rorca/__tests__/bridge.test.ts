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
});
