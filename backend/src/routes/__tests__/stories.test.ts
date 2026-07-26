/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { Server } from 'http';
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

let app: Server;
let tmpDir: string;
let authToken: string;
const workspaceId = `stories-${randomUUID()}`;
const fixtureEmail = `stories-${randomUUID()}@example.com`;
const ownedWorkspaceIds = new Set<string>([workspaceId]);
const ownedDirectories: string[] = [];

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

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-stories-test-'));
  ownedDirectories.push(tmpDir);

  const expressApp = require('../../server').default;
  authToken = await getAuthToken(expressApp, { email: fixtureEmail, role: 'admin' });
  app = expressApp.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    app.once('listening', resolve);
    app.once('error', reject);
  });

  await execute(
    `INSERT INTO workspaces (id, label, path) VALUES ($1, 'Test Workspace', $2)`,
    [workspaceId, tmpDir],
  );

  const pendingDir = path.join(tmpDir, 'forge', 'specs', 'pending');
  const approvedDir = path.join(tmpDir, 'forge', 'specs', 'approved');
  fs.mkdirSync(pendingDir, { recursive: true });
  fs.mkdirSync(approvedDir, { recursive: true });
  fs.writeFileSync(path.join(pendingDir, 'user-auth.json'), JSON.stringify(spec1));
  fs.writeFileSync(path.join(approvedDir, 'dashboard-features.json'), JSON.stringify(spec2));
});

afterAll(async () => {
  app.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    app.close((error) => error ? reject(error) : resolve());
  });
  const ids = [...ownedWorkspaceIds];
  await execute('DELETE FROM spec_tags WHERE workspace_id = ANY($1::text[])', [ids]);
  await execute('DELETE FROM workspaces WHERE id = ANY($1::text[])', [ids]);
  await execute('DELETE FROM users WHERE email = $1', [fixtureEmail]);
  for (const directory of ownedDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
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
    .get(`/api/stories/search?q=login&workspaceId=${workspaceId}`)
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
  expect(loginStory.workspaceId).toBe(workspaceId);
  expect(loginStory.workspaceName).toBe('Test Workspace');
});

test('search by description returns matching stories', async () => {
  const res = await request(app)
    .get(`/api/stories/search?q=reset%20their%20password&workspaceId=${workspaceId}`)
    .set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.items).toHaveLength(1);
  expect(res.body.items[0].storyId).toBe('US-002');
  expect(res.body.items[0].specId).toBe('user-auth');
});

test('search by acceptance criteria returns matching stories', async () => {
  const res = await request(app)
    .get(`/api/stories/search?q=revenue%20chart&workspaceId=${workspaceId}`)
    .set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.items).toHaveLength(1);
  expect(res.body.items[0].specId).toBe('dashboard-features');
  expect(res.body.items[0].storyTitle).toBe('Dashboard overview');
});

test('filter by status=pending excludes approved specs', async () => {
  const res = await request(app)
    .get(`/api/stories/search?q=login&workspaceId=${workspaceId}&status=pending`)
    .set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.items).toHaveLength(1);
  expect(res.body.items[0]).toMatchObject({ specId: 'user-auth', specStatus: 'pending' });
});

test('filter by status=approved excludes pending specs', async () => {
  const res = await request(app)
    .get(`/api/stories/search?q=dashboard&workspaceId=${workspaceId}&status=approved`)
    .set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.items.length).toBeGreaterThanOrEqual(1);
  for (const item of res.body.items) {
    expect(item.specStatus).toBe('approved');
  }
});

test('pagination works correctly', async () => {
  const res = await request(app)
    .get(`/api/stories/search?q=user&workspaceId=${workspaceId}&limit=1&offset=0`)
    .set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.items).toHaveLength(1);
  expect(res.body.total).toBeGreaterThan(1);
  expect(res.body.hasMore).toBe(true);

  // Page 2
  const res2 = await request(app)
    .get(`/api/stories/search?q=user&workspaceId=${workspaceId}&limit=1&offset=1`)
    .set('Authorization', `Bearer ${authToken}`);

  expect(res2.status).toBe(200);
  expect(res2.body.items).toHaveLength(1);
  // Different story than page 1
  expect(res2.body.items[0].storyId).not.toBe(res.body.items[0].storyId);
});

test('search across all workspaces when workspaceId is omitted', async () => {
  const secondWorkspaceId = `stories-second-${randomUUID()}`;
  const uniquePaymentTerm = `stripe-${randomUUID()}`;
  const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-stories-ws2-'));
  ownedWorkspaceIds.add(secondWorkspaceId);
  ownedDirectories.push(tmpDir2);
  await execute(
    `INSERT INTO workspaces (id, label, path) VALUES ($1, 'Second Workspace', $2)`,
    [secondWorkspaceId, tmpDir2],
  );

  const pendingDir2 = path.join(tmpDir2, 'forge', 'specs', 'pending');
  fs.mkdirSync(pendingDir2, { recursive: true });
  fs.writeFileSync(path.join(pendingDir2, 'payments.json'), JSON.stringify({
    title: 'Payment Processing',
    userStories: [{
      id: 'US-001',
      title: `Process payment via ${uniquePaymentTerm}`,
      description: `Integrate ${uniquePaymentTerm} for payment processing`,
      acceptanceCriteria: ['Card payment accepted', 'Receipt emailed'],
      dependsOn: [],
    }],
    generatedAt: '2026-02-22T00:00:00Z',
  }));

  const res = await request(app)
    .get(`/api/stories/search?q=${encodeURIComponent(uniquePaymentTerm)}`)
    .set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.items).toHaveLength(1);
  expect(res.body.items[0].workspaceId).toBe(secondWorkspaceId);
  expect(res.body.items[0].workspaceName).toBe('Second Workspace');
});

test('filter by tags narrows results', async () => {
  // Add a tag to user-auth spec
  await execute(
    `INSERT INTO spec_tags (spec_id, workspace_id, tag_name) VALUES ('user-auth', $1, 'security')`,
    [workspaceId],
  );

  const res = await request(app)
    .get(`/api/stories/search?q=user&workspaceId=${workspaceId}&tags=security`)
    .set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.items).toHaveLength(2);
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
    .get(`/api/stories/search?q=zzzznonexistent&workspaceId=${workspaceId}`)
    .set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.items).toHaveLength(0);
  expect(res.body.total).toBe(0);
  expect(res.body.hasMore).toBe(false);
});

test('search is case-insensitive', async () => {
  const res = await request(app)
    .get(`/api/stories/search?q=PASSWORD&workspaceId=${workspaceId}`)
    .set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.items.length).toBeGreaterThanOrEqual(1);
  const found = res.body.items.find((i: any) => i.storyTitle === 'Password reset');
  expect(found).toBeDefined();
});

test('result includes matchSnippet', async () => {
  const res = await request(app)
    .get(`/api/stories/search?q=revenue&workspaceId=${workspaceId}`)
    .set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.items).toHaveLength(1);
  expect(res.body.items[0].matchSnippet).toBeDefined();
  expect(res.body.items[0].matchSnippet).toContain('revenue');
});
