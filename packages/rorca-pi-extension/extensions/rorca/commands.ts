import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { RorcaApiClient } from "./api.js";
import { parseApproveCommand, parseForgeCommand, parseRetryCommand, parseRunCommand, parseStatusCommand, resolveBriefInput, tokenizeArgs } from "./args.js";
import { buildWatchSnapshot, formatRunList, formatRunNotify } from "./format.js";
import type { ExtensionState, PiModel, SpecDetail, Workspace } from "./types.js";
import { RunWatchController } from "./watch.js";

export type CommandDependencies = {
  api: RorcaApiClient;
  watch: RunWatchController;
  dispatchSkillSpecCreation(input: {
    workspaceId: string;
    brief: string;
    briefSource: string;
    autoApprove: boolean;
    autoRun: boolean;
    queue: boolean;
    modelOverride?: string;
  }): void;
  getState(): ExtensionState;
  updateState(patch: Partial<ExtensionState>): void;
};

async function pickWorkspace(ctx: ExtensionContext, workspaces: Workspace[]): Promise<string | undefined> {
  const labels = workspaces.map((workspace) => `${workspace.id} — ${workspace.label}`);
  const selected = await ctx.ui.select("Select a Rorca workspace", labels);
  if (!selected) return undefined;
  return selected.split(" — ")[0];
}

function storyLines(spec: SpecDetail): string[] {
  const stories = Array.isArray(spec.userStories) ? spec.userStories : Array.isArray(spec.stories) ? spec.stories : [];
  return stories.slice(0, 12).map((story) => `- ${story.id}: ${story.title}`);
}

async function resolveWorkspace(ctx: ExtensionContext, deps: CommandDependencies, workspaceId?: string): Promise<Workspace> {
  return deps.api.resolveWorkspace(workspaceId || deps.getState().workspaceId, (workspaces) => pickWorkspace(ctx, workspaces));
}

const DEFAULT_PI_MODEL = process.env.RORCA_PI_DEFAULT_MODEL || "openai-codex/gpt-5.4";

function normalizePiModelId(model: PiModel): string {
  return `${model.provider}/${model.model}`;
}

export function choosePreferredPiModel(specModel: string | null | undefined, models: PiModel[]): string | undefined {
  if (models.length === 0) {
    if (specModel?.startsWith("openai-codex/")) return specModel;
    return DEFAULT_PI_MODEL;
  }

  const exactIds = new Map<string, string>();
  for (const model of models) {
    const normalizedId = normalizePiModelId(model);
    exactIds.set(normalizedId, normalizedId);
    exactIds.set(model.model, normalizedId);
  }

  if (specModel) {
    const normalized = exactIds.get(specModel);
    if (normalized) return normalized;
  }

  const preferredPatterns = [
    "openai-codex/gpt-5.4",
    "openai-codex/gpt-5.4-mini",
    "openai-codex/gpt-5.3-codex",
    "openai-codex/gpt-5.2",
  ];
  for (const pattern of preferredPatterns) {
    if (exactIds.has(pattern)) return exactIds.get(pattern);
  }

  const firstCodex = models.find((model) => model.provider === "openai-codex");
  if (firstCodex) return normalizePiModelId(firstCodex);

  return normalizePiModelId(models[0]);
}

async function resolvePiModelForRun(spec: SpecDetail, deps: CommandDependencies, ctx: ExtensionContext): Promise<string | undefined> {
  try {
    const models = await deps.api.getPiModels();
    const preferred = choosePreferredPiModel(spec.model, models);
    if (preferred && spec.model && preferred !== spec.model) {
      ctx.ui.notify(`Pi model override: using ${preferred} instead of unavailable spec model ${spec.model}`, "info");
    }
    return preferred;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Pi model discovery failed; using spec/default model (${message})`, "warning");
    return spec.model?.startsWith("openai-codex/") ? spec.model : DEFAULT_PI_MODEL;
  }
}

async function handleTriggeredRun(runId: number, queued: boolean | undefined, autoWatch: boolean, ctx: ExtensionContext, deps: CommandDependencies, label: string): Promise<void> {
  deps.updateState({ lastRunId: runId });
  const queueNote = queued ? " (queued)" : "";
  ctx.ui.notify(`${label}: run #${runId}${queueNote}`, queued ? "info" : "success");
  if (autoWatch) {
    deps.watch.start(runId, ctx);
  }
}

async function dispatchSkillFirstCreateSpec(
  args: string,
  ctx: ExtensionContext,
  deps: CommandDependencies,
  options?: { usageCommand?: string; forceApprove?: boolean; forceRun?: boolean; deprecationNotice?: string },
): Promise<void> {
  const parsed = parseForgeCommand(args, options?.usageCommand ?? "/rorca-create-spec");
  const { brief, sourceLabel } = resolveBriefInput(parsed.brief);
  const workspace = await resolveWorkspace(ctx, deps, parsed.options.workspaceId);
  deps.updateState({ workspaceId: workspace.id });
  if (options?.deprecationNotice) {
    ctx.ui.notify(options.deprecationNotice, "warning");
  }
  deps.dispatchSkillSpecCreation({
    workspaceId: workspace.id,
    brief,
    briefSource: sourceLabel,
    autoApprove: options?.forceApprove ?? parsed.options.approve,
    autoRun: options?.forceRun ?? parsed.options.run,
    queue: parsed.options.queue,
    modelOverride: parsed.options.model,
  });
  ctx.ui.notify(`Dispatched skill-first spec creation in workspace ${workspace.id}`, "info");
}

export function registerRorcaCommands(registerCommand: (name: string, description: string, handler: (args: string, ctx: ExtensionContext) => Promise<void>) => void, deps: CommandDependencies): void {
  registerCommand("rorca-help", "Show Rorca extension commands", async (_args, ctx) => {
    ctx.ui.notify([
      "/rorca-create-spec <brief|@file> [--workspace <id>] [--approve] [--run] [--queue] [--model <model>]",
      "/rorca-approve <spec-slug> [--workspace <id>]",
      "/rorca-run <spec-slug> [--workspace <id>] [--story <id>] [--queue] [--model <model>] [--sequential] [--no-watch]",
      "/rorca-status [runId|workspaceId] [--workspace <id>]",
      "/rorca-watch [runId]",
      "/rorca-retry <runId> [storyId...] [--sequential] [--no-watch]",
      "/rorca-mcp-status",
    ].join("\n"), "info");
  });

  registerCommand("rorca-create-spec", "Skill-first Rorca spec creation via /skill:rorca-forge", async (args, ctx) => {
    await dispatchSkillFirstCreateSpec(args, ctx, deps);
  });

  registerCommand("rorca-forge", "Deprecated compatibility alias for /rorca-create-spec", async (args, ctx) => {
    await dispatchSkillFirstCreateSpec(args, ctx, deps, {
      usageCommand: "/rorca-forge",
      deprecationNotice: "Deprecated: /rorca-forge now aliases /rorca-create-spec. Prefer /rorca-create-spec.",
    });
  });

  registerCommand("rorca-approve", "Approve the last or specified Rorca spec", async (args, ctx) => {
    const parsed = parseApproveCommand(args, deps.getState().lastSpecSlug);
    const workspace = await resolveWorkspace(ctx, deps, parsed.workspaceId);
    await deps.api.approveSpec(parsed.specSlug, workspace.id);
    deps.updateState({ workspaceId: workspace.id, lastSpecSlug: parsed.specSlug });
    ctx.ui.notify(`Approved ${parsed.specSlug}`, "success");
  });

  registerCommand("rorca-forge-run", "Deprecated compatibility alias for /rorca-create-spec --approve --run", async (args, ctx) => {
    await dispatchSkillFirstCreateSpec(args, ctx, deps, {
      usageCommand: "/rorca-forge-run",
      forceApprove: true,
      forceRun: true,
      deprecationNotice: "Deprecated: /rorca-forge-run now aliases /rorca-create-spec --approve --run. Prefer /rorca-create-spec.",
    });
  });

  registerCommand("rorca-run", "Trigger an approved Rorca spec with Pi", async (args, ctx) => {
    const parsed = parseRunCommand(args);
    const workspace = await resolveWorkspace(ctx, deps, parsed.workspaceId);
    const spec = await deps.api.getSpec(parsed.specSlug, workspace.id);
    const resolvedModel = parsed.model ?? await resolvePiModelForRun(spec, deps, ctx);
    const trigger = await deps.api.triggerRun({
      specSlug: parsed.specSlug,
      workspaceId: workspace.id,
      storyId: parsed.storyId,
      queue: parsed.queue,
      model: resolvedModel,
      includeGraph: true,
      forceSequential: parsed.forceSequential,
    });

    if (trigger.conflict) {
      throw new Error(`Workspace busy. Active run: ${trigger.activeRunId}`);
    }

    deps.updateState({ workspaceId: workspace.id, lastSpecSlug: parsed.specSlug });
    await handleTriggeredRun(trigger.runId, trigger.queued, parsed.autoWatch, ctx, deps, `Triggered ${parsed.specSlug}`);
  });

  registerCommand("rorca-status", "Show Rorca run status or recent runs", async (args, ctx) => {
    const state = deps.getState();
    const parsed = parseStatusCommand(args, state.lastRunId, state.workspaceId);

    if (parsed.runId) {
      const detail = await deps.api.getRun(parsed.runId);
      const snapshot = buildWatchSnapshot(detail);
      ctx.ui.setWidget("rorca-run", []);
      ctx.ui.notify(formatRunNotify(snapshot), "info");
      ctx.ui.setWidget("rorca-run", [
        `Rorca Run #${snapshot.runId}`,
        `Status: ${snapshot.status}`,
        `Spec: ${snapshot.specSlug}`,
        ...snapshot.stories.slice(0, 8).map((story) => `- ${story.story_id}: ${story.status}`),
      ]);
      deps.updateState({ lastRunId: parsed.runId });
      return;
    }

    const workspace = await resolveWorkspace(ctx, deps, parsed.workspaceId);
    const [runs, workspaces] = await Promise.all([
      deps.api.listRuns(workspace.id, 10),
      deps.api.listWorkspaces(),
    ]);
    deps.updateState({ workspaceId: workspace.id });
    ctx.ui.notify(formatRunList(runs, workspaces), "info");
  });

  registerCommand("rorca-watch", "Watch the latest or specified Rorca run", async (args, ctx) => {
    const tokens = tokenizeArgs(args);
    const explicitRunId = tokens[0] && /^\d+$/.test(tokens[0]) ? Number(tokens[0]) : deps.getState().lastRunId;
    if (!explicitRunId) {
      throw new Error("Usage: /rorca-watch <runId>");
    }
    deps.watch.start(explicitRunId, ctx);
    ctx.ui.notify(`Watching Rorca run #${explicitRunId}`, "info");
  });

  registerCommand("rorca-attach", "Alias for /rorca-watch", async (args, ctx) => {
    const tokens = tokenizeArgs(args);
    const explicitRunId = tokens[0] && /^\d+$/.test(tokens[0]) ? Number(tokens[0]) : deps.getState().lastRunId;
    if (!explicitRunId) {
      throw new Error("Usage: /rorca-attach <runId>");
    }
    deps.watch.start(explicitRunId, ctx);
    ctx.ui.notify(`Attached to Rorca run #${explicitRunId}`, "info");
  });

  registerCommand("rorca-retry", "Retry failed stories in a Rorca run", async (args, ctx) => {
    const parsed = parseRetryCommand(args, deps.getState().lastRunId);
    const result = await deps.api.retryRun(parsed.runId, parsed.storyIds, {
      forceSequential: parsed.forceSequential,
    });
    await handleTriggeredRun(result.runId, result.queued, parsed.autoWatch, ctx, deps, `Retried run ${parsed.runId}`);
  });
}

