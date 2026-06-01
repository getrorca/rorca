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

jest.mock('../../lib/llm-client', () => ({
  chatComplete: jest.fn(),
  getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
  isValidModel: jest.fn().mockReturnValue(true),
  DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
  resolveVaultProvider: jest.fn().mockReturnValue(null),
  getModelInfo: jest.fn().mockReturnValue(undefined),
  SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
}));

let app: Express;
let tmpDir: string;
let authToken: string;

const spec1 = {
  title: 'Timeout Test Spec',
  userStories: [
    {
      id: 'US-001',
      title: 'Short story',
      description: 'A quick task',
      acceptanceCriteria: ['Done quickly'],
      dependsOn: [],
    },
    {
      id: 'US-002',
      title: 'Long story',
      description: 'An infrastructure task that takes a while',
      acceptanceCriteria: ['Infrastructure deployed', 'Health checks pass'],
      dependsOn: [],
      timeoutMinutes: 90,
    },
  ],
  generatedAt: '2026-02-23T00:00:00Z',
};

beforeEach(async () => {
  jest.resetModules();

  jest.mock('../../lib/llm-client', () => ({
    chatComplete: jest.fn(),
    getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
    isValidModel: jest.fn().mockReturnValue(true),
    DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
    resolveVaultProvider: jest.fn().mockReturnValue(null),
    getModelInfo: jest.fn().mockReturnValue(undefined),
    SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
  }));

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-timeout-test-'));
  const _dbPath = path.join(tmpDir, 'test.db');
process.env.NODE_ENV = 'test';

  const serverMod = require('../../server');
  app = serverMod.default;
// Seed workspace
  await execute(`INSERT INTO workspaces (id, label, path) VALUES ('ws-test', 'Test Workspace', $1) ON CONFLICT (id) DO NOTHING`, [tmpDir]);

  // Create spec file on disk
  const pendingDir = path.join(tmpDir, 'scripts', 'ralph', 'specs', 'pending');
  fs.mkdirSync(pendingDir, { recursive: true });
  fs.writeFileSync(path.join(pendingDir, 'timeout-test.json'), JSON.stringify(spec1));

  authToken = await getAuthToken(app);
});

afterEach(async () => {
  // Close the fresh pool created by jest.resetModules() + require('../../server') to prevent connection exhaustion
  try { const { closePool } = require('../../db/index'); await closePool(); } catch {}
fs.rmSync(tmpDir, { recursive: true, force: true });
delete process.env.NODE_ENV;
});

test('PUT story update accepts timeoutMinutes', async () => {
  const res = await request(app)
    .put('/api/specs/timeout-test/stories/US-001')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ workspaceId: 'ws-test', timeoutMinutes: 15 });

  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.story.timeoutMinutes).toBe(15);

  // Verify persisted to disk
  const raw = JSON.parse(
    fs.readFileSync(path.join(tmpDir, 'scripts', 'ralph', 'specs', 'pending', 'timeout-test.json'), 'utf8')
  );
  const story = raw.userStories.find((s: any) => s.id === 'US-001');
  expect(story.timeoutMinutes).toBe(15);
});

test('PUT story update rejects timeoutMinutes below 5', async () => {
  const res = await request(app)
    .put('/api/specs/timeout-test/stories/US-001')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ workspaceId: 'ws-test', timeoutMinutes: 3 });

  expect(res.status).toBe(400);
  expect(res.body.error).toContain('timeoutMinutes');
});

test('PUT story update rejects timeoutMinutes above 120', async () => {
  const res = await request(app)
    .put('/api/specs/timeout-test/stories/US-001')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ workspaceId: 'ws-test', timeoutMinutes: 200 });

  expect(res.status).toBe(400);
  expect(res.body.error).toContain('timeoutMinutes');
});

test('PUT story update rejects non-integer timeoutMinutes', async () => {
  const res = await request(app)
    .put('/api/specs/timeout-test/stories/US-001')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ workspaceId: 'ws-test', timeoutMinutes: 30.5 });

  expect(res.status).toBe(400);
  expect(res.body.error).toContain('timeoutMinutes');
});

test('existing timeoutMinutes is preserved when not provided in update', async () => {
  // US-002 already has timeoutMinutes: 90 in the spec
  const res = await request(app)
    .put('/api/specs/timeout-test/stories/US-002')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ workspaceId: 'ws-test', title: 'Updated long story' });

  expect(res.status).toBe(200);
  expect(res.body.story.title).toBe('Updated long story');
  expect(res.body.story.timeoutMinutes).toBe(90); // preserved
});

test('story_results table accepts timeout status', async () => {
  // Create a pipeline run first
  const runResult = await queryOne<{ id: number }>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status) VALUES ('test.json', 'ws-test', 'running') RETURNING id`);
  const runId = runResult!.id;

  // Insert a timeout story result
  const storyResult = await queryOne<{ id: number }>(`INSERT INTO story_results (run_id, story_id, status, elapsed_seconds) VALUES ($1, 'US-001', 'timeout', 2700) RETURNING id`, [runId]);

  expect(storyResult!.id).toBeGreaterThan(0);

  // Verify it can be read back
  const row = await queryOne(`SELECT * FROM story_results WHERE id = $1`, [storyResult!.id]) as any;
  expect(row.status).toBe('timeout');
  expect(row.elapsed_seconds).toBe(2700);
});
