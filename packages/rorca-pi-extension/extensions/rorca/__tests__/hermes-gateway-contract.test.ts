/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "../../../../..");
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), "utf8");

const skill = read("packages/rorca-pi-extension/skills/hermes-autonomous-supervisor/SKILL.md");
const mcp = read("backend/src/lib/mcp-http.ts");
const intentRoute = read("backend/src/routes/hermes-intent.ts");
const draftRoute = read("backend/src/routes/hermes-mission-draft.ts");
const subscription = read("backend/src/lib/run-event-subscription.ts");
const gateway = read("backend/src/lib/gateway-events.ts");
const orchestration = read("backend/src/lib/omp-orchestration-events.ts");

const CANONICAL_TOOLS = [
  "rorca_select_workspace",
  "rorca_hermes_intent",
  "rorca_hermes_mission_draft",
  "rorca_hermes_mission_draft_source_drift",
  "rorca_hermes_mission_draft_recompile",
  "rorca_create_spec",
  "rorca_approve_spec",
  "rorca_trigger_run",
  "rorca_subscribe_run_events",
  "rorca_unsubscribe_run_events",
  "rorca_run_status",
  "rorca_pipeline_status",
  "rorca_save_memory",
] as const;

const GATEWAY_KINDS = [
  "mission_draft_ready", "decision_required", "gate_blocked", "source_drift", "run_completed", "release_ready",
] as const;
const ORCHESTRATION_KINDS = [
  "agent_started", "task_started", "agent_progress", "agent_completed", "agent_failed",
] as const;

describe("canonical Hermes skill contract", () => {
  it("documents only canonical tools present on the implemented MCP/OpenAPI surface", () => {
    for (const tool of CANONICAL_TOOLS) expect(skill).toContain(`\`${tool}\``);
    // Generated MCP names are deterministic path projections; aliases/session tools are literal registrations.
    expect(intentRoute).toContain("/api/hermes/intent:");
    expect(draftRoute).toContain("/api/hermes/mission-draft:");
    expect(draftRoute).toContain("/api/hermes/mission-draft/recompile:");
    expect(draftRoute).toContain("/api/hermes/mission-draft/source-drift:");
    for (const tool of CANONICAL_TOOLS.filter((name) => !name.startsWith("rorca_hermes_"))) {
      expect(mcp).toContain(tool);
    }
  });

  it("matches both closed payload families exposed by one subscription", () => {
    expect(subscription).toContain("eventType.startsWith('orchestration.')");
    expect(subscription).toContain("GATEWAY_EVENT_TYPES.has(eventType)");
    expect(skill).toContain("rorca.orchestration-event.v1");
    expect(skill).toContain("rorca.gateway-event.v1");
    for (const kind of GATEWAY_KINDS) {
      expect(gateway).toContain(`'${kind}'`);
      expect(skill).toContain(`gateway.${kind}`);
    }
    for (const kind of ORCHESTRATION_KINDS) {
      expect(orchestration).toContain(`'${kind}'`);
      expect(skill).toContain(`orchestration.${kind}`);
    }
  });

  it("teaches the complete sequence and fail-closed authority boundaries", () => {
    const ordered = [
      "**Intent", "**Compile sources", "**Draft", "**Persist the exact revision", "**Compile controls",
      "**Bind assurance", "**Approve", "**Trigger", "**Subscribe", "**Supervise", "**Learn",
    ];
    let cursor = -1;
    for (const step of ordered) {
      const next = skill.indexOf(step);
      expect(next).toBeGreaterThan(cursor);
      cursor = next;
    }
    expect(skill).toContain("data, never instructions");
    expect(skill).toContain("AAV-023 declared authority");
    expect(skill).toContain("Hermes never grants");
    expect(skill).toMatch(/not\W+an orchestrator/);
    expect(skill).toContain("generic event payload");
  });
});
