/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, expect, it, vi } from "vitest";
import { choosePreferredPiModel, registerRorcaCommands } from "../commands.js";
import type { ExtensionState, PipelineRunDetailResponse } from "../types.js";

function createContext() {
  const notifications: Array<{ message: string; level?: string }> = [];
  const widgets: Array<{ key: string; value?: string[] }> = [];
  return {
    notifications,
    widgets,
    ctx: {
      ui: {
        notify: (message: string, level?: string) => notifications.push({ message, level }),
        setStatus: vi.fn(),
        setWidget: (key: string, value?: string[]) => widgets.push({ key, value }),
        select: vi.fn(async (_title: string, options: string[]) => options[0]),
      },
      sessionManager: {
        getEntries: () => [],
        getBranch: () => [],
      },
      isIdle: () => true,
    },
  };
}

function createRegistry() {
  const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
  return {
    commands,
    register: (name: string, _description: string, handler: (args: string, ctx: any) => Promise<void>) => {
      commands.set(name, handler);
    },
  };
}

describe("rorca pi extension commands", () => {
  it("prefers a locally available Pi model when the spec model is unavailable", () => {
    expect(choosePreferredPiModel("claude-sonnet-4-6", [
      { provider: "openai-codex", model: "gpt-5.4", contextTokens: 272000, maxOutTokens: 128000, thinking: true, images: true },
    ])).toBe("openai-codex/gpt-5.4");

    expect(choosePreferredPiModel("openai-codex/gpt-5.4", [
      { provider: "openai-codex", model: "gpt-5.4", contextTokens: 272000, maxOutTokens: 128000, thinking: true, images: true },
    ])).toBe("openai-codex/gpt-5.4");
  });

  it("dispatches skill-first explicit spec creation", async () => {
    const { commands, register } = createRegistry();
    const dispatchSkillWorkflow = vi.fn();
    let state: ExtensionState = {};
    const api = {
      resolveWorkspace: vi.fn(async () => ({ id: "cashflow", label: "Cashflow", path: "/repo" })),
    } as any;

    registerRorcaCommands(register, {
      api,
      watch: { start: vi.fn(), stop: vi.fn(), currentRunId: () => null } as any,
      dispatchSkillWorkflow,
      canLaunchSkillWorkflow: vi.fn(async () => true),
      getState: () => state,
      updateState: (patch) => {
        state = { ...state, ...patch };
      },
    });

    const { ctx, notifications } = createContext();
    await commands.get("rorca-create-spec")!("Ship OAuth login --workspace cashflow --approve --run --queue --model openai-codex/gpt-5.4", ctx);

    expect(dispatchSkillWorkflow).toHaveBeenCalledWith({
      workflow: "forge",
      skillName: "rorca-forge-run",
      workspaceId: "cashflow",
      brief: "Ship OAuth login",
      briefSource: "inline",
      autoApprove: true,
      autoRun: true,
      queue: true,
      modelOverride: "openai-codex/gpt-5.4",
    });
    expect(state.workspaceId).toBe("cashflow");
    expect(notifications.at(-1)?.message).toContain("Dispatched skill-first spec creation");
  });

  it("maps forge-run compatibility alias onto the dedicated forge-run skill path", async () => {
    const { commands, register } = createRegistry();
    const dispatchSkillWorkflow = vi.fn();
    let state: ExtensionState = {};
    const api = {
      resolveWorkspace: vi.fn(async () => ({ id: "cashflow", label: "Cashflow", path: "/repo" })),
    } as any;

    registerRorcaCommands(register, {
      api,
      watch: { start: vi.fn(), stop: vi.fn(), currentRunId: () => null } as any,
      dispatchSkillWorkflow,
      canLaunchSkillWorkflow: vi.fn(async () => true),
      getState: () => state,
      updateState: (patch) => {
        state = { ...state, ...patch };
      },
    });

    const { ctx, notifications } = createContext();
    await commands.get("rorca-forge-run")!("Ship OAuth login --workspace cashflow --queue", ctx);

    expect(dispatchSkillWorkflow).toHaveBeenCalledWith({
      workflow: "forge",
      skillName: "rorca-forge-run",
      workspaceId: "cashflow",
      brief: "Ship OAuth login",
      briefSource: "inline",
      autoApprove: true,
      autoRun: true,
      queue: true,
      modelOverride: undefined,
    });
    expect(state.workspaceId).toBe("cashflow");
    expect(notifications[0]?.message).toContain("Deprecated: /rorca-forge-run");
    expect(notifications.at(-1)?.message).toContain("Dispatched skill-first spec creation");
  });

  it("dispatches the run-operator skill when MCP tools are available", async () => {
    const { commands, register } = createRegistry();
    const dispatchSkillWorkflow = vi.fn();
    let state: ExtensionState = {};
    const api = {
      resolveWorkspace: vi.fn(async () => ({ id: "cashflow", label: "Cashflow", path: "/repo" })),
    } as any;

    registerRorcaCommands(register, {
      api,
      watch: { start: vi.fn(), stop: vi.fn(), currentRunId: () => null } as any,
      dispatchSkillWorkflow,
      canLaunchSkillWorkflow: vi.fn(async () => true),
      getState: () => state,
      updateState: (patch) => {
        state = { ...state, ...patch };
      },
    });

    const { ctx, notifications } = createContext();
    await commands.get("rorca-run")!("oauth-login --workspace cashflow --sequential", ctx);

    expect(dispatchSkillWorkflow).toHaveBeenCalledWith({
      workflow: "run",
      skillName: "rorca-run-operator",
      workspaceId: "cashflow",
      specSlug: "oauth-login",
      specPath: "forge/specs/approved/oauth-login.json",
      storyId: undefined,
      queue: false,
      forceSequential: true,
      modelOverride: undefined,
      watchAfterLaunch: true,
    });
    expect(notifications.at(-1)?.message).toContain("Dispatched skill-guided run planning");
  });

  it("renders the safe local-first delivery read model without artifact or provider mutation", async () => {
    const { commands, register } = createRegistry();
    let state: ExtensionState = { lastRunId: 42, workspaceId: "cashflow" };
    const api = {
      resolveWorkspace: vi.fn(async () => ({ id: "cashflow", label: "Cashflow", path: "/repo" })),
      listLocalReviewBundles: vi.fn(async () => [{
        bundleId: `lrb-${"a".repeat(64)}`,
        identity: { storyId: "US-001", attempt: 1 },
        repository: { baseSha: "1".repeat(40), headSha: "2".repeat(40) },
        validation: { status: "passed" },
        projectionIntegrity: "verified",
      }]),
    } as any;
    registerRorcaCommands(register, {
      api,
      watch: { start: vi.fn(), stop: vi.fn(), currentRunId: () => null } as any,
      dispatchSkillWorkflow: vi.fn(),
      getState: () => state,
      updateState: (patch) => { state = { ...state, ...patch }; },
    });

    const { ctx, notifications, widgets } = createContext();
    await commands.get("rorca-delivery")!("42 --workspace cashflow", ctx);

    expect(api.listLocalReviewBundles).toHaveBeenCalledWith("cashflow", 42, 20);
    expect(notifications.at(-1)?.message).toContain("no provider, network, credential, merge, or deploy authority");
    expect(notifications.at(-1)?.message).toContain("merge=not_authorized deploy=not_authorized");
    expect(widgets.at(-1)?.key).toBe("rorca-delivery");
    expect(JSON.stringify(widgets)).not.toContain("/repo");
  });

  it("dispatches the retry-planner skill when MCP tools are available", async () => {
    const { commands, register } = createRegistry();
    const dispatchSkillWorkflow = vi.fn();
    let state: ExtensionState = { lastRunId: 77 };
    const api = {} as any;

    registerRorcaCommands(register, {
      api,
      watch: { start: vi.fn(), stop: vi.fn(), currentRunId: () => null } as any,
      dispatchSkillWorkflow,
      canLaunchSkillWorkflow: vi.fn(async () => true),
      getState: () => state,
      updateState: (patch) => {
        state = { ...state, ...patch };
      },
    });

    const { ctx, notifications } = createContext();
    await commands.get("rorca-retry")!("77 US-001 --sequential --no-watch", ctx);

    expect(dispatchSkillWorkflow).toHaveBeenCalledWith({
      workflow: "retry",
      skillName: "rorca-retry-planner",
      runId: 77,
      storyIds: ["US-001"],
      forceSequential: true,
      watchAfterLaunch: false,
    });
    expect(notifications.at(-1)?.message).toContain("Dispatched skill-guided retry planning");
  });

  it("fails closed instead of routing normal authoring through backend drafting", async () => {
    const { commands, register } = createRegistry();
    const watchStart = vi.fn();
    let state: ExtensionState = {};
    const api = {
      resolveWorkspace: vi.fn(async () => ({ id: "cashflow", label: "Cashflow", path: "/repo" })),
      forgeSpec: vi.fn(async () => ({ slug: "oauth-login" })),
      approveSpec: vi.fn(async () => undefined),
      triggerRun: vi.fn(async () => ({ runId: 301, queued: true })),
    } as any;

    registerRorcaCommands(register, {
      api,
      watch: { start: watchStart, stop: vi.fn(), currentRunId: () => null } as any,
      dispatchSkillWorkflow: vi.fn(),
      canLaunchSkillWorkflow: vi.fn(async () => false),
      getState: () => state,
      updateState: (patch) => {
        state = { ...state, ...patch };
      },
    });

    const { ctx, notifications } = createContext();
    await expect(commands.get("rorca-create-spec")!(
      "Ship OAuth login --workspace cashflow --approve --run --queue",
      ctx,
    )).rejects.toThrow("requires MCP generation-context plus explicit persistence tools");

    expect(api.forgeSpec).not.toHaveBeenCalled();
    expect(api.approveSpec).not.toHaveBeenCalled();
    expect(api.triggerRun).not.toHaveBeenCalled();
    expect(watchStart).not.toHaveBeenCalled();
    expect(notifications[0]?.message).toContain("Backend drafting fallback is disabled");
  });

  it("falls back to direct approval when MCP tools are unavailable", async () => {
    const { commands, register } = createRegistry();
    let state: ExtensionState = {};
    const api = {
      resolveWorkspace: vi.fn(async () => ({ id: "cashflow", label: "Cashflow", path: "/repo" })),
      approveSpec: vi.fn(async () => undefined),
    } as any;

    registerRorcaCommands(register, {
      api,
      watch: { start: vi.fn(), stop: vi.fn(), currentRunId: () => null } as any,
      dispatchSkillWorkflow: vi.fn(),
      canLaunchSkillWorkflow: vi.fn(async () => false),
      getState: () => state,
      updateState: (patch) => {
        state = { ...state, ...patch };
      },
    });

    const { ctx, notifications } = createContext();
    await commands.get("rorca-approve")!("oauth-login --workspace cashflow", ctx);

    expect(api.approveSpec).toHaveBeenCalledWith("oauth-login", "cashflow");
    expect(notifications[0]?.message).toContain("falling back to direct approval");
  });

  it("falls back to direct run triggering when MCP tools are unavailable", async () => {
    const { commands, register } = createRegistry();
    const watchStart = vi.fn();
    let state: ExtensionState = {};
    const api = {
      resolveWorkspace: vi.fn(async () => ({ id: "cashflow", label: "Cashflow", path: "/repo" })),
      getSpec: vi.fn(async () => ({ id: "oauth-login", model: "openai-codex/gpt-5.4" })),
      triggerRun: vi.fn(async () => ({ runId: 401, queued: false })),
    } as any;

    registerRorcaCommands(register, {
      api,
      watch: { start: watchStart, stop: vi.fn(), currentRunId: () => null } as any,
      dispatchSkillWorkflow: vi.fn(),
      canLaunchSkillWorkflow: vi.fn(async () => false),
      getState: () => state,
      updateState: (patch) => {
        state = { ...state, ...patch };
      },
    });

    const { ctx, notifications } = createContext();
    await commands.get("rorca-run")!("oauth-login --workspace cashflow --sequential", ctx);

    expect(api.triggerRun).toHaveBeenCalledWith({
      specSlug: "oauth-login",
      workspaceId: "cashflow",
      storyId: undefined,
      queue: false,
      model: "openai-codex/gpt-5.4",
      includeGraph: true,
      forceSequential: true,
    });
    expect(watchStart).toHaveBeenCalledWith(401, ctx);
    expect(notifications[0]?.message).toContain("falling back to direct run trigger");
  });

  it("falls back to direct retry when MCP tools are unavailable", async () => {
    const { commands, register } = createRegistry();
    const watchStart = vi.fn();
    let state: ExtensionState = { lastRunId: 77 };
    const api = {
      retryRun: vi.fn(async () => ({ ok: true, queued: true, runId: 501 })),
    } as any;

    registerRorcaCommands(register, {
      api,
      watch: { start: watchStart, stop: vi.fn(), currentRunId: () => null } as any,
      dispatchSkillWorkflow: vi.fn(),
      canLaunchSkillWorkflow: vi.fn(async () => false),
      getState: () => state,
      updateState: (patch) => {
        state = { ...state, ...patch };
      },
    });

    const { ctx, notifications } = createContext();
    await commands.get("rorca-retry")!("77 US-001 --sequential --no-watch", ctx);

    expect(api.retryRun).toHaveBeenCalledWith(77, ["US-001"], {
      forceSequential: true,
    });
    expect(watchStart).not.toHaveBeenCalled();
    expect(notifications[0]?.message).toContain("falling back to direct retry");
  });

  it("enriches a spec via the direct enrich API and reports the retrieval method", async () => {
    const { commands, register } = createRegistry();
    let state: ExtensionState = { lastSpecSlug: "oauth-login" };
    const api = {
      resolveWorkspace: vi.fn(async () => ({ id: "cashflow", label: "Cashflow", path: "/repo" })),
      enrichSpec: vi.fn(async () => ({ retrievalMethod: "pgvector", storiesEnriched: 3 })),
    } as any;

    registerRorcaCommands(register, {
      api,
      watch: { start: vi.fn(), stop: vi.fn(), currentRunId: () => null } as any,
      dispatchSkillWorkflow: vi.fn(),
      getState: () => state,
      updateState: (patch) => {
        state = { ...state, ...patch };
      },
    });

    const { ctx, notifications } = createContext();
    await commands.get("rorca-enrich")!("oauth-login --workspace cashflow", ctx);

    expect(api.enrichSpec).toHaveBeenCalledWith("oauth-login", "cashflow");
    expect(state.workspaceId).toBe("cashflow");
    expect(state.lastSpecSlug).toBe("oauth-login");
    expect(notifications.at(-1)?.message).toContain("Enriched oauth-login (3 stories) via pgvector");
  });

  it("enriches the last spec when no slug is provided", async () => {
    const { commands, register } = createRegistry();
    let state: ExtensionState = { lastSpecSlug: "billing-flow" };
    const api = {
      resolveWorkspace: vi.fn(async () => ({ id: "cashflow", label: "Cashflow", path: "/repo" })),
      enrichSpec: vi.fn(async () => ({ retrievalMethod: "direction-only", storiesEnriched: 0 })),
    } as any;

    registerRorcaCommands(register, {
      api,
      watch: { start: vi.fn(), stop: vi.fn(), currentRunId: () => null } as any,
      dispatchSkillWorkflow: vi.fn(),
      getState: () => state,
      updateState: (patch) => {
        state = { ...state, ...patch };
      },
    });

    const { ctx, notifications } = createContext();
    await commands.get("rorca-enrich")!("--workspace cashflow", ctx);

    expect(api.enrichSpec).toHaveBeenCalledWith("billing-flow", "cashflow");
    expect(notifications.at(-1)?.message).toContain("Enriched billing-flow (no new stories) via direction-only");
  });

  it("shows run status details", async () => {
    const { commands, register } = createRegistry();
    const detail: PipelineRunDetailResponse = {
      run: {
        id: 91,
        status: "running",
        spec_path: "forge/specs/approved/oauth-login.json",
      },
      stories: [
        { story_id: "US-001", status: "pass" },
        { story_id: "US-002", status: "running" },
      ],
    };
    let state: ExtensionState = { lastRunId: 91 };
    const api = {
      getRun: vi.fn(async () => detail),
      listRuns: vi.fn(),
      listWorkspaces: vi.fn(async () => []),
      resolveWorkspace: vi.fn(),
    } as any;

    registerRorcaCommands(register, {
      api,
      watch: { start: vi.fn(), stop: vi.fn(), currentRunId: () => null } as any,
      dispatchSkillWorkflow: vi.fn(),
      getState: () => state,
      updateState: (patch) => {
        state = { ...state, ...patch };
      },
    });

    const { ctx, notifications, widgets } = createContext();
    await commands.get("rorca-status")!("", ctx);

    expect(api.getRun).toHaveBeenCalledWith(91);
    expect(notifications[0].message).toContain("Run #91");
    expect(widgets.at(-1)?.value?.join("\n")).toContain("US-002: running");
  });

  it("captures a memory as a pending candidate (default)", async () => {
    const { commands, register } = createRegistry();
    const submitCandidate = vi.fn(async () => ({
      id: "cand-1",
      created: true,
    }));
    let state: ExtensionState = {};
    const api = {
      resolveWorkspace: vi.fn(async () => ({ id: "cashflow", label: "Cashflow", path: "/repo" })),
      submitCandidate,
      saveMemory: vi.fn(),
    } as any;

    registerRorcaCommands(register, {
      api,
      watch: { start: vi.fn(), stop: vi.fn(), currentRunId: () => null } as any,
      dispatchSkillWorkflow: vi.fn(),
      getState: () => state,
      updateState: (patch) => {
        state = { ...state, ...patch };
      },
    });

    const { ctx, notifications } = createContext();
    await commands.get("rorca-capture")!(
      "Always use async/await for DB calls --title 'pg async rule' --category Pattern --source US-027 --workspace cashflow",
      ctx,
    );

    expect(submitCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace_id: "cashflow",
        source_system: "rorca-capture",
        category: "Pattern",
        title: "pg async rule",
        rule: "Always use async/await for DB calls",
        confidence: "medium",
        trust_tier: "unverified",
        source_ref: "US-027",
      }),
    );
    expect(submitCandidate).toHaveBeenCalled();
    const firstArg = (submitCandidate as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { idempotency_key?: string } | undefined;
    expect(firstArg?.idempotency_key).toBeTruthy();
    expect(notifications.at(-1)?.message).toContain("Captured");
    expect(notifications.at(-1)?.message).toContain("pending");
  });

  it("captures a memory as approved when --approve is used", async () => {
    const { commands, register } = createRegistry();
    const saveMemory = vi.fn(async () => ({ total: 5 }));
    let state: ExtensionState = {};
    const api = {
      resolveWorkspace: vi.fn(async () => ({ id: "cashflow", label: "Cashflow", path: "/repo" })),
      submitCandidate: vi.fn(),
      saveMemory,
    } as any;

    registerRorcaCommands(register, {
      api,
      watch: { start: vi.fn(), stop: vi.fn(), currentRunId: () => null } as any,
      dispatchSkillWorkflow: vi.fn(),
      getState: () => state,
      updateState: (patch) => {
        state = { ...state, ...patch };
      },
    });

    const { ctx, notifications } = createContext();
    await commands.get("rorca-capture")!(
      "Always use async/await --title 'pg async rule' --category Pattern --approve --workspace cashflow",
      ctx,
    );

    expect(saveMemory).toHaveBeenCalledWith({
      workspaceId: "cashflow",
      category: "Pattern",
      title: "pg async rule",
      rule: "Always use async/await",
      context: expect.stringContaining("Source: manual"),
      source: "",
      sourceType: "manual",
      relatedFiles: [],
    });
    expect(notifications.at(-1)?.message).toContain("approved");
  });

  it("validates related files exist in workspace", async () => {
    const { commands, register } = createRegistry();
    let state: ExtensionState = {};
    const api = {
      resolveWorkspace: vi.fn(async () => ({ id: "cashflow", label: "Cashflow", path: "/nonexistent-repo" })),
      submitCandidate: vi.fn(),
    } as any;

    registerRorcaCommands(register, {
      api,
      watch: { start: vi.fn(), stop: vi.fn(), currentRunId: () => null } as any,
      dispatchSkillWorkflow: vi.fn(),
      getState: () => state,
      updateState: (patch) => {
        state = { ...state, ...patch };
      },
    });

    const { ctx } = createContext();
    const handler = commands.get("rorca-capture")!;
    await expect(handler(
      "Some text --title Test --category Pattern --files src/missing.ts --workspace cashflow",
      ctx,
    )).rejects.toThrow(/not found in workspace/);
  });

  it("reports idempotency when submitting a duplicate candidate", async () => {
    const { commands, register } = createRegistry();
    const submitCandidate = vi.fn(async () => ({
      id: "cand-1",
      created: false, // duplicate
    }));
    let state: ExtensionState = {};
    const api = {
      resolveWorkspace: vi.fn(async () => ({ id: "cashflow", label: "Cashflow", path: "/repo" })),
      submitCandidate,
      saveMemory: vi.fn(),
    } as any;

    registerRorcaCommands(register, {
      api,
      watch: { start: vi.fn(), stop: vi.fn(), currentRunId: () => null } as any,
      dispatchSkillWorkflow: vi.fn(),
      getState: () => state,
      updateState: (patch) => {
        state = { ...state, ...patch };
      },
    });

    const { ctx, notifications } = createContext();
    await commands.get("rorca-capture")!(
      "Some rule --title 'dup test' --category Pattern --source DUP-001 --workspace cashflow",
      ctx,
    );

    expect(notifications.at(-1)?.message).toContain("already exists");
    expect(notifications.at(-1)?.level).toBe("warning");
  });

  it("generates the same idempotency key for identical captures with source ref", async () => {
    const { commands, register } = createRegistry();
    const submitCandidate = vi.fn(async () => ({
      id: "cand-1",
      created: true,
    }));
    let state: ExtensionState = {};
    const api = {
      resolveWorkspace: vi.fn(async () => ({ id: "cashflow", label: "Cashflow", path: "/repo" })),
      submitCandidate,
    } as any;

    registerRorcaCommands(register, {
      api,
      watch: { start: vi.fn(), stop: vi.fn(), currentRunId: () => null } as any,
      dispatchSkillWorkflow: vi.fn(),
      getState: () => state,
      updateState: (patch) => {
        state = { ...state, ...patch };
      },
    });

    const { ctx } = createContext();

    // First call
    await commands.get("rorca-capture")!(
      "Always use async/await --title 'pg async' --category Pattern --source US-027 --workspace cashflow",
      ctx,
    );
    const call0Arg = (submitCandidate as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { idempotency_key?: string } | undefined;
    const key1 = call0Arg?.idempotency_key;

    // Second call with same params
    await commands.get("rorca-capture")!(
      "Always use async/await --title 'pg async' --category Pattern --source US-027 --workspace cashflow",
      ctx,
    );
    const call1Arg = (submitCandidate as ReturnType<typeof vi.fn>).mock.calls[1]?.[0] as { idempotency_key?: string } | undefined;
    const key2 = call1Arg?.idempotency_key;

    expect(key1).toBe(key2);
    expect(typeof key1).toBe("string");
    expect(key1!.length).toBe(32);
  });
});
