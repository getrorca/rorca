/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

export type RorcaSkillWorkflowRequest =
  | {
      workflow: "forge";
      skillName: "rorca-forge" | "rorca-forge-run";
      workspaceId: string;
      brief: string;
      briefSource: string;
      autoApprove: boolean;
      autoRun: boolean;
      queue: boolean;
      modelOverride?: string;
    }
  | {
      workflow: "approve";
      skillName: "rorca-approve";
      workspaceId: string;
      specSlug: string;
    }
  | {
      workflow: "run";
      skillName: "rorca-run-operator";
      workspaceId: string;
      specSlug: string;
      specPath: string;
      storyId?: string;
      queue: boolean;
      forceSequential?: boolean;
      modelOverride?: string;
      watchAfterLaunch: boolean;
    }
  | {
      workflow: "retry";
      skillName: "rorca-retry-planner";
      runId: number;
      storyIds: string[];
      forceSequential?: boolean;
      watchAfterLaunch: boolean;
    };

function indentBlock(value: string): string {
  return value
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function formatArray(items: string[]): string {
  return `[${items.join(", ")}]`;
}

export function getRequiredToolGroups(input: RorcaSkillWorkflowRequest): string[][] {
  switch (input.workflow) {
    case "forge": {
      const groups: string[][] = [
        ["rorca_specs_generation_context"],
        ["rorca_create_spec", "rorca_persist_spec", "rorca_specs_persist"],
        ["rorca_get_specs_by_specId"],
        ["rorca_spec_workflow", "rorca_specs_by_specId_workflow", "rorca_spec_readiness", "rorca_specs_by_specId_readiness"],
      ];
      if (input.autoApprove) groups.push(["rorca_approve_spec", "rorca_specs_by_specId_approve"]);
      if (input.autoRun) groups.push(["rorca_trigger_run", "rorca_pipeline_trigger"]);
      return groups;
    }
    case "approve":
      return [["rorca_approve_spec", "rorca_specs_by_specId_approve"]];
    case "run":
      return [["rorca_trigger_run", "rorca_pipeline_trigger"]];
    case "retry":
      return [["rorca_retry_story", "rorca_pipeline_runs_by_runId_retry"]];
  }
}

export function formatSkillLaunchPrompt(input: RorcaSkillWorkflowRequest): string {
  if (input.workflow === "forge") {
    return [
      `/skill:${input.skillName}`,
      "surface: pi-extension",
      "preferMcp: true",
      "allowRestFallback: false",
      `workspaceId: ${input.workspaceId}`,
      `briefSource: ${input.briefSource}`,
      `autoApprove: ${input.autoApprove}`,
      `autoRun: ${input.autoRun}`,
      `queue: ${input.queue}`,
      ...(input.modelOverride ? [`modelOverride: ${input.modelOverride}`] : []),
      "availableToolAliases: [rorca_get_context, rorca_specs_generation_context, rorca_recall, rorca_search, rorca_get_specs_by_specId, rorca_create_spec, rorca_persist_spec, rorca_spec_workflow, rorca_specs_by_specId_workflow, rorca_spec_readiness, rorca_specs_by_specId_readiness, rorca_retry_spec_stage, rorca_repair_spec, rorca_approve_spec, rorca_trigger_run, rorca_pipeline_trigger]",
      "forgeSequence: [rorca_specs_generation_context, draft_in_pi, rorca_create_spec, get_saved_spec, inspect_workflow_or_readiness, verify_saved_spec]",
      "contextContract: fetch rorca_specs_generation_context before persistence, then forward its contextUsed and contextSummary into rorca_create_spec or rorca_persist_spec so the saved spec Context tab reflects the true caller-observed drafting context",
      "policyContract: persist with explicit policy metadata by passing either policyPresetId or postSavePolicy derived from the effective post-save policy/postSaveDefaults bundle, and report which preset or effective policy was used",
      "postSaveContract: keep post-save enrich and matchSkills enabled by forwarding the bundle defaults as explicit policy intent unless the launcher or user explicitly requests an opt-out",
      "verificationContract: after persistence, read the saved spec plus rorca_spec_workflow or rorca_spec_readiness and classify each story skill state as present, pending, skipped:no_installed_skills, or failed:<retryable_reason>; never treat slug creation alone as proof that skill enrichment succeeded",
      "fallbackContract: backend/server contextSummary backfill is a repair-only fallback and must not be treated as the normal creation contract or as a substitute for caller-observed drafting context",
      "brief: |",
      indentBlock(input.brief),
    ].join("\n");
  }

  if (input.workflow === "approve") {
    return [
      `/skill:${input.skillName}`,
      "surface: pi-extension",
      "preferMcp: true",
      "allowRestFallback: false",
      `workspaceId: ${input.workspaceId}`,
      `specSlug: ${input.specSlug}`,
      "availableToolAliases: [rorca_get_specs_by_specId, rorca_list_specs, rorca_recall, rorca_search, rorca_approve_spec, rorca_specs_by_specId_approve]",
    ].join("\n");
  }

  if (input.workflow === "run") {
    return [
      `/skill:${input.skillName}`,
      "surface: pi-extension",
      "preferMcp: true",
      "allowRestFallback: false",
      `workspaceId: ${input.workspaceId}`,
      `specSlug: ${input.specSlug}`,
      `specPath: ${input.specPath}`,
      `queue: ${input.queue}`,
      `includeGraph: true`,
      `watchAfterLaunch: ${input.watchAfterLaunch}`,
      ...(input.storyId ? [`storyId: ${input.storyId}`] : []),
      ...(input.forceSequential ? ["forceSequential: true"] : []),
      ...(input.modelOverride ? [`modelOverride: ${input.modelOverride}`] : []),
      "availableToolAliases: [rorca_get_specs_by_specId, rorca_pipeline_status, rorca_get_pipeline_runs_by_runId, rorca_recall, rorca_search, rorca_trigger_run, rorca_pipeline_trigger]",
    ].join("\n");
  }

  return [
    `/skill:${input.skillName}`,
    "surface: pi-extension",
    "preferMcp: true",
    "allowRestFallback: false",
    `runId: ${input.runId}`,
    `storyIds: ${formatArray(input.storyIds)}`,
    `watchAfterLaunch: ${input.watchAfterLaunch}`,
    ...(input.forceSequential ? ["forceSequential: true"] : []),
    "availableToolAliases: [rorca_get_pipeline_runs_by_runId, rorca_pipeline_status, rorca_recall, rorca_search, rorca_retry_story, rorca_pipeline_runs_by_runId_retry]",
  ].join("\n");
}
