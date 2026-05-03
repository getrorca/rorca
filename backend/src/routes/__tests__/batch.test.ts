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

let app: Express;
let tmpDir: string;
let mockChatComplete: jest.Mock;
let authToken: string;

const validLlmResponse = JSON.stringify({
  stories: [
    {
      id: 'US-001',
      title: 'Story one',
      description: 'Desc one',
      acceptanceCriteria: ['AC1', 'AC2', 'AC3'],
      dependsOn: [],
    },
  ],
});

beforeEach(async () => {
  jest.resetModules();

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

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-batch-test-'));
  const _dbPath = path.join(tmpDir, 'test.db');
process.env.NODE_ENV = 'test';

  const serverMod = require('../../server');
  app = serverMod.default;
const llmClient = require('../../lib/llm-client');
  mockChatComplete = llmClient.chatComplete;

  // Seed a workspace
  await execute(`INSERT INTO workspaces (id, label, path) VALUES ('ws-test', 'Test WS', $1) ON CONFLICT (id) DO NOTHING`, [os.tmpdir()]);

  authToken = await getAuthToken(app);
});

afterEach(async () => {
  // Close the fresh pool created by jest.resetModules() + require('../../server') to prevent connection exhaustion
  try { const { closePool } = require('../../db/index'); await closePool(); } catch {}
  const specsRoot = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs');
  if (fs.existsSync(specsRoot)) {
    fs.rmSync(specsRoot, { recursive: true, force: true });
  }
fs.rmSync(tmpDir, { recursive: true, force: true });
delete process.env.NODE_ENV;
});

// ─── POST /api/specs/generate/batch ───────────────────────────────────────────

test('POST /api/specs/generate/batch returns batchId and briefCount', async () => {
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } });

  const res = await request(app)
    .post('/api/specs/generate/batch')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      briefs: [
        { brief: 'Build auth system', workspaceId: 'ws-test', title: 'Auth System' },
        { brief: 'Build payment flow', workspaceId: 'ws-test', title: 'Payment Flow' },
      ],
    });

  expect(res.status).toBe(201);
  expect(res.body.batchId).toBeDefined();
  expect(typeof res.body.batchId).toBe('string');
  expect(res.body.briefCount).toBe(2);
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
        { title: 'Good Title', brief: 'Good brief', workspaceId: 'ws-test' },
        { title: 'Bad Title', brief: '', workspaceId: 'ws-test' }, // empty brief
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
        { title: 'Auth System', brief: 'Build auth', workspaceId: 'ws-test', model: 'custom-model-v1' },
      ],
    });

  // Any model string is accepted for openai-compat pass-through
  expect(res.status).not.toBe(400);
});

test('POST /api/specs/generate/batch emits batch_started WAL event', async () => {
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 10, outputTokens: 20 } });

  const res = await request(app)
    .post('/api/specs/generate/batch')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      briefs: [{ brief: 'Build auth', workspaceId: 'ws-test', title: 'Auth' }],
    });

  expect(res.status).toBe(201);

  const walEvent = await queryOne(`SELECT * FROM wal_events WHERE event_type = 'batch_started'`) as { payload: string } | undefined;

  expect(walEvent).toBeDefined();
  const payload = JSON.parse(walEvent!.payload);
  expect(payload.batchId).toBe(res.body.batchId);
  expect(payload.briefCount).toBe(1);
});

// ─── GET /api/specs/generate/batch/:batchId ──────────────────────────────────

test('GET /api/specs/generate/batch/:batchId returns batch status', async () => {
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 10, outputTokens: 20 } });

  const createRes = await request(app)
    .post('/api/specs/generate/batch')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      briefs: [{ brief: 'Build auth', workspaceId: 'ws-test', title: 'Auth Check' }],
    });

  const { batchId } = createRes.body;

  // Wait for async processing to complete
  await new Promise(resolve => setTimeout(resolve, 200));

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
        { brief: 'Will fail', workspaceId: 'ws-test', title: 'Fail Spec' },
        { brief: 'Will succeed', workspaceId: 'ws-test', title: 'Success Spec' },
      ],
    });

  expect(createRes.status).toBe(201);

  // Wait for both to process
  await new Promise(resolve => setTimeout(resolve, 500));

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
        { brief: 'Brief one', workspaceId: 'ws-test', title: 'Spec One' },
        { brief: 'Brief two', workspaceId: 'ws-test', title: 'Spec Two' },
      ],
    });

  await new Promise(resolve => setTimeout(resolve, 500));

  const progressEvents = await query(`SELECT * FROM wal_events WHERE event_type = 'batch_progress' ORDER BY id ASC`) as { payload: string }[];

  // 2 briefs × 2 events each (generating + completed) = 4 events
  expect(progressEvents.length).toBe(4);

  const payloads = progressEvents.map(e => JSON.parse(e.payload));

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
        { brief: 'Good workspace', workspaceId: 'ws-test', title: 'Good Spec' },
      ],
    });

  expect(createRes.status).toBe(201);

  await new Promise(resolve => setTimeout(resolve, 500));

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
      briefs: [{ brief: 'Build auth', workspaceId: 'ws-test', title: 'Batch Auth' }],
    });

  await new Promise(resolve => setTimeout(resolve, 300));

  // Verify via batch status that the spec was generated with the correct slug
  const statusRes = await request(app).get(`/api/specs/generate/batch/${createRes.body.batchId}`).set('Authorization', `Bearer ${authToken}`);
  expect(statusRes.body.items[0].status).toBe('completed');
  expect(statusRes.body.items[0].slug).toBe('batch-auth');

  // Verify WAL event for generate was emitted
  const walEvent = await queryOne(`SELECT payload FROM wal_events WHERE event_type = 'generate' AND spec_id = 'batch-auth'`) as { payload: string } | undefined;
  expect(walEvent).toBeDefined();
  const payload = JSON.parse(walEvent!.payload);
  expect(payload.title).toBe('Batch Auth');
  expect(payload.storyCount).toBe(1);
});
