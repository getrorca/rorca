/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from "vitest";
import { registerTmuxSubagents } from "../tmux-subagents.js";

describe("rorca_tmux_subagents supervised mode", () => {
  it("refuses multiple supervised writers before launching tmux", async () => {
    let tool: any;
    const pi = {
      registerTool: (definition: any) => { if (definition.name === "rorca_tmux_subagents") tool = definition; },
      on: vi.fn(),
    } as any;
    const manager = {
      launch: vi.fn(),
      resolveWorkspaceId: vi.fn(async () => undefined),
      currentSession: vi.fn(() => null),
    } as any;
    registerTmuxSubagents(pi, {} as any, vi.fn(), manager);
    const ctx = {
      cwd: process.cwd(),
      hasUI: false,
      ui: { notify: vi.fn(), setStatus: vi.fn(), custom: vi.fn() },
    } as any;

    await expect(tool.execute("call", {
      supervised: true,
      validationCommands: ["true"],
      tasks: [
        { name: "one", task: "write one" },
        { name: "two", task: "write two" },
      ],
    }, new AbortController().signal, undefined, ctx)).rejects.toThrow(/exactly one source writer/);
    expect(manager.launch).not.toHaveBeenCalled();
  });
});
