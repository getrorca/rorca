/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, expect, it } from "vitest";
import {
  formatAllAgentSessions,
  isRorcaSubagentPane,
  parseAgentPaneLines,
} from "../tmux-subagents.js";

describe("tmux subagent global listing", () => {
  it("parses session-scoped pane metadata from tmux", () => {
    const [pane] = parseAgentPaneLines([
      "review-wave\t200\t1\t1\t0.2\t%7\treviewer ✓\tbash\t1\t0\t1234",
      "",
    ].join("\n"));

    expect(pane).toMatchObject({
      sessionName: "review-wave",
      sessionCreated: 200,
      sessionAttached: true,
      rorcaMarked: true,
      location: "0.2",
      index: 2,
      paneId: "%7",
      title: "reviewer ✓",
      dead: true,
      deadStatus: "0",
      pid: "1234",
    });
  });

  it("discovers explicit Rorca sessions, legacy prefixed sessions, and existing Pi panes", () => {
    const panes = parseAgentPaneLines([
      "custom-marked\t300\t0\t1\t0.0\t%1\twriter\tbash\t0\t\t100",
      "rorca-pi-agents-legacy\t200\t0\t\t0.0\t%2\twriter ✓\tbash\t1\t0\t101",
      "custom-pi-review\t100\t0\t\t0.0\t%3\tπ - rorca\tbash\t0\t\t102",
      "ordinary-shell\t50\t0\t\t0.0\t%4\tMac\tzsh\t0\t\t103",
    ].join("\n"));

    expect(panes.map((pane) => isRorcaSubagentPane(pane))).toEqual([true, true, true, false]);
  });

  it("formats all sessions with aggregate and per-pane status", () => {
    const panes = parseAgentPaneLines([
      "new-review\t300\t1\t1\t0.0\t%1\twriter\tbash\t0\t\t100",
      "new-review\t300\t1\t1\t0.1\t%2\treviewer ✗\tbash\t1\t2\t101",
      "old-review\t100\t0\t1\t0.0\t%3\tqa ✓\tbash\t1\t0\t102",
    ].join("\n"));

    const lines = formatAllAgentSessions(panes);

    expect(lines[0]).toBe("2 Rorca Pi tmux sessions · 3 panes · 1 running · 1 done · 1 failed");
    expect(lines[1]).toContain("new-review · ✕ 1 failed · 0/2 done · 1 running · attached");
    expect(lines).toContain("  0.0 running writer pid=100 cmd=bash");
    expect(lines).toContain("  0.1 fail:2 reviewer pid=101 cmd=bash");
    expect(lines).toContain("old-review · ✓ all 1 done");
  });

  it("reports an explicit empty state", () => {
    expect(formatAllAgentSessions([])).toEqual(["No Rorca Pi tmux subagent sessions found."]);
  });
});
