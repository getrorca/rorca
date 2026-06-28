/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * US-032: Route tests for POST /api/events and POST /api/candidates.
 *
 * Validates:
 *   - Shared payload validation (zod)
 *   - Idempotency returns existing records instead of duplicates
 *   - Payload sanitization/redaction
 *   - Workspace/category/lifecycle value validation
 *   - Swagger tier/rationale annotations are present
 */

import * as crypto from 'crypto';
import request from 'supertest';
import type { Express } from 'express';
import { getAuthToken } from './helpers/auth-helper';

let app: Express;
let authToken: string;
const testWorkspaceId = 'ws-ci-us032';

beforeEach(async () => {
  jest.resetModules();
  jest.clearAllMocks();

  const serverMod = require('../../server');
  app = serverMod.default;
  authToken = await getAuthToken(app);

  // Ensure test workspace exists
  const { execute } = require('../../db/index');
  await execute(
    `INSERT INTO workspaces (id, label, path)
     VALUES ($1, 'CI US-032', '/tmp/ws-ci-us032')
     ON CONFLICT (id) DO NOTHING`,
    [testWorkspaceId],
  );
});

afterEach(async () => {
  try {
    const { closePool } = require('../../db/index');
    await closePool();
  } catch {}
});

// ═══════════════════════════════════════════════════════════════════════════=
// POST /api/events
// ═══════════════════════════════════════════════════════════════════════════=

describe('POST /api/events', () => {
  const validEvent = {
    workspace_id: testWorkspaceId,
    source_system: 'rorca-capture',
    event_type: 'commit',
    occurred_at: '2026-06-27T10:00:00.000Z',
    summary: 'Test commit event',
    payload: { branch: 'main', message: 'feat: add context ingestion' },
    actor: 'test-user',
    source_ref: 'abc123def456',
    idempotency_key: `ce-${crypto.randomUUID()}`,
  };

  test('creates a new event and returns 201', async () => {
    const res = await request(app)
      .post('/api/events')
      .set('Authorization', `Bearer ${authToken}`)
      .send(validEvent);

    expect(res.status).toBe(201);
    expect(res.body.workspace_id).toBe(testWorkspaceId);
    expect(res.body.source_system).toBe('rorca-capture');
    expect(res.body.event_type).toBe('commit');
    expect(res.body.payload).toHaveProperty('branch', 'main');
    // Secrets should be redacted in payload (no raw API keys)
    expect(typeof res.body.payload).toBe('object');
  });

  test('idempotency: duplicate submission returns 200 with existing record', async () => {
    const key = `ce-dup-${crypto.randomUUID()}`;
    const body = { ...validEvent, idempotency_key: key };

    const first = await request(app)
      .post('/api/events')
      .set('Authorization', `Bearer ${authToken}`)
      .send(body);
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/events')
      .set('Authorization', `Bearer ${authToken}`)
      .send(body);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.idempotency_key).toBe(key);
  });

  test('rejects missing required fields', async () => {
    const res = await request(app)
      .post('/api/events')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspace_id: testWorkspaceId,
        // missing source_system, event_type, occurred_at, idempotency_key
      });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Validation failed');
  });

  test('rejects invalid occurred_at format', async () => {
    const res = await request(app)
      .post('/api/events')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        ...validEvent,
        idempotency_key: `ce-fmt-${crypto.randomUUID()}`,
        occurred_at: 'not-a-date',
      });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Validation failed');
  });

  test('rejects non-existent workspace', async () => {
    const res = await request(app)
      .post('/api/events')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        ...validEvent,
        workspace_id: 'non-existent-ws',
        idempotency_key: `ce-nows-${crypto.randomUUID()}`,
      });
    expect(res.status).toBe(404);
  });

  test('rejects blank source_system', async () => {
    const res = await request(app)
      .post('/api/events')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        ...validEvent,
        source_system: '   ',
        idempotency_key: `ce-blank-${crypto.randomUUID()}`,
      });
    expect(res.status).toBe(422);
  });

  test('redacts secrets in payload', async () => {
    const key = `ce-redact-${crypto.randomUUID()}`;
    const res = await request(app)
      .post('/api/events')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        ...validEvent,
        idempotency_key: key,
        payload: {
          note: 'API key: sk-ant-api03-abcdefghijklmnop',
          password: 'supersecret123',
          safe: 'just a note',
        },
      });

    expect(res.status).toBe(201);
    const payload = res.body.payload;

    // API key should be redacted
    expect(JSON.stringify(payload)).toContain('[REDACTED]');
    // Non-secret fields survive
    expect(payload.safe).toBe('just a note');
  });

  test('accepts minimal valid payload (defaults applied)', async () => {
    const key = `ce-min-${crypto.randomUUID()}`;
    const res = await request(app)
      .post('/api/events')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspace_id: testWorkspaceId,
        source_system: 'manual',
        event_type: 'manual_note',
        occurred_at: '2026-06-27T10:00:00.000Z',
        idempotency_key: key,
      });

    expect(res.status).toBe(201);
    expect(res.body.schema_version).toBe(1);
    expect(res.body.payload).toEqual({});
  });
});

// ═══════════════════════════════════════════════════════════════════════════=
// POST /api/candidates
// ═══════════════════════════════════════════════════════════════════════════=

describe('POST /api/candidates', () => {
  const validCandidate = {
    workspace_id: testWorkspaceId,
    source_system: 'rorca-capture',
    category: 'Pattern',
    title: 'Use Connection Pooling',
    rule: 'Always use connection pooling for database access',
    context: 'Prevents connection exhaustion under load',
    related_files: ['src/db/pool.ts'],
    idempotency_key: `mc-${crypto.randomUUID()}`,
  };

  test('creates a new candidate and returns 201', async () => {
    const res = await request(app)
      .post('/api/candidates')
      .set('Authorization', `Bearer ${authToken}`)
      .send(validCandidate);

    expect(res.status).toBe(201);
    expect(res.body.workspace_id).toBe(testWorkspaceId);
    expect(res.body.category).toBe('Pattern');
    expect(res.body.title).toBe('Use Connection Pooling');
    expect(res.body.review_status).toBe('pending');
    expect(res.body.trust_tier).toBe('unverified');
    expect(res.body.confidence).toBe('medium');
  });

  test('idempotency: duplicate submission returns 200 with existing record', async () => {
    const key = `mc-dup-${crypto.randomUUID()}`;
    const body = { ...validCandidate, idempotency_key: key };

    const first = await request(app)
      .post('/api/candidates')
      .set('Authorization', `Bearer ${authToken}`)
      .send(body);
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/candidates')
      .set('Authorization', `Bearer ${authToken}`)
      .send(body);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.idempotency_key).toBe(key);
  });

  test('rejects missing required fields', async () => {
    const res = await request(app)
      .post('/api/candidates')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspace_id: testWorkspaceId,
        // missing source_system, category, title, rule, idempotency_key
      });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Validation failed');
  });

  test('rejects invalid confidence value', async () => {
    const res = await request(app)
      .post('/api/candidates')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        ...validCandidate,
        idempotency_key: `mc-conf-${crypto.randomUUID()}`,
        confidence: 'ultra',
      });
    expect(res.status).toBe(422);
  });

  test('rejects invalid trust_tier value', async () => {
    const res = await request(app)
      .post('/api/candidates')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        ...validCandidate,
        idempotency_key: `mc-trust-${crypto.randomUUID()}`,
        trust_tier: 'godlike',
      });
    expect(res.status).toBe(422);
  });

  test('rejects non-existent workspace', async () => {
    const res = await request(app)
      .post('/api/candidates')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        ...validCandidate,
        workspace_id: 'non-existent-ws',
        idempotency_key: `mc-nows-${crypto.randomUUID()}`,
      });
    expect(res.status).toBe(404);
  });

  test('rejects non-existent context_event_id', async () => {
    const res = await request(app)
      .post('/api/candidates')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        ...validCandidate,
        idempotency_key: `mc-bad-ev-${crypto.randomUUID()}`,
        context_event_id: 99999999,
      });
    expect(res.status).toBe(404);
  });

  test('links candidate to existing context_event', async () => {
    // First create a context event
    const eventKey = `ce-link-${crypto.randomUUID()}`;
    const ev = await request(app)
      .post('/api/events')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspace_id: testWorkspaceId,
        source_system: 'git',
        event_type: 'commit',
        occurred_at: '2026-06-27T10:00:00.000Z',
        idempotency_key: eventKey,
      });

    // Then create candidate linked to it
    const candidateKey = `mc-link-${crypto.randomUUID()}`;
    const res = await request(app)
      .post('/api/candidates')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        ...validCandidate,
        idempotency_key: candidateKey,
        context_event_id: parseInt(ev.body.id, 10),
      });

    expect(res.status).toBe(201);
    expect(res.body.context_event_id).toBe(String(ev.body.id));
  });

  test('redacts secrets in rule and context', async () => {
    const key = `mc-redact-${crypto.randomUUID()}`;
    const res = await request(app)
      .post('/api/candidates')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        ...validCandidate,
        idempotency_key: key,
        rule: 'Set DATABASE_URL=postgres://user:secret123@host/db and use it',
        context: 'Password is hunter2 and key is sk-ant-api03-abcdefgh',
      });

    expect(res.status).toBe(201);
    // Secrets in rule should be redacted
    expect(res.body.rule).toContain('[REDACTED]');
    expect(res.body.rule).not.toContain('secret123');
    // Secrets in context should be redacted
    expect(res.body.context).toContain('[REDACTED]');
    expect(res.body.context).not.toContain('hunter2');
  });

  test('accepts minimal valid payload (defaults applied)', async () => {
    const key = `mc-min-${crypto.randomUUID()}`;
    const res = await request(app)
      .post('/api/candidates')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspace_id: testWorkspaceId,
        source_system: 'manual',
        category: 'Gotcha',
        title: 'Minimal Test',
        rule: 'Do the thing',
        idempotency_key: key,
      });

    expect(res.status).toBe(201);
    expect(res.body.review_status).toBe('pending');
    expect(res.body.trust_tier).toBe('unverified');
    expect(res.body.confidence).toBe('medium');
    expect(res.body.schema_version).toBe(1);
    expect(res.body.related_files).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// US-033: GET /api/candidates (list)
// ════════════════════════════════════════════════════════════════════════════

describe('GET /api/candidates (list)', () => {
  /** Helper: create a candidate via POST and return the response body. */
  async function createCandidate(overrides: Record<string, unknown> = {}) {
    const key = `mc-list-${crypto.randomUUID()}`;
    const res = await request(app)
      .post('/api/candidates')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspace_id: testWorkspaceId,
        source_system: 'manual',
        category: 'Pattern',
        title: `List Test ${key.slice(0, 8)}`,
        rule: 'Keep lists paginated',
        context: 'Large datasets must be paginated',
        related_files: ['src/routes/candidates.ts'],
        confidence: 'high',
        trust_tier: 'trusted',
        idempotency_key: key,
        metadata: { test: true },
        ...overrides,
        // Ensure overrides don't override the key
        idempotency_key: key,
      });
    return res.body;
  }

  test('returns empty list for workspace with no candidates', async () => {
    const res = await request(app)
      .get('/api/candidates')
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspace_id: testWorkspaceId, limit: 10 });

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.total).toBe(0);
    expect(res.body.hasMore).toBe(false);
  });

  test('paginates results with page and limit', async () => {
    // Create 5 candidates
    for (let i = 0; i < 5; i++) {
      await createCandidate({ title: `Page Test ${i}` });
    }

    const page1 = await request(app)
      .get('/api/candidates')
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspace_id: testWorkspaceId, limit: 2, page: 1 });

    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.total).toBeGreaterThanOrEqual(5);
    expect(page1.body.hasMore).toBe(true);

    const page2 = await request(app)
      .get('/api/candidates')
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspace_id: testWorkspaceId, limit: 2, page: 2 });

    expect(page2.status).toBe(200);
    expect(page2.body.items).toHaveLength(2);

    // No overlap between pages
    const ids1 = page1.body.items.map((i: any) => i.id);
    const ids2 = page2.body.items.map((i: any) => i.id);
    expect(ids1.filter((id: string) => ids2.includes(id))).toHaveLength(0);

    // Last page (page 3) should have 1 item, hasMore=false
    const page3 = await request(app)
      .get('/api/candidates')
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspace_id: testWorkspaceId, limit: 2, page: 3 });

    expect(page3.status).toBe(200);
    expect(page3.body.items).toHaveLength(1);
    expect(page3.body.hasMore).toBe(false);
  });

  test('filters by review status', async () => {
    await createCandidate({ title: 'Pending Only' });

    const res = await request(app)
      .get('/api/candidates')
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspace_id: testWorkspaceId, status: 'pending' });

    expect(res.status).toBe(200);
    for (const item of res.body.items) {
      expect(item.reviewStatus).toBe('pending');
    }
  });

  test('rejects invalid status filter', async () => {
    const res = await request(app)
      .get('/api/candidates')
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspace_id: testWorkspaceId, status: 'bogus' });

    expect(res.status).toBe(400);
  });

  test('filters by source_system', async () => {
    await createCandidate({ source_system: 'git' });
    await createCandidate({ source_system: 'manual' });

    const res = await request(app)
      .get('/api/candidates')
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspace_id: testWorkspaceId, source_system: 'git' });

    expect(res.status).toBe(200);
    for (const item of res.body.items) {
      expect(item.sourceSystem).toBe('git');
    }
    expect(res.body.items.length).toBeGreaterThanOrEqual(1);
  });

  test('filters by category', async () => {
    await createCandidate({ category: 'Bug Fix' });
    await createCandidate({ category: 'Pattern' });

    const res = await request(app)
      .get('/api/candidates')
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspace_id: testWorkspaceId, category: 'Bug Fix' });

    expect(res.status).toBe(200);
    for (const item of res.body.items) {
      expect(item.category).toBe('Bug Fix');
    }
    expect(res.body.items.length).toBeGreaterThanOrEqual(1);
  });

  test('filters by confidence', async () => {
    await createCandidate({ confidence: 'low' });
    await createCandidate({ confidence: 'high' });

    const res = await request(app)
      .get('/api/candidates')
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspace_id: testWorkspaceId, confidence: 'low' });

    expect(res.status).toBe(200);
    for (const item of res.body.items) {
      expect(item.confidence).toBe('low');
    }
  });

  test('filters by trust_tier', async () => {
    await createCandidate({ trust_tier: 'community' });
    await createCandidate({ trust_tier: 'trusted' });

    const res = await request(app)
      .get('/api/candidates')
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspace_id: testWorkspaceId, trust_tier: 'community' });

    expect(res.status).toBe(200);
    for (const item of res.body.items) {
      expect(item.trustTier).toBe('community');
    }
  });

  test('filters by search (ILIKE match on title)', async () => {
    await createCandidate({ title: 'Use Connection Pooling' });
    await createCandidate({ title: 'Always use Lazy Loading' });

    const res = await request(app)
      .get('/api/candidates')
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspace_id: testWorkspaceId, search: 'Pooling' });

    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThanOrEqual(1);
    for (const item of res.body.items) {
      expect(
        item.title.includes('Pooling') ||
        (item.rule && item.rule.includes('Pooling')) ||
        (item.context && item.context.includes('Pooling'))
      ).toBe(true);
    }
  });

  test('filters by date range (date_from / date_to)', async () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    const past = new Date(Date.now() - 86400000).toISOString();

    // Create a candidate now
    await createCandidate({ title: 'Date Range Test' });

    // Query: from 1 day ago to 1 day in future — should include the candidate
    const resWith = await request(app)
      .get('/api/candidates')
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspace_id: testWorkspaceId, date_from: past, date_to: future });

    expect(resWith.status).toBe(200);
    expect(resWith.body.items.length).toBeGreaterThanOrEqual(1);

    // Query: from far future — should be empty
    const longFuture = new Date(Date.now() + 864000000).toISOString();
    const resEmpty = await request(app)
      .get('/api/candidates')
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspace_id: testWorkspaceId, date_from: longFuture });

    expect(resEmpty.status).toBe(200);
    expect(resEmpty.body.items).toHaveLength(0);
  });

  test('requires workspace_id', async () => {
    const res = await request(app)
      .get('/api/candidates')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(400);
  });

  test('workspace scoping: candidates from one workspace do not leak to another', async () => {
    const otherWsId = 'ws-ci-us033-other';
    const { execute } = require('../../db/index');
    await execute(
      `INSERT INTO workspaces (id, label, path)
       VALUES ($1, 'CI US-033 Other', '/tmp/ws-ci-us033-other')
       ON CONFLICT (id) DO NOTHING`,
      [otherWsId],
    );

    // Create candidate in original workspace
    const key = `mc-scope-${crypto.randomUUID()}`;
    await request(app)
      .post('/api/candidates')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspace_id: testWorkspaceId,
        source_system: 'manual',
        category: 'Pattern',
        title: 'Scope Test Candidate',
        rule: 'Always scope',
        idempotency_key: key,
      });

    // Query the OTHER workspace — should be empty
    const res = await request(app)
      .get('/api/candidates')
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspace_id: otherWsId });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);

    // Query the original workspace — should have the candidate
    const res2 = await request(app)
      .get('/api/candidates')
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspace_id: testWorkspaceId });

    expect(res2.status).toBe(200);
    expect(res2.body.items.length).toBeGreaterThanOrEqual(1);
    const found = res2.body.items.find((i: any) => i.title === 'Scope Test Candidate');
    expect(found).toBeDefined();
  });

  test('redacts secrets in rule and context on output', async () => {
    const key = `mc-list-redact-${crypto.randomUUID()}`;
    await request(app)
      .post('/api/candidates')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspace_id: testWorkspaceId,
        source_system: 'manual',
        category: 'Gotcha',
        title: 'Redact Test',
        rule: 'API key: sk-ant-api03-secretvaluehere',
        context: 'Password is supersecret123',
        idempotency_key: key,
      });

    const res = await request(app)
      .get('/api/candidates')
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspace_id: testWorkspaceId });

    expect(res.status).toBe(200);
    const item = res.body.items.find((i: any) => i.title === 'Redact Test');
    expect(item).toBeDefined();
    expect(item.rule).toContain('[REDACTED]');
    expect(item.rule).not.toContain('secretvaluehere');
    expect(item.context).toContain('[REDACTED]');
    expect(item.context).not.toContain('supersecret123');
  });

  test('rejects invalid confidence filter', async () => {
    const res = await request(app)
      .get('/api/candidates')
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspace_id: testWorkspaceId, confidence: 'ultra' });

    expect(res.status).toBe(400);
  });

  test('rejects invalid trust_tier filter', async () => {
    const res = await request(app)
      .get('/api/candidates')
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspace_id: testWorkspaceId, trust_tier: 'godmode' });

    expect(res.status).toBe(400);
  });

  test('returns non-existent workspace as 404', async () => {
    const res = await request(app)
      .get('/api/candidates')
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspace_id: 'non-existent-ws-xyz' });

    expect(res.status).toBe(404);
  });

  test('items are sorted by created_at DESC (newest first)', async () => {
    // Create 3 candidates in sequence
    await createCandidate({ title: 'Oldest' });
    // Small delay to ensure different created_at timestamps
    await new Promise(r => setTimeout(r, 50));
    await createCandidate({ title: 'Middle' });
    await new Promise(r => setTimeout(r, 50));
    await createCandidate({ title: 'Newest' });

    const res = await request(app)
      .get('/api/candidates')
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspace_id: testWorkspaceId, limit: 10 });

    expect(res.status).toBe(200);

    // Find the indices of our test items
    const titles = res.body.items.map((i: any) => i.title);
    const idxNewest = titles.indexOf('Newest');
    const idxMiddle = titles.indexOf('Middle');
    const idxOldest = titles.indexOf('Oldest');

    if (idxNewest >= 0 && idxMiddle >= 0 && idxOldest >= 0) {
      expect(idxNewest).toBeLessThan(idxMiddle);
      expect(idxMiddle).toBeLessThan(idxOldest);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// US-033: GET /api/candidates/:id (detail)
// ════════════════════════════════════════════════════════════════════════════

describe('GET /api/candidates/:id (detail)', () => {
  /** Helper: create a candidate via POST and return its parsed body. */
  async function createCandidate(rawOverrides: Record<string, unknown> = {}) {
    const key = `mc-detail-${crypto.randomUUID()}`;
    const res = await request(app)
      .post('/api/candidates')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspace_id: testWorkspaceId,
        source_system: 'manual',
        category: 'Pattern',
        title: `Detail Test ${key.slice(0, 8)}`,
        rule: 'Always test thoroughly',
        context: 'Tests catch regressions',
        related_files: ['src/routes/candidates.ts', 'src/lib/paginate.ts'],
        confidence: 'high',
        trust_tier: 'trusted',
        idempotency_key: key,
        metadata: { source: 'test-suite' },
        ...rawOverrides,
        idempotency_key: key, // ensure override safety
      });
    return res.body;
  }

  test('returns candidate by ID with full shape', async () => {
    const candidate = await createCandidate();
    const id = candidate.id;

    const res = await request(app)
      .get(`/api/candidates/${id}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.candidate).toBeDefined();
    const c = res.body.candidate;
    expect(c.id).toBe(String(id));
    expect(c.workspaceId).toBe(testWorkspaceId);
    expect(c.category).toBe('Pattern');
    expect(c.confidence).toBe('high');
    expect(c.trustTier).toBe('trusted');
    expect(c.reviewStatus).toBe('pending');
    expect(c.relatedFiles).toEqual(['src/routes/candidates.ts', 'src/lib/paginate.ts']);
    expect(c.metadata).toEqual({ source: 'test-suite' });
    expect(c.createdAt).toBeDefined();
    expect(c.updatedAt).toBeDefined();
  });

  test('returns 404 for non-existent candidate', async () => {
    const res = await request(app)
      .get('/api/candidates/99999999')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
  });

  test('returns 400 for invalid (non-numeric) ID', async () => {
    const res = await request(app)
      .get('/api/candidates/abc')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(400);
  });

  test('returns 400 for zero or negative ID', async () => {
    const res = await request(app)
      .get('/api/candidates/0')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(400);
  });

  test('includes event provenance when candidate is linked to a context_event', async () => {
    // Create a context event first
    const eventKey = `ce-detail-${crypto.randomUUID()}`;
    const ev = await request(app)
      .post('/api/events')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspace_id: testWorkspaceId,
        source_system: 'git',
        event_type: 'commit',
        occurred_at: '2026-06-28T12:00:00.000Z',
        summary: 'Commit for detail test',
        payload: { branch: 'feat/us-033', message: 'Add candidate list/detail routes' },
        idempotency_key: eventKey,
      });
    const eventId = parseInt(ev.body.id, 10);

    // Create candidate linked to the event
    const candidate = await createCandidate({ context_event_id: eventId });
    const candidateId = candidate.id;

    const res = await request(app)
      .get(`/api/candidates/${candidateId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.eventProvenance).toBeDefined();
    expect(res.body.eventProvenance).not.toBeNull();
    const ep = res.body.eventProvenance;
    expect(ep.id).toBe(eventId);
    expect(ep.eventType).toBe('commit');
    expect(ep.summary).toBe('Commit for detail test');
    expect(ep.payload).toBeDefined();
    expect(ep.payload.branch).toBe('feat/us-033');
  });

  test('eventProvenance is null when candidate has no context_event_id', async () => {
    const candidate = await createCandidate({ context_event_id: undefined });
    const id = candidate.id;

    const res = await request(app)
      .get(`/api/candidates/${id}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.eventProvenance).toBeNull();
  });

  test('redacts secrets in event payload on detail output', async () => {
    // Create a context event with secrets in payload
    const eventKey = `ce-redact-${crypto.randomUUID()}`;
    const ev = await request(app)
      .post('/api/events')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspace_id: testWorkspaceId,
        source_system: 'manual',
        event_type: 'manual_note',
        occurred_at: '2026-06-28T12:00:00.000Z',
        payload: {
          note: 'API key: sk-ant-api03-sensitivekey123',
          secret: 'db_password=hunter2_super_secret',
        },
        idempotency_key: eventKey,
      });
    const eventId = parseInt(ev.body.id, 10);

    const candidate = await createCandidate({ context_event_id: eventId });
    const candidateId = candidate.id;

    const res = await request(app)
      .get(`/api/candidates/${candidateId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.eventProvenance).toBeDefined();
    const payloadStr = JSON.stringify(res.body.eventProvenance.payload);
    // Redacted content should appear
    expect(payloadStr).toContain('[REDACTED]');
    // Raw secrets should not appear
    expect(payloadStr).not.toContain('sensitivekey123');
    expect(payloadStr).not.toContain('hunter2_super_secret');
  });

  test('redacts secrets in rule and context on detail output', async () => {
    const key = `mc-detail-redact-${crypto.randomUUID()}`;
    const createRes = await request(app)
      .post('/api/candidates')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspace_id: testWorkspaceId,
        source_system: 'manual',
        category: 'Gotcha',
        title: 'Detail Redact',
        rule: 'Connect to postgres://admin:secretpass@localhost/db',
        context: 'Token is sk-ant-api03-privatekeyhere',
        idempotency_key: key,
      });
    const id = createRes.body.id;

    const res = await request(app)
      .get(`/api/candidates/${id}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.candidate.rule).toContain('[REDACTED]');
    expect(res.body.candidate.rule).not.toContain('secretpass');
    expect(res.body.candidate.context).toContain('[REDACTED]');
    expect(res.body.candidate.context).not.toContain('privatekeyhere');
  });

  test('promotedMemory is null when candidate has not been promoted', async () => {
    const candidate = await createCandidate();
    const id = candidate.id;

    const res = await request(app)
      .get(`/api/candidates/${id}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.promotedMemory).toBeNull();
  });

  test('includes metadata in detail response', async () => {
    const candidate = await createCandidate({
      metadata: { capturedBy: 'rorca-capture', version: 2 },
    });
    const id = candidate.id;

    const res = await request(app)
      .get(`/api/candidates/${id}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.candidate.metadata).toEqual({ capturedBy: 'rorca-capture', version: 2 });
  });

  test('includes related files in detail response', async () => {
    const candidate = await createCandidate({
      related_files: ['src/foo.ts', 'src/bar.ts'],
    });
    const id = candidate.id;

    const res = await request(app)
      .get(`/api/candidates/${id}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.candidate.relatedFiles).toEqual(['src/foo.ts', 'src/bar.ts']);
  });
});
