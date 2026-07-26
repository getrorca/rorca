/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * US-004: Schema regression fixture for the Context Intelligence Platform capture plane.
 *
 * Guards the two foundation tables this story owns (`context_events`, `memory_candidates`)
 * so later stories (US-014/US-026/US-032/US-034/US-035) cannot silently break the contract
 * defined in docs/context-intelligence-platform.md:
 *   - idempotency uniqueness prevents duplicate ingestion / offline-queue replay
 *   - review-lifecycle and trust-tier values are constrained
 *   - the governance gate is enforced at the DB boundary: a non-approved candidate can never
 *     carry a promoted durable memory.
 */

import { Pool } from 'pg';
import { getTestPool, closeTestPool } from '../../__tests__/helpers/pg-test-utils';

let pool: Pool;

beforeAll(() => {
  pool = getTestPool();
});

async function cleanOwnedFixtures(): Promise<void> {
  await pool.query("DELETE FROM memory_candidates WHERE workspace_id = 'ws-ci'");
  await pool.query("DELETE FROM context_events WHERE workspace_id = 'ws-ci'");
  await pool.query("DELETE FROM memories WHERE workspace_id = 'ws-ci'");
  await pool.query("DELETE FROM workspaces WHERE id = 'ws-ci'");
}

afterAll(async () => {
  await cleanOwnedFixtures();
  await closeTestPool();
});

beforeEach(async () => {
  await cleanOwnedFixtures();
  await pool.query(
    "INSERT INTO workspaces (id, label, path) VALUES ('ws-ci', 'CI', '/tmp/ws-ci')"
  );
});

async function expectReject(sql: string, params: unknown[] = []): Promise<void> {
  await expect(pool.query(sql, params)).rejects.toThrow();
}

describe('context_events', () => {
  test('table exists with the contracted columns', async () => {
    const { rows } = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'context_events'
    `);
    const cols = rows.map((r) => r.column_name);
    for (const c of [
      'workspace_id', 'source_system', 'source_ref', 'event_type', 'actor',
      'occurred_at', 'summary', 'payload', 'idempotency_key', 'schema_version',
      'created_at', 'updated_at',
    ]) {
      expect(cols).toContain(c);
    }
  });

  test('accepts a valid event', async () => {
    const { rowCount } = await pool.query(
      `INSERT INTO context_events (workspace_id, source_system, event_type, occurred_at, idempotency_key)
       VALUES ('ws-ci', 'git', 'commit', NOW(), 'ce-ok')`
    );
    expect(rowCount).toBe(1);
  });

  test('rejects a duplicate idempotency key in the same workspace', async () => {
    await pool.query(
      `INSERT INTO context_events (workspace_id, source_system, event_type, occurred_at, idempotency_key)
       VALUES ('ws-ci', 'git', 'commit', NOW(), 'ce-dup')`
    );
    await expectReject(
      `INSERT INTO context_events (workspace_id, source_system, event_type, occurred_at, idempotency_key)
       VALUES ('ws-ci', 'git', 'commit', NOW(), 'ce-dup')`
    );
  });

  test('rejects blank provenance / event type', async () => {
    await expectReject(
      `INSERT INTO context_events (workspace_id, source_system, event_type, occurred_at, idempotency_key)
       VALUES ('ws-ci', '   ', 'commit', NOW(), 'ce-1')`
    );
    await expectReject(
      `INSERT INTO context_events (workspace_id, source_system, event_type, occurred_at, idempotency_key)
       VALUES ('ws-ci', 'git', '', NOW(), 'ce-2')`
    );
  });
});

describe('memory_candidates', () => {
  async function seedMemory(): Promise<number> {
    const { rows } = await pool.query(
      `INSERT INTO memories (workspace_id, category, content) VALUES ('ws-ci', 'Gotcha', 'x') RETURNING id`
    );
    return rows[0].id;
  }

  test('table exists with the contracted columns', async () => {
    const { rows } = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'memory_candidates'
    `);
    const cols = rows.map((r) => r.column_name);
    for (const c of [
      'workspace_id', 'context_event_id', 'category', 'title', 'rule', 'context',
      'related_files', 'confidence', 'trust_tier', 'review_status', 'reviewer',
      'promoted_memory_id', 'promoted_at', 'idempotency_key', 'metadata',
    ]) {
      expect(cols).toContain(c);
    }
  });

  test('defaults a fresh candidate to pending / agent observation / low confidence', async () => {
    const { rows } = await pool.query(
      `INSERT INTO memory_candidates (workspace_id, source_system, category, title, rule, idempotency_key)
       VALUES ('ws-ci', 'git', 'Pattern', 'T', 'do it', 'mc-def')
       RETURNING review_status, trust_tier, confidence`
    );
    expect(rows[0]).toMatchObject({
      review_status: 'pending',
      trust_tier: 'agent_observation',
      confidence: 'low',
    });
  });

  test('rejects duplicate idempotency key', async () => {
    await pool.query(
      `INSERT INTO memory_candidates (workspace_id, source_system, category, title, rule, idempotency_key)
       VALUES ('ws-ci', 'git', 'C', 'T', 'r', 'mc-dup')`
    );
    await expectReject(
      `INSERT INTO memory_candidates (workspace_id, source_system, category, title, rule, idempotency_key)
       VALUES ('ws-ci', 'git', 'C', 'T', 'r', 'mc-dup')`
    );
  });

  test('rejects invalid lifecycle / trust values', async () => {
    await expectReject(
      `INSERT INTO memory_candidates (workspace_id, source_system, category, title, rule, idempotency_key, review_status)
       VALUES ('ws-ci', 'git', 'C', 'T', 'r', 'mc-1', 'bogus')`
    );
    await expectReject(
      `INSERT INTO memory_candidates (workspace_id, source_system, category, title, rule, idempotency_key, trust_tier)
       VALUES ('ws-ci', 'git', 'C', 'T', 'r', 'mc-2', 'godlike')`
    );
  });

  test('governance gate: a non-approved candidate cannot carry a promoted memory', async () => {
    const memId = await seedMemory();
    await expectReject(
      `INSERT INTO memory_candidates (workspace_id, source_system, category, title, rule, idempotency_key,
                                      review_status, promoted_memory_id, promoted_at)
       VALUES ('ws-ci', 'git', 'C', 'T', 'r', 'mc-gate', 'pending', $1, NOW())`,
      [memId]
    );
  });

  test('approved candidate may be promoted to a durable memory', async () => {
    const memId = await seedMemory();
    const { rowCount } = await pool.query(
      `INSERT INTO memory_candidates (workspace_id, source_system, category, title, rule, idempotency_key,
                                      review_status, reviewer, reviewed_at, promoted_memory_id, promoted_at)
       VALUES ('ws-ci', 'git', 'C', 'T', 'r', 'mc-promote', 'approved', 'alice', NOW(), $1, NOW())`,
      [memId]
    );
    expect(rowCount).toBe(1);
  });

  test('deleting a context_event nulls the candidate provenance link (SET NULL)', async () => {
    const { rows: ev } = await pool.query(
      `INSERT INTO context_events (workspace_id, source_system, event_type, occurred_at, idempotency_key)
       VALUES ('ws-ci', 'git', 'commit', NOW(), 'ce-link') RETURNING id`
    );
    const eventId = ev[0].id;
    await pool.query(
      `INSERT INTO memory_candidates (workspace_id, source_system, category, title, rule, idempotency_key, context_event_id)
       VALUES ('ws-ci', 'git', 'C', 'T', 'r', 'mc-link', $1)`,
      [eventId]
    );
    await pool.query('DELETE FROM context_events WHERE id = $1', [eventId]);
    const { rows } = await pool.query(
      `SELECT context_event_id FROM memory_candidates WHERE idempotency_key = 'mc-link'`
    );
    expect(rows[0].context_event_id).toBeNull();
  });
});
