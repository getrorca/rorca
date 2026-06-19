/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, expect, it } from "vitest";
import { buildWatchSnapshot, formatRunList, formatRunWidget, summarizeStories } from "../format.js";

describe("rorca pi extension formatting", () => {
  it("summarizes story statuses", () => {
    expect(summarizeStories([
      { story_id: "US-001", status: "pass" },
      { story_id: "US-002", status: "running" },
      { story_id: "US-003", status: "queued" },
      { story_id: "US-004", status: "fail" },
    ])).toEqual({
      total: 4,
      pass: 1,
      fail: 1,
      running: 1,
      blocked: 0,
      queued: 1,
      skipped: 0,
    });
  });

  it("builds widget lines with progress log path", () => {
    const snapshot = buildWatchSnapshot({
      run: {
        id: 77,
        status: "running",
        spec_path: "forge/specs/approved/oauth-login.json",
        branch_name: "feat/oauth-login",
        worktree_path: "/tmp/oauth-login",
        triggered_via: "run_now",
      },
      stories: [
        { story_id: "US-001", status: "pass" },
        { story_id: "US-002", status: "running" },
      ],
    }, "/repo");

    const widget = formatRunWidget(snapshot).join("\n");
    expect(widget).toContain("Rorca Run #77");
    expect(widget).toContain("Progress logs: /repo/.rorca/progress/run-77");
  });

  it("formats recent run list", () => {
    const output = formatRunList([
      { id: 12, status: "running", spec_path: "forge/specs/approved/oauth-login.json", workspace_id: "cashflow" },
    ], [
      { id: "cashflow", label: "Cashflow App", path: "/repo" },
    ]);

    expect(output).toContain("#12");
    expect(output).toContain("oauth-login");
    expect(output).toContain("Cashflow App");
  });
});
