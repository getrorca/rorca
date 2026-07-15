/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JsonSchema, McpToolDefinition } from "./types.js";

const PROTOCOL_VERSION = "2025-03-26";
const MCP_ACCEPT_HEADER = "application/json, text/event-stream";

function readMcpAdminToken(): string {
  const envToken = process.env.RORCA_PI_MCP_TOKEN;
  if (envToken?.trim()) return envToken.trim();

  const tokenPath = path.join(os.homedir(), ".rorca", "mcp-admin-token");
  if (fs.existsSync(tokenPath)) {
    return fs.readFileSync(tokenPath, "utf8").trim();
  }

  return "";
}

type RorcaMcpBridgeOptions = {
  mcpUrlOverride?: string;
  authToken?: string | null;
  statusKey?: string;
  statusLabel?: string;
};

function cloneSchema(schema: JsonSchema | undefined): Record<string, unknown> {
  if (!schema) return { type: "object", properties: {} };
  return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
}

function buildParametersSchema(tool: McpToolDefinition): Record<string, unknown> {
  const schema = cloneSchema(tool.inputSchema);
  return {
    type: "object",
    properties: schema.properties && typeof schema.properties === "object" ? schema.properties : {},
    ...(Array.isArray(schema.required) ? { required: schema.required } : {}),
  };
}

function formatToolResult(result: Record<string, unknown>): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const textParts = content
    .filter((item): item is { type: string; text?: string } => Boolean(item) && typeof item === "object")
    .map((item) => item.type === "text" && typeof item.text === "string" ? item.text : JSON.stringify(item, null, 2))
    .filter(Boolean);

  return textParts.length > 0 ? textParts.join("\n\n") : JSON.stringify(result, null, 2);
}

export class RorcaMcpBridge {
  private readonly mcpUrl: string;
  private readonly mcpToken: string;
  private readonly statusKey: string;
  private readonly statusLabel: string;
  private requestId = 0;
  private sessionId: string | null = null;
  private bridgePromise: Promise<{ sessionId: string; tools: McpToolDefinition[] }> | null = null;
  private readonly registeredTools = new Set<string>();

  constructor(mcpUrl: string, options: RorcaMcpBridgeOptions = {}) {
    this.mcpUrl = options.mcpUrlOverride || process.env.RORCA_PI_MCP_URL || mcpUrl;
    this.mcpToken = options.authToken !== undefined ? (options.authToken ?? "") : readMcpAdminToken();
    this.statusKey = options.statusKey || "rorca-mcp";
    this.statusLabel = options.statusLabel || "Rorca MCP";
  }

  async register(pi: ExtensionAPI, ctx: ExtensionContext): Promise<number> {
    const bridge = await this.getBridge();
    for (const tool of bridge.tools) {
      if (this.registeredTools.has(tool.name)) continue;
      this.registeredTools.add(tool.name);
      pi.registerTool({
        name: tool.name,
        label: tool.name,
        description: tool.description || `Rorca MCP tool: ${tool.name}`,
        parameters: buildParametersSchema(tool),
        execute: async (_toolCallId: string, params: Record<string, unknown>, signal: AbortSignal) => {
          const response = await this.mcpPost("tools/call", { name: tool.name, arguments: params }, bridge.sessionId, signal);
          const result = response.result as Record<string, unknown>;
          return {
            content: [{ type: "text", text: formatToolResult(result) }],
            details: { bridge: this.statusKey, tool: tool.name },
          };
        },
      });
    }

    ctx.ui.setStatus(this.statusKey, `${this.statusLabel}: ${bridge.tools.length} tools`);
    return bridge.tools.length;
  }

  async status(): Promise<{ toolCount: number; url: string }> {
    const bridge = await this.getBridge();
    return { toolCount: bridge.tools.length, url: this.mcpUrl };
  }

  async listToolNames(): Promise<string[]> {
    const bridge = await this.getBridge();
    return bridge.tools.map((tool) => tool.name);
  }

  async supportsToolGroups(toolGroups: string[][]): Promise<boolean> {
    const names = new Set(await this.listToolNames());
    return toolGroups.every((group) => group.some((name) => names.has(name)));
  }

  async dispose(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await fetch(this.mcpUrl, {
        method: "DELETE",
        headers: {
          Accept: MCP_ACCEPT_HEADER,
          ...(this.mcpToken ? { Authorization: `Bearer ${this.mcpToken}` } : {}),
          "mcp-session-id": this.sessionId,
        },
      });
    } catch {
      // Best effort cleanup.
    }
  }

  private nextId(): number {
    this.requestId += 1;
    return this.requestId;
  }

  private async getBridge(signal?: AbortSignal): Promise<{ sessionId: string; tools: McpToolDefinition[] }> {
    if (!this.bridgePromise) {
      this.bridgePromise = this.initializeBridge(signal);
    }
    const bridge = await this.bridgePromise;
    this.sessionId = bridge.sessionId;
    return bridge;
  }

  private async initializeBridge(signal?: AbortSignal): Promise<{ sessionId: string; tools: McpToolDefinition[] }> {
    const initialized = await this.mcpPost("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "rorca-pi-extension", version: "0.1.0" },
    }, undefined, signal);

    if (!initialized.sessionId) {
      throw new Error("MCP server did not return a session id");
    }

    const tools: McpToolDefinition[] = [];
    let cursor: string | undefined;
    for (;;) {
      const listed = await this.mcpPost("tools/list", cursor ? { cursor } : {}, initialized.sessionId, signal);
      const pageTools = Array.isArray(listed.result.tools) ? listed.result.tools as McpToolDefinition[] : [];
      tools.push(...pageTools);
      const nextCursor = typeof listed.result.nextCursor === "string" ? listed.result.nextCursor : undefined;
      if (!nextCursor) break;
      cursor = nextCursor;
    }

    return { sessionId: initialized.sessionId, tools };
  }

  private async mcpPost(method: string, params: Record<string, unknown>, sessionId?: string, signal?: AbortSignal): Promise<{ sessionId: string; result: Record<string, unknown> }> {
    const response = await fetch(this.mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: MCP_ACCEPT_HEADER,
        ...(this.mcpToken ? { Authorization: `Bearer ${this.mcpToken}` } : {}),
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: this.nextId(),
        method,
        params,
      }),
      signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`${method} failed (${response.status}): ${body}`);
    }

    const payload = await response.json() as {
      result?: Record<string, unknown>;
      error?: { message?: string };
    };

    if (payload.error?.message) {
      throw new Error(payload.error.message);
    }

    return {
      sessionId: response.headers.get("mcp-session-id") || sessionId || "",
      result: payload.result || {},
    };
  }
}
