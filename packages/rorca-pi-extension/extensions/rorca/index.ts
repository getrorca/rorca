/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RorcaApiClient } from "./api.js";
import { registerHermesAutonomousSupervisor } from "./autonomous-supervisor.js";
import { RorcaMcpBridge } from "./bridge.js";
import { registerRorcaCommands } from "./commands.js";
import { formatSkillLaunchPrompt, getRequiredToolGroups, type RorcaSkillWorkflowRequest } from "./skill-launcher.js";
import { mergeState, restoreState, STATE_ENTRY_TYPE } from "./state.js";
import { TmuxSubagentManager, registerTmuxSubagents } from "./tmux-subagents.js";
import type { ExtensionState } from "./types.js";
import { RunWatchController } from "./watch.js";

export default function rorcaPiExtension(pi: ExtensionAPI): void {
  // OMP exposes its package/settings namespace and owns MCP transports itself.
  // Legacy Pi still needs this package's HTTP bridge.
  const nativeMcp = "pi" in pi && typeof pi.pi === "object" && pi.pi !== null && "settings" in pi.pi;
  const api = new RorcaApiClient();
  let state: ExtensionState = {};
  const updateState = (patch: Partial<ExtensionState>) => {
    state = mergeState(state, patch);
    pi.appendEntry(STATE_ENTRY_TYPE, state);
  };

  const dispatchSkillWorkflow = (input: RorcaSkillWorkflowRequest) => {
    pi.sendUserMessage(formatSkillLaunchPrompt(input));
  };
  const watch = new RunWatchController(api, updateState, (runId: number) => {
    // A failed Rorca run is a ticket, never a tombstone. Send the repair
    // workflow so the Pi session diagnoses, fixes, and re-drives the run.
    dispatchSkillWorkflow({
      workflow: "repair",
      skillName: "hermes-rorca-run-repair",
      runId,
      prompt: `Rorca run #${runId} failed. Use the hermes-rorca-run-repair skill: diagnose the root cause, apply the smallest safe fix, re-drive the run, and verify it concludes. Never leave the run failed without a written diagnosis and an exact operator action.`,
    });
  });
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

  const tmuxManager = new TmuxSubagentManager(api);
  registerHermesAutonomousSupervisor(pi, api, tmuxManager, registerCommand);
  registerTmuxSubagents(pi, api, registerCommand, tmuxManager);

  registerRorcaCommands(registerCommand, {
    api,
    watch,
    dispatchSkillWorkflow,
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

  registerTmuxSubagents(pi, api, registerCommand);

  registerCommand("rorca-mcp-status", "Show Rorca MCP bridge status", async (_args, ctx) => {
    if (nativeMcp) {
      ctx.ui.notify("Rorca MCP is managed by OMP. Use /mcp for connection status and /mcp reload to refresh tools.", "info");
      return;
    }
    const status = await bridge.status();
    ctx.ui.notify(`Rorca MCP bridge healthy: ${status.toolCount} tools from ${status.url}`, "success");
  });

  pi.on("session_start", async (_event, ctx) => {
    state = restoreState(ctx.sessionManager.getEntries());

    try {
      const health = await api.getHealth();
      const backendStatus = health.status || "unknown";
      ctx.ui.setStatus("rorca-api", `Rorca API: ${backendStatus}`);
      if (nativeMcp) {
        ctx.ui.setStatus("rorca-mcp", "Rorca MCP: managed by OMP (/mcp)");
      } else if (health.mcp?.enabled && health.mcp.url) {
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
