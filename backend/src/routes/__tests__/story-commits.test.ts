/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHmac } from 'crypto';
import type { Express } from 'express';
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';
import { query, execute } from '../../db/index';

let app: Express;
let tmpDir: string;
let authToken: string;

const WEBHOOK_SECRET = 'test-webhook-secret-commits';
const WORKSPACE_ID = 'ws-commit-test';

function sign(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

function sendWebhook(payload: Record<string, any>, event = 'push') {
  const body = JSON.stringify(payload);
  const sig = sign(body, WEBHOOK_SECRET);
  return request(app)
    .post('/api/webhooks/github')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', sig)
    .set('X-GitHub-Event', event)
    .set('X-GitHub-Delivery', `delivery-${Date.now()}`)
    .send(body);
}

function makePushPayload(commits: Array<{ id: string; message: string; author?: { name: string; email: string; username?: string }; timestamp?: string }>) {
  return {
    ref: 'refs/heads/main',
    repository: { full_name: 'acme/my-repo' },
    sender: { login: 'octocat' },
    commits: commits.map(c => ({
      id: c.id,
      message: c.message,
      author: c.author ?? { name: 'Test User', email: 'test@example.com', username: 'testuser' },
      timestamp: c.timestamp ?? '2026-02-23T12:00:00Z',
    })),
  };
}

function createSpecFile(stories: Array<{ id: string; title: string }>) {
  const approvedDir = path.join(tmpDir, 'forge', 'specs', 'approved');
  fs.mkdirSync(approvedDir, { recursive: true });

  const spec = {
    title: 'test-spec',
    userStories: stories.map(s => ({
      id: s.id,
      title: s.title,
      description: 'Test',
      acceptanceCriteria: ['AC1', 'AC2', 'AC3'],
      dependsOn: [],
      passes: false,
    })),
    generatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(path.join(approvedDir, 'test-spec.json'), JSON.stringify(spec, null, 2));
}

beforeEach(async () => {
  jest.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-commit-test-'));
  const _dbPath = path.join(tmpDir, 'test.db');
process.env.NODE_ENV = 'test';

  const serverMod = require('../../server');
  app = serverMod.default;
authToken = await getAuthToken(app);

  await execute(`DELETE FROM story_commits`);
  await execute(`DELETE FROM wal_events`);
  await execute(`DELETE FROM workspace_github_webhooks WHERE workspace_id = $1`, [WORKSPACE_ID]);

  await execute(`INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET path = $3`, [WORKSPACE_ID, 'Commit Test', tmpDir]);

  const authMod = require('../auth');
  const encryptedSecret = authMod.encryptToken(WEBHOOK_SECRET);
  await execute(`INSERT INTO workspace_github_webhooks (workspace_id, repo_owner, repo_name, webhook_id, encrypted_webhook_secret)
     VALUES ($1, $2, $3, $4, $5)`, [WORKSPACE_ID, 'acme', 'my-repo', 12345, encryptedSecret]);
});

afterEach(async () => {
  // Close the fresh pool created by jest.resetModules() + require('../../server') to prevent connection exhaustion
  try { const { closePool } = require('../../db/index'); await closePool(); } catch {}
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 100));
fs.rmSync(tmpDir, { recursive: true, force: true });
delete process.env.NODE_ENV;
});

// ─── extractStoryIdsFromCommit unit tests ────────────────────────────────────

test('extractStoryIdsFromCommit: feat(US-XXX) pattern', () => {
  const { extractStoryIdsFromCommit } = require('../webhook-handlers');
  const ids = extractStoryIdsFromCommit('feat(US-001): Add user login');
  expect(ids).toEqual(['US-001']);
});

test('extractStoryIdsFromCommit: multiple IDs in parens', () => {
  const { extractStoryIdsFromCommit } = require('../webhook-handlers');
  const ids = extractStoryIdsFromCommit('feat(US-001, US-002): Batch update');
  expect(ids).toContain('US-001');
  expect(ids).toContain('US-002');
  expect(ids).toHaveLength(2);
});

test('extractStoryIdsFromCommit: fix() pattern also matches', () => {
  const { extractStoryIdsFromCommit } = require('../webhook-handlers');
  const ids = extractStoryIdsFromCommit('fix(US-005): Resolve crash');
  expect(ids).toEqual(['US-005']);
});

test('extractStoryIdsFromCommit: fallback scans for US-XXX', () => {
  const { extractStoryIdsFromCommit } = require('../webhook-handlers');
  const ids = extractStoryIdsFromCommit('Implement US-003 login flow');
  expect(ids).toEqual(['US-003']);
});

test('extractStoryIdsFromCommit: no IDs returns empty', () => {
  const { extractStoryIdsFromCommit } = require('../webhook-handlers');
  const ids = extractStoryIdsFromCommit('chore: update deps');
  expect(ids).toEqual([]);
});

test('extractStoryIdsFromCommit: case insensitive', () => {
  const { extractStoryIdsFromCommit } = require('../webhook-handlers');
  const ids = extractStoryIdsFromCommit('feat(us-010): lowercase');
  expect(ids).toEqual(['US-010']);
});

// ─── Push webhook integration tests ─────────────────────────────────────────

test('push with feat(US-XXX) commits creates story_commits rows', async () => {
  createSpecFile([
    { id: 'US-001', title: 'Story 1' },
    { id: 'US-002', title: 'Story 2' },
  ]);

  const payload = makePushPayload([
    { id: 'sha111', message: 'feat(US-001): Add login form' },
  ]);

  const res = await sendWebhook(payload);
  expect(res.status).toBe(200);
  await new Promise((r) => setTimeout(r, 200));

  const rows = await query(`SELECT * FROM story_commits`) as any[];
  expect(rows).toHaveLength(1);
  expect(rows[0].story_id).toBe('US-001');
  expect(rows[0].spec_id).toBe('test-spec');
  expect(rows[0].commit_sha).toBe('sha111');
  expect(rows[0].commit_message).toBe('feat(US-001): Add login form');
  expect(rows[0].author).toBe('testuser');
});

test('single commit with multiple story IDs creates multiple rows', async () => {
  createSpecFile([
    { id: 'US-001', title: 'Story 1' },
    { id: 'US-002', title: 'Story 2' },
    { id: 'US-003', title: 'Story 3' },
  ]);

  const payload = makePushPayload([
    { id: 'sha222', message: 'feat(US-001, US-003): Shared component' },
  ]);

  await sendWebhook(payload);
  await new Promise((r) => setTimeout(r, 200));

  const rows = await query(`SELECT * FROM story_commits ORDER BY story_id`) as any[];
  expect(rows).toHaveLength(2);
  expect(rows[0].story_id).toBe('US-001');
  expect(rows[1].story_id).toBe('US-003');
  expect(rows[0].commit_sha).toBe('sha222');
  expect(rows[1].commit_sha).toBe('sha222');
});

test('push emits github_push_commits WAL event', async () => {
  createSpecFile([
    { id: 'US-001', title: 'Story 1' },
  ]);

  const payload = makePushPayload([
    { id: 'sha333', message: 'feat(US-001): Add feature' },
  ]);

  await sendWebhook(payload);
  await new Promise((r) => setTimeout(r, 200));

  const events = await query(`SELECT * FROM wal_events WHERE event_type = 'github_push_commits'`) as any[];

  expect(events).toHaveLength(1);
  const walPayload = JSON.parse(events[0].payload);
  expect(walPayload.linked_count).toBe(1);
  expect(walPayload.commits_count).toBe(1);
});

test('commit without story IDs does not create rows', async () => {
  createSpecFile([
    { id: 'US-001', title: 'Story 1' },
  ]);

  const payload = makePushPayload([
    { id: 'sha444', message: 'chore: update dependencies' },
  ]);

  await sendWebhook(payload);
  await new Promise((r) => setTimeout(r, 200));

  const rows = await query(`SELECT * FROM story_commits`);
  expect(rows).toHaveLength(0);
});

test('duplicate commit SHA is ignored (INSERT OR IGNORE)', async () => {
  createSpecFile([
    { id: 'US-001', title: 'Story 1' },
  ]);

  const payload = makePushPayload([
    { id: 'sha555', message: 'feat(US-001): Add feature' },
  ]);

  await sendWebhook(payload);
  await new Promise((r) => setTimeout(r, 200));
  await sendWebhook(payload);
  await new Promise((r) => setTimeout(r, 200));

  const rows = await query(`SELECT * FROM story_commits`);
  expect(rows).toHaveLength(1);
});

// ─── GET /api/specs/:specId/stories/:storyId/commits ─────────────────────────

test('GET story commits returns linked commits', async () => {
  createSpecFile([
    { id: 'US-001', title: 'Story 1' },
  ]);

  // Insert a commit directly
  await execute(`INSERT INTO story_commits (story_id, spec_id, workspace_id, commit_sha, commit_message, author, pushed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`, ['US-001', 'test-spec', WORKSPACE_ID, 'abc123', 'feat(US-001): Add login', 'octocat', '2026-02-23T12:00:00Z']);

  const res = await request(app)
    .get(`/api/specs/test-spec/stories/US-001/commits?workspaceId=${WORKSPACE_ID}`)
    .set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.commits).toHaveLength(1);
  expect(res.body.commits[0].commit_sha).toBe('abc123');
  expect(res.body.commits[0].author).toBe('octocat');
});

test('GET story commits returns empty for story with no commits', async () => {
  const res = await request(app)
    .get(`/api/specs/test-spec/stories/US-999/commits?workspaceId=${WORKSPACE_ID}`)
    .set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.commits).toHaveLength(0);
});

test('GET story commits requires workspaceId', async () => {
  const res = await request(app)
    .get('/api/specs/test-spec/stories/US-001/commits')
    .set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(400);
});
