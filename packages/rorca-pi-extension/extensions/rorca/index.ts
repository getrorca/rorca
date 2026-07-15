/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RorcaApiClient } from "./api.js";
import { RorcaMcpBridge } from "./bridge.js";
import { registerRorcaCommands } from "./commands.js";
import { formatSkillLaunchPrompt, getRequiredToolGroups, type RorcaSkillWorkflowRequest } from "./skill-launcher.js";
import { mergeState, restoreState, STATE_ENTRY_TYPE } from "./state.js";
import type { ExtensionState } from "./types.js";
import { RunWatchController } from "./watch.js";

export default function rorcaPiExtension(pi: ExtensionAPI): void {
  const api = new RorcaApiClient();
  let state: ExtensionState = {};
  const updateState = (patch: Partial<ExtensionState>) => {
    state = mergeState(state, patch);
    pi.appendEntry(STATE_ENTRY_TYPE, state);
  };

  const watch = new RunWatchController(api, updateState);
  const bridge = new RorcaMcpBridge(`${api.baseUrl}/mcp`);
  const playwrightBrowserBridge = process.env.RORCA_PI_PLAYWRIGHT_MCP_URL
    ? new RorcaMcpBridge(process.env.RORCA_PI_PLAYWRIGHT_MCP_URL, {
        mcpUrlOverride: process.env.RORCA_PI_PLAYWRIGHT_MCP_URL,
        authToken: null,
        statusKey: "playwright-mcp",
        statusLabel: "Playwright MCP",
      })
    : null;
  const chromeBrowserBridge = process.env.RORCA_PI_CHROME_MCP_URL
    ? new RorcaMcpBridge(process.env.RORCA_PI_CHROME_MCP_URL, {
        mcpUrlOverride: process.env.RORCA_PI_CHROME_MCP_URL,
        authToken: null,
        statusKey: "chrome-devtools-mcp",
        statusLabel: "Chrome DevTools MCP",
      })
    : null;

  const withErrors = (handler: (args: string, ctx: ExtensionContext) => Promise<void>) => async (args: string, ctx: ExtensionContext) => {
    try {
      await handler(args, ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Rorca: ${message}`, "error");
    }
  };

  const registerCommand = (name: string, description: string, handler: (args: string, ctx: ExtensionContext) => Promise<void>) => {
    pi.registerCommand(name, {
      description,
      handler: withErrors(handler),
    });
  };

  registerRorcaCommands(registerCommand, {
    api,
    watch,
    dispatchSkillWorkflow: (input: RorcaSkillWorkflowRequest) => {
      pi.sendUserMessage(formatSkillLaunchPrompt(input));
    },
    canLaunchSkillWorkflow: async (input: RorcaSkillWorkflowRequest) => {
      try {
        return await bridge.supportsToolGroups(getRequiredToolGroups(input));
      } catch {
        return false;
      }
    },
    getState: () => state,
    updateState,
  });

  registerCommand("rorca-mcp-status", "Show Rorca MCP bridge status", async (_args, ctx) => {
    const status = await bridge.status();
    ctx.ui.notify(`Rorca MCP bridge healthy: ${status.toolCount} tools from ${status.url}`, "success");
  });

  pi.on("session_start", async (_event, ctx) => {
    state = restoreState(ctx.sessionManager.getEntries());

    try {
      const health = await api.getHealth();
      const backendStatus = health.status || "unknown";
      ctx.ui.setStatus("rorca-api", `Rorca API: ${backendStatus}`);
      if (health.mcp?.enabled && health.mcp.url) {
        const toolCount = await bridge.register(pi, ctx);
        ctx.ui.notify(`Loaded ${toolCount} Rorca MCP tools from ${health.mcp.url}`, "success");
      } else {
        ctx.ui.notify("Rorca MCP bridge unavailable; slash commands still work if the REST API is up.", "warning");
      }

      const browserBridgeLoaders: Array<[string, RorcaMcpBridge | null]> = [
        ["Playwright", playwrightBrowserBridge],
        ["Chrome DevTools", chromeBrowserBridge],
      ];
      for (const [label, browserBridge] of browserBridgeLoaders) {
        if (!browserBridge) continue;
        try {
          const toolCount = await browserBridge.register(pi, ctx);
          ctx.ui.notify(`Loaded ${toolCount} ${label} MCP tools`, "success");
        } catch (browserError) {
          const message = browserError instanceof Error ? browserError.message : String(browserError);
          ctx.ui.notify(`${label} MCP bridge unavailable: ${message}`, "warning");
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.setStatus("rorca-api", "Rorca API: unavailable");
      ctx.ui.notify(`Rorca backend unavailable: ${message}`, "error");
    }

    if (state.watchingRunId) {
      watch.start(state.watchingRunId, ctx);
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    state = restoreState(ctx.sessionManager.getEntries());
    if (state.watchingRunId && watch.currentRunId() !== state.watchingRunId) {
      watch.start(state.watchingRunId, ctx);
    }
  });

  pi.on("session_shutdown", async () => {
    watch.stop();
    await Promise.all([
      bridge.dispose(),
      playwrightBrowserBridge?.dispose() ?? Promise.resolve(),
      chromeBrowserBridge?.dispose() ?? Promise.resolve(),
    ]);
  });
}
