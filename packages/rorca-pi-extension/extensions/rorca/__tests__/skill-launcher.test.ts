/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import { describe, expect, it } from "vitest";
import { formatSkillLaunchPrompt, getRequiredToolGroups } from "../skill-launcher.js";

const forgeRequest = {
  workflow: "forge" as const,
  skillName: "rorca-forge" as const,
  workspaceId: "cashflow",
  brief: "Ship OAuth login",
  briefSource: "inline",
  autoApprove: false,
  autoRun: false,
  queue: false,
};

describe("rorca skill launcher", () => {
  it("requires generation context and explicit caller-draft persistence", () => {
    expect(getRequiredToolGroups(forgeRequest)).toEqual([
      ["rorca_specs_generation_context"],
      ["rorca_create_spec", "rorca_persist_spec"],
      ["rorca_get_spec_export_kit"],
      ["rorca_get_specs_by_specId"],
      ["rorca_spec_workflow", "rorca_specs_by_specId_workflow", "rorca_spec_readiness", "rorca_specs_by_specId_readiness"],
    ]);
  });

  it("adds approve/run tool groups for the explicit composite flow", () => {
    expect(getRequiredToolGroups({
      ...forgeRequest,
      skillName: "rorca-forge-run",
      autoApprove: true,
      autoRun: true,
      queue: true,
    })).toEqual([
      ["rorca_specs_generation_context"],
      ["rorca_create_spec", "rorca_persist_spec"],
      ["rorca_get_spec_export_kit"],
      ["rorca_get_specs_by_specId"],
      ["rorca_spec_workflow", "rorca_specs_by_specId_workflow", "rorca_spec_readiness", "rorca_specs_by_specId_readiness"],
      ["rorca_approve_spec", "rorca_specs_by_specId_approve"],
      ["rorca_trigger_run", "rorca_pipeline_trigger"],
    ]);
  });

  it("pins forge/run to one no-guessing authoring call and safe local execution", () => {
    const prompt = formatSkillLaunchPrompt({
      ...forgeRequest,
      skillName: "rorca-forge-run",
      autoApprove: true,
      autoRun: true,
      queue: true,
      modelOverride: "openai-codex/gpt-5.4",
    });

    expect(prompt).toContain("forgeSequence: [rorca_specs_generation_context, caller_draft_stories_and_export_kit, rorca_create_spec_or_persist, verify_current_export_kit");
    expect(prompt).toContain("complete exportKit input locally using exportKitContract");
    expect(prompt).toContain("never use rorca_specs_forge or rorca_generate_spec for normal authoring");
    expect(prompt).toContain("never invent or self-assert a human receipt");
    expect(prompt).toContain("verificationContract: after explicit persistence");
    expect(prompt).toContain("autoWorktree=true, autoMerge=false, mergeStrategy=branch-only, terminal_mode=ansi-html, and forceSequential=true");
    expect(prompt).not.toContain("rorca_specs_authoring_preflight,");
    expect(prompt.indexOf("brief: |")).toBeGreaterThan(prompt.indexOf("runContract:"));
  });
});

describe("rorca run repair workflow", () => {
  const repairRequest = {
    workflow: "repair" as const,
    skillName: "hermes-rorca-run-repair" as const,
    runId: 611,
    prompt: "Rorca run #611 failed. Diagnose, fix, re-drive, verify.",
  };

  it("exposes run status/retry and spec workflow tool groups", () => {
    expect(getRequiredToolGroups(repairRequest)).toEqual([
      ["rorca_run_status", "rorca_pipeline_runs_by_runId", "rorca_pipeline_runs_by_runId_retry"],
      ["rorca_spec_workflow", "rorca_spec_readiness"],
    ]);
  });

  it("pins the repair skill and mandates diagnosis before re-drive", () => {
    const prompt = formatSkillLaunchPrompt(repairRequest);
    expect(prompt).toContain("/skill:hermes-rorca-run-repair");
    expect(prompt).toContain("runId: 611");
    expect(prompt).toContain("repairContract: diagnose the root cause");
    expect(prompt).toContain("apply the smallest safe fix");
    expect(prompt).toContain("re-drive the run");
    expect(prompt).toContain("Never leave the run failed without a written diagnosis and an exact operator action");
    expect(prompt).toContain("task: |");
    expect(prompt).toContain("Rorca run #611 failed.");
  });
});
