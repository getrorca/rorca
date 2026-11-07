/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'crypto';
import { once } from 'events';
import * as fs from 'fs';
import type { Server } from 'http';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import request from 'supertest';
import { ensureTestUser, getAuthToken } from './helpers/auth-helper';
import { query, queryOne, execute } from '../../db/index';

// Mock llm-client before any imports that use it
jest.mock('../../lib/llm-client', () => ({
  chatComplete: jest.fn(),
  getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
  isValidModel: jest.fn().mockImplementation((m: string) =>
    ['claude-sonnet-4-5-20250929', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'].includes(m)
  ),
  DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
  resolveVaultProvider: jest.fn().mockReturnValue(null),
  getModelInfo: jest.fn().mockReturnValue(undefined),
  SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'],
}));

// Lifecycle compilation is certified separately. Batch authoring tests retain
// canonical persistence/workflow behavior without creating immutable portfolio
// evidence that a fixture teardown is not authorized to delete.
jest.mock('../../lib/spec-post-save-workflow', () => {
  const actual = jest.requireActual('../../lib/spec-post-save-workflow');
  return {
    ...actual,
    finalizeSpecPostSavePlanIfReady: jest.fn().mockResolvedValue(null),
  };
});

// Batch authoring starts without a compiled lifecycle plan, so exact-revision
// staleness invalidation is a no-op. Its database behavior is certified by the
// lifecycle plan service suite.
jest.mock('../../lib/ssdlc-plan-service', () => ({
  ...jest.requireActual('../../lib/ssdlc-plan-service'),
  markCurrentPlanStaleIfMaterialChanged: jest.fn().mockResolvedValue(false),
}));

let app: Server;
let tmpDir: string;
let mockChatComplete: jest.Mock;
let authToken: string;
let walBoundary = 0;

const WORKSPACE_ID = `ws-batch-${crypto.randomUUID()}`;

const validLlmResponse = JSON.stringify({
  stories: [
    {
      id: 'US-001',
      title: 'User login',
      description: 'Allow users to log in with email and password',
      acceptanceCriteria: [
        'Given valid credentials, the user is authenticated',
        'Given invalid credentials, an error is shown',
        'The session persists across refresh',
      ],
      dependsOn: [],
    },
    {
      id: 'US-002',
      title: 'Dashboard view',
      description: 'Show the user dashboard after login',
      acceptanceCriteria: [
        'The dashboard shows the user name',
        'The dashboard shows recent activity',
        'The dashboard loads within two seconds',
      ],
      dependsOn: ['US-001'],
    },
  ],
});

function parsePayload(value: unknown): Record<string, any> {
  return typeof value === 'string' ? JSON.parse(value) : (value as Record<string, any>);
}

async function waitForBatch(batchId: string, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const res = await request(app).get(`/api/specs/generate/batch/${batchId}`).set('Authorization', `Bearer ${authToken}`);
    const summary = res.body.summary as { completed?: number; failed?: number; queued?: number; generating?: number } | undefined;
    const total = res.body.totalBriefs as number | undefined;
    if (summary && typeof total === 'number' && (summary.completed ?? 0) + (summary.failed ?? 0) === total) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Batch ${batchId} did not finish within ${timeoutMs}ms`);
}

async function cleanFixtureState(): Promise<void> {
  const slugs = (await query<{ spec_slug: string }>(
    `SELECT DISTINCT spec_slug FROM spec_generation_logs
     WHERE context_summary_json->>'workspaceId' = $1`,
    [WORKSPACE_ID],
  )).map(row => row.spec_slug);

  await execute('DELETE FROM spec_post_save_workflow_runs WHERE workspace_id = $1', [WORKSPACE_ID]);
  await execute('DELETE FROM spec_jobs WHERE workspace_id = $1', [WORKSPACE_ID]);
  await execute('DELETE FROM spec_search_index WHERE workspace_id = $1', [WORKSPACE_ID]);
  if (slugs.length > 0) {
    await execute('DELETE FROM spec_versions WHERE spec_slug = ANY($1::text[])', [slugs]);
  }
  await execute(
    `DELETE FROM spec_generation_logs WHERE context_summary_json->>'workspaceId' = $1`,
    [WORKSPACE_ID],
  );
  await execute(
    `DELETE FROM wal_events
     WHERE workspace_id = $1
        OR (id > $2 AND event_type IN ('batch_started', 'batch_progress', 'batch_finished', 'generate'))`,
    [WORKSPACE_ID, walBoundary],
  );
  fs.rmSync(path.join(tmpDir, 'forge'), { recursive: true, force: true });
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-batch-test-'));
  const authId = crypto.randomUUID();
  const fixtureUser = await ensureTestUser({
    email: `batch-${authId}@test.rorca.local`,
    authId,
    role: 'admin',
    plan: 'pro',
  });

  const serverMod = require('../../server');
  const expressApp = serverMod.default as Express;
  const llmClient = require('../../lib/llm-client');
  mockChatComplete = llmClient.chatComplete;
  authToken = await getAuthToken(expressApp, {
    email: fixtureUser.email,
    authId,
    role: 'admin',
    displayName: 'Batch Test Admin',
  });
  await execute(
    `INSERT INTO workspaces (id, label, path) VALUES ($1, 'Batch Test WS', $2)
     ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`,
    [WORKSPACE_ID, tmpDir],
  );
  const boundary = await queryOne<{ id: string | number | null }>('SELECT MAX(id) AS id FROM wal_events');
  walBoundary = Number(boundary?.id ?? 0);

  app = expressApp.listen(0, '127.0.0.1');
  await once(app, 'listening');
});

beforeEach(async () => {
  jest.clearAllMocks();
  mockChatComplete.mockReset();
  await cleanFixtureState();
  const boundary = await queryOne<{ id: string | number | null }>('SELECT MAX(id) AS id FROM wal_events');
  walBoundary = Number(boundary?.id ?? 0);
});

afterEach(cleanFixtureState);

afterAll(async () => {
  try {
    await cleanFixtureState();
  } finally {
    app.closeAllConnections();
    await new Promise<void>((resolve, reject) => app.close(error => error ? reject(error) : resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.NODE_ENV;
  }
});

// ─── POST /api/specs/generate/batch ───────────────────────────────────────────

test('POST /api/specs/generate/batch returns batchId and briefCount', async () => {
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } });

  const res = await request(app)
    .post('/api/specs/generate/batch')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      briefs: [
        { brief: 'Build auth system', workspaceId: WORKSPACE_ID, title: 'Auth System' },
        { brief: 'Build payment flow', workspaceId: WORKSPACE_ID, title: 'Payment Flow' },
      ],
    });

  expect(res.status).toBe(201);
  expect(res.body.batchId).toBeDefined();
  expect(typeof res.body.batchId).toBe('string');
  expect(res.body.briefCount).toBe(2);

  await waitForBatch(res.body.batchId);
});

 test('POST /api/specs/forge/batch uses the shared skill-first batch route', async () => {
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 40, outputTokens: 50 } });

  const res = await request(app)
    .post('/api/specs/forge/batch')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      briefs: [
        { brief: 'Build billing dashboard', workspaceId: WORKSPACE_ID, title: 'Billing Dashboard', postSave: { enrich: false, matchSkills: false, memorySynthesis: false } },
      ],
    });

  expect(res.status).toBe(201);
  expect(typeof res.body.batchId).toBe('string');
  expect(res.body.briefCount).toBe(1);

  await waitForBatch(res.body.batchId);

  const statusRes = await request(app)
    .get(`/api/specs/forge/batch/${res.body.batchId}`)
    .set('Authorization', `Bearer ${authToken}`);

  expect(statusRes.status).toBe(200);
  expect({
    status: statusRes.body.items[0].status,
    slug: statusRes.body.items[0].slug,
    error: statusRes.body.items[0].error,
  }).toEqual({ status: 'completed', slug: 'billing-dashboard', error: undefined });
});

test('POST /api/specs/generate/batch with empty briefs → 400', async () => {
  const res = await request(app)
    .post('/api/specs/generate/batch')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ briefs: [] });

  expect(res.status).toBe(400);
  expect(res.body.error).toContain('empty briefs');
});

test('POST /api/specs/generate/batch with missing briefs field → 400', async () => {
  const res = await request(app)
    .post('/api/specs/generate/batch')
    .set('Authorization', `Bearer ${authToken}`)
    .send({});

  expect(res.status).toBe(400);
  expect(res.body.error).toContain('empty briefs');
});

test('POST /api/specs/generate/batch validates brief fields', async () => {
  const res = await request(app)
    .post('/api/specs/generate/batch')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      briefs: [
        { title: 'Good Title', brief: 'Good brief', workspaceId: WORKSPACE_ID },
        { title: 'Bad Title', brief: '', workspaceId: WORKSPACE_ID }, // empty brief
      ],
    });

  expect(res.status).toBe(400);
  expect(res.body.error).toContain('index 1');
});

test('POST /api/specs/generate/batch accepts any model string (pass-through)', async () => {
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } });

  const res = await request(app)
    .post('/api/specs/generate/batch')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      briefs: [
        { title: 'Auth System', brief: 'Build auth', workspaceId: WORKSPACE_ID, model: 'custom-model-v1' },
      ],
    });

  // Any model string is accepted for openai-compat pass-through
  expect(res.status).not.toBe(400);

  await waitForBatch(res.body.batchId);
});

test('POST /api/specs/generate/batch emits batch_started WAL event', async () => {
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 10, outputTokens: 20 } });

  const res = await request(app)
    .post('/api/specs/generate/batch')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      briefs: [{ brief: 'Build auth', workspaceId: WORKSPACE_ID, title: 'Auth' }],
    });

  expect(res.status).toBe(201);

  const events = await query(`SELECT * FROM wal_events WHERE event_type = 'batch_started' ORDER BY id ASC`) as { payload: unknown }[];
  const walEvent = events.map((event) => parsePayload(event.payload)).find((payload) => payload.batchId === res.body.batchId);

  expect(walEvent).toBeDefined();
  expect(walEvent?.briefCount).toBe(1);

  await waitForBatch(res.body.batchId);
});

// ─── GET /api/specs/generate/batch/:batchId ──────────────────────────────────

test('GET /api/specs/generate/batch/:batchId returns batch status', async () => {
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 10, outputTokens: 20 } });

  const createRes = await request(app)
    .post('/api/specs/generate/batch')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      briefs: [{ brief: 'Build auth', workspaceId: WORKSPACE_ID, title: 'Auth Check' }],
    });

  const { batchId } = createRes.body;

  await waitForBatch(batchId);

  const statusRes = await request(app).get(`/api/specs/generate/batch/${batchId}`).set('Authorization', `Bearer ${authToken}`);

  expect(statusRes.status).toBe(200);
  expect(statusRes.body.batchId).toBe(batchId);
  expect(statusRes.body.totalBriefs).toBe(1);
  expect(statusRes.body.items).toHaveLength(1);
  expect(statusRes.body.items[0].status).toBe('completed');
  expect(statusRes.body.items[0].slug).toBe('auth-check');
  expect(statusRes.body.summary.completed).toBe(1);
  expect(statusRes.body.finishedAt).toBeDefined();
});

test('GET /api/specs/generate/batch/:batchId with unknown ID → 404', async () => {
  const res = await request(app).get('/api/specs/generate/batch/nonexistent-id').set('Authorization', `Bearer ${authToken}`);
  expect(res.status).toBe(404);
  expect(res.body.error).toContain('not found');
});

// ─── Sequential processing & error isolation ─────────────────────────────────

test('failed brief does not block subsequent briefs', async () => {
  // First call fails, second succeeds
  mockChatComplete
    .mockRejectedValueOnce(new Error('LLM timeout'))
    .mockResolvedValueOnce({ text: validLlmResponse, usage: { inputTokens: 10, outputTokens: 20 } });

  const createRes = await request(app)
    .post('/api/specs/generate/batch')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      briefs: [
        { brief: 'Will fail', workspaceId: WORKSPACE_ID, title: 'Fail Spec' },
        { brief: 'Will succeed', workspaceId: WORKSPACE_ID, title: 'Success Spec' },
      ],
    });

  expect(createRes.status).toBe(201);

  await waitForBatch(createRes.body.batchId);

  const statusRes = await request(app).get(`/api/specs/generate/batch/${createRes.body.batchId}`).set('Authorization', `Bearer ${authToken}`);

  expect(statusRes.body.items[0].status).toBe('failed');
  expect(statusRes.body.items[0].error).toBe('LLM timeout');
  expect(statusRes.body.items[1].status).toBe('completed');
  expect(statusRes.body.items[1].slug).toBe('success-spec');
  expect(statusRes.body.summary.failed).toBe(1);
  expect(statusRes.body.summary.completed).toBe(1);
});

test('batch emits batch_progress WAL events for each brief', async () => {
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 10, outputTokens: 20 } });

  const createRes = await request(app)
    .post('/api/specs/generate/batch')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      briefs: [
        { brief: 'Brief one', workspaceId: WORKSPACE_ID, title: 'Spec One' },
        { brief: 'Brief two', workspaceId: WORKSPACE_ID, title: 'Spec Two' },
      ],
    });

  await waitForBatch(createRes.body.batchId);

  const progressEvents = await query(`SELECT * FROM wal_events WHERE event_type = 'batch_progress' ORDER BY id ASC`) as { payload: unknown }[];
  const payloads = progressEvents
    .map(e => parsePayload(e.payload))
    .filter((payload) => payload.batchId === createRes.body.batchId);

  // 2 briefs × 2 events each (generating + completed) = 4 events
  expect(payloads.length).toBe(4);

  // First brief: generating → completed
  expect(payloads[0].briefIndex).toBe(0);
  expect(payloads[0].status).toBe('generating');
  expect(payloads[1].briefIndex).toBe(0);
  expect(payloads[1].status).toBe('completed');

  // Second brief: generating → completed
  expect(payloads[2].briefIndex).toBe(1);
  expect(payloads[2].status).toBe('generating');
  expect(payloads[3].briefIndex).toBe(1);
  expect(payloads[3].status).toBe('completed');

  // All payloads should have the same batchId
  for (const p of payloads) {
    expect(p.batchId).toBe(createRes.body.batchId);
    expect(p.totalBriefs).toBe(2);
  }
});

test('batch with invalid workspace captures error per-brief', async () => {
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 10, outputTokens: 20 } });

  const createRes = await request(app)
    .post('/api/specs/generate/batch')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      briefs: [
        { brief: 'Bad workspace', workspaceId: 'nonexistent', title: 'Ghost' },
        { brief: 'Good workspace', workspaceId: WORKSPACE_ID, title: 'Good Spec' },
      ],
    });

  expect(createRes.status).toBe(201);

  await waitForBatch(createRes.body.batchId);

  const statusRes = await request(app).get(`/api/specs/generate/batch/${createRes.body.batchId}`).set('Authorization', `Bearer ${authToken}`);

  expect(statusRes.body.items[0].status).toBe('failed');
  expect(statusRes.body.items[0].error).toContain('Workspace not found');
  expect(statusRes.body.items[1].status).toBe('completed');
});

test('batch writes spec and emits generate WAL event', async () => {
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 10, outputTokens: 20 } });

  const createRes = await request(app)
    .post('/api/specs/generate/batch')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      briefs: [{ brief: 'Build auth', workspaceId: WORKSPACE_ID, title: 'Batch Auth' }],
    });

  await waitForBatch(createRes.body.batchId);

  // Verify via batch status that the spec was generated with the correct slug
  const statusRes = await request(app).get(`/api/specs/generate/batch/${createRes.body.batchId}`).set('Authorization', `Bearer ${authToken}`);
  expect(statusRes.body.items[0].status).toBe('completed');
  expect(statusRes.body.items[0].slug).toBe('batch-auth');

  // Verify WAL event for generate was emitted
  const walEvent = await queryOne(`SELECT payload FROM wal_events WHERE event_type = 'generate' AND spec_id = 'batch-auth'`) as { payload: unknown } | undefined;
  expect(walEvent).toBeDefined();
  const payload = parsePayload(walEvent!.payload);
  expect(payload.title).toBe('Batch Auth');
  expect(payload.storyCount).toBe(2);
});
