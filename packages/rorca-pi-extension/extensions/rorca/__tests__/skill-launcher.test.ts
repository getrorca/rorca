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
  it("uses the shared forge operation instead of exposing low-level authoring schemas", () => {
    expect(getRequiredToolGroups(forgeRequest)).toEqual([
      ["rorca_specs_forge"],
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
      ["rorca_specs_forge"],
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

    expect(prompt).toContain("forgeSequence: [rorca_specs_forge, get_saved_spec, inspect_workflow_and_readiness");
    expect(prompt).toContain("authoringContract: call rorca_specs_forge once");
    expect(prompt).toContain("never invent or self-assert a human receipt");
    expect(prompt).toContain("verificationContract: after forge persistence");
    expect(prompt).toContain("autoWorktree=true, autoMerge=false, mergeStrategy=branch-only, terminal_mode=ansi-html, and forceSequential=true");
    expect(prompt).not.toContain("rorca_specs_authoring_preflight,");
    expect(prompt.indexOf("brief: |")).toBeGreaterThan(prompt.indexOf("runContract:"));
  });
});
