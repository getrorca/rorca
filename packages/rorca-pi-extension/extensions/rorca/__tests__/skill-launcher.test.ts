/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, expect, it } from "vitest";
import { formatSkillLaunchPrompt, getRequiredToolGroups } from "../skill-launcher.js";

describe("rorca skill launcher", () => {
  it("requires the canonical generation-context, persistence, and post-persist verification tools for forge flows", () => {
    expect(getRequiredToolGroups({
      workflow: "forge",
      skillName: "rorca-forge",
      workspaceId: "cashflow",
      brief: "Ship OAuth login",
      briefSource: "inline",
      autoApprove: false,
      autoRun: false,
      queue: false,
    })).toEqual([
      ["rorca_specs_generation_context"],
      ["rorca_specs_authoring_preflight", "rorca_preflight_spec_authoring"],
      ["rorca_specs_authoring_preflight_confirm", "rorca_confirm_spec_authoring_plan"],
      ["rorca_create_spec", "rorca_persist_spec", "rorca_specs_persist", "rorca_persist_spec_batch", "rorca_specs_persist_batch"],
      ["rorca_get_specs_by_specId"],
      ["rorca_spec_workflow", "rorca_specs_by_specId_workflow", "rorca_spec_readiness", "rorca_specs_by_specId_readiness"],
    ]);
  });

  it("adds approve/run tool groups when forge flows request end-to-end launch", () => {
    expect(getRequiredToolGroups({
      workflow: "forge",
      skillName: "rorca-forge-run",
      workspaceId: "cashflow",
      brief: "Ship OAuth login",
      briefSource: "inline",
      autoApprove: true,
      autoRun: true,
      queue: true,
    })).toEqual([
      ["rorca_specs_generation_context"],
      ["rorca_specs_authoring_preflight", "rorca_preflight_spec_authoring"],
      ["rorca_specs_authoring_preflight_confirm", "rorca_confirm_spec_authoring_plan"],
      ["rorca_create_spec", "rorca_persist_spec", "rorca_specs_persist", "rorca_persist_spec_batch", "rorca_specs_persist_batch"],
      ["rorca_get_specs_by_specId"],
      ["rorca_spec_workflow", "rorca_specs_by_specId_workflow", "rorca_spec_readiness", "rorca_specs_by_specId_readiness"],
      ["rorca_approve_spec", "rorca_specs_by_specId_approve"],
      ["rorca_trigger_run", "rorca_pipeline_trigger"],
    ]);
  });

  it("pins the forge prompt to context forwarding, explicit policy passing, workflow/readiness verification, and repair-only fallback semantics", () => {
    const prompt = formatSkillLaunchPrompt({
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

    expect(prompt).toContain("forgeSequence: [rorca_specs_generation_context, validate_lifecycle_authoring, propose_one_or_many_plan, draft_complete_spec_set, rorca_specs_authoring_preflight, revise_max_3, explicit_human_confirmation_if_required, persist_one_or_batch");
    expect(prompt).toContain("authoringContract: lifecycleAuthoring is mandatory for phase-aware claims");
    expect(prompt).toContain("revisionContract: record each attempt and material revisions, stop after at most 3 attempts");
    expect(prompt).toContain("confirmationContract: show exact spec count, boundaries, requirement ownership, dependency DAG, required capabilities, and revisions");
    expect(prompt).toContain("contextContract: fetch rorca_specs_generation_context before persistence, then forward its contextUsed and contextSummary into rorca_create_spec or rorca_persist_spec");
    expect(prompt).toContain("policyContract: persist with explicit policy metadata by passing either policyPresetId or postSavePolicy derived from the effective post-save policy/postSaveDefaults bundle, and report which preset or effective policy was used");
    expect(prompt).toContain("policyPresetId");
    expect(prompt).toContain("postSaveContract: keep post-save enrich and matchSkills enabled by forwarding the bundle defaults as explicit policy intent unless the launcher or user explicitly requests an opt-out");
    expect(prompt).toContain("verificationContract: after persistence, read the saved spec plus rorca_spec_workflow or rorca_spec_readiness and classify each story skill state as present, pending, skipped:no_installed_skills, or failed:<retryable_reason>; never treat slug creation alone as proof that skill enrichment succeeded");
    expect(prompt).toContain("skipped:no_installed_skills");
    expect(prompt).toContain("failed:<retryable_reason>");
    expect(prompt).toContain("fallbackContract: backend/server contextSummary backfill is a repair-only fallback and must not be treated as the normal creation contract or as a substitute for caller-observed drafting context");
    expect(prompt).toContain("availableToolAliases: [rorca_get_context, rorca_specs_generation_context, rorca_specs_authoring_preflight, rorca_preflight_spec_authoring, rorca_specs_authoring_preflight_confirm, rorca_confirm_spec_authoring_plan");

    const forgeSequenceIndex = prompt.indexOf("forgeSequence:");
    const authoringContractIndex = prompt.indexOf("authoringContract:");
    const contextContractIndex = prompt.indexOf("contextContract:");
    const policyContractIndex = prompt.indexOf("policyContract:");
    const verificationContractIndex = prompt.indexOf("verificationContract:");
    const briefIndex = prompt.indexOf("brief: |");
    expect(forgeSequenceIndex).toBeGreaterThan(-1);
    expect(authoringContractIndex).toBeGreaterThan(forgeSequenceIndex);
    expect(contextContractIndex).toBeGreaterThan(authoringContractIndex);
    expect(policyContractIndex).toBeGreaterThan(contextContractIndex);
    expect(verificationContractIndex).toBeGreaterThan(policyContractIndex);
    expect(briefIndex).toBeGreaterThan(verificationContractIndex);
  });
});
