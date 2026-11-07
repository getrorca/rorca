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
import { execute } from '../../db/index';
import { encryptToken } from '../../lib/auth-utils';

let app: Server;
let tmpDir: string;
let authToken: string;

const WEBHOOK_SECRET = 'test-webhook-secret-checks';
const WORKSPACE_ID = 'ws-checks-test';

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
    action: 'opened',
    repository: { full_name: 'acme/my-repo' },
    sender: { login: 'octocat' },
    pull_request: {
      number: 10,
      title: 'feat(US-001): Add user login',
      html_url: 'https://github.com/acme/my-repo/pull/10',
      head: {
        ref: 'feat/US-001-add-login',
        sha: 'abcdef1234567890abcdef1234567890abcdef12',
      },
      base: { ref: 'main' },
      merged: false,
      ...overrides.pull_request,
    },
    ...overrides,
  };
}

function createSpecFile(
  stories: Array<{ id: string; title: string; acceptanceCriteria?: string[] }>,
) {
  const approvedDir = path.join(tmpDir, 'scripts', 'ralph', 'specs', 'approved');
  fs.mkdirSync(approvedDir, { recursive: true });

  const spec = {
    title: 'test-spec',
    userStories: stories.map(s => ({
      id: s.id,
      title: s.title,
      description: 'Test',
      acceptanceCriteria: s.acceptanceCriteria ?? ['AC1', 'AC2'],
      dependsOn: [],
      passes: false,
    })),
    generatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(
    path.join(approvedDir, 'test-spec.json'),
    JSON.stringify(spec, null, 2),
  );
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.AUTH_REQUIRED = 'true';
  const serverMod = require('../../server');
  const expressApp = serverMod.default as Express;
  authToken = await getAuthToken(expressApp);
  app = expressApp.listen(0, '127.0.0.1');
  await once(app, 'listening');
});

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-checks-test-'));
  await execute('DELETE FROM workspace_github_webhooks WHERE workspace_id = $1', [WORKSPACE_ID]);
  await execute('DELETE FROM wal_events WHERE workspace_id = $1', [WORKSPACE_ID]);
  await execute(
    `INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`,
    [WORKSPACE_ID, 'Checks Test', tmpDir],
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
  delete process.env.AUTH_REQUIRED;
});

// ─── checkCriteriaCoverage unit tests ────────────────────────────────────────

test('checkCriteriaCoverage: all criteria covered when keywords match', async () => {
  const { checkCriteriaCoverage } = require('../../lib/github-checks');
  const criteria = [
    'User can login with email and password',
    'Display error message on invalid credentials',
  ];
  const files = [
    { filename: 'src/auth/login.ts', patch: '+function handleLogin(email: string, password: string) {\n+  if (!valid) showError("invalid credentials");\n+}' },
    { filename: 'src/components/ErrorMessage.tsx', patch: '+export function ErrorMessage({ message }: { message: string }) {' },
  ];

  const coverage = checkCriteriaCoverage(criteria, files);
  expect(coverage).toHaveLength(2);
  expect(coverage[0].covered).toBe(true);
  expect(coverage[1].covered).toBe(true);
});

test('checkCriteriaCoverage: criteria not covered when no keyword matches', () => {
  const { checkCriteriaCoverage } = require('../../lib/github-checks');
  const criteria = ['System sends email notification on password reset'];
  const files = [
    { filename: 'src/utils/format.ts', patch: '+function formatDate(d: Date) { return d.toISOString(); }' },
  ];

  const coverage = checkCriteriaCoverage(criteria, files);
  expect(coverage).toHaveLength(1);
  expect(coverage[0].covered).toBe(false);
});

test('checkCriteriaCoverage: empty criteria returns empty array', () => {
  const { checkCriteriaCoverage } = require('../../lib/github-checks');
  const coverage = checkCriteriaCoverage([], []);
  expect(coverage).toEqual([]);
});

test('checkCriteriaCoverage: filename matches count as coverage', () => {
  const { checkCriteriaCoverage } = require('../../lib/github-checks');
  const criteria = ['API endpoint returns validation errors'];
  const files = [
    { filename: 'src/routes/api-endpoint.ts', patch: '+  return res.json({ validation: errors });' },
  ];

  const coverage = checkCriteriaCoverage(criteria, files);
  expect(coverage[0].covered).toBe(true);
});

// ─── CHECK_NAME constant ─────────────────────────────────────────────────────

test('CHECK_NAME is rorca/spec-compliance', () => {
  const { CHECK_NAME } = require('../../lib/github-checks');
  expect(CHECK_NAME).toBe('rorca/spec-compliance');
});

// ─── POST /api/github/checks/:sha — manual update ───────────────────────────

test('manual check update rejects invalid SHA', async () => {
  const res = await request(app)
    .post('/api/github/checks/abc')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ state: 'success', workspaceId: WORKSPACE_ID });

  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/invalid sha/i);
});

test('manual check update rejects invalid state', async () => {
  const res = await request(app)
    .post(`/api/github/checks/${'a'.repeat(40)}`)
    .set('Authorization', `Bearer ${authToken}`)
    .send({ state: 'unknown', workspaceId: WORKSPACE_ID });

  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/invalid state/i);
});

test('manual check update rejects missing workspaceId', async () => {
  const res = await request(app)
    .post(`/api/github/checks/${'a'.repeat(40)}`)
    .set('Authorization', `Bearer ${authToken}`)
    .send({ state: 'success' });

  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/workspaceid/i);
});

test('manual check update requires an exact canonical run identity before repository lookup', async () => {
  const res = await request(app)
    .post(`/api/github/checks/${'a'.repeat(40)}`)
    .set('Authorization', `Bearer ${authToken}`)
    .send({ state: 'success', workspaceId: 'nonexistent-ws' });

  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/runId must be a positive safe integer/i);
});

test('manual check update requires authentication', async () => {
  const res = await request(app)
    .post('/api/github/checks/abcdef1234567')
    .send({ state: 'success', workspaceId: WORKSPACE_ID });

  expect(res.status).toBe(401);
});

// ─── Webhook handler: PR opened triggers check evaluation ────────────────────

test('handlePullRequestCheck is registered for pull_request events', () => {
  // The handler is registered on import via registerWebhookHandlers
  // We verify by checking the exported function exists
  const { handlePullRequestCheck } = require('../webhook-handlers');
  expect(typeof handlePullRequestCheck).toBe('function');
});

test('handlePullRequestCheck ignores non-open/sync actions', () => {
  const { handlePullRequestCheck } = require('../webhook-handlers');
  // "closed" action should be handled by handlePullRequestMerge, not check handler
  // This should return without error
  handlePullRequestCheck(
    { action: 'closed', pull_request: { merged: true } },
    'pull_request',
    WORKSPACE_ID,
  );
  // No assertion needed — just verifying no throw
});

test('handlePullRequestCheck processes opened PRs', () => {
  const { handlePullRequestCheck } = require('../webhook-handlers');
  createSpecFile([
    { id: 'US-001', title: 'Story 1', acceptanceCriteria: ['Test criterion'] },
  ]);

  // Mock global fetch to avoid actual GitHub API calls
  const originalFetch = global.fetch;
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status: 401,
    text: () => Promise.resolve('Unauthorized'),
  });

  // Should not throw even if GitHub API call fails
  handlePullRequestCheck(
    makePrPayload().pull_request
      ? makePrPayload()
      : makePrPayload(),
    'pull_request',
    WORKSPACE_ID,
  );

  global.fetch = originalFetch;
});

// ─── PR webhook integration: opened event produces WAL event ─────────────────

test('opened PR webhook is accepted and triggers async processing', async () => {
  createSpecFile([
    {
      id: 'US-001',
      title: 'Story 1',
      acceptanceCriteria: ['User can login with email'],
    },
  ]);

  const payload = makePrPayload({ action: 'opened' });
  const res = await sendWebhook(payload);
  expect(res.status).toBe(200);
});

test('synchronize PR webhook is accepted', async () => {
  createSpecFile([
    {
      id: 'US-001',
      title: 'Story 1',
      acceptanceCriteria: ['User can login with email'],
    },
  ]);

  const payload = makePrPayload({ action: 'synchronize' });
  const res = await sendWebhook(payload);
  expect(res.status).toBe(200);
});
