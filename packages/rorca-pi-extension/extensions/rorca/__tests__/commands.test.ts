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
    const dispatchSkillSpecCreation = vi.fn();
    let state: ExtensionState = {};
    const api = {
      resolveWorkspace: vi.fn(async () => ({ id: "cashflow", label: "Cashflow", path: "/repo" })),
    } as any;

    registerRorcaCommands(register, {
      api,
      watch: { start: vi.fn(), stop: vi.fn(), currentRunId: () => null } as any,
      dispatchSkillSpecCreation,
      getState: () => state,
      updateState: (patch) => {
        state = { ...state, ...patch };
      },
    });

    const { ctx, notifications } = createContext();
    await commands.get("rorca-create-spec")!("Ship OAuth login --workspace cashflow --approve --run --queue --model openai-codex/gpt-5.4", ctx);

    expect(dispatchSkillSpecCreation).toHaveBeenCalledWith({
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

  it("maps forge-run compatibility alias onto the skill-first create-spec flow", async () => {
    const { commands, register } = createRegistry();
    const dispatchSkillSpecCreation = vi.fn();
    let state: ExtensionState = {};
    const api = {
      resolveWorkspace: vi.fn(async () => ({ id: "cashflow", label: "Cashflow", path: "/repo" })),
    } as any;

    registerRorcaCommands(register, {
      api,
      watch: { start: vi.fn(), stop: vi.fn(), currentRunId: () => null } as any,
      dispatchSkillSpecCreation,
      getState: () => state,
      updateState: (patch) => {
        state = { ...state, ...patch };
      },
    });

    const { ctx, notifications } = createContext();
    await commands.get("rorca-forge-run")!("Ship OAuth login --workspace cashflow --queue", ctx);

    expect(dispatchSkillSpecCreation).toHaveBeenCalledWith({
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

  it("forwards sequential mode on /rorca-run", async () => {
    const { commands, register } = createRegistry();
    let state: ExtensionState = {};
    const api = {
      resolveWorkspace: vi.fn(async () => ({ id: "cashflow", label: "Cashflow", path: "/repo" })),
      getSpec: vi.fn(async () => ({ id: "oauth-login", model: "openai-codex/gpt-5.4" })),
      triggerRun: vi.fn(async () => ({ runId: 101, queued: false })),
    } as any;

    registerRorcaCommands(register, {
      api,
      watch: { start: vi.fn(), stop: vi.fn(), currentRunId: () => null } as any,
      dispatchSkillSpecCreation: vi.fn(),
      getState: () => state,
      updateState: (patch) => {
        state = { ...state, ...patch };
      },
    });

    const { ctx } = createContext();
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
  });

  it("forwards sequential mode on /rorca-retry", async () => {
    const { commands, register } = createRegistry();
    let state: ExtensionState = { lastRunId: 77 };
    const api = {
      retryRun: vi.fn(async () => ({ ok: true, queued: true, runId: 102 })),
    } as any;

    registerRorcaCommands(register, {
      api,
      watch: { start: vi.fn(), stop: vi.fn(), currentRunId: () => null } as any,
      dispatchSkillSpecCreation: vi.fn(),
      getState: () => state,
      updateState: (patch) => {
        state = { ...state, ...patch };
      },
    });

    const { ctx } = createContext();
    await commands.get("rorca-retry")!("77 US-001 --sequential --no-watch", ctx);

    expect(api.retryRun).toHaveBeenCalledWith(77, ["US-001"], {
      forceSequential: true,
    });
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
      dispatchSkillSpecCreation: vi.fn(),
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
});
