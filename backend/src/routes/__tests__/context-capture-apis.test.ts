/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import '../../lib/async-handler';
import express from 'express';
import request from 'supertest';
import contextEventsRouter from '../context-events';
import contextCandidatesRouter from '../context-candidates';
import memoryCandidatesRouter from '../memory-candidates';
import { errorHandler } from '../../lib/error-handler';
import { query, queryOne } from '../../db/index';
import { promoteMemory } from '../../lib/memory-promotion';
import { buildMemoryCandidateIdempotencyKey } from '../../lib/context-capture';

jest.mock('../../db/index', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

jest.mock('../../lib/memory-promotion', () => ({
  promoteMemory: jest.fn(),
}));

jest.mock('../../lib/sse-hub', () => ({
  broadcastAll: jest.fn(),
}));

const mockQuery = query as jest.MockedFunction<typeof query>;
const mockQueryOne = queryOne as jest.MockedFunction<typeof queryOne>;
const mockPromoteMemory = promoteMemory as jest.MockedFunction<typeof promoteMemory>;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/context-events', contextEventsRouter);
  app.use('/api/context-candidates', contextCandidatesRouter);
  app.use('/api/memory/candidates', memoryCandidatesRouter);
  app.use(errorHandler);
  return app;
}

function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '101',
    workspaceId: 'ws-ccs-003',
    eventType: 'manual_cli_note',
    sourceSystem: 'pi-sidecar',
    sourceRef: 'session:1',
    actor: 'pi',
    occurredAt: '2026-07-04T12:00:00.000Z',
    summary: 'Captured useful context',
    payload: { text: 'Use the canonical route shape.' },
    provenance: { adapter: 'unit-test' },
    relatedFiles: ['backend/src/routes/context-events.ts'],
    metadata: { contentHash: 'hash' },
    trustTier: 'agent_observation',
    idempotencyKey: 'context-event:ws-ccs-003:pi-sidecar:hash',
    createdAt: '2026-07-04T12:00:00.000Z',
    updatedAt: '2026-07-04T12:00:00.000Z',
    ...overrides,
  };
}

function candidateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '201',
    workspaceId: 'ws-ccs-003',
    contextEventId: '101',
    eventType: 'manual_cli_note',
    sourceSystem: 'pi-sidecar',
    sourceRef: 'session:1',
    actor: 'pi',
    occurredAt: '2026-07-04T12:00:00.000Z',
    suggestedCategory: 'Decision',
    title: 'Use context capture routes',
    rule: 'Route context sidecar data through typed review APIs.',
    context: 'Keeps candidate review separate from durable retrieval.',
    relatedFiles: ['backend/src/routes/context-candidates.ts'],
    confidence: 'medium',
    trustTier: 'agent_observation',
    reviewStatus: 'pending',
    reviewer: null,
    reviewedAt: null,
    promotedMemoryId: null,
    promotedAt: null,
    idempotencyKey: 'memory-candidate:ws-ccs-003:event:101:hash',
    provenance: { sourceEventId: '101' },
    metadata: { contentHash: 'hash' },
    claim: null,
    policy: null,
    incidentLearning: null,
    securitySensitive: false,
    regulatedDomain: false,
    requiresReview: true,
    createdAt: '2026-07-04T12:01:00.000Z',
    updatedAt: '2026-07-04T12:01:00.000Z',
    ...overrides,
  };
}

let state: {
  workspace?: { id: string; path: string };
  existingEvent?: any;
  insertedEvent?: any;
  contextEvent?: any;
  existingCandidateByKey?: any;
  insertedCandidate?: any;
  candidateById?: any;
  nextCandidateById?: any;
  listItems: any[];
};

function findQueryOneCallContaining(fragment: string): { sql: string; params: unknown[] } {
  const call = mockQueryOne.mock.calls.find(([sql]) => String(sql).includes(fragment));
  if (!call) throw new Error(`Expected queryOne call containing ${fragment}`);
  return { sql: String(call[0]), params: (call[1] ?? []) as unknown[] };
}

beforeEach(() => {
  jest.clearAllMocks();
  state = {
    workspace: { id: 'ws-ccs-003', path: '/tmp/ws-ccs-003' },
    existingEvent: undefined,
    insertedEvent: eventRow(),
    contextEvent: eventRow(),
    existingCandidateByKey: undefined,
    insertedCandidate: candidateRow(),
    candidateById: candidateRow(),
    nextCandidateById: undefined,
    listItems: [candidateRow()],
  };

  mockQueryOne.mockImplementation(async (sqlArg: string, params?: unknown[]) => {
    const sql = String(sqlArg);

    if (sql.includes('UPDATE memory_candidates')) {
      if (state.nextCandidateById) state.candidateById = state.nextCandidateById;
      return { id: String(params?.[0] ?? '201') } as any;
    }
    if (sql.includes('INSERT INTO context_events')) return state.insertedEvent;
    if (sql.includes('INSERT INTO memory_candidates')) return state.insertedCandidate;
    if (sql.includes('INSERT INTO wal_events')) return { id: 999 } as any;
    if (sql.includes('SELECT COUNT')) return { total: state.listItems.length } as any;
    if (sql.includes('FROM workspaces')) return state.workspace as any;
    if (sql.includes('FROM memories')) return { id: Number(params?.[0] ?? 1) } as any;
    if (sql.includes('FROM context_events') && sql.includes('idempotency_key')) return state.existingEvent;
    if (sql.includes('FROM context_events') && sql.includes('WHERE id = $1')) return state.contextEvent;
    if (sql.includes('FROM memory_candidates') && sql.includes('WHERE idempotency_key')) return state.existingCandidateByKey;
    if (sql.includes('FROM memory_candidates') && sql.includes('WHERE id = $1')) return state.candidateById;

    return undefined as any;
  });

  mockQuery.mockImplementation(async () => state.listItems as any);
  mockPromoteMemory.mockResolvedValue({
    memoryId: '777',
    entry: {
      date: '2026-07-04',
      category: 'Decision',
      title: 'Use context capture routes',
      rule: 'Route context sidecar data through typed review APIs.',
      context: 'Keeps candidate review separate from durable retrieval.',
      source: 'context-candidate:201',
    },
    relatedFiles: ['backend/src/routes/context-candidates.ts'],
  });
});

describe('memory candidate idempotency keys', () => {
  it('deduplicates explicit source refs by source and omitted sources by content hash', () => {
    const base = {
      workspaceId: 'ws-ccs-003',
      sourceSystem: 'rorca-capture',
      title: 'Remember me',
      context: 'Manual capture',
      suggestedCategory: 'Decision',
      relatedFiles: [] as string[],
    };

    const sourceA = buildMemoryCandidateIdempotencyKey({ ...base, sourceRef: 'story:1', rule: 'first' });
    const sourceB = buildMemoryCandidateIdempotencyKey({ ...base, sourceRef: 'story:1', rule: 'second' });
    const contentA = buildMemoryCandidateIdempotencyKey({ ...base, sourceRef: null, rule: 'same' });
    const contentB = buildMemoryCandidateIdempotencyKey({ ...base, sourceRef: null, rule: 'same' });

    expect(sourceA.idempotencyKey).toBe(sourceB.idempotencyKey);
    expect(sourceA.idempotencyKey).toMatch(/^memory-candidate:ws-ccs-003:source:/);
    expect(contentA.idempotencyKey).toBe(contentB.idempotencyKey);
    expect(contentA.idempotencyKey).toMatch(/^memory-candidate:ws-ccs-003:content:/);
  });
});

describe('POST /api/context-events', () => {
  it('validates payloads through AppError responses', async () => {
    const res = await request(buildApp())
      .post('/api/context-events')
      .send({ workspaceId: 'ws-ccs-003' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.error).toMatch(/Invalid context event payload/);
  });

  it('returns the existing event for an idempotent sidecar retry', async () => {
    state.existingEvent = eventRow({ id: 'existing-event' });

    const res = await request(buildApp())
      .post('/api/context-events')
      .send({
        workspaceId: 'ws-ccs-003',
        eventType: 'manual_cli_note',
        sourceSystem: 'pi-sidecar',
        sourceRef: 'session:1',
        summary: 'Captured useful context',
        payload: { text: 'Use the canonical route shape.' },
        relatedFiles: ['backend/src/routes/context-events.ts'],
      });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);
    expect(res.body.idempotent).toBe(true);
    expect(res.body.event.id).toBe('existing-event');
  });

  it('redacts representative secrets before inserting a context event', async () => {
    const res = await request(buildApp())
      .post('/api/context-events')
      .send({
        workspaceId: 'ws-ccs-003',
        eventType: 'manual_cli_note',
        sourceSystem: 'pi-sidecar',
        sourceRef: 'session:secret',
        summary: 'Authorization: Bearer abc.def.rawsecret',
        payload: {
          openai: 'sk-1234567890abcdefghijklmnop',
          database: 'postgres://user:pass@localhost:5432/app',
          pem: '-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----',
        },
        relatedFiles: ['backend/src/routes/context-events.ts'],
      });

    expect(res.status).toBe(201);
    const insert = findQueryOneCallContaining('INSERT INTO context_events');
    const serialized = JSON.stringify(insert.params);
    expect(serialized).toContain('Bearer [REDACTED]');
    expect(serialized).toContain('sk-[REDACTED]');
    expect(serialized).toContain('[REDACTED_DATABASE_URL]');
    expect(serialized).toContain('[REDACTED_PRIVATE_KEY]');
    expect(serialized).not.toContain('rawsecret');
    expect(serialized).not.toContain('sk-1234567890abcdefghijklmnop');
    expect(serialized).not.toContain('user:pass');
    expect(serialized).not.toContain('BEGIN PRIVATE KEY');
  });
});

describe('context candidate creation/list/detail', () => {
  it('creates a pending candidate linked to a context event', async () => {
    const res = await request(buildApp())
      .post('/api/context-candidates')
      .send({
        workspaceId: 'ws-ccs-003',
        contextEventId: '101',
        suggestedCategory: 'Decision',
        title: 'Use context capture routes',
        rule: 'Route context sidecar data through typed review APIs.',
        context: 'Keeps candidate review separate from durable retrieval.',
        relatedFiles: ['backend/src/routes/context-candidates.ts'],
      });

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.candidate.reviewStatus).toBe('pending');
    expect(res.body.candidate.contextEventId).toBe('101');
  });

  it('redacts candidate secrets and forces regulated-domain candidates to require review before insert', async () => {
    const res = await request(buildApp())
      .post('/api/context-candidates')
      .send({
        workspaceId: 'ws-ccs-003',
        suggestedCategory: 'Gotcha',
        title: 'HIPAA patient records need review',
        rule: 'Never persist postgres://user:pass@localhost:5432/app in captured memory.',
        context: 'Authorization: Bearer raw-regulated-token for patient data.',
        confidence: 'medium',
        regulatedDomain: false,
        requiresReview: false,
      });

    expect(res.status).toBe(201);
    const insert = findQueryOneCallContaining('INSERT INTO memory_candidates');
    const serialized = JSON.stringify(insert.params);
    expect(serialized).toContain('[REDACTED_DATABASE_URL]');
    expect(serialized).toContain('Bearer [REDACTED]');
    expect(serialized).not.toContain('user:pass');
    expect(serialized).not.toContain('raw-regulated-token');
    expect(insert.params[20]).toBe(true); // security_sensitive
    expect(insert.params[21]).toBe(true); // regulated_domain
    expect(insert.params[22]).toBe(true); // requires_review forced true
  });

  it('returns the existing candidate for an idempotent sidecar retry', async () => {
    state.existingCandidateByKey = candidateRow({ id: 'already-there', idempotencyKey: 'candidate:dupe' });

    const res = await request(buildApp())
      .post('/api/context-candidates')
      .send({
        workspaceId: 'ws-ccs-003',
        suggestedCategory: 'Decision',
        title: 'Duplicate',
        rule: 'Do not insert duplicate candidates.',
        idempotencyKey: 'candidate:dupe',
      });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);
    expect(res.body.idempotent).toBe(true);
    expect(res.body.candidate.id).toBe('already-there');
  });

  it('supports the /api/memory/candidates alias for manual sidecar submissions', async () => {
    const res = await request(buildApp())
      .post('/api/memory/candidates')
      .send({
        workspaceId: 'ws-ccs-003',
        sourceSystem: 'rorca-capture',
        sourceRef: 'manual:1',
        suggestedCategory: 'Pattern',
        title: 'Capture manual sidecar memory',
        rule: 'Manual memory capture should use pending candidates.',
      });

    expect(res.status).toBe(201);
    expect(res.body.candidate.reviewStatus).toBe('pending');
  });

  it('lists pending candidates by default through the pagination helper query shape', async () => {
    const res = await request(buildApp())
      .get('/api/context-candidates')
      .query({ workspaceId: 'ws-ccs-003', limit: 10 });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].reviewStatus).toBe('pending');
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('review_status = ANY'), expect.any(Array));
  });

  it('applies default retrieval safety gates in SQL and supports explicit unsafe opt-in', async () => {
    let res = await request(buildApp())
      .get('/api/context-candidates/retrieval')
      .query({ workspaceId: 'ws-ccs-003', limit: 10 });

    expect(res.status).toBe(200);
    let retrievalQuery = mockQuery.mock.calls[mockQuery.mock.calls.length - 1]?.[0] as string;
    expect(retrievalQuery).toContain("review_status NOT IN ('pending', 'rejected')");
    expect(retrievalQuery).toContain("CASE confidence WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END");
    expect(retrievalQuery).toContain("(regulated_domain = false OR review_status = 'approved')");

    mockQuery.mockClear();
    res = await request(buildApp())
      .get('/api/context-candidates/retrieval')
      .query({ workspaceId: 'ws-ccs-003', includeUnsafe: 'true', limit: 10 });

    expect(res.status).toBe(200);
    retrievalQuery = mockQuery.mock.calls[mockQuery.mock.calls.length - 1]?.[0] as string;
    expect(retrievalQuery).not.toContain("review_status NOT IN ('pending', 'rejected')");
    expect(retrievalQuery).not.toContain('regulated_domain = false');
  });

  it('returns NotFoundError for missing candidate detail', async () => {
    state.candidateById = undefined;

    const res = await request(buildApp())
      .get('/api/context-candidates/999')
      .query({ workspaceId: 'ws-ccs-003' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});

describe('context candidate review lifecycle', () => {
  it('approves a candidate, promotes durable memory with provenance, and stores promotion links', async () => {
    state.nextCandidateById = candidateRow({ reviewStatus: 'approved', reviewer: 'alice', promotedMemoryId: 777 });

    const res = await request(buildApp())
      .post('/api/context-candidates/201/approve')
      .send({ reviewer: 'alice' });

    expect(res.status).toBe(200);
    expect(res.body.approved).toBe(true);
    expect(res.body.candidate.promotedMemoryId).toBe(777);
    expect(mockPromoteMemory).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-ccs-003',
      sourceType: 'auto-extracted',
      relatedFiles: ['backend/src/routes/context-candidates.ts'],
      provenance: expect.objectContaining({
        contextCapture: expect.objectContaining({
          candidateId: '201',
          contextEventId: '101',
          reviewer: 'alice',
          relatedFiles: ['backend/src/routes/context-candidates.ts'],
        }),
      }),
    }));
  });

  it('blocks regulated-domain approval unless explicit review confirmation is provided', async () => {
    state.candidateById = candidateRow({ regulatedDomain: true, requiresReview: true });

    const res = await request(buildApp())
      .post('/api/context-candidates/201/approve')
      .send({ reviewer: 'auto-operator' });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('regulatedReviewConfirmed');
    expect(mockPromoteMemory).not.toHaveBeenCalled();
  });

  it('rejects a candidate with an audited reason and does not promote memory', async () => {
    state.nextCandidateById = candidateRow({ reviewStatus: 'rejected', reviewer: 'alice' });

    const res = await request(buildApp())
      .post('/api/context-candidates/201/reject')
      .send({ reviewer: 'alice', reason: 'Too speculative' });

    expect(res.status).toBe(200);
    expect(res.body.rejected).toBe(true);
    expect(res.body.candidate.reviewStatus).toBe('rejected');
    expect(mockPromoteMemory).not.toHaveBeenCalled();
  });

  it('supports duplicate, supersede, conflict, and defer lifecycle actions', async () => {
    state.nextCandidateById = candidateRow({ reviewStatus: 'duplicate' });
    let res = await request(buildApp())
      .post('/api/context-candidates/201/duplicate')
      .send({ duplicateOfCandidateId: '202', reason: 'Same learning' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('duplicate');

    state.candidateById = candidateRow();
    state.nextCandidateById = candidateRow({ reviewStatus: 'superseded' });
    res = await request(buildApp())
      .post('/api/context-candidates/201/supersede')
      .send({ supersededByMemoryId: '777', reason: 'Promoted memory is newer' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('superseded');

    state.candidateById = candidateRow();
    state.nextCandidateById = candidateRow({ reviewStatus: 'conflict' });
    res = await request(buildApp())
      .post('/api/context-candidates/201/conflict')
      .send({ conflictingMemoryId: '777', reason: 'Contradicts existing policy' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('conflict');

    state.candidateById = candidateRow();
    state.nextCandidateById = candidateRow({ reviewStatus: 'deferred' });
    res = await request(buildApp())
      .post('/api/context-candidates/201/defer')
      .send({ reason: 'Needs human review', deferUntil: '2026-07-05T00:00:00.000Z' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('deferred');
  });
});
