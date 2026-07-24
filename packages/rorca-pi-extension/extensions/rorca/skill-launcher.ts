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
        // Until MCP projects the backend's complete lifecycle-authoring schema,
        // the shared forge operation is the one canonical no-guessing path.
        ["rorca_specs_forge"],
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
      "availableToolAliases: [rorca_specs_forge, rorca_get_specs_by_specId, rorca_spec_workflow, rorca_specs_by_specId_workflow, rorca_spec_readiness, rorca_specs_by_specId_readiness, rorca_retry_spec_stage, rorca_repair_spec, rorca_approve_spec, rorca_trigger_run, rorca_pipeline_trigger]",
      "forgeSequence: [rorca_specs_forge, get_saved_spec, inspect_workflow_and_readiness, approve_if_requested, trigger_safe_local_run_if_requested]",
      "authoringContract: call rorca_specs_forge once with this brief and workspace; Rorca owns context gathering, deterministic lifecycle preflight, bounded revisions, policy defaults, enrichment, and canonical persistence",
      "confirmationContract: if forge reports that explicit human confirmation is required, stop and present that exact request; never invent or self-assert a human receipt",
      "verificationContract: after forge persistence, read the saved spec plus rorca_spec_workflow or rorca_spec_readiness; do not treat slug creation alone as execution readiness",
      "runContract: ordinary runs use autoWorktree=true, autoMerge=false, mergeStrategy=branch-only, terminal_mode=ansi-html, and forceSequential=true; external delivery is a separate TaskManifest-authorized workflow",
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
