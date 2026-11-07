/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import { describe, expect, it, vi } from "vitest";
import { RunWatchController } from "../watch.js";

function makeCtx() {
  return {
    ui: {
      setWidget: vi.fn(),
      setStatus: vi.fn(),
      notify: vi.fn(),
    },
  } as unknown as Parameters<RunWatchController["start"]>[1];
}

function runDetail(id: number, status: string) {
  return {
    run: { id, status, spec_path: "specs/approved/demo.json" },
    stories: [],
  };
}

describe("RunWatchController failure repair", () => {
  it("dispatches the repair workflow when a run fails instead of abandoning it", async () => {
    const dispatchRepair = vi.fn();
    const updateState = vi.fn();
    const ctx = makeCtx();
    const controller = new RunWatchController(
      {
        getRun: vi.fn().mockResolvedValue(runDetail(611, "failed")),
      } as never,
      updateState,
      dispatchRepair,
    );

    controller.start(611, ctx);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(dispatchRepair).toHaveBeenCalledWith(611);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("611"),
      "error",
    );
    // The controller must not keep polling a failed run.
    expect(updateState).toHaveBeenCalledWith({
      watchingRunId: undefined,
      lastRunId: 611,
    });
    controller.stop();
  });

  it("does not dispatch repair for successful runs", async () => {
    const dispatchRepair = vi.fn();
    const ctx = makeCtx();
    const controller = new RunWatchController(
      {
        getRun: vi.fn().mockResolvedValue(runDetail(610, "completed")),
      } as never,
      vi.fn(),
      dispatchRepair,
    );

    controller.start(610, ctx);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(dispatchRepair).not.toHaveBeenCalled();
    controller.stop();
  });

  it("repair dispatch is optional and safe when not configured", async () => {
    const ctx = makeCtx();
    const controller = new RunWatchController(
      {
        getRun: vi.fn().mockResolvedValue(runDetail(612, "failed")),
      } as never,
      vi.fn(),
    );

    controller.start(612, ctx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Without a dispatcher, the failed run simply stops watching — no crash.
    controller.stop();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("612"),
      "error",
    );
  });
});
