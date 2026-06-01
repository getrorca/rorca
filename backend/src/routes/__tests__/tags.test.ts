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
let authToken: string;

const specSlug = 'test-spec';
const specContent = {
  title: 'Test Spec',
  userStories: [
    {
      id: 'US-001',
      title: 'Story one',
      description: 'First story',
      acceptanceCriteria: ['AC1', 'AC2', 'AC3'],
      dependsOn: [],
    },
  ],
  generatedAt: '2026-02-23T00:00:00Z',
};

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

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-tags-test-'));
  const _dbPath = path.join(tmpDir, 'test.db');
process.env.NODE_ENV = 'test';

  const serverMod = require('../../server');
  app = serverMod.default;
// Seed workspace
  await execute(`INSERT INTO workspaces (id, label, path) VALUES ('ws-test', 'Test WS', $1) ON CONFLICT (id) DO NOTHING`, [tmpDir]);

  // Create spec file on disk
  const pendingDir = path.join(tmpDir, 'scripts', 'ralph', 'specs', 'pending');
  fs.mkdirSync(pendingDir, { recursive: true });
  fs.writeFileSync(path.join(pendingDir, `${specSlug}.json`), JSON.stringify(specContent));

  authToken = await getAuthToken(app);
});

afterEach(async () => {
  // Close the fresh pool created by jest.resetModules() + require('../../server') to prevent connection exhaustion
  try { const { closePool } = require('../../db/index'); await closePool(); } catch {}
fs.rmSync(tmpDir, { recursive: true, force: true });
delete process.env.NODE_ENV;
});

// ─── POST /api/specs/:specId/tags ────────────────────────────────────────────

describe('POST /api/specs/:specId/tags', () => {
  test('adds tags to a spec and returns them', async () => {
    const res = await request(app)
      .post(`/api/specs/${specSlug}/tags`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', tags: ['frontend', 'priority-high'] });

    expect(res.status).toBe(200);
    expect(res.body.tags).toEqual(['frontend', 'priority-high']);
  });

  test('normalizes tags to lowercase', async () => {
    const res = await request(app)
      .post(`/api/specs/${specSlug}/tags`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', tags: ['Frontend', 'BACKEND'] });

    expect(res.status).toBe(200);
    expect(res.body.tags).toEqual(['backend', 'frontend']);
  });

  test('ignores duplicate tags (idempotent)', async () => {
    await request(app)
      .post(`/api/specs/${specSlug}/tags`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', tags: ['auth'] });

    const res = await request(app)
      .post(`/api/specs/${specSlug}/tags`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', tags: ['auth', 'api'] });

    expect(res.status).toBe(200);
    expect(res.body.tags).toEqual(['api', 'auth']);
  });

  test('missing workspaceId returns 400', async () => {
    const res = await request(app)
      .post(`/api/specs/${specSlug}/tags`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ tags: ['test'] });

    expect(res.status).toBe(400);
  });

  test('missing tags array returns 400', async () => {
    const res = await request(app)
      .post(`/api/specs/${specSlug}/tags`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });

    expect(res.status).toBe(400);
  });

  test('emits WAL event on tag add', async () => {
    await request(app)
      .post(`/api/specs/${specSlug}/tags`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', tags: ['infra'] });

    const evt = await queryOne(`SELECT * FROM wal_events WHERE event_type = 'tags_updated' ORDER BY id DESC LIMIT 1`) as any;
    expect(evt).toBeDefined();
    expect(evt.spec_id).toBe(specSlug);
    const payload = JSON.parse(evt.payload);
    expect(payload.action).toBe('add');
    expect(payload.added).toContain('infra');
  });
});

// ─── DELETE /api/specs/:specId/tags/:tag ──────────────────────────────────────

describe('DELETE /api/specs/:specId/tags/:tag', () => {
  beforeEach(async () => {
    await request(app)
      .post(`/api/specs/${specSlug}/tags`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', tags: ['frontend', 'backend'] });
  });

  test('removes a tag and returns updated list', async () => {
    const res = await request(app)
      .delete(`/api/specs/${specSlug}/tags/frontend?workspaceId=ws-test`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.tags).toEqual(['backend']);
  });

  test('returns 404 for non-existent tag', async () => {
    const res = await request(app)
      .delete(`/api/specs/${specSlug}/tags/nonexistent?workspaceId=ws-test`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
  });

  test('missing workspaceId returns 400', async () => {
    const res = await request(app)
      .delete(`/api/specs/${specSlug}/tags/frontend`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(400);
  });
});

// ─── GET /api/specs/tags/autocomplete ────────────────────────────────────────

describe('GET /api/specs/tags/autocomplete', () => {
  beforeEach(async () => {
    // Add tags to two different specs
    await request(app)
      .post(`/api/specs/${specSlug}/tags`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', tags: ['frontend', 'auth', 'api'] });

    // Create a second spec
    const pendingDir = path.join(tmpDir, 'scripts', 'ralph', 'specs', 'pending');
    fs.writeFileSync(
      path.join(pendingDir, 'second-spec.json'),
      JSON.stringify({ ...specContent, title: 'Second Spec' })
    );
    await request(app)
      .post('/api/specs/second-spec/tags')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', tags: ['frontend', 'backend'] });
  });

  test('returns all tags sorted by count', async () => {
    const res = await request(app)
      .get('/api/specs/tags/autocomplete?workspaceId=ws-test')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.tags.length).toBeGreaterThanOrEqual(4);
    // 'frontend' appears in 2 specs, so should be first
    expect(res.body.tags[0].name).toBe('frontend');
    expect(res.body.tags[0].count).toBe(2);
  });

  test('filters by prefix query', async () => {
    const res = await request(app)
      .get('/api/specs/tags/autocomplete?workspaceId=ws-test&q=fro')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.tags.length).toBe(1);
    expect(res.body.tags[0].name).toBe('frontend');
  });

  test('missing workspaceId returns 400', async () => {
    const res = await request(app)
      .get('/api/specs/tags/autocomplete')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(400);
  });
});

// ─── GET /api/specs with tags filter ─────────────────────────────────────────

describe('GET /api/specs with tags filter', () => {
  beforeEach(async () => {
    // Create a second spec
    const pendingDir = path.join(tmpDir, 'scripts', 'ralph', 'specs', 'pending');
    fs.writeFileSync(
      path.join(pendingDir, 'second-spec.json'),
      JSON.stringify({ ...specContent, title: 'Second Spec' })
    );

    // Tag the first spec with 'frontend' and 'auth'
    await request(app)
      .post(`/api/specs/${specSlug}/tags`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', tags: ['frontend', 'auth'] });

    // Tag the second spec with 'frontend' only
    await request(app)
      .post('/api/specs/second-spec/tags')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', tags: ['frontend'] });
  });

  test('returns specs matching all specified tags', async () => {
    const res = await request(app)
      .get('/api/specs?workspaceId=ws-test&tags=frontend,auth')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    // Only test-spec has both 'frontend' and 'auth'
    expect(res.body.items.length).toBe(1);
    expect(res.body.items[0].id).toBe(specSlug);
  });

  test('returns specs matching single tag', async () => {
    const res = await request(app)
      .get('/api/specs?workspaceId=ws-test&tags=frontend')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    // Both specs have 'frontend'
    expect(res.body.items.length).toBe(2);
  });

  test('includes tags array in spec summary', async () => {
    const res = await request(app)
      .get('/api/specs?workspaceId=ws-test')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    const spec = res.body.items.find((s: any) => s.id === specSlug);
    expect(spec.tags).toEqual(['auth', 'frontend']);
  });

  test('no tags filter returns all specs', async () => {
    const res = await request(app)
      .get('/api/specs?workspaceId=ws-test')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(2);
  });
});
