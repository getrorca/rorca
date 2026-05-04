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
import { query, queryOne, execute } from '../../db/index';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

let app: Express;
let tmpDir: string;
let authToken: string;

const WORKSPACE_ID = 'ws-import-test';

function makeGithubIssue(num: number, overrides: Record<string, any> = {}) {
  return {
    number: num,
    title: `Issue #${num}: Test feature`,
    body: `Description for issue ${num}`,
    html_url: `https://github.com/acme/my-repo/issues/${num}`,
    labels: [{ name: 'enhancement' }, { name: 'frontend' }],
    state: 'open',
    ...overrides,
  };
}

function createSpecFile(
  specId: string,
  stories: Array<{ id: string; title: string }> = [],
  dir: 'approved' | 'pending' = 'approved',
) {
  const targetDir = path.join(tmpDir, 'scripts', 'ralph', 'specs', dir);
  fs.mkdirSync(targetDir, { recursive: true });

  const spec = {
    title: specId,
    userStories: stories.map(s => ({
      id: s.id,
      title: s.title,
      description: 'Existing story',
      acceptanceCriteria: ['AC1', 'AC2', 'AC3'],
      dependsOn: [],
      passes: false,
    })),
    generatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(
    path.join(targetDir, `${specId}.json`),
    JSON.stringify(spec, null, 2),
  );
}

beforeEach(async () => {
  jest.resetModules();
  mockFetch.mockReset();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-gh-import-test-'));
  const _dbPath = path.join(tmpDir, 'test.db');
process.env.NODE_ENV = 'test';

  const serverMod = require('../../server');
  app = serverMod.default;
authToken = await getAuthToken(app);

  await execute(`DELETE FROM wal_events`);

  // Create workspace
  await execute(`INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`, [WORKSPACE_ID, 'Import Test', tmpDir]);

  // Store GitHub webhook connection
  const authMod = require('../auth');
  const encryptedSecret = authMod.encryptToken('test-secret');
  await execute(`INSERT INTO workspace_github_webhooks (workspace_id, repo_owner, repo_name, webhook_id, encrypted_webhook_secret)
     VALUES ($1, $2, $3, $4, $5)`, [WORKSPACE_ID, 'acme', 'my-repo', 12345, encryptedSecret]);

  // Store GitHub OAuth token — must reference the real user created by getAuthToken
  const user = await queryOne(`SELECT id FROM users WHERE email = 'testauth@example.com'`) as { id: string };
  const encryptedToken = authMod.encryptToken('gho_test_token_123');
  await execute(`INSERT INTO github_connections (id, user_id, github_user_id, encrypted_token, scopes, github_username)
     VALUES ($1, $2, $3, $4, $5, $6)`, ['gc-test', user.id, '12345', encryptedToken, 'repo', 'octocat']);
});

afterEach(async () => {
  // Close the fresh pool created by jest.resetModules() + require('../../server') to prevent connection exhaustion
  try { const { closePool } = require('../../db/index'); await closePool(); } catch {}
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 50));
fs.rmSync(tmpDir, { recursive: true, force: true });
delete process.env.NODE_ENV;
});

// ─── Validation ──────────────────────────────────────────────────────────────

test('returns 400 when workspaceId is missing', async () => {
  const res = await request(app)
    .post('/api/specs/test-spec/import/github-issues')
    .set('Authorization', `Bearer ${authToken}`)
    .send({});

  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/workspaceId/i);
});

test('returns 404 when workspace not found', async () => {
  const res = await request(app)
    .post('/api/specs/test-spec/import/github-issues')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ workspaceId: 'nonexistent' });

  expect(res.status).toBe(404);
  expect(res.body.error).toMatch(/workspace not found/i);
});

test('returns 404 when spec not found', async () => {
  const res = await request(app)
    .post('/api/specs/nonexistent-spec/import/github-issues')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ workspaceId: WORKSPACE_ID, issueNumbers: [1] });

  expect(res.status).toBe(404);
  expect(res.body.error).toMatch(/spec not found/i);
});

test('returns 400 when no GitHub connection exists', async () => {
  // Remove the webhook connection
  await execute(`DELETE FROM workspace_github_webhooks WHERE workspace_id = $1`, [WORKSPACE_ID]);

  createSpecFile('test-spec');

  const res = await request(app)
    .post('/api/specs/test-spec/import/github-issues')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ workspaceId: WORKSPACE_ID, issueNumbers: [1] });

  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/no github connection/i);
});

test('returns 400 when no GitHub OAuth token exists', async () => {
  await execute(`DELETE FROM github_connections`);
  createSpecFile('test-spec');

  const res = await request(app)
    .post('/api/specs/test-spec/import/github-issues')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ workspaceId: WORKSPACE_ID, issueNumbers: [1] });

  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/no github oauth token/i);
});

// ─── Preview mode ─────────────────────────────────────────────────────────────

test('preview mode returns proposed stories without writing', async () => {
  createSpecFile('test-spec', [{ id: 'US-001', title: 'Existing story' }]);

  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => makeGithubIssue(42),
  });

  const res = await request(app)
    .post('/api/specs/test-spec/import/github-issues')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: WORKSPACE_ID,
      issueNumbers: [42],
      preview: true,
    });

  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.preview).toBe(true);
  expect(res.body.stories).toHaveLength(1);
  expect(res.body.stories[0]).toMatchObject({
    id: 'US-002',
    title: 'Issue #42: Test feature',
    githubIssueUrl: 'https://github.com/acme/my-repo/issues/42',
    tags: ['enhancement', 'frontend'],
  });

  // Verify spec file was NOT modified
  const specPath = path.join(tmpDir, 'scripts', 'ralph', 'specs', 'approved', 'test-spec.json');
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  expect(spec.userStories).toHaveLength(1); // Still just the original story
});

// ─── Import mode ──────────────────────────────────────────────────────────────

test('import mode appends stories and writes to disk', async () => {
  createSpecFile('test-spec', [{ id: 'US-001', title: 'Existing story' }]);

  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => makeGithubIssue(10),
  });
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => makeGithubIssue(11, { body: null, labels: [] }),
  });

  const res = await request(app)
    .post('/api/specs/test-spec/import/github-issues')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: WORKSPACE_ID,
      issueNumbers: [10, 11],
    });

  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.preview).toBe(false);
  expect(res.body.importedCount).toBe(2);
  expect(res.body.stories).toHaveLength(2);

  // Verify story IDs are sequential after existing
  expect(res.body.stories[0].id).toBe('US-002');
  expect(res.body.stories[1].id).toBe('US-003');

  // Verify githubIssueUrl
  expect(res.body.stories[0].githubIssueUrl).toBe('https://github.com/acme/my-repo/issues/10');

  // Verify null body maps to empty description
  expect(res.body.stories[1].description).toBe('');

  // Verify spec file was updated
  const specPath = path.join(tmpDir, 'scripts', 'ralph', 'specs', 'approved', 'test-spec.json');
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  expect(spec.userStories).toHaveLength(3); // 1 existing + 2 imported
  expect(spec.userStories[2].githubIssueUrl).toBe('https://github.com/acme/my-repo/issues/11');

  // Verify WAL event was emitted
  const walEvents = await query(`SELECT * FROM wal_events WHERE event_type = 'github_issues_imported'`) as any[];
  expect(walEvents).toHaveLength(1);
  const payload = JSON.parse(walEvents[0].payload);
  expect(payload.issueCount).toBe(2);
  expect(payload.issueNumbers).toEqual([10, 11]);
});

// ─── GitHub API error handling ──────────────────────────────────────────────

test('partial failures are reported alongside successful imports', async () => {
  createSpecFile('test-spec');

  // Issue 10 succeeds
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => makeGithubIssue(10),
  });
  // Issue 999 returns 404
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status: 404,
    statusText: 'Not Found',
  });

  const res = await request(app)
    .post('/api/specs/test-spec/import/github-issues')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: WORKSPACE_ID,
      issueNumbers: [10, 999],
    });

  expect(res.status).toBe(200);
  expect(res.body.importedCount).toBe(1);
  expect(res.body.errors).toHaveLength(1);
  expect(res.body.errors[0].number).toBe(999);
});

test('returns 502 when all issues fail to fetch', async () => {
  createSpecFile('test-spec');

  mockFetch.mockResolvedValueOnce({
    ok: false,
    status: 403,
    statusText: 'Forbidden',
  });

  const res = await request(app)
    .post('/api/specs/test-spec/import/github-issues')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: WORKSPACE_ID,
      issueNumbers: [1],
    });

  expect(res.status).toBe(502);
  expect(res.body.error).toMatch(/failed to fetch/i);
});

// ─── Pagination (fetch all open issues) ───────────────────────────────────────

test('fetches all open issues with pagination when no issueNumbers provided', async () => {
  createSpecFile('test-spec');

  // Page 1: 100 items (full page → triggers next page fetch)
  const page1 = Array.from({ length: 100 }, (_, i) =>
    makeGithubIssue(i + 1)
  );
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => page1,
  });

  // Page 2: partial page (signals end)
  const page2 = [makeGithubIssue(101), makeGithubIssue(102)];
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => page2,
  });

  const res = await request(app)
    .post('/api/specs/test-spec/import/github-issues')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: WORKSPACE_ID,
      preview: true,
    });

  expect(res.status).toBe(200);
  expect(res.body.stories).toHaveLength(102);

  // Verify pagination URLs were called
  expect(mockFetch).toHaveBeenCalledTimes(2);
  const firstCall = mockFetch.mock.calls[0][0] as string;
  expect(firstCall).toContain('state=open');
  expect(firstCall).toContain('page=1');
  const secondCall = mockFetch.mock.calls[1][0] as string;
  expect(secondCall).toContain('page=2');
});

// ─── Label mapping ─────────────────────────────────────────────────────────

test('maps GitHub labels to tags on imported stories', async () => {
  createSpecFile('test-spec');

  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => makeGithubIssue(5, {
      labels: [{ name: 'bug' }, { name: 'priority: high' }, { name: 'backend' }],
    }),
  });

  const res = await request(app)
    .post('/api/specs/test-spec/import/github-issues')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: WORKSPACE_ID,
      issueNumbers: [5],
      preview: true,
    });

  expect(res.body.stories[0].tags).toEqual(['bug', 'priority: high', 'backend']);
});

// ─── Works with pending specs too ─────────────────────────────────────────────

test('imports into a pending spec', async () => {
  createSpecFile('pending-spec', [{ id: 'ST-001', title: 'Pending story' }], 'pending');

  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => makeGithubIssue(7),
  });

  const res = await request(app)
    .post('/api/specs/pending-spec/import/github-issues')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: WORKSPACE_ID,
      issueNumbers: [7],
    });

  expect(res.status).toBe(200);
  expect(res.body.stories[0].id).toBe('ST-002'); // Continues prefix from existing stories
});
