/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
// __tests__ -> rorca -> extensions -> rorca-pi-extension -> packages -> repo root
const repoRoot = path.resolve(testDir, "../../../../..");

function read(relative: string): string {
  return readFileSync(path.join(repoRoot, relative), "utf8");
}

const integrationDoc = read("docs/mcp-integration.md");
const readme = read("packages/rorca-pi-extension/README.md");
const pkg = JSON.parse(read("packages/rorca-pi-extension/package.json")) as {
  version: string;
};
const changelog = read("packages/rorca-pi-extension/CHANGELOG.md");

// Canonical, current MCP tool names that Hermes must be able to discover and
// that the Hermes-facing docs must reference (no stale aliases).
const CANONICAL_TOOLS = [
  "rorca_get_context",
  "rorca_create_spec",
  "rorca_list_specs",
  "rorca_approve_spec",
  "rorca_trigger_run",
  "rorca_pipeline_status",
  "rorca_run_status",
];

describe("Hermes MCP integration docs", () => {
  it("documents the canonical create-spec, get-context, list/approve, and pipeline trigger/status tools", () => {
    for (const tool of CANONICAL_TOOLS) {
      expect(integrationDoc).toContain(tool);
    }
  });

  it("teaches the brief -> spec -> review -> approve -> run -> inspect workflow", () => {
    expect(integrationDoc).toContain(
      "brief → spec → review → approve → run → inspect",
    );
  });

  it("documents MCP server registration with endpoint and bearer auth", () => {
    expect(integrationDoc).toContain("/mcp");
    expect(integrationDoc.toLowerCase()).toContain("bearer");
    expect(integrationDoc).toContain("tools/list");
  });

  it("documents a clean-environment install and update/rollback flow", () => {
    expect(integrationDoc).toContain("rorca pi install");
    expect(integrationDoc.toLowerCase()).toContain("roll back");
    expect(readme.toLowerCase()).toContain("update and rollback");
  });

  it("stays truthful about Graph Lite and BYOP and avoids overclaiming", () => {
    for (const text of [integrationDoc, readme]) {
      expect(text).toContain("Graph Lite");
      expect(text).toContain("BYOP");
    }
    expect(integrationDoc).toContain("Do not overclaim");
  });

  it("frames Hermes as an external distribution channel, not a replacement for first-party UX", () => {
    expect(integrationDoc).toContain("external distribution channel");
    expect(integrationDoc).toContain(
      "replacement for the first-party Rorca app/TUI",
    );
    expect(readme).toContain("external distribution channel");
  });

  it("versions the package so installs can be validated and rolled back", () => {
    expect(pkg.version).toBe("0.2.0");
    expect(changelog).toContain(`[${pkg.version}]`);
  });
});
