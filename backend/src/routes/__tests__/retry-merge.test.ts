/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';
import { queryOne, execute } from '../../db/index';

jest.setTimeout(90_000);

const mockBossSend = jest.fn().mockResolvedValue('mock-merge-job-id');

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
    send: mockBossSend,
    work: jest.fn(),
    stop: jest.fn().mockResolvedValue(undefined),
  }),
}));

let app: Express;
let tmpDir: string;
let wsDir: string;
let workspaceId: string;
let authToken: string;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  const serverMod = require('../../server');
  app = serverMod.default;
  authToken = await getAuthToken(app);
});

beforeEach(async () => {
  jest.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-retry-merge-test-'));
  wsDir = path.join(tmpDir, 'workspace');
  workspaceId = `ws-merge-${path.basename(tmpDir)}`;
  fs.mkdirSync(path.join(wsDir, 'forge', 'specs', 'approved'), { recursive: true });
  await execute(
    `INSERT INTO workspaces (id, label, path) VALUES ($1, 'Merge WS', $2)`,
    [workspaceId, wsDir],
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(async () => {
  try { const { closePool } = require('../../db/index'); await closePool(); } catch {}
  delete process.env.NODE_ENV;
});

/** Seed a pipeline run with merge_status */
async function seedRunWithMerge(overrides: {
  status?: string;
  merge_status?: string | null;
  branch_name?: string | null;
  worktree_path?: string | null;
  auto_merge?: boolean;
  merge_strategy?: string;
  agent_type?: string | null;
  agent_model?: string | null;
} = {}) {
  const result = await queryOne<{ id: number }>(
    `INSERT INTO pipeline_runs (spec_path, workspace_id, status, branch_name, worktree_path, merge_status, auto_merge, merge_strategy, agent_type, agent_model)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [
      'forge/specs/approved/test-spec.json',
      workspaceId,
      overrides.status ?? 'done',
      overrides.branch_name === undefined ? 'feat/test-branch-123' : overrides.branch_name,
      overrides.worktree_path === undefined ? '/tmp/worktree-test' : overrides.worktree_path,
      overrides.merge_status === undefined ? 'failed' : overrides.merge_status,
      overrides.auto_merge ?? true,
      overrides.merge_strategy ?? 'direct',
      overrides.agent_type ?? 'pi',
      overrides.agent_model ?? 'openai-codex/gpt-5.6-sol',
    ],
  );
  return result!.id;
}

describe('POST /api/pipeline/runs/:runId/retry-merge', () => {
  test('retires the actuator before looking up a nonexistent run', async () => {
    const res = await request(app)
      .post('/api/pipeline/runs/999999/retry-merge')
      .set('Authorization', `Bearer ${authToken}`)
      .send();

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Manual retry-merge is retired');
    expect(mockBossSend).not.toHaveBeenCalled();
  });

  test('returns 409 when merge_status is null', async () => {
    const runId = await seedRunWithMerge({ merge_status: null });

    const res = await request(app)
      .post(`/api/pipeline/runs/${runId}/retry-merge`)
      .set('Authorization', `Bearer ${authToken}`)
      .send();

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Manual retry-merge is retired');
    expect(mockBossSend).not.toHaveBeenCalled();
  });

  test('returns 409 when merge_status is merged', async () => {
    const runId = await seedRunWithMerge({ merge_status: 'merged' });

    const res = await request(app)
      .post(`/api/pipeline/runs/${runId}/retry-merge`)
      .set('Authorization', `Bearer ${authToken}`)
      .send();

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Manual retry-merge is retired');
    expect(mockBossSend).not.toHaveBeenCalled();
  });

  test('returns 409 when merge_status is merging', async () => {
    const runId = await seedRunWithMerge({ merge_status: 'merging' });

    const res = await request(app)
      .post(`/api/pipeline/runs/${runId}/retry-merge`)
      .set('Authorization', `Bearer ${authToken}`)
      .send();

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Manual retry-merge is retired');
    expect(mockBossSend).not.toHaveBeenCalled();
  });

  test('returns 409 when run has no branch_name', async () => {
    const runId = await seedRunWithMerge({ merge_status: 'failed', branch_name: null });

    const res = await request(app)
      .post(`/api/pipeline/runs/${runId}/retry-merge`)
      .set('Authorization', `Bearer ${authToken}`)
      .send();

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Manual retry-merge is retired');
    expect(mockBossSend).not.toHaveBeenCalled();
  });

  test('rejects branch-only and no-auto-merge runs without queueing a base merge', async () => {
    const runId = await seedRunWithMerge({ auto_merge: false, merge_strategy: 'branch-only' });
    const res = await request(app)
      .post(`/api/pipeline/runs/${runId}/retry-merge`)
      .set('Authorization', `Bearer ${authToken}`)
      .send();

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Manual retry-merge is retired');
    expect(mockBossSend).not.toHaveBeenCalled();
  });

  test('does not reset failed merge state or enqueue the retired actuator', async () => {
    const runId = await seedRunWithMerge({ merge_status: 'failed' });

    const res = await request(app)
      .post(`/api/pipeline/runs/${runId}/retry-merge`)
      .set('Authorization', `Bearer ${authToken}`)
      .send();

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Manual retry-merge is retired');

    const run = await queryOne<{ merge_status: string }>(
      'SELECT merge_status FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    expect(run!.merge_status).toBe('failed');
    expect(mockBossSend).not.toHaveBeenCalled();
  });

  test('returns 400 for invalid runId', async () => {
    const res = await request(app)
      .post('/api/pipeline/runs/notanumber/retry-merge')
      .set('Authorization', `Bearer ${authToken}`)
      .send();

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid runId');
  });
});
