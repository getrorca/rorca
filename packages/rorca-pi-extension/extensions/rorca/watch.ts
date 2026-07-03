/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { RorcaApiClient } from "./api.js";
import { buildWatchSnapshot, formatRunNotify, formatRunWidget } from "./format.js";
import type { ExtensionState } from "./types.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "blocked"]);

export class RunWatchController {
  private stopRequested = false;
  private activeRunId: number | null = null;
  private lastStatus: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly api: RorcaApiClient,
    private readonly updateState: (patch: Partial<ExtensionState>) => void,
  ) {}

  start(runId: number, ctx: ExtensionContext): void {
    this.stop();
    this.stopRequested = false;
    this.activeRunId = runId;
    this.lastStatus = null;
    this.updateState({ watchingRunId: runId, lastRunId: runId });
    void this.tick(runId, ctx);
  }

  stop(): void {
    this.stopRequested = true;
    this.activeRunId = null;
    this.lastStatus = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  currentRunId(): number | null {
    return this.activeRunId;
  }

  private async tick(runId: number, ctx: ExtensionContext): Promise<void> {
    try {
      const detail = await this.api.getRun(runId);
      const snapshot = buildWatchSnapshot(detail);
      ctx.ui.setWidget("rorca-run", formatRunWidget(snapshot));
      ctx.ui.setStatus("rorca-run", `Rorca #${runId}: ${snapshot.status}`);

      if (this.lastStatus !== snapshot.status) {
        ctx.ui.notify(formatRunNotify(snapshot), snapshot.status === "failed" ? "error" : "info");
        this.lastStatus = snapshot.status;
      }

      if (TERMINAL_STATUSES.has(snapshot.status)) {
        this.activeRunId = null;
        this.updateState({ watchingRunId: undefined, lastRunId: runId });
        return;
      }
    } catch (error) {
      this.activeRunId = null;
      if (!this.stopRequested) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Rorca watch failed for run #${runId}: ${message}`, "error");
      }
      return;
    }

    if (this.stopRequested || this.activeRunId !== runId) return;
    this.timer = setTimeout(() => {
      void this.tick(runId, ctx);
    }, 2_000);
  }
}
