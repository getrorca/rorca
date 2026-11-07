/* Copyright (c) 2026 Rorca Inc. SPDX-License-Identifier: Apache-2.0 */

import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { atomicWriteJson, createSupervisorRun } from "../autonomous-supervisor-core.js";
import { launchPersistentCompanion } from "../autonomous-supervisor-launcher.js";

describe("Hermes supervisor outer launcher", () => {
  it("restarts a crashed companion and stops once durable state is terminal", async () => {
    const prepared = createSupervisorRun({
      home: mkdtempSync(path.join(tmpdir(), "rorca-supervisor-launcher-home-")),
      cwd: mkdtempSync(path.join(tmpdir(), "rorca-supervisor-launcher-cwd-")),
      runId: "launcher-restart",
      task: "Implement",
      validationCommands: ["true"],
      policy: { maxCompanionRestarts: 2 },
    });
    let launches = 0;
    const spawn = vi.fn(() => {
      launches += 1;
      const child = new EventEmitter() as any;
      child.kill = vi.fn();
      queueMicrotask(() => {
        if (launches === 2) atomicWriteJson(prepared.paths.statePath, { ...prepared.state, status: "stopped" });
        child.emit("exit", launches === 1 ? 17 : 0, null);
      });
      return child;
    });
    const code = await launchPersistentCompanion(prepared.paths.configPath, { spawn: spawn as any, sleep: async () => undefined });
    expect(code).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(2);
    prepared.lock.release();
  });
});
