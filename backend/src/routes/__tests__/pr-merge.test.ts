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
import { once } from 'events';
import type { Server } from 'http';
import type { Express } from 'express';
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';
import { query, execute } from '../../db/index';
import { encryptToken } from '../../lib/auth-utils';

let app: Server;
let tmpDir: string;
let _authToken: string;

const WEBHOOK_SECRET = 'test-webhook-secret-pr-merge';
const WORKSPACE_ID = 'ws-pr-merge-test';

function sign(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

function sendWebhook(payload: Record<string, any>, event = 'pull_request') {
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

function makePrPayload(overrides: Record<string, any> = {}) {
  return {
    action: 'closed',
    repository: { full_name: 'acme/my-repo' },
    sender: { login: 'octocat' },
    pull_request: {
      merged: true,
      title: 'feat(US-001): Add user login',
      html_url: 'https://github.com/acme/my-repo/pull/42',
      merge_commit_sha: 'abc123def456',
      head: { ref: 'feat/US-001-add-login' },
      ...overrides.pull_request,
    },
    ...overrides,
  };
}

function createSpecFile(stories: Array<{ id: string; title: string; passes?: boolean }>) {
  const approvedDir = path.join(tmpDir, 'scripts', 'ralph', 'specs', 'approved');
  fs.mkdirSync(approvedDir, { recursive: true });

  const spec = {
    title: 'test-spec',
    userStories: stories.map(s => ({
      id: s.id,
      title: s.title,
      description: 'Test',
      acceptanceCriteria: ['AC1', 'AC2', 'AC3'],
      dependsOn: [],
      passes: s.passes ?? false,
    })),
    generatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(path.join(approvedDir, 'test-spec.json'), JSON.stringify(spec, null, 2));
  return approvedDir;
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  const serverMod = require('../../server');
  const expressApp = serverMod.default as Express;
  _authToken = await getAuthToken(expressApp);
  app = expressApp.listen(0, '127.0.0.1');
  await once(app, 'listening');
});

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-pr-merge-test-'));
  await execute('DELETE FROM workspace_github_webhooks WHERE workspace_id = $1', [WORKSPACE_ID]);
  await execute('DELETE FROM wal_events WHERE workspace_id = $1', [WORKSPACE_ID]);
  await execute(
    `INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`,
    [WORKSPACE_ID, 'PR Merge Test', tmpDir],
  );
  await execute(
    `INSERT INTO workspace_github_webhooks (workspace_id, repo_owner, repo_name, webhook_id, encrypted_webhook_secret)
     VALUES ($1, $2, $3, $4, $5)`,
    [WORKSPACE_ID, 'acme', 'my-repo', 12345, encryptToken(WEBHOOK_SECRET)],
  );
});

afterEach(async () => {
  await execute('DELETE FROM workspace_github_webhooks WHERE workspace_id = $1', [WORKSPACE_ID]);
  await execute('DELETE FROM wal_events WHERE workspace_id = $1', [WORKSPACE_ID]);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(async () => {
  app.closeAllConnections();
  await new Promise<void>((resolve, reject) => app.close(error => error ? reject(error) : resolve()));
  delete process.env.NODE_ENV;
});

// ─── extractStoryIds unit tests ─────────────────────────────────────────────

test('extractStoryIds: feat(US-XXX) in title', () => {
  const { extractStoryIds } = require('../webhook-handlers');
  const ids = extractStoryIds('feat(US-001): Add user login', 'main');
  expect(ids).toEqual(['US-001']);
});

test('extractStoryIds: multiple IDs in title parens', () => {
  const { extractStoryIds } = require('../webhook-handlers');
  const ids = extractStoryIds('feat(US-001, US-002): Add features', 'main');
  expect(ids).toContain('US-001');
  expect(ids).toContain('US-002');
  expect(ids).toHaveLength(2);
});

test('extractStoryIds: feat/US-XXX-slug in branch', () => {
  const { extractStoryIds } = require('../webhook-handlers');
  const ids = extractStoryIds('some title', 'feat/US-003-add-login');
  expect(ids).toEqual(['US-003']);
});

test('extractStoryIds: fallback pattern in title', () => {
  const { extractStoryIds } = require('../webhook-handlers');
  const ids = extractStoryIds('Fix US-005 bug', 'bugfix/something');
  expect(ids).toEqual(['US-005']);
});

test('extractStoryIds: no IDs found returns empty', () => {
  const { extractStoryIds } = require('../webhook-handlers');
  const ids = extractStoryIds('unrelated change', 'main');
  expect(ids).toEqual([]);
});

test('extractStoryIds: case insensitive', () => {
  const { extractStoryIds } = require('../webhook-handlers');
  const ids = extractStoryIds('feat(us-010): lowercase', 'main');
  expect(ids).toEqual(['US-010']);
});

test('extractStoryIds: deduplicates across title and branch', () => {
  const { extractStoryIds } = require('../webhook-handlers');
  const ids = extractStoryIds('feat(US-001): Add login', 'feat/US-001-add-login');
  expect(ids).toEqual(['US-001']);
});

// ─── Release-1 provider merge observation is non-mutating ──────────────────

test('merged PR observation does not grant story-pass authority', async () => {
  createSpecFile([
    { id: 'US-001', title: 'Story 1' },
    { id: 'US-002', title: 'Story 2' },
  ]);

  const payload = makePrPayload();
  const res = await sendWebhook(payload);
  expect(res.status).toBe(200);

  // Wait for async processing
  await new Promise((r) => setTimeout(r, 200));

  const specPath = path.join(tmpDir, 'scripts', 'ralph', 'specs', 'approved', 'test-spec.json');
  const content = JSON.parse(fs.readFileSync(specPath, 'utf8'));

  for (const story of content.userStories) {
    expect(story.passes).toBe(false);
    expect(story.mergedVia).toBeUndefined();
  }
});

test('merged PR observation does not synthesize an authoritative merge WAL event', async () => {
  createSpecFile([
    { id: 'US-001', title: 'Story 1' },
  ]);

  const payload = makePrPayload();
  await sendWebhook(payload);
  await new Promise((r) => setTimeout(r, 200));

  const events = await query(`SELECT * FROM wal_events WHERE event_type = 'github_pr_merged'`) as any[];

  expect(events).toHaveLength(0);
});

test('non-merged PR close does not update stories', async () => {
  createSpecFile([
    { id: 'US-001', title: 'Story 1' },
  ]);

  const payload = makePrPayload({
    pull_request: {
      merged: false,
      title: 'feat(US-001): Add login',
      html_url: 'https://github.com/acme/my-repo/pull/42',
      merge_commit_sha: null,
      head: { ref: 'feat/US-001-add-login' },
    },
  });

  await sendWebhook(payload);
  await new Promise((r) => setTimeout(r, 200));

  const specPath = path.join(tmpDir, 'scripts', 'ralph', 'specs', 'approved', 'test-spec.json');
  const content = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const us001 = content.userStories.find((s: any) => s.id === 'US-001');
  expect(us001.passes).toBe(false);

  const events = await query(`SELECT * FROM wal_events WHERE event_type = 'github_pr_merged'`);
  expect(events).toHaveLength(0);
});

test('PR with no story IDs does not emit WAL event', async () => {
  createSpecFile([
    { id: 'US-001', title: 'Story 1' },
  ]);

  const payload = makePrPayload({
    pull_request: {
      merged: true,
      title: 'chore: update dependencies',
      html_url: 'https://github.com/acme/my-repo/pull/99',
      merge_commit_sha: 'deadbeef',
      head: { ref: 'chore/update-deps' },
    },
  });

  await sendWebhook(payload);
  await new Promise((r) => setTimeout(r, 200));

  const events = await query(`SELECT * FROM wal_events WHERE event_type = 'github_pr_merged'`);
  expect(events).toHaveLength(0);
});

test('PR with multiple story IDs still cannot update stories without host closeout authority', async () => {
  createSpecFile([
    { id: 'US-001', title: 'Story 1' },
    { id: 'US-002', title: 'Story 2' },
    { id: 'US-003', title: 'Story 3' },
  ]);

  const payload = makePrPayload({
    pull_request: {
      merged: true,
      title: 'feat(US-001, US-003): Multiple stories',
      html_url: 'https://github.com/acme/my-repo/pull/50',
      merge_commit_sha: 'multi123',
      head: { ref: 'feat/US-001-US-003-multi' },
    },
  });

  await sendWebhook(payload);
  await new Promise((r) => setTimeout(r, 200));

  const specPath = path.join(tmpDir, 'scripts', 'ralph', 'specs', 'approved', 'test-spec.json');
  const content = JSON.parse(fs.readFileSync(specPath, 'utf8'));

  expect(content.userStories.every((story: any) => story.passes === false)).toBe(true);

  const events = await query(`SELECT * FROM wal_events WHERE event_type = 'github_pr_merged'`) as any[];
  expect(events).toHaveLength(0);
});
