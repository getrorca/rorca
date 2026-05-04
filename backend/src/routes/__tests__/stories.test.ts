/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';
import { execute } from '../../db/index';

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
  title: 'User Authentication',
  userStories: [
    {
      id: 'US-001',
      title: 'User login',
      description: 'Allow users to log in with email and password',
      acceptanceCriteria: ['Given valid creds, user is authenticated', 'Session persists across refresh'],
      dependsOn: [],
    },
    {
      id: 'US-002',
      title: 'Password reset',
      description: 'Allow users to reset their password via email',
      acceptanceCriteria: ['Reset link sent to email', 'Link expires after 24 hours'],
      dependsOn: ['US-001'],
    },
  ],
  generatedAt: '2026-02-20T00:00:00Z',
};

const spec2 = {
  title: 'Dashboard Features',
  userStories: [
    {
      id: 'US-001',
      title: 'Dashboard overview',
      description: 'Show summary metrics on the dashboard',
      acceptanceCriteria: ['Displays total users', 'Displays revenue chart', 'Login required to view'],
      dependsOn: [],
    },
  ],
  generatedAt: '2026-02-21T00:00:00Z',
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

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-stories-test-'));
  const _dbPath = path.join(tmpDir, 'test.db');
process.env.NODE_ENV = 'test';

  const serverMod = require('../../server');
  app = serverMod.default;
// Seed workspace
  await execute(`INSERT INTO workspaces (id, label, path) VALUES ('ws-test', 'Test Workspace', $1) ON CONFLICT (id) DO NOTHING`, [tmpDir]);

  // Create spec files on disk
  const pendingDir = path.join(tmpDir, 'scripts', 'ralph', 'specs', 'pending');
  const approvedDir = path.join(tmpDir, 'scripts', 'ralph', 'specs', 'approved');
  fs.mkdirSync(pendingDir, { recursive: true });
  fs.mkdirSync(approvedDir, { recursive: true });

  fs.writeFileSync(path.join(pendingDir, 'user-auth.json'), JSON.stringify(spec1));
  fs.writeFileSync(path.join(approvedDir, 'dashboard-features.json'), JSON.stringify(spec2));

  authToken = await getAuthToken(app);
});

afterEach(async () => {
  // Close the fresh pool created by jest.resetModules() + require('../../server') to prevent connection exhaustion
  try { const { closePool } = require('../../db/index'); await closePool(); } catch {}
fs.rmSync(tmpDir, { recursive: true, force: true });
delete process.env.NODE_ENV;
});

test('GET /api/stories/search without q returns 400', async () => {
  const res = await request(app)
    .get('/api/stories/search')
    .set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(400);
  expect(res.body.error).toContain('q');
});

test('search by story title returns matching stories', async () => {
  const res = await request(app)
    .get('/api/stories/search?q=login&workspaceId=ws-test')
    .set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.items).toHaveLength(2); // "User login" story + dashboard "Login required to view" AC
  expect(res.body.total).toBe(2);
  expect(res.body.hasMore).toBe(false);

  // First result should be the title match (User login)
  const loginStory = res.body.items.find((i: any) => i.storyId === 'US-001' && i.specId === 'user-auth');
  expect(loginStory).toBeDefined();
  expect(loginStory.storyTitle).toBe('User login');
  expect(loginStory.specId).toBe('user-auth');
  expect(loginStory.specTitle).toBe('User Authentication');
  expect(loginStory.workspaceId).toBe('ws-test');
  expect(loginStory.workspaceName).toBe('Test Workspace');
});

test('search by description returns matching stories', async () => {
  const res = await request(app)
    .get('/api/stories/search?q=reset%20their%20password&workspaceId=ws-test')
    .set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.items).toHaveLength(1);
  expect(res.body.items[0].storyId).toBe('US-002');
  expect(res.body.items[0].specId).toBe('user-auth');
});

test('search by acceptance criteria returns matching stories', async () => {
  const res = await request(app)
    .get('/api/stories/search?q=revenue%20chart&workspaceId=ws-test')
    .set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.items).toHaveLength(1);
  expect(res.body.items[0].specId).toBe('dashboard-features');
  expect(res.body.items[0].storyTitle).toBe('Dashboard overview');
});

test('filter by status=pending excludes approved specs', async () => {
  const res = await request(app)
    .get('/api/stories/search?q=US-001&workspaceId=ws-test&status=pending')
    .set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  // Only stories from pending specs
  for (const item of res.body.items) {
    expect(item.specStatus).toBe('pending');
  }
});

test('filter by status=approved excludes pending specs', async () => {
  const res = await request(app)
    .get('/api/stories/search?q=dashboard&workspaceId=ws-test&status=approved')
    .set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.items.length).toBeGreaterThanOrEqual(1);
  for (const item of res.body.items) {
    expect(item.specStatus).toBe('approved');
  }
});

test('pagination works correctly', async () => {
  const res = await request(app)
    .get('/api/stories/search?q=user&workspaceId=ws-test&limit=1&offset=0')
    .set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.items).toHaveLength(1);
  expect(res.body.total).toBeGreaterThan(1);
  expect(res.body.hasMore).toBe(true);

  // Page 2
  const res2 = await request(app)
    .get('/api/stories/search?q=user&workspaceId=ws-test&limit=1&offset=1')
    .set('Authorization', `Bearer ${authToken}`);

  expect(res2.status).toBe(200);
  expect(res2.body.items).toHaveLength(1);
  // Different story than page 1
  expect(res2.body.items[0].storyId).not.toBe(res.body.items[0].storyId);
});

test('search across all workspaces when workspaceId is omitted', async () => {
  // Add a second workspace
  const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-stories-ws2-'));
  await execute(`INSERT INTO workspaces (id, label, path) VALUES ('ws-test-2', 'Second Workspace', $1) ON CONFLICT (id) DO NOTHING`, [tmpDir2]);

  const pendingDir2 = path.join(tmpDir2, 'scripts', 'ralph', 'specs', 'pending');
  fs.mkdirSync(pendingDir2, { recursive: true });
  fs.writeFileSync(path.join(pendingDir2, 'payments.json'), JSON.stringify({
    title: 'Payment Processing',
    userStories: [{
      id: 'US-001',
      title: 'Process payment via Stripe',
      description: 'Integrate Stripe for payment processing',
      acceptanceCriteria: ['Card payment accepted', 'Receipt emailed'],
      dependsOn: [],
    }],
    generatedAt: '2026-02-22T00:00:00Z',
  }));

  const res = await request(app)
    .get('/api/stories/search?q=payment')
    .set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.items).toHaveLength(1);
  expect(res.body.items[0].workspaceId).toBe('ws-test-2');
  expect(res.body.items[0].workspaceName).toBe('Second Workspace');

  // Cleanup
  fs.rmSync(tmpDir2, { recursive: true, force: true });
});

test('filter by tags narrows results', async () => {
  // Add a tag to user-auth spec
  await execute(`INSERT INTO spec_tags (spec_id, workspace_id, tag_name) VALUES ('user-auth', 'ws-test', 'security')`);

  const res = await request(app)
    .get('/api/stories/search?q=user&workspaceId=ws-test&tags=security')
    .set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  // Only stories from specs with the 'security' tag
  for (const item of res.body.items) {
    expect(item.specId).toBe('user-auth');
    expect(item.tags).toContain('security');
  }
});

test('non-existent workspace returns 404', async () => {
  const res = await request(app)
    .get('/api/stories/search?q=test&workspaceId=nonexistent')
    .set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(404);
  expect(res.body.error).toContain('Workspace not found');
});

test('no matches returns empty items with total 0', async () => {
  const res = await request(app)
    .get('/api/stories/search?q=zzzznonexistent&workspaceId=ws-test')
    .set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.items).toHaveLength(0);
  expect(res.body.total).toBe(0);
  expect(res.body.hasMore).toBe(false);
});

test('search is case-insensitive', async () => {
  const res = await request(app)
    .get('/api/stories/search?q=PASSWORD&workspaceId=ws-test')
    .set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.items.length).toBeGreaterThanOrEqual(1);
  const found = res.body.items.find((i: any) => i.storyTitle === 'Password reset');
  expect(found).toBeDefined();
});

test('result includes matchSnippet', async () => {
  const res = await request(app)
    .get('/api/stories/search?q=revenue&workspaceId=ws-test')
    .set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.items).toHaveLength(1);
  expect(res.body.items[0].matchSnippet).toBeDefined();
  expect(res.body.items[0].matchSnippet).toContain('revenue');
});
