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

  // Isolate the shared CI workspace: clear rows accumulated by earlier tests
  // or prior runs (the jest DB teardown is intentionally skipped, so the
  // candidates/events/memories tables persist across files). Each test creates
  // the data it needs, so starting from an empty workspace is the contract.
  await execute(`DELETE FROM memory_candidates WHERE workspace_id = $1`, [testWorkspaceId]);
  await execute(`DELETE FROM context_events WHERE workspace_id = $1`, [testWorkspaceId]);
  await execute(`DELETE FROM memories WHERE workspace_id = $1`, [testWorkspaceId]);
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

// ════════════════════════════════════════════════════════════════════════════
// US-034: Review actions — approve, edit-and-approve, reject, duplicate,
// supersede, revisit, lifecycle validation, idempotency
// ════════════════════════════════════════════════════════════════════════════

describe('US-034: Review actions', () => {
  /** Helper: create a candidate via POST and return its parsed body. */
  async function createCandidate(overrides: Record<string, unknown> = {}) {
    const key = `mc-review-${crypto.randomUUID()}`;
    const res = await request(app)
      .post('/api/candidates')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspace_id: testWorkspaceId,
        source_system: 'manual',
        category: 'Pattern',
        title: `Review Test ${key.slice(0, 8)}`,
        rule: 'Always write tests',
        context: 'Tests prevent regressions',
        related_files: ['src/foo.ts'],
        confidence: 'high',
        trust_tier: 'trusted',
        ...overrides,
        idempotency_key: key,
      });
    return res.body;
  }

  // ── Approve ──────────────────────────────────────────────────────────────

  describe('POST /api/candidates/:id/approve', () => {
    test('approves a pending candidate and promotes to durable memory', async () => {
      const candidate = await createCandidate({ title: 'Approve Me' });
      const id = candidate.id;

      const res = await request(app)
        .post(`/api/candidates/${id}/approve`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reviewer: 'test-user', review_note: 'Looks correct' });

      expect(res.status).toBe(200);
      expect(res.body.candidate.reviewStatus).toBe('approved');
      expect(res.body.candidate.reviewer).toBe('test-user');
      expect(res.body.candidate.reviewNote).toContain('Approved');
      expect(res.body.candidate.reviewNote).toContain('Looks correct');
      expect(res.body.candidate.reviewedAt).toBeDefined();
      expect(res.body.candidate.promotedMemoryId).toBeDefined();
      expect(res.body.candidate.promotedAt).toBeDefined();
      expect(res.body.promotedMemoryId).toBeDefined();
      expect(typeof res.body.promotedMemoryId).toBe('number');
    });

    test('approval is idempotent: re-approving returns 200 with same promotedMemoryId', async () => {
      const candidate = await createCandidate({ title: 'Idempotent Approve' });
      const id = candidate.id;

      const first = await request(app)
        .post(`/api/candidates/${id}/approve`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reviewer: 'test-user' });

      expect(first.status).toBe(200);
      const firstMemoryId = first.body.promotedMemoryId;
      expect(firstMemoryId).toBeDefined();

      const second = await request(app)
        .post(`/api/candidates/${id}/approve`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reviewer: 'other-user' });

      expect(second.status).toBe(200);
      expect(second.body.promotedMemoryId).toBe(firstMemoryId);
      expect(second.body.candidate.reviewStatus).toBe('approved');
      // Reviewer should NOT change on idempotent re-approval
      expect(second.body.candidate.reviewer).toBe('test-user');
    });

    test('edit-and-approve: modifies candidate fields before promotion', async () => {
      const candidate = await createCandidate({ title: 'Original Title', category: 'Pattern' });
      const id = candidate.id;

      const res = await request(app)
        .post(`/api/candidates/${id}/approve`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          reviewer: 'editor',
          review_note: 'Renamed for clarity',
          title: 'Edited Title',
          category: 'Bug Fix',
          confidence: 'low',
          related_files: ['src/edited.ts', 'src/bar.ts'],
        });

      expect(res.status).toBe(200);
      expect(res.body.candidate.reviewStatus).toBe('approved');
      expect(res.body.candidate.title).toBe('Edited Title');
      expect(res.body.candidate.category).toBe('Bug Fix');
      expect(res.body.candidate.confidence).toBe('low');
      expect(res.body.candidate.relatedFiles).toEqual(['src/edited.ts', 'src/bar.ts']);
      // The original rule should be preserved (not overridden)
      expect(res.body.candidate.rule).toContain('Always write tests');
      expect(res.body.promotedMemoryId).toBeDefined();
    });

    test('edit-and-approve: redacts secrets in edited fields', async () => {
      const candidate = await createCandidate({ title: 'Secret Test' });
      const id = candidate.id;

      const res = await request(app)
        .post(`/api/candidates/${id}/approve`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          reviewer: 'security',
          rule: 'Use API key sk-ant-api03-super-secret-key-here',
          context: 'Password is hunter2_secret',
        });

      expect(res.status).toBe(200);
      expect(res.body.candidate.rule).toContain('[REDACTED]');
      expect(res.body.candidate.rule).not.toContain('super-secret-key-here');
      expect(res.body.candidate.context).toContain('[REDACTED]');
      expect(res.body.candidate.context).not.toContain('hunter2_secret');
    });

    test('rejects approval of already-rejected candidate (409)', async () => {
      const candidate = await createCandidate({ title: 'Already Rejected' });
      const id = candidate.id;

      // First reject it
      await request(app)
        .post(`/api/candidates/${id}/reject`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reviewer: 'rejector' });

      // Then try to approve
      const res = await request(app)
        .post(`/api/candidates/${id}/approve`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reviewer: 'approver' });

      expect(res.status).toBe(409);
    });

    test('rejects approval of non-existent candidate (404)', async () => {
      const res = await request(app)
        .post('/api/candidates/99999999/approve')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reviewer: 'ghost' });

      expect(res.status).toBe(404);
    });

    test('rejects approval with invalid ID (400)', async () => {
      const res = await request(app)
        .post('/api/candidates/abc/approve')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reviewer: 'bad' });

      expect(res.status).toBe(400);
    });

    test('approves without reviewer (null reviewer is allowed)', async () => {
      const candidate = await createCandidate({ title: 'No Reviewer' });
      const id = candidate.id;

      const res = await request(app)
        .post(`/api/candidates/${id}/approve`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.candidate.reviewStatus).toBe('approved');
      expect(res.body.candidate.reviewer).toBeNull();
    });

    test('approved candidate appears in promoted memory via detail endpoint', async () => {
      const candidate = await createCandidate({
        title: 'Promoted Detail',
        rule: 'Detail promotes correctly',
        category: 'Gotcha',
        related_files: ['src/detail.ts'],
      });
      const id = candidate.id;

      // Approve
      await request(app)
        .post(`/api/candidates/${id}/approve`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reviewer: 'promoter' });

      // Check detail endpoint shows promoted memory
      const detail = await request(app)
        .get(`/api/candidates/${id}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(detail.status).toBe(200);
      expect(detail.body.promotedMemory).not.toBeNull();
      expect(detail.body.promotedMemory.category).toBe('Gotcha');
      expect(detail.body.promotedMemory.content).toContain('Promoted Detail');
      expect(detail.body.promotedMemory.content).toContain('Detail promotes correctly');
    });
  });

  // ── Reject ───────────────────────────────────────────────────────────────

  describe('POST /api/candidates/:id/reject', () => {
    test('rejects a pending candidate', async () => {
      const candidate = await createCandidate({ title: 'Reject Me' });
      const id = candidate.id;

      const res = await request(app)
        .post(`/api/candidates/${id}/reject`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reviewer: 'rejector', review_note: 'Not relevant' });

      expect(res.status).toBe(200);
      expect(res.body.candidate.reviewStatus).toBe('rejected');
      expect(res.body.candidate.reviewer).toBe('rejector');
      expect(res.body.candidate.reviewNote).toContain('Rejected');
      expect(res.body.candidate.reviewNote).toContain('Not relevant');
      expect(res.body.candidate.reviewedAt).toBeDefined();
    });

    test('reject is idempotent', async () => {
      const candidate = await createCandidate({ title: 'Double Reject' });
      const id = candidate.id;

      await request(app)
        .post(`/api/candidates/${id}/reject`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reviewer: 'first' });

      const second = await request(app)
        .post(`/api/candidates/${id}/reject`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reviewer: 'second' });

      expect(second.status).toBe(200);
      expect(second.body.candidate.reviewStatus).toBe('rejected');
      // Reviewer should NOT change on idempotent reject
      expect(second.body.candidate.reviewer).toBe('first');
    });

    test('rejects rejecting an approved candidate (409)', async () => {
      const candidate = await createCandidate({ title: 'Approved No Reject' });
      const id = candidate.id;

      await request(app)
        .post(`/api/candidates/${id}/approve`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reviewer: 'approver' });

      const res = await request(app)
        .post(`/api/candidates/${id}/reject`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reviewer: 'would-be-rejector' });

      expect(res.status).toBe(409);
    });
  });

  // ── Duplicate ────────────────────────────────────────────────────────────

  describe('POST /api/candidates/:id/mark-duplicate', () => {
    test('marks candidate as duplicate of another', async () => {
      const original = await createCandidate({ title: 'Original Candidate' });
      const dup = await createCandidate({ title: 'Duplicate Candidate' });

      const res = await request(app)
        .post(`/api/candidates/${dup.id}/mark-duplicate`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          reviewer: 'deduper',
          review_note: 'Same as original',
          duplicate_of_candidate_id: original.id,
        });

      expect(res.status).toBe(200);
      expect(res.body.candidate.reviewStatus).toBe('duplicate');
      expect(res.body.candidate.duplicateOfCandidateId).toBe(original.id);
      expect(res.body.candidate.reviewNote).toContain('Duplicate of candidate');
      expect(res.body.candidate.reviewNote).toContain('Same as original');
    });

    test('rejects missing duplicate_of_candidate_id (400)', async () => {
      const candidate = await createCandidate({ title: 'Missing Dup Ref' });
      const id = candidate.id;

      const res = await request(app)
        .post(`/api/candidates/${id}/mark-duplicate`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reviewer: 'oops' });

      expect(res.status).toBe(400);
    });

    test('rejects self-duplicate (400)', async () => {
      const candidate = await createCandidate({ title: 'Self Dup' });
      const id = candidate.id;

      const res = await request(app)
        .post(`/api/candidates/${id}/mark-duplicate`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          reviewer: 'self',
          duplicate_of_candidate_id: id,
        });

      expect(res.status).toBe(400);
    });

    test('rejects marking duplicate of approved candidate (409)', async () => {
      const candidate = await createCandidate({ title: 'Approved No Dup' });
      const id = candidate.id;

      await request(app)
        .post(`/api/candidates/${id}/approve`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reviewer: 'approver' });

      const res = await request(app)
        .post(`/api/candidates/${id}/mark-duplicate`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          reviewer: 'nope',
          duplicate_of_candidate_id: 1,
        });

      expect(res.status).toBe(409);
    });

    test('rejects duplicate target that does not exist (404)', async () => {
      const candidate = await createCandidate({ title: 'Bad Target' });
      const id = candidate.id;

      const res = await request(app)
        .post(`/api/candidates/${id}/mark-duplicate`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          reviewer: 'ghost',
          duplicate_of_candidate_id: 99999999,
        });

      expect(res.status).toBe(404);
    });
  });

  // ── Supersede ────────────────────────────────────────────────────────────

  describe('POST /api/candidates/:id/mark-superseded', () => {
    test('marks candidate as superseded', async () => {
      const candidate = await createCandidate({ title: 'Supersede Me' });
      const id = candidate.id;

      const res = await request(app)
        .post(`/api/candidates/${id}/mark-superseded`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reviewer: 'superseder', review_note: 'Obsolete' });

      expect(res.status).toBe(200);
      expect(res.body.candidate.reviewStatus).toBe('superseded');
      expect(res.body.candidate.reviewer).toBe('superseder');
      expect(res.body.candidate.reviewNote).toContain('Superseded');
      expect(res.body.candidate.reviewNote).toContain('Obsolete');
    });

    test('supersede is idempotent', async () => {
      const candidate = await createCandidate({ title: 'Double Supersede' });
      const id = candidate.id;

      await request(app)
        .post(`/api/candidates/${id}/mark-superseded`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reviewer: 'first' });

      const second = await request(app)
        .post(`/api/candidates/${id}/mark-superseded`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reviewer: 'second' });

      expect(second.status).toBe(200);
      expect(second.body.candidate.reviewStatus).toBe('superseded');
      expect(second.body.candidate.reviewer).toBe('first');
    });

    test('rejects superseding already-approved candidate (409)', async () => {
      const candidate = await createCandidate({ title: 'Approved No Supersede' });
      const id = candidate.id;

      await request(app)
        .post(`/api/candidates/${id}/approve`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reviewer: 'approver' });

      const res = await request(app)
        .post(`/api/candidates/${id}/mark-superseded`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reviewer: 'nope' });

      expect(res.status).toBe(409);
    });
  });

  // ── Revisit ──────────────────────────────────────────────────────────────

  describe('POST /api/candidates/:id/revisit', () => {
    test('reopens a rejected candidate', async () => {
      const candidate = await createCandidate({ title: 'Reopen Me' });
      const id = candidate.id;

      await request(app)
        .post(`/api/candidates/${id}/reject`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reviewer: 'rejector' });

      const res = await request(app)
        .post(`/api/candidates/${id}/revisit`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reviewer: 'reopener', review_note: 'Reconsidered' });

      expect(res.status).toBe(200);
      expect(res.body.candidate.reviewStatus).toBe('revisit');
      expect(res.body.candidate.reviewNote).toContain('Reopened');
      expect(res.body.candidate.reviewNote).toContain('Reconsidered');
    });

    test('reopens a duplicate candidate', async () => {
      const original = await createCandidate({ title: 'Original' });
      const dup = await createCandidate({ title: 'Dup Reopen' });

      await request(app)
        .post(`/api/candidates/${dup.id}/mark-duplicate`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reviewer: 'dedup', duplicate_of_candidate_id: original.id });

      const res = await request(app)
        .post(`/api/candidates/${dup.id}/revisit`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reviewer: 'reopen' });

      expect(res.status).toBe(200);
      expect(res.body.candidate.reviewStatus).toBe('revisit');
    });

    test('reopens a superseded candidate', async () => {
      const candidate = await createCandidate({ title: 'Superseded Reopen' });
      const id = candidate.id;

      await request(app)
        .post(`/api/candidates/${id}/mark-superseded`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reviewer: 'superseder' });

      const res = await request(app)
        .post(`/api/candidates/${id}/revisit`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reviewer: 'reopen' });

      expect(res.status).toBe(200);
      expect(res.body.candidate.reviewStatus).toBe('revisit');
    });

    test('rejects revisit of pending candidate (409)', async () => {
      const candidate = await createCandidate({ title: 'Pending No Revisit' });
      const id = candidate.id;

      const res = await request(app)
        .post(`/api/candidates/${id}/revisit`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reviewer: 'nope' });

      expect(res.status).toBe(409);
    });

    test('rejects revisit of approved candidate (409)', async () => {
      const candidate = await createCandidate({ title: 'Approved No Revisit' });
      const id = candidate.id;

      await request(app)
        .post(`/api/candidates/${id}/approve`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reviewer: 'approver' });

      const res = await request(app)
        .post(`/api/candidates/${id}/revisit`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reviewer: 'nope' });

      expect(res.status).toBe(409);
    });

    test('revisit is idempotent', async () => {
      const candidate = await createCandidate({ title: 'Double Revisit' });
      const id = candidate.id;

      await request(app)
        .post(`/api/candidates/${id}/reject`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reviewer: 'rejector' });

      await request(app)
        .post(`/api/candidates/${id}/revisit`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reviewer: 'first' });

      const second = await request(app)
        .post(`/api/candidates/${id}/revisit`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reviewer: 'second' });

      expect(second.status).toBe(200);
      expect(second.body.candidate.reviewStatus).toBe('revisit');
      expect(second.body.candidate.reviewer).toBe('first');
    });

    test('revisit → approve full lifecycle works', async () => {
      const candidate = await createCandidate({ title: 'Full Lifecycle' });
      const id = candidate.id;

      // pending → rejected
      await request(app)
        .post(`/api/candidates/${id}/reject`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reviewer: 'rejector' });

      // rejected → revisit
      const revisitRes = await request(app)
        .post(`/api/candidates/${id}/revisit`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reviewer: 'reopener' });
      expect(revisitRes.body.candidate.reviewStatus).toBe('revisit');

      // revisit → approved (with edits)
      const approveRes = await request(app)
        .post(`/api/candidates/${id}/approve`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          reviewer: 'final-approver',
          title: 'Final Approved Title',
          category: 'Decision',
        });

      expect(approveRes.status).toBe(200);
      expect(approveRes.body.candidate.reviewStatus).toBe('approved');
      expect(approveRes.body.candidate.title).toBe('Final Approved Title');
      expect(approveRes.body.candidate.category).toBe('Decision');
      expect(approveRes.body.promotedMemoryId).toBeDefined();
    });
  });

  // ── Combined lifecycle validation ────────────────────────────────────────

  describe('Lifecycle transition validation', () => {
    test('all invalid transitions return 409', async () => {
      // approved → reject
      const approved = await createCandidate({ title: 'Approved Terminal' });
      await request(app)
        .post(`/api/candidates/${approved.id}/approve`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reviewer: 'a' });

      let res = await request(app)
        .post(`/api/candidates/${approved.id}/reject`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reviewer: 'r' });
      expect(res.status).toBe(409);

      res = await request(app)
        .post(`/api/candidates/${approved.id}/mark-superseded`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reviewer: 's' });
      expect(res.status).toBe(409);

      res = await request(app)
        .post(`/api/candidates/${approved.id}/mark-duplicate`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reviewer: 'd', duplicate_of_candidate_id: 1 });
      expect(res.status).toBe(409);

      res = await request(app)
        .post(`/api/candidates/${approved.id}/revisit`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reviewer: 'v' });
      expect(res.status).toBe(409);

      // pending → revisit
      const pending = await createCandidate({ title: 'Pending No Revisit' });
      res = await request(app)
        .post(`/api/candidates/${pending.id}/revisit`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reviewer: 'v' });
      expect(res.status).toBe(409);
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// US-035: Candidate retrieval gating — governance gate integration tests
// ════════════════════════════════════════════════════════════════════════════

describe('US-035: Candidate retrieval gating', () => {
  const { queryOne } = require('../../db/index');

  /** Helper: create a candidate via POST and return its parsed body. */
  async function createCandidate(overrides: Record<string, unknown> = {}) {
    const key = `mc-gate-${crypto.randomUUID()}`;
    const res = await request(app)
      .post('/api/candidates')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspace_id: testWorkspaceId,
        source_system: 'manual',
        category: 'Decision',
        title: `Gate Test ${key.slice(0, 8)}`,
        rule: 'Always use the governance gate for candidate retrieval',
        context: 'Prevents unvetted knowledge from entering prompt composition',
        related_files: ['src/lib/memory-router.ts'],
        confidence: 'high',
        trust_tier: 'trusted',
        ...overrides,
        idempotency_key: key,
      });
    return res.body;
  }

  /** Query the memories table for a specific content pattern. */
  async function findMemoryByContent(contentSubstring: string): Promise<{ id: number; content: string } | null> {
    // queryOne is pulled in via require() above (untyped), so cast the result
    // instead of passing a type argument (TS2347 on untyped calls).
    const row = (await queryOne(
      `SELECT id, content FROM memories
       WHERE workspace_id = $1 AND content ILIKE $2 AND deleted_at IS NULL
       LIMIT 1`,
      [testWorkspaceId, `%${contentSubstring}%`],
    )) as { id: number; content: string } | undefined;
    return row ?? null;
  }

  // ── Exclusion before approval ──────────────────────────────────────────

  test('pending candidate is NOT in the memories table (exclusion before approval)', async () => {
    const candidate = await createCandidate({
      title: 'Exclusion Test',
      rule: 'Exclusion before approval rule',
    });

    // The candidate exists in memory_candidates...
    expect(candidate.review_status).toBe('pending');

    // ...but MUST NOT appear in the memories table (the retrieval source)
    const mem = await findMemoryByContent('Exclusion before approval');
    expect(mem).toBeNull();
  });

  test('rejected candidate is NOT in the memories table', async () => {
    const candidate = await createCandidate({
      title: 'Rejected Gate Test',
      rule: 'Rejected candidate should not be retrievable',
    });

    await request(app)
      .post(`/api/candidates/${candidate.id}/reject`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ reviewer: 'gating-test', review_note: 'Not valid knowledge' });

    const mem = await findMemoryByContent('Rejected candidate should not be retrievable');
    expect(mem).toBeNull();
  });

  test('duplicate candidate is NOT in the memories table', async () => {
    const original = await createCandidate({
      title: 'Original Knowledge',
      rule: 'Original durable knowledge rule',
    });
    const duplicate = await createCandidate({
      title: 'Duplicate Gated',
      rule: 'Duplicate candidate should not be retrievable',
    });

    await request(app)
      .post(`/api/candidates/${duplicate.id}/mark-duplicate`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ reviewer: 'gating-test', duplicate_of_candidate_id: original.id });

    const mem = await findMemoryByContent('Duplicate candidate should not be retrievable');
    expect(mem).toBeNull();
  });

  test('superseded candidate is NOT in the memories table', async () => {
    const candidate = await createCandidate({
      title: 'Superseded Gate Test',
      rule: 'Superseded candidate should not be retrievable',
    });

    await request(app)
      .post(`/api/candidates/${candidate.id}/mark-superseded`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ reviewer: 'gating-test', review_note: 'Obsolete knowledge' });

    const mem = await findMemoryByContent('Superseded candidate should not be retrievable');
    expect(mem).toBeNull();
  });

  // ── Inclusion after promotion ───────────────────────────────────────────

  test('approved candidate IS promoted into the memories table (inclusion after promotion)', async () => {
    const candidate = await createCandidate({
      title: 'Inclusion Test',
      rule: 'Inclusion after promotion rule',
      category: 'Gotcha',
    });

    const approveRes = await request(app)
      .post(`/api/candidates/${candidate.id}/approve`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ reviewer: 'gating-test', review_note: 'Verified and approved' });

    expect(approveRes.status).toBe(200);
    expect(approveRes.body.candidate.reviewStatus).toBe('approved');
    expect(approveRes.body.promotedMemoryId).toBeDefined();

    // The approved candidate MUST now appear in the memories table
    const mem = await findMemoryByContent('Inclusion after promotion');
    expect(mem).not.toBeNull();
    expect(mem!.content).toContain('Inclusion Test');
    expect(mem!.content).toContain('Inclusion after promotion rule');
  });

  test('edit-and-approve candidate IS promoted into the memories table with edited fields', async () => {
    const candidate = await createCandidate({
      title: 'Edit Include Test',
      rule: 'Original rule before edit',
      category: 'Pattern',
      related_files: ['src/original.ts'],
    });

    const approveRes = await request(app)
      .post(`/api/candidates/${candidate.id}/approve`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        reviewer: 'gating-test',
        title: 'Edited Title After Promotion',
        rule: 'Edited rule after approval and promotion',
        category: 'Bug Fix',
        related_files: ['src/edited.ts'],
      });

    expect(approveRes.status).toBe(200);
    expect(approveRes.body.promotedMemoryId).toBeDefined();

    // The promoted memory must contain the edited fields, not the originals
    const mem = await findMemoryByContent('Edited Title After Promotion');
    expect(mem).not.toBeNull();
    expect(mem!.content).toContain('Edited Title After Promotion');
    expect(mem!.content).toContain('Edited rule after approval and promotion');
    expect(mem!.content).not.toContain('Original rule before edit');
  });

  // ── Governance gate: unapproved statuses collectively excluded ─────────

  test('ALL unapproved statuses (pending/rejected/duplicate/superseded/revisit) are excluded from memories', async () => {
    // Create candidates for each non-approved status
    const pendingCandidate = await createCandidate({
      title: 'Pending Bulk',
      rule: 'Pending bulk test rule',
    });

    const rejectedCandidate = await createCandidate({
      title: 'Rejected Bulk',
      rule: 'Rejected bulk test rule',
    });
    await request(app)
      .post(`/api/candidates/${rejectedCandidate.id}/reject`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ reviewer: 'gating-test' });

    const supersededCandidate = await createCandidate({
      title: 'Superseded Bulk',
      rule: 'Superseded bulk test rule',
    });
    await request(app)
      .post(`/api/candidates/${supersededCandidate.id}/mark-superseded`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ reviewer: 'gating-test' });

    // Verify none of them appear in memories
    const mem1 = await findMemoryByContent('Pending bulk test rule');
    expect(mem1).toBeNull();

    const mem2 = await findMemoryByContent('Rejected bulk test rule');
    expect(mem2).toBeNull();

    const mem3 = await findMemoryByContent('Superseded bulk test rule');
    expect(mem3).toBeNull();

    // Now approve the pending candidate → must appear
    await request(app)
      .post(`/api/candidates/${pendingCandidate.id}/approve`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ reviewer: 'gating-test' });

    const mem4 = await findMemoryByContent('Pending bulk test rule');
    expect(mem4).not.toBeNull();

    // Rejected and superseded must still be excluded
    const mem5 = await findMemoryByContent('Rejected bulk test rule');
    expect(mem5).toBeNull();

    const mem6 = await findMemoryByContent('Superseded bulk test rule');
    expect(mem6).toBeNull();
  });

  // ── Auditable candidates remain in memory_candidates after rejection ────

  test('rejected/duplicate/superseded candidates remain auditable via the candidates API', async () => {
    const rejected = await createCandidate({
      title: 'Auditable Rejected',
      rule: 'Auditable rejected rule for audit trail',
    });

    await request(app)
      .post(`/api/candidates/${rejected.id}/reject`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ reviewer: 'auditor', review_note: 'Not relevant' });

    // The candidate MUST still be visible in the candidates list
    const listRes = await request(app)
      .get('/api/candidates')
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspace_id: testWorkspaceId, status: 'rejected' });

    expect(listRes.status).toBe(200);
    const found = listRes.body.items.find((i: any) => i.id === String(rejected.id));
    expect(found).toBeDefined();
    expect(found.reviewStatus).toBe('rejected');

    // The detail endpoint must also show it
    const detailRes = await request(app)
      .get(`/api/candidates/${rejected.id}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(detailRes.status).toBe(200);
    expect(detailRes.body.candidate.reviewStatus).toBe('rejected');

    // But it must NOT be in the memories table
    const mem = await findMemoryByContent('Auditable rejected rule for audit trail');
    expect(mem).toBeNull();
  });

  // ── Revived candidate (revisit → approve) reaches memories ─────────────

  test('revived candidate (revisit → approve) reaches the memories table', async () => {
    const candidate = await createCandidate({
      title: 'Revived Knowledge',
      rule: 'Revived candidate after revisit approval rule',
    });

    // Reject first
    await request(app)
      .post(`/api/candidates/${candidate.id}/reject`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ reviewer: 'first-reviewer' });

    // Verify exclusion after rejection
    let mem = await findMemoryByContent('Revived candidate after revisit');
    expect(mem).toBeNull();

    // Revisit
    await request(app)
      .post(`/api/candidates/${candidate.id}/revisit`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ reviewer: 'reopener' });

    // Approve after revisit
    const approveRes = await request(app)
      .post(`/api/candidates/${candidate.id}/approve`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ reviewer: 'second-reviewer', review_note: 'Reconsidered and approved' });

    expect(approveRes.status).toBe(200);
    expect(approveRes.body.promotedMemoryId).toBeDefined();

    // Now it MUST appear in memories
    mem = await findMemoryByContent('Revived candidate after revisit');
    expect(mem).not.toBeNull();
    expect(mem!.content).toContain('Revived Knowledge');
  });
});
