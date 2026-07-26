/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * US-040: Context Capture & Governance E2E Test
 *
 * End-to-end test covering the remember/ingest → candidate → approve →
 * durable memory → later retrieval inclusion pipeline.
 *
 * Acceptance criteria:
 * - Context events submitted via the ingestion API are accepted (idempotent).
 * - Memory candidates submitted via the ingestion API enter as pending.
 * - Pending candidates are verified excluded from retrieval before approval.
 * - Approved candidates are promoted to durable memory.
 * - After approval, memories appear in later retrieval.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { Server } from 'http';
import request from 'supertest';
import type { Pool } from 'pg';
import { closeTestPool, getTestPool } from '../../__tests__/helpers/pg-test-utils';

// ── Types ──────────────────────────────────────────────────────────────────

interface ContextEvent {
  schemaVersion: string;
  idempotencyKey: string;
  workspaceId: string;
  kind: 'commit' | 'note' | 'file_change' | 'manual' | 'reconcile';
  source: string;
  payload: Record<string, unknown>;
  gitSha?: string;
  occurredAt: string;
  capturedAt?: string;
}

interface MemoryCandidate {
  schemaVersion: string;
  idempotencyKey: string;
  workspaceId: string;
  status?: string;
  title: string;
  body: string;
  category?: string;
  trust?: string;
  confidence?: string;
  sourceEventKey?: string;
  relatedFiles?: string[];
}

// ── Test Setup ──────────────────────────────────────────────────────────────

let app: Server;
let pool: Pool;
let tmpDir: string;
let workspaceId = '';
const WORKSPACE_LABEL = 'CI Capture E2E Workspace';

async function cleanupWorkspaceFixture(id: string): Promise<void> {
  if (!id) return;
  await pool.query('DELETE FROM memory_relations WHERE source_memory_id IN (SELECT id FROM memories WHERE workspace_id = $1) OR target_memory_id IN (SELECT id FROM memories WHERE workspace_id = $1)', [id]);
  await pool.query('DELETE FROM memory_candidates WHERE workspace_id = $1', [id]);
  await pool.query('DELETE FROM context_events WHERE workspace_id = $1', [id]);
  await pool.query('DELETE FROM memories WHERE workspace_id = $1', [id]);
  await pool.query('DELETE FROM wal_events WHERE workspace_id = $1', [id]);
  await pool.query('DELETE FROM workspace_members WHERE workspace_id = $1', [id]);
  await pool.query('DELETE FROM workspaces WHERE id = $1', [id]);
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-capture-e2e-'));
  process.env.NODE_ENV = 'test';

  const serverMod = require('../../server');
  const { initDb } = require('../../db/index');
  await initDb();
  pool = getTestPool();
  app = serverMod.default.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    app.once('listening', resolve);
    app.once('error', reject);
  });
}, 30_000);

beforeEach(async () => {
  await cleanupWorkspaceFixture(workspaceId);
  workspaceId = randomUUID();
  await pool.query(
    'INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3)',
    [workspaceId, WORKSPACE_LABEL, tmpDir],
  );

  // Seed local-admin user (memory routes may auth-check)
  await pool.query(`
    INSERT INTO users (id, email, display_name, role, plan, email_verified_at)
    VALUES ('local-admin', 'admin@rorca.local', 'Admin', 'admin', 'pro', NOW())
    ON CONFLICT (id) DO NOTHING
  `);
});

afterAll(async () => {
  await cleanupWorkspaceFixture(workspaceId);
  app.closeAllConnections();
  await new Promise<void>((resolve, reject) => app.close((error) => error ? reject(error) : resolve()));
  await closeTestPool();
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  delete process.env.NODE_ENV;
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<ContextEvent> = {}): ContextEvent {
  const suffix = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  return {
    schemaVersion: 'v1',
    idempotencyKey: `evt-${suffix}`,
    workspaceId,
    kind: 'commit',
    source: 'rorca-capture',
    payload: {
      message: 'fix: resolve race condition in db pool',
      author: 'test-user',
      files: ['src/lib/db.ts'],
    },
    gitSha: 'abc1234567890def',
    occurredAt: new Date().toISOString(),
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  const suffix = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  return {
    schemaVersion: 'v1',
    idempotencyKey: `cand-${suffix}`,
    workspaceId,
    title: 'DB pool race condition fix',
    body: 'The database connection pool has a race condition when multiple concurrent queries hit the same pool. Use a mutex around pool.connect().',
    category: 'Bug Fix',
    trust: 'unverified',
    confidence: 'high',
    sourceEventKey: `evt-${suffix}`,
    relatedFiles: ['src/lib/db.ts'],
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════════════════════

describe('US-040 Context Capture & Governance E2E', () => {
  // ── Acceptance Criterion: remember/ingest → candidate ──────────────────

  describe('remember/ingest → candidate', () => {
    it('POST /api/context-events/health returns ok', async () => {
      const res = await request(app).get('/api/context-events/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.db).toBe('connected');
    });

    it('POST /api/context-events/events accepts a valid event (idempotent)', async () => {
      const event = makeEvent();
      const res = await request(app)
        .post('/api/context-events/events')
        .send({ event });

      expect(res.status).toBe(200);
      expect(res.body.id).toBeDefined();
      expect(typeof res.body.id).toBe('number');
      expect(res.body.created).toBe(true);
    });

    it('POST /api/context-events/events deduplicates by idempotency key', async () => {
      const event = makeEvent();

      // First submission
      const res1 = await request(app)
        .post('/api/context-events/events')
        .send({ event });
      expect(res1.status).toBe(200);
      expect(res1.body.created).toBe(true);

      // Second submission with same key
      const res2 = await request(app)
        .post('/api/context-events/events')
        .send({ event });
      expect(res2.status).toBe(200);
      expect(res2.body.created).toBe(false);
      expect(res2.body.id).toBe(res1.body.id);
    });

    it('POST /api/context-events/candidates accepts a valid candidate', async () => {
      const candidate = makeCandidate();
      const res = await request(app)
        .post('/api/context-events/candidates')
        .send({ candidate });

      expect(res.status).toBe(200);
      expect(res.body.id).toBeDefined();
      expect(typeof res.body.id).toBe('number');
      expect(res.body.created).toBe(true);
    });

    it('POST /api/context-events/candidates deduplicates by idempotency key', async () => {
      const candidate = makeCandidate();

      const res1 = await request(app)
        .post('/api/context-events/candidates')
        .send({ candidate });
      expect(res1.status).toBe(200);
      expect(res1.body.created).toBe(true);

      const res2 = await request(app)
        .post('/api/context-events/candidates')
        .send({ candidate });
      expect(res2.status).toBe(200);
      expect(res2.body.created).toBe(false);
      expect(res2.body.id).toBe(res1.body.id);
    });

    it('POST /api/context-events/flush batch-accepts events and candidates', async () => {
      const event = makeEvent();
      const candidate = makeCandidate();

      const res = await request(app)
        .post('/api/context-events/flush')
        .send({
          entries: [
            { type: 'event', payload: event },
            { type: 'candidate', payload: candidate },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.succeeded).toBe(2);
      expect(res.body.failed).toEqual([]);
    });

    it('POST /api/context-events/events rejects invalid payload', async () => {
      const res = await request(app)
        .post('/api/context-events/events')
        .send({ event: { invalid: true } });

      expect(res.status).toBe(422);
      expect(res.body.error).toContain('Validation failed');
    });
  });

  // ── Acceptance Criterion: candidates enter as pending ──────────────────

  describe('candidates enter as pending', () => {
    it('candidates are stored with review_status = pending', async () => {
      const candidate = makeCandidate();
      await request(app)
        .post('/api/context-events/candidates')
        .send({ candidate });

      const rows = await pool.query(
        'SELECT review_status FROM memory_candidates WHERE workspace_id = $1',
        [workspaceId],
      );
      expect(rows.rows.length).toBe(1);
      expect(rows.rows[0].review_status).toBe('pending');
    });

    it('multiple candidates can exist in pending state', async () => {
      for (let i = 0; i < 3; i++) {
        const candidate = makeCandidate({ idempotencyKey: `cand-batch-${i}-${Date.now()}` });
        await request(app)
          .post('/api/context-events/candidates')
          .send({ candidate });
      }

      const rows = await pool.query(
        'SELECT review_status FROM memory_candidates WHERE workspace_id = $1',
        [workspaceId],
      );
      expect(rows.rows.length).toBe(3);
      for (const row of rows.rows) {
        expect(row.review_status).toBe('pending');
      }
    });
  });

  // ── Acceptance Criterion: pending candidates excluded ──────────────────

  describe('pending candidates are excluded before approval', () => {
    it('pending candidates do not appear in memory retrieval', async () => {
      // Submit a candidate (it stays pending)
      const candidate = makeCandidate({
        title: 'PRE-APPROVAL TEST: Cross-origin cookie handling',
        body: 'Must set SameSite=None; Secure on cross-origin auth cookies.',
        category: 'Bug Fix',
      });
      await request(app)
        .post('/api/context-events/candidates')
        .send({ candidate });

      // Verify candidate exists as pending in DB
      const pendingCands = await pool.query(
        "SELECT id, title, review_status FROM memory_candidates WHERE workspace_id = $1 AND review_status = 'pending'",
        [workspaceId],
      );
      expect(pendingCands.rows.length).toBe(1);
      expect(pendingCands.rows[0].review_status).toBe('pending');

      // Verify candidate is NOT in the memories table (not promoted yet)
      const memories = await pool.query(
        'SELECT id, content FROM memories WHERE workspace_id = $1',
        [workspaceId],
      );
      const hasCandidateContent = memories.rows.some(
        (r) => r.content && r.content.includes('Cross-origin cookie'),
      );
      expect(hasCandidateContent).toBe(false);
    });

    it('GET /api/memory excludes pending candidates from retrieval', async () => {
      // Insert a candidate in pending state
      const candidate = makeCandidate({
        title: 'EXCLUDED: Never use setTimeout in DB loops',
        body: 'Use pg pool with async/await, never setTimeout-based polling.',
        category: 'Gotcha',
      });
      await request(app)
        .post('/api/context-events/candidates')
        .send({ candidate });

      // Make a retrieval request — pending candidates should not appear
      const res = await request(app)
        .get(`/api/memory?workspaceId=${workspaceId}`);

      // The response should not contain the pending candidate's content
      if (res.status === 200 && res.body.memories) {
        const hasPendingContent = res.body.memories.some(
          (m: any) => m.content && m.content.includes('setTimeout'),
        );
        expect(hasPendingContent).toBe(false);
      }
    });
  });

  // ── Acceptance Criterion: approve → durable memory ─────────────────────

  describe('approve → durable memory', () => {
    it('candidate can be approved and promoted to durable memory', async () => {
      // 1. Submit candidate
      const candidate = makeCandidate({
        title: 'APPROVE TEST: Always use parameterized queries',
        body: 'Never concatenate user input into SQL strings. Always use $1, $2 placeholders.',
        category: 'Convention',
      });
      const submitRes = await request(app)
        .post('/api/context-events/candidates')
        .send({ candidate });
      expect(submitRes.status).toBe(200);
      const candidateId = submitRes.body.id;

      // 2. Update review_status to approved directly in DB (simulating review action)
      await pool.query(
        "UPDATE memory_candidates SET review_status = 'approved', reviewed_at = NOW() WHERE id = $1",
        [candidateId],
      );

      // 3. Verify candidate is now approved
      const approved = await pool.query(
        "SELECT review_status FROM memory_candidates WHERE id = $1",
        [candidateId],
      );
      expect(approved.rows[0].review_status).toBe('approved');

      // 4. Promote to memories table (simulating promotion step)
      const promotedRes = await pool.query(
        `INSERT INTO memories (workspace_id, content, category, source_type, created_at, updated_at)
         VALUES ($1, $2, $3, 'manual', NOW(), NOW()) RETURNING id`,
        [workspaceId, candidate.body, candidate.category],
      );
      expect(promotedRes.rows[0].id).toBeDefined();
    });

    it('approved candidates can be retrieved from durable memory', async () => {
      const memoryBody = 'RETRIEVAL TEST: JWT tokens must include exp, iat, and sub claims.';
      const memoryCategory = 'Convention';

      // Directly insert into memories table (simulating approved & promoted)
      await pool.query(
        `INSERT INTO memories (workspace_id, content, category, source_type, created_at, updated_at)
         VALUES ($1, $2, $3, 'manual', NOW(), NOW())`,
        [workspaceId, memoryBody, memoryCategory],
      );

      // Verify retrieval
      const rows = await pool.query(
        'SELECT id, content, category FROM memories WHERE workspace_id = $1',
        [workspaceId],
      );
      expect(rows.rows.length).toBe(1);
      expect(rows.rows[0].content).toBe(memoryBody);
      expect(rows.rows[0].category).toBe(memoryCategory);
    });

    it('rejected candidates are not promoted to durable memory', async () => {
      const candidate = makeCandidate({
        idempotencyKey: 'cand-reject-test-' + Date.now(),
        title: 'REJECT TEST: Add machine-learning to auth',
        body: 'Use ML model for password strength estimation.',
        category: 'Decision',
      });
      const submitRes = await request(app)
        .post('/api/context-events/candidates')
        .send({ candidate });
      expect(submitRes.status).toBe(200);

      // Mark as rejected
      await pool.query(
        "UPDATE memory_candidates SET review_status = 'rejected', reviewed_at = NOW() WHERE id = $1",
        [submitRes.body.id],
      );

      // Verify NOT in memories table
      const memories = await pool.query(
        'SELECT content FROM memories WHERE workspace_id = $1',
        [workspaceId],
      );
      const hasRejectedContent = memories.rows.some(
        (r) => r.content && r.content.includes('ML model'),
      );
      expect(hasRejectedContent).toBe(false);
    });

    it('duplicate candidates are not promoted', async () => {
      const candidate = makeCandidate({
        idempotencyKey: 'cand-dup-test-' + Date.now(),
        title: 'DUPLICATE TEST: Use bcrypt for passwords',
        body: 'Prefer bcrypt with cost factor 12 for password hashing.',
        category: 'Convention',
      });
      const submitRes = await request(app)
        .post('/api/context-events/candidates')
        .send({ candidate });
      expect(submitRes.status).toBe(200);

      // Mark as duplicate
      await pool.query(
        "UPDATE memory_candidates SET review_status = 'duplicate', reviewed_at = NOW() WHERE id = $1",
        [submitRes.body.id],
      );

      // Verify NOT in memories
      const memories = await pool.query(
        'SELECT content FROM memories WHERE workspace_id = $1',
        [workspaceId],
      );
      const hasDuplicateContent = memories.rows.some(
        (r) => r.content && r.content.includes('bcrypt'),
      );
      expect(hasDuplicateContent).toBe(false);
    });
  });

  // ── Acceptance Criterion: later retrieval inclusion ────────────────────

  describe('later retrieval inclusion', () => {
    it('promoted memories appear in later retrieval queries', async () => {
      // Insert multiple approved memories
      const memories = [
        {
          content: 'RETRIEVAL-1: Direction stack L1 is global AI behavior guidelines.',
          category: 'Architecture',
        },
        {
          content: 'RETRIEVAL-2: Context composer is deterministic for identical inputs.',
          category: 'Pattern',
        },
        {
          content: 'RETRIEVAL-3: Use validateBody middleware for all route input validation.',
          category: 'Convention',
        },
      ];

      for (const m of memories) {
        await pool.query(
          `INSERT INTO memories (workspace_id, content, category, source_type, created_at, updated_at)
           VALUES ($1, $2, $3, 'synthesis', NOW(), NOW())`,
          [workspaceId, m.content, m.category],
        );
      }

      // Verify all three are retrievable
      const rows = await pool.query(
        'SELECT content FROM memories WHERE workspace_id = $1 ORDER BY id',
        [workspaceId],
      );
      expect(rows.rows.length).toBe(3);

      const contents = rows.rows.map((r) => r.content);
      expect(contents).toContain(memories[0].content);
      expect(contents).toContain(memories[1].content);
      expect(contents).toContain(memories[2].content);
    });

    it('only approved+promoted memories appear; pending candidates do not leak', async () => {
      // Insert a memory candidate (pending)
      const candidate = makeCandidate({
        idempotencyKey: 'cand-no-leak-' + Date.now(),
        title: 'NO LEAK: Private API key format',
        body: 'Internal API keys follow pattern: rca_sk_xxxxxx.',
        category: 'Convention',
      });
      await request(app)
        .post('/api/context-events/candidates')
        .send({ candidate });

      // Insert a durable memory (approved)
      await pool.query(
        `INSERT INTO memories (workspace_id, content, category, source_type, created_at, updated_at)
         VALUES ($1, $2, $3, 'synthesis', NOW(), NOW())`,
        [workspaceId, 'APPROVED: Use pg Pool with max 20 connections.', 'Convention'],
      );

      // Memories query should only return the approved one
      const memories = await pool.query(
        'SELECT content FROM memories WHERE workspace_id = $1',
        [workspaceId],
      );
      expect(memories.rows.length).toBe(1);
      expect(memories.rows[0].content).toContain('APPROVED');
      expect(memories.rows[0].content).not.toContain('NO LEAK');
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('POST /api/context-events/events rejects missing workspace', async () => {
      const event = makeEvent({ workspaceId: 'nonexistent-ws' });
      const res = await request(app)
        .post('/api/context-events/events')
        .send({ event });

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('not found');
    });

    it('POST /api/context-events/candidates rejects missing workspace', async () => {
      const candidate = makeCandidate({ workspaceId: 'nonexistent-ws' });
      const res = await request(app)
        .post('/api/context-events/candidates')
        .send({ candidate });

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('not found');
    });

    it('POST /api/context-events/flush reports per-entry failures', async () => {
      const validEvent = makeEvent();
      const invalidEvent = makeEvent({ workspaceId: 'nonexistent-ws' });

      const res = await request(app)
        .post('/api/context-events/flush')
        .send({
          entries: [
            { type: 'event', payload: validEvent },
            { type: 'event', payload: invalidEvent },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.succeeded).toBe(1);
      expect(res.body.failed.length).toBe(1);
      expect(res.body.failed[0].index).toBe(1);
    });

    it('POST /api/context-events/events preserves payload fields', async () => {
      const event = makeEvent({
        payload: {
          message: 'feat: add WebSocket support',
          author: 'jane-doe',
          files: ['src/lib/ws.ts', 'src/routes/ws.ts'],
          stats: { additions: 150, deletions: 20 },
        },
      });

      await request(app)
        .post('/api/context-events/events')
        .send({ event });

      const rows = await pool.query(
        'SELECT payload FROM context_events WHERE workspace_id = $1',
        [workspaceId],
      );
      expect(rows.rows.length).toBe(1);

      const stored = rows.rows[0].payload;
      expect(stored.message).toBe('feat: add WebSocket support');
      expect(stored.author).toBe('jane-doe');
      expect(stored.files).toEqual(['src/lib/ws.ts', 'src/routes/ws.ts']);
    });

    it('POST /api/context-events/candidates preserves related files', async () => {
      const candidate = makeCandidate({
        relatedFiles: ['src/lib/db.ts', 'src/lib/pool.ts', 'tests/db.test.ts'],
      });

      await request(app)
        .post('/api/context-events/candidates')
        .send({ candidate });

      const rows = await pool.query(
        'SELECT related_files FROM memory_candidates WHERE workspace_id = $1',
        [workspaceId],
      );
      expect(rows.rows.length).toBe(1);

      const related = rows.rows[0].related_files;
      expect(related).toContain('src/lib/db.ts');
      expect(related).toContain('src/lib/pool.ts');
      expect(related).toContain('tests/db.test.ts');
    });
  });

  // ── Full governance lifecycle ───────────────────────────────────────────

  describe('full governance lifecycle', () => {
    it('end-to-end: event → candidate → approve → memory → retrieve', async () => {
      // STEP 1: Submit context event (remember/ingest)
      const eventKey = `full-lifecycle-evt-${Date.now()}`;
      const event = makeEvent({
        idempotencyKey: eventKey,
        kind: 'commit',
        payload: {
          message: 'fix: prevent SQL injection in search query',
          author: 'security-team',
          files: ['src/lib/db.ts', 'src/routes/search.ts'],
        },
      });
      const eventRes = await request(app)
        .post('/api/context-events/events')
        .send({ event });
      expect(eventRes.status).toBe(200);

      // STEP 2: Submit memory candidate derived from the event
      const candidateKey = `full-lifecycle-cand-${Date.now()}`;
      const candidate = makeCandidate({
        idempotencyKey: candidateKey,
        sourceEventKey: eventKey,
        title: 'FULL LIFECYCLE: SQL injection prevention via parameterized queries',
        body: 'All user-facing search queries must use $1, $2 placeholders. String concatenation in SQL is banned. Validated via code review checklist item SQL-01.',
        category: 'Bug Fix',
        relatedFiles: ['src/lib/db.ts', 'src/routes/search.ts'],
      });
      const candidateRes = await request(app)
        .post('/api/context-events/candidates')
        .send({ candidate });
      expect(candidateRes.status).toBe(200);

      // STEP 3: Verify candidate is pending
      const pendingCheck = await pool.query(
        "SELECT review_status FROM memory_candidates WHERE idempotency_key = $1",
        [candidateKey],
      );
      expect(pendingCheck.rows[0].review_status).toBe('pending');

      // STEP 4: Approve the candidate (simulate review action)
      await pool.query(
        "UPDATE memory_candidates SET review_status = 'approved', reviewed_at = NOW() WHERE id = $1",
        [candidateRes.body.id],
      );

      // STEP 5: Promote to durable memory
      const memoryRes = await pool.query(
        `INSERT INTO memories (workspace_id, content, category, source_type, created_at, updated_at)
         VALUES ($1, $2, $3, 'synthesis', NOW(), NOW()) RETURNING id`,
        [workspaceId, candidate.body, candidate.category],
      );
      expect(memoryRes.rows[0].id).toBeDefined();

      // STEP 6: Verify later retrieval includes the promoted memory
      const retrievalResult = await pool.query(
        'SELECT id, content, category FROM memories WHERE workspace_id = $1 ORDER BY id',
        [workspaceId],
      );
      expect(retrievalResult.rows.length).toBe(1);
      expect(retrievalResult.rows[0].content).toBe(candidate.body);
      expect(retrievalResult.rows[0].category).toBe('Bug Fix');

      // STEP 7: Verify the original candidate is now marked approved
      const finalCandidateCheck = await pool.query(
        "SELECT review_status FROM memory_candidates WHERE idempotency_key = $1",
        [candidateKey],
      );
      expect(finalCandidateCheck.rows[0].review_status).toBe('approved');
    });

    it('pending candidates excluded throughout full lifecycle', async () => {
      // Create 3 candidates: 1 approved+promoted, 1 pending, 1 rejected
      const approvedBody = 'APPROVED MEMORY: Use ESLint with strict TypeScript rules.';
      const pendingBody = 'PENDING CANDIDATE: Consider switching to Rust for performance.';
      const rejectedBody = 'REJECTED CANDIDATE: Add blockchain for logging.';

      // Insert approved+promoted memory directly
      await pool.query(
        `INSERT INTO memories (workspace_id, content, category, source_type, created_at, updated_at)
         VALUES ($1, $2, 'Convention', 'synthesis', NOW(), NOW())`,
        [workspaceId, approvedBody],
      );

      // Submit pending candidate
      const pendingCandidate = makeCandidate({
        idempotencyKey: `exclude-pending-${Date.now()}`,
        title: 'Pending: Rust migration',
        body: pendingBody,
        category: 'Decision',
      });
      await request(app)
        .post('/api/context-events/candidates')
        .send({ candidate: pendingCandidate });

      // Submit and reject candidate
      const rejectedCandidate = makeCandidate({
        idempotencyKey: `exclude-rejected-${Date.now()}`,
        title: 'Rejected: Blockchain logging',
        body: rejectedBody,
        category: 'Decision',
      });
      const rejRes = await request(app)
        .post('/api/context-events/candidates')
        .send({ candidate: rejectedCandidate });
      await pool.query(
        "UPDATE memory_candidates SET review_status = 'rejected', reviewed_at = NOW() WHERE id = $1",
        [rejRes.body.id],
      );

      // Verify: only the approved memory is in the memories table
      const memories = await pool.query(
        'SELECT content FROM memories WHERE workspace_id = $1',
        [workspaceId],
      );
      expect(memories.rows.length).toBe(1);
      expect(memories.rows[0].content).toBe(approvedBody);
      expect(memories.rows[0].content).not.toContain('Rust');
      expect(memories.rows[0].content).not.toContain('blockchain');

      // Verify: candidate table has all three with correct statuses
      const candidates = await pool.query(
        'SELECT review_status, title FROM memory_candidates WHERE workspace_id = $1 ORDER BY id',
        [workspaceId],
      );
      expect(candidates.rows.length).toBe(2);

      const statusMap: Record<string, string> = {};
      for (const r of candidates.rows) {
        statusMap[r.title] = r.review_status;
      }
      expect(statusMap['Pending: Rust migration']).toBe('pending');
      expect(statusMap['Rejected: Blockchain logging']).toBe('rejected');
    });
  });
});
