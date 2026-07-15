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

let app: Express;
let tmpDir: string;
let wsDir: string;
let authToken: string;
let mockBossSend: jest.Mock;

beforeEach(async () => {
  jest.resetModules();

  mockBossSend = jest.fn().mockResolvedValue('mock-merge-job-id');

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

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-retry-merge-test-'));
  process.env.NODE_ENV = 'test';

  const serverMod = require('../../server');
  app = serverMod.default;
  authToken = await getAuthToken(app);

  await execute(`UPDATE users SET plan = 'pro' WHERE email = 'testauth@example.com'`);

  wsDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(path.join(wsDir, 'forge', 'specs', 'approved'), { recursive: true });

  // Clean up
  await execute(`DELETE FROM token_usage WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = 'ws-merge')`);
  await execute(`DELETE FROM story_results WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = 'ws-merge')`);
  await execute(`DELETE FROM pipeline_runs WHERE workspace_id = 'ws-merge'`);
  await execute(`DELETE FROM wal_events WHERE workspace_id = 'ws-merge'`);

  await execute(
    `INSERT INTO users (id, email, display_name, password_hash, plan)
     VALUES ('local-admin', 'admin@rorca.local', 'Admin', 'x', 'pro')
     ON CONFLICT (id) DO UPDATE SET plan = 'pro'`,
  );

  await execute(
    `INSERT INTO workspaces (id, label, path) VALUES ('ws-merge', 'Merge WS', $1)
     ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`,
    [wsDir],
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
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
      'ws-merge',
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
  test('returns 404 when run does not exist', async () => {
    const res = await request(app)
      .post('/api/pipeline/runs/999999/retry-merge')
      .set('Authorization', `Bearer ${authToken}`)
      .send();

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('not found');
  });

  test('returns 409 when merge_status is null', async () => {
    const runId = await seedRunWithMerge({ merge_status: null });

    const res = await request(app)
      .post(`/api/pipeline/runs/${runId}/retry-merge`)
      .set('Authorization', `Bearer ${authToken}`)
      .send();

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('null');
  });

  test('returns 409 when merge_status is merged', async () => {
    const runId = await seedRunWithMerge({ merge_status: 'merged' });

    const res = await request(app)
      .post(`/api/pipeline/runs/${runId}/retry-merge`)
      .set('Authorization', `Bearer ${authToken}`)
      .send();

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('merged');
  });

  test('returns 409 when merge_status is merging', async () => {
    const runId = await seedRunWithMerge({ merge_status: 'merging' });

    const res = await request(app)
      .post(`/api/pipeline/runs/${runId}/retry-merge`)
      .set('Authorization', `Bearer ${authToken}`)
      .send();

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('merging');
  });

  test('returns 409 when run has no branch_name', async () => {
    const runId = await seedRunWithMerge({ merge_status: 'failed', branch_name: null });

    const res = await request(app)
      .post(`/api/pipeline/runs/${runId}/retry-merge`)
      .set('Authorization', `Bearer ${authToken}`)
      .send();

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('branch_name');
  });

  test('rejects branch-only and no-auto-merge runs without queueing a base merge', async () => {
    const runId = await seedRunWithMerge({ auto_merge: false, merge_strategy: 'branch-only' });
    const res = await request(app)
      .post(`/api/pipeline/runs/${runId}/retry-merge`)
      .set('Authorization', `Bearer ${authToken}`)
      .send();

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('autoMerge=true direct');
    expect(mockBossSend).not.toHaveBeenCalled();
  });

  test('succeeds: resets merge_status to merging and enqueues job', async () => {
    const runId = await seedRunWithMerge({ merge_status: 'failed' });

    const res = await request(app)
      .post(`/api/pipeline/runs/${runId}/retry-merge`)
      .set('Authorization', `Bearer ${authToken}`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, runId: Number(runId), queued: true });

    // Verify merge_status was reset to 'merging'
    const run = await queryOne<{ merge_status: string }>(
      'SELECT merge_status FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    expect(run!.merge_status).toBe('merging');

    // Verify pg-boss send was called with correct queue and payload
    expect(mockBossSend).toHaveBeenCalledWith(
      'pipeline:merge',
      {
        runId: Number(runId),
        branch: 'feat/test-branch-123',
        workspaceId: 'ws-merge',
        posture: { agent: 'pi', model: 'openai-codex/gpt-5.6-sol', source: 'manual-retry' },
      },
      expect.objectContaining({
        retryLimit: 0,
        expireInSeconds: 3600,
      }),
    );
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
