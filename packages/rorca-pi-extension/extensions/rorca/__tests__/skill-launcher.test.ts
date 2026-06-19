/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, expect, it } from "vitest";
import { formatSkillLaunchPrompt, getRequiredToolGroups } from "../skill-launcher.js";

describe("rorca skill launcher", () => {
  it("requires the canonical generation-context bundle before forge persistence", () => {
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
      ["rorca_create_spec", "rorca_persist_spec", "rorca_specs_persist"],
    ]);
  });

  it("pins the forge prompt to context forwarding, post-save defaults, and recovery-only fallback semantics", () => {
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

    expect(prompt).toContain("forgeSequence: [rorca_specs_generation_context, draft_in_pi, rorca_create_spec, verify_saved_spec]");
    expect(prompt).toContain("contextContract: fetch rorca_specs_generation_context before persistence, then forward its contextUsed and contextSummary into rorca_create_spec or rorca_persist_spec");
    expect(prompt).toContain("postSaveContract: keep post-save enrich and matchSkills enabled by inheriting postSaveDefaults or passing postSave with enrich=true and matchSkills=true unless the launcher or user explicitly requests an opt-out");
    expect(prompt).toContain("fallbackContract: backend/server contextSummary backfill is recovery-grade fallback only and must not be treated as a substitute for caller-observed drafting context");

    const forgeSequenceIndex = prompt.indexOf("forgeSequence:");
    const contextContractIndex = prompt.indexOf("contextContract:");
    const briefIndex = prompt.indexOf("brief: |");
    expect(forgeSequenceIndex).toBeGreaterThan(-1);
    expect(contextContractIndex).toBeGreaterThan(forgeSequenceIndex);
    expect(briefIndex).toBeGreaterThan(contextContractIndex);
  });
});
