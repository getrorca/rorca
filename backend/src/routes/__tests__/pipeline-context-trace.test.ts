/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * CTM-002 — end-to-end coverage for the lazy context-trace raw payload route:
 *   GET /api/pipeline/runs/:runId/context-trace/:rawRef
 *
 * Verifies: successful lazy fetch, run-scoped validation, malformed rawRef,
 * genuine 404, and corrupt-artifact fallback (422).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';
import { queryOne, execute } from '../../db/index';
import {
  createContextTraceWriter,
  getTraceArtifactPath,
} from '../../lib/context-trace';

jest.setTimeout(90_000);

jest.mock('../../lib/llm-client', () => ({
  chatComplete: jest.fn(),
  getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
  isValidModel: jest.fn().mockReturnValue(true),
  DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
  resolveVaultProvider: jest.fn().mockReturnValue(null),
  getModelInfo: jest.fn().mockReturnValue(undefined),
  SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
}));

jest.mock('../../lib/pg-boss', () => ({
  initBoss: jest.fn().mockResolvedValue(undefined),
  getBoss: jest.fn().mockReturnValue({
    send: jest.fn().mockResolvedValue('mock-job-id'),
    work: jest.fn(),
    stop: jest.fn().mockResolvedValue(undefined),
  }),
}));

jest.mock('../../lib/pty-manager', () => ({
  PTY_AVAILABLE: true,
  PTY_UNAVAILABLE_HINT: 'Run: cd backend && npm rebuild node-pty',
}));

let app: Express;
let tmpDir: string;
let wsDir: string;

const WS_ID = 'ws-ctm-trace';

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  const serverMod = require('../../server');
  app = serverMod.default;
  await getAuthToken(app);
});

beforeEach(async () => {
  jest.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-ctm-trace-'));
  wsDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(wsDir, { recursive: true });

  await execute(`DELETE FROM story_results WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = $1)`, [WS_ID]);
  await execute(`DELETE FROM pipeline_runs WHERE workspace_id = $1`, [WS_ID]);
  await execute(
    `INSERT INTO workspaces (id, label, path) VALUES ($1, 'CTM Trace WS', $2)
     ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`,
    [WS_ID, wsDir],
  );
});

afterEach(async () => {
  await new Promise((r) => setImmediate(r));
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function insertRun(): Promise<number> {
  const row = await queryOne<{ id: number | string }>(
    `INSERT INTO pipeline_runs (spec_path, workspace_id, status) VALUES ($1, $2, 'running') RETURNING id`,
    ['forge/specs/approved/ctm.json', WS_ID],
  );
  return Number(row!.id);
}

describe('GET /api/pipeline/runs/:runId/context-trace/:rawRef', () => {
  it('lazily resolves a raw payload written off the hot path', async () => {
    const runId = await insertRun();
    const writer = createContextTraceWriter(wsDir, runId);
    const heavy = { prompt: 'A'.repeat(1000), files: ['a.ts', 'b.ts'] };
    const event = writer.appendEvent('prompt', heavy, { label: 'prompt:US-001' });
    await writer.close();

    expect(event).not.toBeNull();

    const res = await request(app).get(
      `/api/pipeline/runs/${runId}/context-trace/${encodeURIComponent(event!.rawRef)}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.rawRef).toBe(event!.rawRef);
    expect(res.body.runId).toBe(runId);
    expect(res.body.phase).toBe('prompt');
    expect(res.body.payload).toEqual(heavy);
  });

  it('falls back to the run worktree path when the workspace root has no trace artifact', async () => {
    const runId = await insertRun();
    const worktreeDir = path.join(tmpDir, 'run-worktree');
    fs.mkdirSync(worktreeDir, { recursive: true });
    await execute(`UPDATE pipeline_runs SET worktree_path = $1 WHERE id = $2`, [worktreeDir, runId]);

    const writer = createContextTraceWriter(worktreeDir, runId);
    const heavy = { retrieval: 'payload', storyId: 'SMG-001' };
    const event = writer.appendEvent('memory', heavy, { label: 'retrieval:SMG-001' });
    await writer.close();

    const res = await request(app).get(
      `/api/pipeline/runs/${runId}/context-trace/${encodeURIComponent(event!.rawRef)}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.rawRef).toBe(event!.rawRef);
    expect(res.body.payload).toEqual(heavy);
  });

  it('tolerates duplicate delivery: repeated lookups of the same rawRef are idempotent', async () => {
    // SSE may redeliver a metadata event (last-seq-wins de-dup is client-side),
    // so the lazy raw fetch must be idempotent: the same rawRef must always
    // resolve to the same stable record, with no state mutated by reads.
    const runId = await insertRun();
    const writer = createContextTraceWriter(wsDir, runId);
    const heavy = { prompt: 'B'.repeat(2000), selections: ['x.ts'] };
    const event = writer.appendEvent('context', heavy, { label: 'arbiter:US-002' });
    await writer.close();

    expect(event).not.toBeNull();
    const url = `/api/pipeline/runs/${runId}/context-trace/${encodeURIComponent(event!.rawRef)}`;

    const first = await request(app).get(url);
    const second = await request(app).get(url);
    const third = await request(app).get(url);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);
    // Byte-for-byte identical bodies across redelivered fetches.
    expect(second.body).toEqual(first.body);
    expect(third.body).toEqual(first.body);
    expect(first.body.rawRef).toBe(event!.rawRef);
    expect(first.body.payload).toEqual(heavy);
  });

  it('returns 400 for a malformed rawRef', async () => {
    const runId = await insertRun();
    const res = await request(app).get(`/api/pipeline/runs/${runId}/context-trace/not-a-ref`);
    expect(res.status).toBe(400);
  });

  it('rejects a rawRef that belongs to a different run (run-scoped)', async () => {
    const runId = await insertRun();
    // A well-formed ref but for a different run id.
    const otherRef = `r${runId + 999}:0`;
    const res = await request(app).get(
      `/api/pipeline/runs/${runId}/context-trace/${encodeURIComponent(otherRef)}`,
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 when the run does not exist', async () => {
    const res = await request(app).get('/api/pipeline/runs/99999999/context-trace/r99999999:0');
    expect(res.status).toBe(404);
  });

  it('returns 404 when no artifact exists for the run', async () => {
    const runId = await insertRun();
    const res = await request(app).get(`/api/pipeline/runs/${runId}/context-trace/r${runId}:0`);
    expect(res.status).toBe(404);
  });

  it('returns 422 corrupt-artifact fallback when the artifact is unreadable', async () => {
    const runId = await insertRun();
    // Write a non-gzip artifact file so decompression fails — lookup yields no
    // record while the file still exists → corrupt-artifact fallback.
    const artifactPath = getTraceArtifactPath(wsDir, runId);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, Buffer.from('this is not gzip', 'utf8'));

    const res = await request(app).get(`/api/pipeline/runs/${runId}/context-trace/r${runId}:0`);
    expect(res.status).toBe(422);
  });
});
