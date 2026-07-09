/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CaptureConfigError, resolveCaptureConfig } from "../config.js";
import { resolveWorkspace } from "../api.js";
import { shouldCapturePath } from "../context-safety.js";

function tempRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), "rorca-capture-"));
  mkdirSync(path.join(repo, ".rorca"), { recursive: true });
  return repo;
}

describe("rorca-capture config discovery", () => {
  it("applies discovery priority: env, .rorca/config.json, .rorca/capture.json, auto", () => {
    const repo = tempRepo();
    writeFileSync(path.join(repo, ".rorca", "config.json"), JSON.stringify({
      apiUrl: "http://config:3030",
      workspaceId: "workspace-from-config",
      queuePath: ".rorca/config-queue.ndjson",
      mode: "vm",
      ignore: { paths: ["config-ignore/**"], maxFileBytes: 123 },
      redaction: { enabled: false, replacement: "[CONFIG]" },
    }), "utf8");
    writeFileSync(path.join(repo, ".rorca", "capture.json"), JSON.stringify({
      apiUrl: "http://capture:3030",
      workspaceId: "workspace-from-capture",
      queuePath: ".rorca/capture-queue.ndjson",
      mode: "local",
      ignore: { paths: ["capture-ignore/**"], maxEventBytes: 456 },
    }), "utf8");

    const config = resolveCaptureConfig({
      cwd: repo,
      gitRoot: repo,
      env: {
        RORCA_API_URL: "http://env:3030/",
        RORCA_QUEUE_PATH: ".rorca/env-queue.ndjson",
      },
    });

    expect(config.apiUrl).toBe("http://env:3030");
    expect(config.workspaceId).toBe("workspace-from-capture");
    expect(config.queuePath).toBe(path.join(repo, ".rorca", "env-queue.ndjson"));
    expect(config.mode).toBe("local");
    expect(config.ignore.paths).toContain("capture-ignore/**");
    expect(config.ignore.maxFileBytes).toBe(123);
    expect(config.ignore.maxEventBytes).toBe(456);
    expect(config.redaction.enabled).toBe(false);
    expect(config.repoPath).toBe(repo);
    expect(config.sources.apiUrl).toBe("env");
    expect(config.sources.workspaceId).toBe("capture-config");
    expect(config.sources.queuePath).toBe("env");
  });

  it("loads operator auto-approval only from explicit config or env", () => {
    const repo = tempRepo();
    expect(resolveCaptureConfig({ cwd: repo, gitRoot: repo, env: {} }).operatorAutoApprove).toBe(false);

    writeFileSync(path.join(repo, ".rorca", "capture.json"), JSON.stringify({ operatorAutoApprove: true }), "utf8");
    expect(resolveCaptureConfig({ cwd: repo, gitRoot: repo, env: {} }).operatorAutoApprove).toBe(true);
    expect(resolveCaptureConfig({ cwd: repo, gitRoot: repo, env: { RORCA_CAPTURE_OPERATOR_AUTO_APPROVE: "false" } }).operatorAutoApprove).toBe(false);
  });

  it("loads .rorca-captureignore while keeping built-in excludes non-overridable", () => {
    const repo = tempRepo();
    writeFileSync(path.join(repo, ".rorca-captureignore"), [
      "generated/**",
      "!generated/keep.ts",
      "!.env",
      "",
    ].join("\n"), "utf8");

    const config = resolveCaptureConfig({ cwd: repo, gitRoot: repo, env: {} });

    expect(config.configFiles.captureIgnore).toBe(path.join(repo, ".rorca-captureignore"));
    expect(config.ignore.paths).toContain("generated/**");
    expect(shouldCapturePath("generated/output.ts", config.ignore)).toBe(false);
    expect(shouldCapturePath("generated/keep.ts", config.ignore)).toBe(true);
    expect(shouldCapturePath(".env", config.ignore)).toBe(false);
  });

  it("uses default API URL and queue path in local auto-detect mode", () => {
    const repo = tempRepo();
    const config = resolveCaptureConfig({ cwd: repo, gitRoot: repo, env: {} });

    expect(config.apiUrl).toBe("http://localhost:3030");
    expect(config.repoPath).toBe(repo);
    expect(config.queuePath).toBe(path.join(repo, ".rorca-capture-queue.jsonl"));
    expect(config.mode).toBe("local");
    expect(config.apiOnly).toBe(true);
  });

  it("throws a hard missing API URL error in CI mode", () => {
    const repo = tempRepo();

    expect(() => resolveCaptureConfig({ cwd: repo, gitRoot: repo, ci: true, env: {} })).toThrow(CaptureConfigError);
    expect(() => resolveCaptureConfig({ cwd: repo, gitRoot: repo, ci: true, env: {} })).toThrow(/RORCA_API_URL is required/);
  });

  it("forces CI mode from CI=true even when config says local", () => {
    const repo = tempRepo();
    writeFileSync(path.join(repo, ".rorca", "capture.json"), JSON.stringify({ mode: "local" }), "utf8");

    expect(() => resolveCaptureConfig({ cwd: repo, gitRoot: repo, env: { CI: "true" } })).toThrow(/RORCA_API_URL is required/);
  });

  it("throws NOT_FOUND when no workspace path matches the repo", async () => {
    const repo = tempRepo();
    const config = resolveCaptureConfig({
      cwd: repo,
      gitRoot: repo,
      env: { RORCA_API_URL: "http://localhost:3030" },
    });

    await expect(resolveWorkspace(config, {
      async get<T>() {
        return { items: [{ id: "other", path: path.join(repo, "other") }] } as T;
      },
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
