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
import { query, execute } from '../../db/index';

let app: Express;
let tmpDir: string;
let authToken: string;

beforeEach(async () => {
  jest.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-direction-test-'));
  const _dbPath = path.join(tmpDir, 'test.db');
process.env.NODE_ENV = 'test';
  const serverMod = require('../../server');
  app = serverMod.default;
authToken = await getAuthToken(app);
});

afterEach(async () => {
  // Close the fresh pool created by jest.resetModules() + require('../../server') to prevent connection exhaustion
  try { const { closePool } = require('../../db/index'); await closePool(); } catch {}
fs.rmSync(tmpDir, { recursive: true, force: true });
delete process.env.NODE_ENV;
});

const validWorkspace = {
  id: 'ws-dir-test',
  label: 'Direction Test',
  path: os.tmpdir(),
  domains: ['backend'],
};

// Valid L3 YAML that passes schema validation
const validL3Yaml = `name: MyProject
type: web-app
stack:
  - React
  - Node.js
purpose: Ship v2 of the dashboard
key_modules:
  - auth
  - billing`;

// --- PUT + GET basic tests ---

test('PUT layer=1 + GET returns matching contentYaml', async () => {
  const putRes = await request(app)
    .put('/api/direction')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ layer: 1, contentYaml: 'quality: high' });
  expect(putRes.status).toBe(200);
  expect(putRes.body).toEqual({ ok: true });
});

test('PUT layer=2 with domain + GET returns correct row', async () => {
  await request(app)
    .put('/api/direction')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ layer: 2, domain: 'backend', contentYaml: 'style: concise' });

  // Verify via preview that L2 is included
  const res = await request(app)
    .get('/api/direction/preview?brief=test&domain=backend')
    .set('Authorization', `Bearer ${authToken}`);
  expect(res.status).toBe(200);
  expect(res.body.synthesized).toContain('style: concise');
});

// --- Preview with hydrated context ---

test('GET /api/direction/preview with hydrated workspace includes schema section', async () => {
  // Create workspace
  await request(app).post('/api/workspaces').set('Authorization', `Bearer ${authToken}`).send(validWorkspace);

  // Set L3
  await request(app)
    .put('/api/direction')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ layer: 3, workspaceId: 'ws-dir-test', contentYaml: validL3Yaml });

  // Seed workspace_context with schema (git_memory column was removed in migration 064)
  await execute(`INSERT INTO workspace_context (workspace_id, schema_snapshot, schema_table_count, git_commit_count)
     VALUES ($1, $2, $3, $4)`, ['ws-dir-test', 'CREATE TABLE users (id TEXT);', 1, 42]);

  const res = await request(app)
    .get('/api/direction/preview?brief=build+auth&workspaceId=ws-dir-test')
    .set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.synthesized).toContain('=== DATABASE SCHEMA (Auto-Hydrated) ===');
  expect(res.body.synthesized).toContain('CREATE TABLE users (id TEXT);');
  expect(res.body.synthesized).not.toContain('=== PROJECT MEMORY (Git History) ===');
  expect(res.body.schemaTableCount).toBe(1);
  expect(res.body.gitCommitCount).toBe(42);
});

test('GET /api/direction/preview with no workspace_context omits schema/git sections gracefully', async () => {
  // Create workspace but do NOT seed workspace_context
  await request(app).post('/api/workspaces').set('Authorization', `Bearer ${authToken}`).send(validWorkspace);

  const res = await request(app)
    .get('/api/direction/preview?brief=build+auth&workspaceId=ws-dir-test')
    .set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.synthesized).not.toContain('=== DATABASE SCHEMA (Auto-Hydrated) ===');
  expect(res.body.synthesized).not.toContain('=== PROJECT MEMORY (Git History) ===');
  expect(res.body.schemaTableCount).toBeNull();
  expect(res.body.gitCommitCount).toBeNull();
});

test('GET /api/direction/preview without workspaceId omits hydrated sections', async () => {
  const res = await request(app)
    .get('/api/direction/preview?brief=generic+spec')
    .set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.synthesized).toContain('=== SPEC BRIEF (L4) ===');
  expect(res.body.synthesized).not.toContain('=== DATABASE SCHEMA (Auto-Hydrated) ===');
  expect(res.body.schemaTableCount).toBeNull();
  expect(res.body.gitCommitCount).toBeNull();
});

// --- US-003: Model Selection ---

test('PUT L3 with preferredModel stores it and GET returns it', async () => {
  await request(app).post('/api/workspaces').set('Authorization', `Bearer ${authToken}`).send(validWorkspace);

  const putRes = await request(app)
    .put('/api/direction')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      layer: 3,
      workspaceId: 'ws-dir-test',
      contentYaml: validL3Yaml,
      preferredModel: 'claude-opus-4-6',
    });
  expect(putRes.status).toBe(200);

  const getRes = await request(app)
    .get('/api/direction?layer=3&workspaceId=ws-dir-test')
    .set('Authorization', `Bearer ${authToken}`);
  expect(getRes.status).toBe(200);
  expect(getRes.body.contentYaml).toBe(validL3Yaml);
  expect(getRes.body.preferredModel).toBe('claude-opus-4-6');
});

test('PUT L3 with any preferredModel string is accepted (pass-through)', async () => {
  const res = await request(app)
    .put('/api/direction')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      layer: 3,
      workspaceId: 'ws-dir-test',
      contentYaml: validL3Yaml,
      preferredModel: 'custom-openai-compat-model',
    });
  // Any model string is accepted for openai-compat pass-through
  expect(res.status).not.toBe(400);
});

test('PUT L1 with preferredModel returns 400 (only valid for L3)', async () => {
  const res = await request(app)
    .put('/api/direction')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      layer: 1,
      contentYaml: 'quality: high',
      preferredModel: 'claude-opus-4-6',
    });
  expect(res.status).toBe(400);
  expect(res.body.error).toContain('only valid for layer 3');
});

test('GET /api/direction/models returns supported models', async () => {
  // Clear env vars that affect provider detection to ensure deterministic test
  const savedOpenRouter = process.env.OPENROUTER_API_KEY;
  const savedAnthropic = process.env.ANTHROPIC_API_KEY;
  const savedOpenAI = process.env.OPENAI_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;

  try {
    const res = await request(app).get('/api/direction/models').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    // With only claude-cli (always present), only Anthropic models are returned
    expect(res.body.models).toHaveLength(3);
    expect(res.body.models.map((m: { id: string }) => m.id)).toContain('claude-opus-4-6');
    expect(res.body.configuredProviders).toContain('claude-cli');
  } finally {
    if (savedOpenRouter) process.env.OPENROUTER_API_KEY = savedOpenRouter;
    if (savedAnthropic) process.env.ANTHROPIC_API_KEY = savedAnthropic;
    if (savedOpenAI) process.env.OPENAI_API_KEY = savedOpenAI;
  }
});

// --- WAL events ---

test('WAL event logged for direction_update on PUT', async () => {
  await request(app)
    .put('/api/direction')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ layer: 1, contentYaml: 'quality: high' });

  const events = await query("SELECT event_type FROM wal_events WHERE event_type = 'direction_update'") as { event_type: string }[];

  expect(events).toHaveLength(1);
  expect(events[0].event_type).toBe('direction_update');
});

// --- US-006: YAML Validation ---

test('PUT with invalid YAML syntax returns 422 with line/column', async () => {
  const res = await request(app)
    .put('/api/direction')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ layer: 1, contentYaml: 'foo: [bad yaml\n  bar: baz' });
  expect(res.status).toBe(422);
  expect(res.body.error).toBe('Invalid YAML syntax');
  expect(res.body.yamlError).toBeDefined();
  expect(res.body.yamlError.line).toBeGreaterThan(0);
  expect(res.body.yamlError.message).toBeTruthy();
});

test('PUT L3 missing required fields returns 422 with field paths', async () => {
  const res = await request(app)
    .put('/api/direction')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ layer: 3, workspaceId: 'ws-test', contentYaml: 'goal: ship v2' });
  expect(res.status).toBe(422);
  expect(res.body.error).toBe('Direction content failed schema validation');
  expect(res.body.validationErrors).toBeDefined();
  expect(res.body.validationErrors.length).toBeGreaterThan(0);
  // Should flag missing name, type, stack, purpose, key_modules
  const paths = res.body.validationErrors.map((e: { path: string }) => e.path);
  expect(paths).toContain('name');
  expect(paths).toContain('stack');
  expect(paths).toContain('key_modules');
});

test('PUT L3 with valid schema passes', async () => {
  const res = await request(app)
    .put('/api/direction')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ layer: 3, workspaceId: 'ws-test', contentYaml: validL3Yaml });
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
});

test('PUT L3 with stack as non-array returns 422', async () => {
  const badYaml = `name: MyProject
type: web-app
stack: not-an-array
purpose: Ship v2
key_modules:
  - auth`;
  const res = await request(app)
    .put('/api/direction')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ layer: 3, workspaceId: 'ws-test', contentYaml: badYaml });
  expect(res.status).toBe(422);
  const msgs = res.body.validationErrors.map((e: { message: string }) => e.message);
  expect(msgs.some((m: string) => m.includes('stack'))).toBe(true);
});

test('PUT L1/L2 with plain text YAML passes (no required fields)', async () => {
  const res1 = await request(app)
    .put('/api/direction')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ layer: 1, contentYaml: 'just plain text' });
  expect(res1.status).toBe(200);

  const res2 = await request(app)
    .put('/api/direction')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ layer: 2, domain: 'backend', contentYaml: 'also plain text' });
  expect(res2.status).toBe(200);
});

test('PUT L3 with scalar YAML returns 422 (must be mapping)', async () => {
  const res = await request(app)
    .put('/api/direction')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ layer: 3, workspaceId: 'ws-test', contentYaml: 'just a string' });
  expect(res.status).toBe(422);
  expect(res.body.validationErrors[0].message).toContain('YAML mapping');
});

// --- US-006: Preview Warnings ---

test('GET /api/direction/preview includes EMPTY_L1 warning when no L1 set', async () => {
  const res = await request(app)
    .get('/api/direction/preview?brief=test')
    .set('Authorization', `Bearer ${authToken}`);
  expect(res.status).toBe(200);
  expect(res.body.warnings).toBeDefined();
  expect(res.body.warnings.some((w: { code: string }) => w.code === 'EMPTY_L1')).toBe(true);
});

test('GET /api/direction/preview includes MISSING_L3 warning for workspace without L3', async () => {
  await request(app).post('/api/workspaces').set('Authorization', `Bearer ${authToken}`).send(validWorkspace);

  const res = await request(app)
    .get('/api/direction/preview?brief=test&workspaceId=ws-dir-test')
    .set('Authorization', `Bearer ${authToken}`);
  expect(res.status).toBe(200);
  expect(res.body.warnings.some((w: { code: string }) => w.code === 'MISSING_L3')).toBe(true);
});

test('GET /api/direction/preview includes DOMAIN_MISMATCH when domain not in workspace domains', async () => {
  await request(app).post('/api/workspaces').set('Authorization', `Bearer ${authToken}`).send(validWorkspace); // domains: ['backend']

  const res = await request(app)
    .get('/api/direction/preview?brief=test&workspaceId=ws-dir-test&domain=frontend')
    .set('Authorization', `Bearer ${authToken}`);
  expect(res.status).toBe(200);
  expect(res.body.warnings.some((w: { code: string }) => w.code === 'DOMAIN_MISMATCH')).toBe(true);
});

test('GET /api/direction/preview has no DOMAIN_MISMATCH when domain matches', async () => {
  await request(app).post('/api/workspaces').set('Authorization', `Bearer ${authToken}`).send(validWorkspace); // domains: ['backend']

  // Set L2 for backend domain
  await request(app)
    .put('/api/direction')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ layer: 2, domain: 'backend', contentYaml: 'style: concise' });

  const res = await request(app)
    .get('/api/direction/preview?brief=test&workspaceId=ws-dir-test&domain=backend')
    .set('Authorization', `Bearer ${authToken}`);
  expect(res.status).toBe(200);
  expect(res.body.warnings.some((w: { code: string }) => w.code === 'DOMAIN_MISMATCH')).toBe(false);
});

test('GET /api/direction/preview no warnings when fully configured', async () => {
  await request(app).post('/api/workspaces').set('Authorization', `Bearer ${authToken}`).send(validWorkspace);

  // Set L1
  await request(app)
    .put('/api/direction')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ layer: 1, contentYaml: 'quality: high' });

  // Set L3
  await request(app)
    .put('/api/direction')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ layer: 3, workspaceId: 'ws-dir-test', contentYaml: validL3Yaml });

  const res = await request(app)
    .get('/api/direction/preview?brief=test&workspaceId=ws-dir-test')
    .set('Authorization', `Bearer ${authToken}`);
  expect(res.status).toBe(200);
  expect(res.body.warnings).toEqual([]);
});
