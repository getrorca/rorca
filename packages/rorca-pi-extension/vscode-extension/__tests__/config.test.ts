/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, test } from "vitest";
import { normalizeRorcaCaptureConfig } from "../src/config.js";

describe("Rorca VS Code extension config", () => {
  test("normalizes defaults and clamps governance/queue settings", () => {
    const cfg = normalizeRorcaCaptureConfig({
      get(key, fallback) {
        const values: Record<string, unknown> = {
          apiBaseUrl: "http://127.0.0.1:3030/",
          policyMode: "bad-policy",
          queueMaxSize: -1,
          memoryCandidateMaxCount: 99,
          memoryCandidateTokenCap: 10,
        };
        return (key in values ? values[key] : fallback) as never;
      },
    });

    expect(cfg.apiBaseUrl).toBe("http://127.0.0.1:3030");
    expect(cfg.policyMode).toBe("metadata-only");
    expect(cfg.queueMaxSize).toBe(1);
    expect(cfg.memoryCandidateMaxCount).toBe(32);
    expect(cfg.memoryCandidateTokenCap).toBe(100);
  });
});
