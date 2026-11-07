/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RorcaApiClient } from "./api.js";
import { generateCaptureIdempotencyKey, parseApproveCommand, parseCaptureCommand, parseEnrichCommand, parseForgeCommand, parseRetryCommand, parseRunCommand, parseStatusCommand, resolveBriefInput, tokenizeArgs } from "./args.js";
import { buildWatchSnapshot, formatRunList, formatRunNotify } from "./format.js";
import { type RorcaSkillWorkflowRequest } from "./skill-launcher.js";
import type { ExtensionState, PiModel, SpecDetail, Workspace } from "./types.js";
import { RunWatchController } from "./watch.js";

export type CommandDependencies = {
  api: RorcaApiClient;
  watch: RunWatchController;
  dispatchSkillWorkflow(input: RorcaSkillWorkflowRequest): void;
  canLaunchSkillWorkflow?(input: RorcaSkillWorkflowRequest): Promise<boolean>;
  getState(): ExtensionState;
  updateState(patch: Partial<ExtensionState>): void;
};

async function pickWorkspace(ctx: ExtensionContext, workspaces: Workspace[]): Promise<string | undefined> {
  const labels = workspaces.map((workspace) => `${workspace.id} — ${workspace.label}`);
  const selected = await ctx.ui.select("Select a Rorca workspace", labels);
  if (!selected) return undefined;
  return selected.split(" — ")[0];
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

async function canUseSkillWorkflow(deps: CommandDependencies, input: RorcaSkillWorkflowRequest): Promise<boolean> {
  if (!deps.canLaunchSkillWorkflow) return true;
  return deps.canLaunchSkillWorkflow(input);
}

/**
 * CTM-006: Surface the canonical workspace-context routing decision before a run so
 * the operator is warned when a workspace is context blind (missing the
 * .rorca / AGENTS.md / MEMORY.md routing contract). Nonfatal — a failed lookup or
 * missing endpoint never blocks the run.
 */
async function notifyContextRoutingHealth(ctx: ExtensionContext, deps: CommandDependencies, workspaceId: string): Promise<void> {
  try {
    const routing = await deps.api.getContextRouting(workspaceId);
    if (!routing?.contract?.satisfied) {
      const unmet = routing?.contract?.unmet?.length ? routing.contract.unmet.join("; ") : "missing routing context";
      ctx.ui.notify(`Context routing warning for ${workspaceId} (richness ${routing?.richnessScore ?? 0}/100): ${unmet}`, "warning");
    }
  } catch {
    // Endpoint unavailable or older backend — routing health is advisory, never blocking.
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

  const autoApprove = options?.forceApprove ?? parsed.options.approve;
  const autoRun = options?.forceRun ?? parsed.options.run;
  const skillInput: RorcaSkillWorkflowRequest = {
    workflow: "forge",
    skillName: autoApprove && autoRun ? "rorca-forge-run" : "rorca-forge",
    workspaceId: workspace.id,
    brief,
    briefSource: sourceLabel,
    autoApprove,
    autoRun,
    queue: parsed.options.queue,
    modelOverride: parsed.options.model,
  };

  if (await canUseSkillWorkflow(deps, skillInput)) {
    deps.dispatchSkillWorkflow(skillInput);
    ctx.ui.notify(`Dispatched skill-first spec creation in workspace ${workspace.id}`, "info");
    return;
  }

  ctx.ui.notify("Rorca MCP explicit-draft bundle unavailable: generation-context and rorca_create_spec/rorca_persist_spec are required. Backend drafting fallback is disabled for normal authoring.", "error");
  throw new Error("Skill-first spec creation requires MCP generation-context plus explicit persistence tools");
}

export function registerRorcaCommands(registerCommand: (name: string, description: string, handler: (args: string, ctx: ExtensionContext) => Promise<void>) => void, deps: CommandDependencies): void {
  registerCommand("rorca-help", "Show Rorca extension commands", async (_args, ctx) => {
    ctx.ui.notify([
      "/rorca-create-spec <brief|@file> [--workspace <id>] [--approve] [--run] [--queue] [--model <model>]",
      "/rorca-approve <spec-slug> [--workspace <id>]",
      "/rorca-enrich <spec-slug> [--workspace <id>]",
      "/rorca-run <spec-slug> [--workspace <id>] [--story <id>] [--queue] [--model <model>] [--sequential] [--no-watch]",
      "/rorca-status [runId|workspaceId] [--workspace <id>]",
      "/rorca-delivery [runId] [--workspace <id>]",
      "/rorca-watch [runId]",
      "/rorca-retry <runId> [storyId...] [--sequential] [--no-watch]",
      "/rorca-capture <text> --title <title> --category <category> [--files <path...>] [--source <ref>] [--confidence high|medium|low] [--trust tier] [--workspace <id>] [--approve]",
      "/agents-list [all|--all|session-name]",
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
    deps.updateState({ workspaceId: workspace.id, lastSpecSlug: parsed.specSlug });

    const skillInput: RorcaSkillWorkflowRequest = {
      workflow: "approve",
      skillName: "rorca-approve",
      workspaceId: workspace.id,
      specSlug: parsed.specSlug,
    };

    if (await canUseSkillWorkflow(deps, skillInput)) {
      deps.dispatchSkillWorkflow(skillInput);
      ctx.ui.notify(`Dispatched skill-guided approval for ${parsed.specSlug}`, "info");
      return;
    }

    ctx.ui.notify("Rorca MCP bridge unavailable; falling back to direct approval.", "warning");
    await deps.api.approveSpec(parsed.specSlug, workspace.id);
    ctx.ui.notify(`Approved ${parsed.specSlug}`, "success");
  });

  registerCommand("rorca-enrich", "Enrich a Rorca spec's stories with retrieved context annotations", async (args, ctx) => {
    const parsed = parseEnrichCommand(args, deps.getState().lastSpecSlug);
    const workspace = await resolveWorkspace(ctx, deps, parsed.workspaceId);
    deps.updateState({ workspaceId: workspace.id, lastSpecSlug: parsed.specSlug });

    ctx.ui.notify(`Enriching ${parsed.specSlug}…`, "info");
    const result = await deps.api.enrichSpec(parsed.specSlug, workspace.id);
    const countNote = result.storiesEnriched > 0
      ? `${result.storiesEnriched} ${result.storiesEnriched === 1 ? "story" : "stories"}`
      : "no new stories";
    ctx.ui.notify(`Enriched ${parsed.specSlug} (${countNote}) via ${result.retrievalMethod}`, "success");
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
    deps.updateState({ workspaceId: workspace.id, lastSpecSlug: parsed.specSlug });

    await notifyContextRoutingHealth(ctx, deps, workspace.id);

    const skillInput: RorcaSkillWorkflowRequest = {
      workflow: "run",
      skillName: "rorca-run-operator",
      workspaceId: workspace.id,
      specSlug: parsed.specSlug,
      specPath: `forge/specs/approved/${parsed.specSlug}.json`,
      storyId: parsed.storyId,
      queue: parsed.queue,
      forceSequential: parsed.forceSequential,
      modelOverride: parsed.model,
      watchAfterLaunch: parsed.autoWatch,
    };

    if (await canUseSkillWorkflow(deps, skillInput)) {
      deps.dispatchSkillWorkflow(skillInput);
      ctx.ui.notify(`Dispatched skill-guided run planning for ${parsed.specSlug}`, "info");
      return;
    }

    ctx.ui.notify("Rorca MCP bridge unavailable; falling back to direct run trigger.", "warning");
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

  registerCommand("rorca-delivery", "Inspect provider-neutral local review bundles", async (args, ctx) => {
    const state = deps.getState();
    const parsed = parseStatusCommand(args, state.lastRunId, state.workspaceId);
    const workspace = await resolveWorkspace(ctx, deps, parsed.workspaceId);
    const bundles = await deps.api.listLocalReviewBundles(workspace.id, parsed.runId, 20);
    deps.updateState({ workspaceId: workspace.id, ...(parsed.runId ? { lastRunId: parsed.runId } : {}) });
    const scope = parsed.runId ? `run #${parsed.runId}` : `workspace ${workspace.id}`;
    const lines = [
      `Local review delivery — ${scope}`,
      "Default: local-review-bundle (no provider, network, credential, merge, or deploy authority)",
      ...(bundles.length === 0
        ? ["No finalized bundles."]
        : bundles.map((bundle) => [
            bundle.bundleId,
            `${bundle.identity.storyId} attempt ${bundle.identity.attempt}`,
            `${bundle.repository.baseSha.slice(0, 8)}→${bundle.repository.headSha.slice(0, 8)}`,
            `validation=${bundle.validation.status}`,
            `projection=${bundle.projectionIntegrity}`,
            "merge=not_authorized deploy=not_authorized",
          ].join(" · "))),
    ];
    ctx.ui.setWidget("rorca-delivery", lines.slice(0, 12));
    ctx.ui.notify(lines.join("\n"), bundles.some((bundle) => bundle.projectionIntegrity !== "verified") ? "warning" : "info");
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
    const skillInput: RorcaSkillWorkflowRequest = {
      workflow: "retry",
      skillName: "rorca-retry-planner",
      runId: parsed.runId,
      storyIds: parsed.storyIds,
      forceSequential: parsed.forceSequential,
      watchAfterLaunch: parsed.autoWatch,
    };

    if (await canUseSkillWorkflow(deps, skillInput)) {
      deps.dispatchSkillWorkflow(skillInput);
      ctx.ui.notify(`Dispatched skill-guided retry planning for run ${parsed.runId}`, "info");
      return;
    }

    ctx.ui.notify("Rorca MCP bridge unavailable; falling back to direct retry.", "warning");
    const result = await deps.api.retryRun(parsed.runId, parsed.storyIds, {
      forceSequential: parsed.forceSequential,
    });
    await handleTriggeredRun(result.runId, result.queued, parsed.autoWatch, ctx, deps, `Retried run ${parsed.runId}`);
  });

  registerCommand("rorca-capture", "Capture a memory (lessons, decisions, conventions, bug fixes, patterns, gotchas) to the workspace ledger", async (args, ctx) => {
    const parsed = parseCaptureCommand(args);
    const workspace = await resolveWorkspace(ctx, deps, parsed.workspaceId);
    deps.updateState({ workspaceId: workspace.id });

    // Validate related files exist in the workspace
    const missingFiles: string[] = [];
    for (const file of parsed.files) {
      const absPath = path.join(workspace.path, file);
      if (!fs.existsSync(absPath)) {
        missingFiles.push(file);
      }
    }
    if (missingFiles.length > 0) {
      throw new Error(
        `Related file(s) not found in workspace: ${missingFiles.join(', ')}`,
      );
    }

    const idempotencyKey = generateCaptureIdempotencyKey(
      workspace.id,
      parsed.source,
      parsed.title,
      parsed.text,
    );

    if (parsed.approve) {
      // Submit directly as an approved memory entry
      const result = await deps.api.saveMemory({
        workspaceId: workspace.id,
        category: parsed.category,
        title: parsed.title,
        rule: parsed.text,
        context: `Source: ${parsed.source || 'manual'} | Confidence: ${parsed.confidence} | Trust: ${parsed.trust}`,
        source: parsed.source ?? '',
        sourceType: 'manual',
        relatedFiles: parsed.files,
      });
      ctx.ui.notify(
        `Captured "${parsed.title}" as ${parsed.category} memory (approved, #${result.total} entries)`,
        "success",
      );
    } else {
      // Submit as a pending candidate for review
      const result = await deps.api.submitCandidate({
        workspace_id: workspace.id,
        source_system: 'rorca-capture',
        category: parsed.category,
        title: parsed.title,
        rule: parsed.text,
        context: `Submitted via Pi CLI. Source: ${parsed.source || 'manual'}. Confidence: ${parsed.confidence}. Trust: ${parsed.trust}.`,
        related_files: parsed.files,
        confidence: parsed.confidence,
        trust_tier: parsed.trust,
        source_ref: parsed.source,
        idempotency_key: idempotencyKey,
      });

      const statusLabel = result.created ? 'pending' : 'already exists';
      ctx.ui.notify(
        `Captured "${parsed.title}" as ${parsed.category} candidate (${statusLabel}, idempotent key: ${idempotencyKey.slice(0, 8)}…)`,
        result.created ? "info" : "warning",
      );
    }
  });
}

