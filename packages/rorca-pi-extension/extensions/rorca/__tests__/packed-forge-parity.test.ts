/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("packed and installed Forge/MCP parity", () => {
  it("installs the real tarball and preserves explicit-draft/no-action contracts", () => {
    const root = path.resolve(__dirname, "../../../../..");
    const output = execFileSync(process.execPath, [
      path.join(root, "scripts", "check-pi-packed-forge-parity.mjs"),
    ], { cwd: root, encoding: "utf8", timeout: 90_000 });
    expect(output).toContain("PI_PACKED_FORGE_PARITY_PASSED");
  }, 100_000);
});
