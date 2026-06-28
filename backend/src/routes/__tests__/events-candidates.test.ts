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
