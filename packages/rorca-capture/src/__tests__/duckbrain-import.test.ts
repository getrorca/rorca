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
import { resolveCaptureConfig } from "../config.js";
import { importDuckBrainJsonlFile, importDuckBrainJsonlText } from "../duckbrain-import.js";

function tempRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), "rorca-duckbrain-import-"));
  mkdirSync(path.join(repo, ".rorca"), { recursive: true });
  return repo;
}

function configFor(repo: string) {
  return resolveCaptureConfig({ cwd: repo, gitRoot: repo, overrides: { workspaceId: "ws-duck" } });
}

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    namespace: "engineering",
    key: "decision/auth-refresh",
    content: "Use rotating refresh tokens for auth sessions.",
    created_at: "2026-01-02T03:04:05.000Z",
    tags: ["decision", "auth"],
    metadata: { duckId: "duck-1", source: "scratchpad" },
    ...overrides,
  };
}

describe("DuckBrain JSONL import adapter", () => {
  it("dry-runs valid JSONL while preserving provenance and applying safety rules", async () => {
    const repo = tempRepo();
    const config = configFor(repo);
    const jsonl = `${JSON.stringify(record({
      content: "HIPAA patient workflow note. API_KEY=super-secret-value should be scrubbed.",
      metadata: { duckId: "duck-1", nested: { source: "scratchpad" } },
    }))}\n`;

    const summary = await importDuckBrainJsonlText(jsonl, {
      workspaceId: "ws-duck",
      config,
      dryRun: true,
      now: new Date("2026-02-03T04:05:06.000Z"),
      sourcePath: path.join(repo, "duckbrain.jsonl"),
      submitCandidate: async () => {
        throw new Error("dry-run must not submit candidates");
      },
    });

    expect(summary).toMatchObject({ dryRun: true, imported: 1, skipped: 0, duplicate: 0, queued: 0, total: 1 });
    const candidate = summary.candidates[0];
    expect(candidate).toMatchObject({
      status: "dry-run",
      namespace: "engineering",
      key: "decision/auth-refresh",
      createdAt: "2026-01-02T03:04:05.000Z",
      originalTags: ["decision", "auth"],
      reviewStatus: "pending",
      trustTier: "working_note",
      regulatedDomain: true,
      securitySensitive: true,
      requiresReview: true,
    });
    expect(candidate.sourceRef).toBe("duckbrain:engineering:decision/auth-refresh");
    expect(candidate.entryHash).toMatch(/^[0-9a-f]{64}$/);
    expect(candidate.title).not.toContain("super-secret-value");
    expect(candidate.title).toContain("[REDACTED_SECRET_ASSIGNMENT]");
    expect(candidate.provenance).toMatchObject({
      namespace: "engineering",
      key: "decision/auth-refresh",
      sourceRef: "duckbrain:engineering:decision/auth-refresh",
      source_ref: "duckbrain:engineering:decision/auth-refresh",
      entryHash: candidate.entryHash,
      entry_hash: candidate.entryHash,
      createdAt: "2026-01-02T03:04:05.000Z",
      created_at: "2026-01-02T03:04:05.000Z",
      originalTags: ["decision", "auth"],
      original_tags: ["decision", "auth"],
      pendingByDefault: true,
    });
    expect(candidate.metadata).toMatchObject({
      namespace: "engineering",
      key: "decision/auth-refresh",
      sourceRef: "duckbrain:engineering:decision/auth-refresh",
      entryHash: candidate.entryHash,
      entry_hash: candidate.entryHash,
      createdAt: "2026-01-02T03:04:05.000Z",
      created_at: "2026-01-02T03:04:05.000Z",
      originalTags: ["decision", "auth"],
      original_tags: ["decision", "auth"],
      originalMetadata: { duckId: "duck-1", nested: { source: "scratchpad" } },
      original_metadata: { duckId: "duck-1", nested: { source: "scratchpad" } },
      review: { status: "pending", pendingByDefault: true, autoApproved: false },
      safety: { regulatedDomain: true, securitySensitive: true, requiresReview: true },
    });
    expect(String(candidate.metadata.originalMetadata)).not.toContain("super-secret-value");
    expect(candidate.metadata.import).toMatchObject({ dryRun: true, pendingByDefault: true, autoApproved: false });
  });

  it("skips malformed lines and records missing required provenance fields without aborting", async () => {
    const repo = tempRepo();
    const summary = await importDuckBrainJsonlText([
      JSON.stringify(record()),
      "{ truncated",
      JSON.stringify(record({ key: undefined })),
      JSON.stringify(record({ tags: undefined })),
    ].join("\n"), {
      workspaceId: "ws-duck",
      config: configFor(repo),
      dryRun: true,
      now: new Date("2026-02-03T04:05:06.000Z"),
    });

    expect(summary.imported).toBe(1);
    expect(summary.skipped).toBe(3);
    expect(summary.reasons.map((reason) => reason.code)).toEqual(["malformed_json", "missing_key", "missing_tags"]);
    expect(summary.candidates).toHaveLength(1);
  });

  it("deduplicates repeated entry hashes silently during live imports", async () => {
    const repo = tempRepo();
    const candidate = record({ content: "Same content for duplicate detection." });
    const submissions: string[] = [];

    const summary = await importDuckBrainJsonlText(`${JSON.stringify(candidate)}\n${JSON.stringify(candidate)}\n`, {
      workspaceId: "ws-duck",
      config: configFor(repo),
      dryRun: false,
      submitCandidate: async (payload) => {
        submissions.push(payload.idempotencyKey);
        return { status: "imported", candidateId: "101" };
      },
    });

    expect(summary.imported).toBe(1);
    expect(summary.duplicate).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(submissions).toHaveLength(1);
    expect(summary.reasons).toEqual([expect.objectContaining({ code: "duplicate_entry", line: 2 })]);
  });

  it("treats existing API candidates as duplicate no-ops", async () => {
    const repo = tempRepo();
    const summary = await importDuckBrainJsonlText(`${JSON.stringify(record())}\n`, {
      workspaceId: "ws-duck",
      config: configFor(repo),
      dryRun: false,
      submitCandidate: async () => ({ status: "duplicate", candidateId: "existing-1" }),
    });

    expect(summary).toMatchObject({ imported: 0, duplicate: 1, skipped: 0, queued: 0 });
    expect(summary.candidates[0]).toMatchObject({ status: "duplicate", candidateId: "existing-1", reviewStatus: "pending" });
  });

  it("supports practical filters and file-path input", async () => {
    const repo = tempRepo();
    const inputPath = path.join(repo, "duckbrain.jsonl");
    writeFileSync(inputPath, [
      JSON.stringify(record({ namespace: "keep", key: "one", tags: ["selected"], content: "Keep this memory." })),
      JSON.stringify(record({ namespace: "drop", key: "two", tags: ["other"], content: "Drop this memory." })),
    ].join("\n"), "utf8");

    const summary = await importDuckBrainJsonlFile(inputPath, {
      workspaceId: "ws-duck",
      config: configFor(repo),
      dryRun: true,
      filters: ["namespace:keep", "tag:selected"],
    });

    expect(summary.imported).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.reasons).toEqual([expect.objectContaining({ code: "filtered", line: 2 })]);
    expect(summary.candidates[0]).toMatchObject({ namespace: "keep", key: "one" });
  });
});
