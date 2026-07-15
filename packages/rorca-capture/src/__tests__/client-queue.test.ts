/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCaptureClient } from "../api.js";
import { resolveCaptureConfig } from "../config.js";
import { enqueueCaptureQueueEntry, readCaptureQueue } from "../queue.js";

function tempRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), "rorca-capture-queue-"));
  mkdirSync(path.join(repo, ".rorca"), { recursive: true });
  return repo;
}

function configFor(repo: string, queuePath = path.join(repo, ".rorca-capture-queue.jsonl")) {
  return resolveCaptureConfig({
    cwd: repo,
    gitRoot: repo,
    env: { RORCA_API_URL: "http://localhost:3030", RORCA_WORKSPACE_ID: "ws-queue", RORCA_QUEUE_PATH: queuePath },
  });
}

function eventPayload(repo: string, summary = "Capture queue test") {
  return {
    workspaceId: "ws-queue",
    eventType: "manual_cli_note",
    sourceSystem: "unit-test",
    sourceRef: "story:CCS-005",
    summary,
    payload: {
      text: "API_TOKEN=super-secret should not be stored",
      path: path.join(repo, "src", "example.ts"),
    },
    relatedFiles: ["src/example.ts"],
  };
}

describe("capture client offline queue", () => {
  it("writes a normalized redacted JSONL entry with deterministic retry metadata when offline", async () => {
    const repo = tempRepo();
    const config = configFor(repo);
    const client = createCaptureClient(config, {
      token: "test-token",
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:3030");
      },
    });

    const result = await client.submitContextEvent(eventPayload(repo));

    expect(result.status).toBe("queued");
    const entries = readCaptureQueue(config.queuePath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      version: 1,
      operation: "context-event",
      eventType: "manual_cli_note",
      endpoint: "/api/context-events",
      attempts: 0,
      retryable: true,
    });
    expect(entries[0].key).toMatch(/^capture:/);
    expect(entries[0].contentFingerprint).toHaveLength(64);
    expect(entries[0].lastError).toBeUndefined();
    expect(entries[0].nextRetryAt).toBeUndefined();

    const raw = readFileSync(config.queuePath, "utf8");
    expect(raw).toContain("[REDACTED_SECRET_ASSIGNMENT]");
    expect(raw).not.toContain("super-secret");
    expect(raw).not.toContain(repo);
  });

  it("redacts representative secrets before the first API submission attempt", async () => {
    const repo = tempRepo();
    const config = configFor(repo);
    let submittedBody: any;
    const client = createCaptureClient(config, {
      token: "test-token",
      fetchImpl: async (_url, init) => {
        submittedBody = init?.body ? JSON.parse(String(init.body)) : undefined;
        return new Response(JSON.stringify({ event: { id: "evt-redacted" }, created: true }), { status: 201 });
      },
    });

    const result = await client.submitContextEvent({
      ...eventPayload(repo),
      summary: "Authorization: Bearer abc.def.secret-token",
      payload: {
        bearer: "Bearer abcdefghijklmnopqrstuvwxyz.123456",
        openai: "sk-1234567890abcdefghijklmnop",
        privateKey: "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----",
        databaseUrl: "postgres://user:pass@localhost:5432/app",
      },
    });

    expect(result.status).toBe("submitted");
    const serialized = JSON.stringify(submittedBody);
    expect(serialized).toContain("Bearer [REDACTED]");
    expect(serialized).toContain("sk-[REDACTED]");
    expect(serialized).toContain("[REDACTED_PRIVATE_KEY]");
    expect(serialized).toContain("[REDACTED_DATABASE_URL]");
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("sk-1234567890abcdefghijklmnop");
    expect(serialized).not.toContain("BEGIN PRIVATE KEY");
    expect(serialized).not.toContain("user:pass");
  });

  it("avoids duplicate queue entries for the same deterministic key", async () => {
    const repo = tempRepo();
    const config = configFor(repo);
    const client = createCaptureClient(config, {
      token: "test-token",
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });

    const first = await client.submitContextEvent(eventPayload(repo, "Same content"));
    const second = await client.submitContextEvent(eventPayload(repo, "Same content"));

    expect(first.status).toBe("queued");
    expect(second.status).toBe("queued");
    if (second.status === "queued") expect(second.duplicate).toBe(true);
    const entries = readCaptureQueue(config.queuePath);
    expect(entries).toHaveLength(1);
  });

  it("flush drains successfully submitted entries", async () => {
    const repo = tempRepo();
    const config = configFor(repo);
    enqueueCaptureQueueEntry(config.queuePath, config, {
      operation: "context-event",
      endpoint: "/api/context-events",
      payload: eventPayload(repo, "Flush me"),
    });
    const calls: string[] = [];
    const client = createCaptureClient(config, {
      token: "test-token",
      fetchImpl: async (url) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ event: { id: "evt-1" }, created: true }), { status: 201 });
      },
    });

    const result = await client.flushQueue();

    expect(result).toMatchObject({ submitted: 1, failed: 0, remaining: 0 });
    expect(calls).toEqual(["http://localhost:3030/api/context-events"]);
    expect(readCaptureQueue(config.queuePath)).toHaveLength(0);
  });

  it("flush approves queued candidates when approval was requested", async () => {
    const repo = tempRepo();
    const config = configFor(repo);
    const candidatePayload = {
      workspaceId: "ws-queue",
      eventType: "manual_cli_note",
      sourceSystem: "unit-test",
      sourceRef: "candidate:approval",
      suggestedCategory: "Decision",
      title: "Approve queued candidate",
      rule: "Queued candidates can carry explicit approval intent.",
    };
    const offlineClient = createCaptureClient(config, {
      token: "test-token",
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });

    const queued = await offlineClient.submitCandidate(candidatePayload, {
      endpoint: "/api/memory/candidates",
      approvalEndpointBase: "/api/memory/candidates",
      approve: true,
      approvalPayload: { workspaceId: "ws-queue", reviewer: "local-operator" },
    });

    expect(queued.status).toBe("queued");
    expect(readCaptureQueue(config.queuePath)[0].approval).toMatchObject({ endpointBase: "/api/memory/candidates" });

    const calls: Array<{ url: string; body: unknown }> = [];
    const flushingClient = createCaptureClient(config, {
      token: "test-token",
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
        if (String(url).endsWith("/api/memory/candidates/55/approve")) {
          return new Response(JSON.stringify({ approved: true }), { status: 200 });
        }
        return new Response(JSON.stringify({ candidate: { id: "55", reviewStatus: "pending" }, created: true }), { status: 201 });
      },
    });

    const result = await flushingClient.flushQueue();

    expect(result).toMatchObject({ submitted: 1, failed: 0, remaining: 0 });
    expect(calls.map((call) => call.url)).toEqual([
      "http://localhost:3030/api/memory/candidates",
      "http://localhost:3030/api/memory/candidates/55/approve",
    ]);
    expect(calls[1].body).toMatchObject({ workspaceId: "ws-queue", reviewer: "local-operator" });
  });

  it("flush keeps failed entries with retry metadata while draining later successes", async () => {
    const repo = tempRepo();
    const config = configFor(repo);
    enqueueCaptureQueueEntry(config.queuePath, config, {
      operation: "context-event",
      endpoint: "/api/context-events",
      payload: eventPayload(repo, "Fails first"),
    });
    enqueueCaptureQueueEntry(config.queuePath, config, {
      operation: "context-event",
      endpoint: "/api/context-events",
      payload: eventPayload(repo, "Succeeds second"),
    });
    let call = 0;
    const now = new Date("2026-07-04T12:00:00.000Z");
    const client = createCaptureClient(config, {
      token: "test-token",
      fetchImpl: async () => {
        call += 1;
        if (call === 1) {
          return new Response(JSON.stringify({ error: "temporary outage" }), { status: 500 });
        }
        return new Response(JSON.stringify({ event: { id: "evt-2" }, created: true }), { status: 200 });
      },
    });

    const result = await client.flushQueue({ now });

    expect(result).toMatchObject({ submitted: 1, failed: 1, remaining: 1 });
    const entries = readCaptureQueue(config.queuePath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ attempts: 1, retryable: true, lastError: "temporary outage" });
    expect(Date.parse(entries[0].nextRetryAt ?? "")).toBeGreaterThan(now.getTime());
  });

  it("marks API 4xx failures non-retryable with sanitized messages", async () => {
    const repo = tempRepo();
    const config = configFor(repo);
    enqueueCaptureQueueEntry(config.queuePath, config, {
      operation: "context-event",
      endpoint: "/api/context-events",
      payload: eventPayload(repo, "Validation failure"),
    });
    const client = createCaptureClient(config, {
      token: "test-token",
      fetchImpl: async () => new Response(JSON.stringify({
        error: `Invalid API_TOKEN=super-secret at ${path.join(repo, "src", "example.ts")}`,
        code: "VALIDATION_ERROR",
      }), { status: 422 }),
    });

    const result = await client.flushQueue();

    expect(result.failed).toBe(1);
    const [entry] = readCaptureQueue(config.queuePath);
    expect(entry.retryable).toBe(false);
    expect(entry.nextRetryAt).toBeUndefined();
    expect(entry.lastError).toContain("[REDACTED_SECRET_ASSIGNMENT]");
    expect(entry.lastError).not.toContain("super-secret");
    expect(entry.lastError).not.toContain(repo);
    expect(entry.lastError).not.toContain("at async");
  });
});
