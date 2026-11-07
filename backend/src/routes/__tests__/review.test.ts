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
import { createHash } from 'node:crypto';
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';
import { execute, query } from '../../db/index';
import { persistReviewComment } from '../../lib/review-comment-persistence';

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
let workspaceId: string;

const SPEC_ID = 'test-review-spec';
const OPERATOR_CAPABILITY = 'review-test-local-operator';
const CSRF_TOKEN = 'a'.repeat(64);

const SAMPLE_SPEC = {
  title: 'Test Review Spec',
  userStories: [
    {
      id: 'US-001',
      title: 'First story',
      description: 'First story description',
      acceptanceCriteria: ['It works'],
      dependsOn: [],
      passes: false,
    },
  ],
  model: 'claude-sonnet-4-5-20250929',
  generatedAt: new Date().toISOString(),
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

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-review-test-'));
  const _dbPath = path.join(tmpDir, 'test.db');
process.env.NODE_ENV = 'test';
process.env.RORCA_OPERATOR_CAPABILITY_SHA256 = createHash('sha256').update(OPERATOR_CAPABILITY).digest('hex');

  const serverMod = require('../../server');
  app = serverMod.default;
authToken = await getAuthToken(app);

  workspaceId = 'ws-review-test-' + Date.now();
  await execute(`INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`, [workspaceId,
    'Review Test Workspace',
    tmpDir,]);

  // Create the spec file on disk
  const approvedDir = path.join(tmpDir, 'forge', 'specs', 'approved');
  fs.mkdirSync(approvedDir, { recursive: true });
  fs.writeFileSync(
    path.join(approvedDir, `${SPEC_ID}.json`),
    JSON.stringify(SAMPLE_SPEC),
    'utf-8',
  );
});

afterEach(async () => {
  // Close the fresh pool created by jest.resetModules() + require('../../server') to prevent connection exhaustion
  try { const { closePool } = require('../../db/index'); await closePool(); } catch {}
fs.rmSync(tmpDir, { recursive: true, force: true });
delete process.env.NODE_ENV;
delete process.env.RORCA_OPERATOR_CAPABILITY_SHA256;
});

// ─── POST /api/specs/:specId/review-link ─────────────────────────────────

describe('POST /api/specs/:specId/review-link', () => {
  test('creates a review link and returns token + expiresAt', async () => {
    const res = await request(app)
      .post(`/api/specs/${SPEC_ID}/review-link`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId });

    expect(res.status).toBe(201);
    expect(res.body.token).toBeDefined();
    expect(res.body.url).toBeDefined();
    expect(res.body.expiresAt).toBeDefined();
    expect(res.body.url).toContain(res.body.token);
  });

  test('returns 400 when workspaceId is missing', async () => {
    const res = await request(app)
      .post(`/api/specs/${SPEC_ID}/review-link`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/workspaceId/i);
  });

  test('returns 404 for unknown workspace', async () => {
    const res = await request(app)
      .post(`/api/specs/${SPEC_ID}/review-link`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'nonexistent-ws' });

    expect(res.status).toBe(404);
  });

  test('returns 404 for non-existent spec', async () => {
    const res = await request(app)
      .post('/api/specs/nonexistent-spec-xyz/review-link')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId });

    expect(res.status).toBe(404);
  });
});

// ─── GET /api/review/:token ───────────────────────────────────────────────

describe('GET /api/review/:token', () => {
  test('returns spec + stories via valid review token', async () => {
    // Create the token first
    const createRes = await request(app)
      .post(`/api/specs/${SPEC_ID}/review-link`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId });

    const { token } = createRes.body;

    const res = await request(app).get(`/api/review/${token}`);

    expect(res.status).toBe(200);
    expect(res.body.specId).toBe(SPEC_ID);
    expect(res.body.stories).toBeDefined();
    expect(Array.isArray(res.body.stories)).toBe(true);
    expect(res.body.stories).toHaveLength(1);
    expect(res.body.expiresAt).toBeDefined();
  });

  test('returns 404 for invalid token', async () => {
    const res = await request(app).get('/api/review/not-a-real-token');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Invalid review link/i);
  });
});

// ─── POST /api/review/:token/comments ────────────────────────────────────

describe('POST /api/review/:token/comments', () => {
  test('adds a guest comment via review token', async () => {
    const createRes = await request(app)
      .post(`/api/specs/${SPEC_ID}/review-link`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId });

    const { token } = createRes.body;

    const res = await request(app)
      .post(`/api/review/${token}/comments`)
      .send({
        storyId: 'US-001',
        body: 'This looks good!',
        authorName: 'Guest Reviewer',
      });

    expect(res.status).toBe(201);
    expect(res.body.body).toBe('This looks good!');
    expect(res.body.story_id).toBe('US-001');
    expect(res.body.user_id).toBeNull();
  });

  test('returns 400 when body is missing', async () => {
    const createRes = await request(app)
      .post(`/api/specs/${SPEC_ID}/review-link`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId });

    const { token } = createRes.body;

    const res = await request(app)
      .post(`/api/review/${token}/comments`)
      .send({ storyId: 'US-001' });

    expect(res.status).toBe(400);
  });

  test('returns 404 for invalid token', async () => {
    const res = await request(app)
      .post('/api/review/not-a-real-token/comments')
      .send({ storyId: 'US-001', body: 'comment' });

    expect(res.status).toBe(404);
  });
});

// ─── POST /api/review/comment — Internal ────────────────────────────────

describe('POST /api/review/comment (internal)', () => {
  test('stores adversarial review comment with persona', async () => {
    const res = await request(app)
      .post('/api/review/comment')
      .set('Origin', 'http://localhost:5210')
      .set('Cookie', `_csrf=${CSRF_TOKEN}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .set('X-Rorca-Operator-Capability', OPERATOR_CAPABILITY)
      .send({
        workspace_id: workspaceId,
        spec_id: SPEC_ID,
        story_id: 'US-001',
        body: 'Security concern found.',
        author_name: 'Red Team Agent',
        review_persona: 'red-team',
        review_type: 'security',
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.spec_id).toBe(SPEC_ID);
    expect(res.body.story_id).toBe('US-001');
    expect(res.body.review_persona).toBe('red-team');
  });

  test('returns 400 when spec_id is missing', async () => {
    const res = await request(app)
      .post('/api/review/comment')
      .set('Origin', 'http://localhost:5210')
      .set('Cookie', `_csrf=${CSRF_TOKEN}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .set('X-Rorca-Operator-Capability', OPERATOR_CAPABILITY)
      .send({ workspace_id: workspaceId, story_id: 'US-001', body: 'comment' });

    expect(res.status).toBe(400);
  });

  test('replays the same caller key without inserting duplicate feedback', async () => {
    const payload = {
      workspace_id: workspaceId,
      spec_id: SPEC_ID,
      story_id: 'US-001',
      body: 'Retry-safe security concern.',
      author_name: 'Red Team Agent',
      review_persona: 'red-team',
      review_type: 'security',
    };
    const send = () => request(app)
      .post('/api/review/comment')
      .set('Origin', 'http://localhost:5210')
      .set('Cookie', `_csrf=${CSRF_TOKEN}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .set('X-Rorca-Operator-Capability', OPERATOR_CAPABILITY)
      .set('Idempotency-Key', 'review-retry-safe-001')
      .send(payload);
    const first = await send();
    const replay = await send();
    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ id: first.body.id, replayed: true });
  });

  test('rejects reuse of a caller key with different review semantics', async () => {
    const send = (body: string) => request(app)
      .post('/api/review/comment')
      .set('Origin', 'http://localhost:5210')
      .set('Cookie', `_csrf=${CSRF_TOKEN}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .set('X-Rorca-Operator-Capability', OPERATOR_CAPABILITY)
      .set('Idempotency-Key', 'review-conflict-001')
      .send({
        workspace_id: workspaceId,
        spec_id: SPEC_ID,
        story_id: 'US-001',
        body,
        author_name: 'Security Reviewer',
      });
    expect((await send('Original review body.')).status).toBe(201);
    const conflict = await send('Changed body under the same key.');
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toMatch(/already bound/i);
  });
});

describe('canonical review comment persistence', () => {
  test('system actor replay is idempotent without exercising HTTP operator authority', async () => {
    const input = {
      workspaceId,
      specId: SPEC_ID,
      storyId: 'US-001',
      body: 'Canonical execution review.',
      authorName: '[review] Security Reviewer',
      reviewPersona: 'Security Reviewer',
      reviewType: 'adversarial',
      actorScope: 'system' as const,
      replayKey: 'execution:canonical-review-001',
    };
    const first = await persistReviewComment(input);
    const replay = await persistReviewComment(input);
    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({ replayed: true, comment: { id: first.comment.id } });
    const rows = await query<{ id: string }>(
      'SELECT id FROM story_comments WHERE id = $1',
      [first.comment.id],
    );
    expect(rows).toHaveLength(1);
  });
});
