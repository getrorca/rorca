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

let app: Express;
let tmpDir: string;
let authToken: string;

const WORKSPACE_ID = 'ws-pr-body-test';

function createSpecFile(specId: string, stories: Array<{
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
}>) {
  const approvedDir = path.join(tmpDir, 'scripts', 'ralph', 'specs', 'approved');
  fs.mkdirSync(approvedDir, { recursive: true });

  const spec = {
    title: `Test Spec ${specId}`,
    userStories: stories.map(s => ({
      ...s,
      passes: false,
    })),
    generatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(path.join(approvedDir, `${specId}.json`), JSON.stringify(spec, null, 2));
}

beforeEach(async () => {
  jest.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-pr-body-test-'));
  const _dbPath = path.join(tmpDir, 'test.db');
process.env.NODE_ENV = 'test';

  const serverMod = require('../../server');
  app = serverMod.default;
authToken = await getAuthToken(app);

  await execute(`INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`, [WORKSPACE_ID, 'PR Body Test', tmpDir]);
});

afterEach(async () => {
  // Close the fresh pool created by jest.resetModules() + require('../../server') to prevent connection exhaustion
  try { const { closePool } = require('../../db/index'); await closePool(); } catch {}
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 100));
fs.rmSync(tmpDir, { recursive: true, force: true });
delete process.env.NODE_ENV;
});

// ─── POST /api/specs/:specId/stories/:storyId/pr-body ──────────────────────

test('generates PR body with default template', async () => {
  createSpecFile('my-spec', [
    {
      id: 'US-001',
      title: 'User Login',
      description: 'Allow users to log in with email and password',
      acceptanceCriteria: ['Given valid creds, user is authenticated', 'Given invalid creds, error shown', 'Session persists across refresh'],
      dependsOn: [],
    },
  ]);

  const res = await request(app)
    .post('/api/specs/my-spec/stories/US-001/pr-body')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ workspaceId: WORKSPACE_ID });

  expect(res.status).toBe(200);
  expect(res.body.body).toBeDefined();
  expect(res.body.body).toContain('US-001');
  expect(res.body.body).toContain('User Login');
  expect(res.body.body).toContain('Allow users to log in');
  expect(res.body.body).toContain('- [ ] Given valid creds');
  expect(res.body.body).toContain('- [ ] Given invalid creds');
  expect(res.body.body).toContain('- [ ] Session persists');
  expect(res.body.body).toContain('my-spec');
});

test('includes dependencies section when story has dependencies', async () => {
  createSpecFile('dep-spec', [
    {
      id: 'US-001',
      title: 'Base Feature',
      description: 'Base',
      acceptanceCriteria: ['AC1', 'AC2', 'AC3'],
      dependsOn: [],
    },
    {
      id: 'US-002',
      title: 'Dependent Feature',
      description: 'Depends on US-001',
      acceptanceCriteria: ['AC1', 'AC2'],
      dependsOn: ['US-001'],
    },
  ]);

  const res = await request(app)
    .post('/api/specs/dep-spec/stories/US-002/pr-body')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ workspaceId: WORKSPACE_ID });

  expect(res.status).toBe(200);
  expect(res.body.body).toContain('Dependencies');
  expect(res.body.body).toContain('`US-001`');
});

test('omits dependencies section when story has no dependencies', async () => {
  createSpecFile('nodep-spec', [
    {
      id: 'US-001',
      title: 'Independent Feature',
      description: 'No deps',
      acceptanceCriteria: ['AC1', 'AC2', 'AC3'],
      dependsOn: [],
    },
  ]);

  const res = await request(app)
    .post('/api/specs/nodep-spec/stories/US-001/pr-body')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ workspaceId: WORKSPACE_ID });

  expect(res.status).toBe(200);
  expect(res.body.body).not.toContain('Dependencies');
});

test('uses custom workspace pr_template when set', async () => {
  createSpecFile('custom-spec', [
    {
      id: 'US-001',
      title: 'Custom Story',
      description: 'With custom template',
      acceptanceCriteria: ['AC1'],
      dependsOn: [],
    },
  ]);

  await execute(`UPDATE workspaces SET pr_template = $1 WHERE id = $2`, ['# PR: {{storyId}}\n\n{{storyTitle}}\n\nChecklist:\n{{acceptanceCriteriaChecklist}}', WORKSPACE_ID]);

  const res = await request(app)
    .post('/api/specs/custom-spec/stories/US-001/pr-body')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ workspaceId: WORKSPACE_ID });

  expect(res.status).toBe(200);
  expect(res.body.body).toContain('# PR: US-001');
  expect(res.body.body).toContain('Custom Story');
  expect(res.body.body).toContain('- [ ] AC1');
});

test('returns 400 when workspaceId missing', async () => {
  const res = await request(app)
    .post('/api/specs/my-spec/stories/US-001/pr-body')
    .set('Authorization', `Bearer ${authToken}`)
    .send({});

  expect(res.status).toBe(400);
  expect(res.body.error).toContain('workspaceId');
});

test('returns 404 when workspace not found', async () => {
  const res = await request(app)
    .post('/api/specs/my-spec/stories/US-001/pr-body')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ workspaceId: 'nonexistent' });

  expect(res.status).toBe(404);
  expect(res.body.error).toContain('Workspace not found');
});

test('returns 404 when spec not found', async () => {
  const res = await request(app)
    .post('/api/specs/nonexistent-spec/stories/US-001/pr-body')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ workspaceId: WORKSPACE_ID });

  expect(res.status).toBe(404);
  expect(res.body.error).toContain('not found');
});

test('returns 404 when story not found in spec', async () => {
  createSpecFile('exists-spec', [
    {
      id: 'US-001',
      title: 'Story',
      description: 'Desc',
      acceptanceCriteria: ['AC1'],
      dependsOn: [],
    },
  ]);

  const res = await request(app)
    .post('/api/specs/exists-spec/stories/US-999/pr-body')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ workspaceId: WORKSPACE_ID });

  expect(res.status).toBe(404);
  expect(res.body.error).toContain('US-999');
});

// ─── PATCH /api/workspaces/:id — pr_template update ─────────────────────────

test('PATCH workspace updates pr_template', async () => {
  const res = await request(app)
    .patch(`/api/workspaces/${WORKSPACE_ID}`)
    .set('Authorization', `Bearer ${authToken}`)
    .send({ pr_template: '# Custom\n{{storyTitle}}' });

  expect(res.status).toBe(200);
  expect(res.body.workspace.pr_template).toBe('# Custom\n{{storyTitle}}');

  // Verify persisted
  const row = await queryOne(`SELECT pr_template FROM workspaces WHERE id = $1`, [WORKSPACE_ID]) as any;
  expect(row.pr_template).toBe('# Custom\n{{storyTitle}}');
});

test('PATCH workspace clears pr_template with null', async () => {
  await execute(`UPDATE workspaces SET pr_template = $1 WHERE id = $2`, ['old template', WORKSPACE_ID]);

  const res = await request(app)
    .patch(`/api/workspaces/${WORKSPACE_ID}`)
    .set('Authorization', `Bearer ${authToken}`)
    .send({ pr_template: null });

  expect(res.status).toBe(200);
  expect(res.body.workspace.pr_template).toBeNull();
});

test('PATCH workspace returns 404 for unknown workspace', async () => {
  const res = await request(app)
    .patch('/api/workspaces/nonexistent')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ pr_template: 'test' });

  expect(res.status).toBe(404);
});
