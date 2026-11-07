/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

jest.mock('../../db/index', () => ({
  execute: jest.fn(),
  query: jest.fn(),
  queryOne: jest.fn(),
}));

import { query, queryOne } from '../../db/index';
import { getContextCaptureMonitoring } from '../context-capture-controls';

const queryMock = query as jest.MockedFunction<typeof query>;
const queryOneMock = queryOne as jest.MockedFunction<typeof queryOne>;

describe('always-on context production monitoring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('aggregates queue, failed-job, distillation, audit, and worker signals without exposing raw errors', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('GROUP BY name, state')) {
        return [
          { name: 'context:capture', state: 'created', count: '2', oldest_pending_at: '2026-07-14T00:00:00.000Z', last_completed_at: null },
          { name: 'context:capture', state: 'completed', count: '7', oldest_pending_at: null, last_completed_at: '2026-07-14T01:00:00.000Z' },
          { name: 'context:distill', state: 'failed', count: '1', oldest_pending_at: null, last_completed_at: null },
        ] as never;
      }
      if (sql.includes('WITH failed_jobs')) {
        return [{ id: 'job-1', name: 'context:distill', failed_at: '2026-07-14T02:00:00.000Z', retry_count: 3 }] as never;
      }
      if (sql.includes("distillation_status = 'error'")) {
        return [{ id: '42', event_type: 'git_commit', attempted_at: '2026-07-14T02:00:00.000Z', distillation_error: 'column payload does not exist: raw detail must stay private', accepted_historical: false }] as never;
      }
      return [] as never;
    });

    queryOneMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM context_events')) {
        return {
          total: '10', pending: '1', skipped: '3', candidates: '5', auto_approved: '0', errors: '1',
          active_errors: '1', accepted_historical_errors: '0',
          last_attempted_at: '2026-07-14T02:00:00.000Z', last_error_at: '2026-07-14T02:00:00.000Z',
          last_active_error_at: '2026-07-14T02:00:00.000Z', accepted_baseline_applied_at: null,
        } as never;
      }
      if (sql.includes('FROM context_capture_audit_log')) {
        return {
          events: '12', submitted: '10', suppressed: '2', redactions: '8', ignored_paths: '3',
          truncated: '1', regulated_events: '1', last_audit_at: '2026-07-14T03:00:00.000Z',
        } as never;
      }
      if (sql.includes('FROM worker_heartbeat')) {
        return { pid: 123, last_seen: new Date().toISOString() } as never;
      }
      return undefined;
    });

    const result = await getContextCaptureMonitoring('rorca', 24);

    expect(result.queues.capture).toMatchObject({ available: true, depth: 2, created: 2, completed: 7 });
    expect(result.queues.distillation).toMatchObject({ available: true, failed: 1 });
    expect(result.queues.recentFailures).toEqual([{ id: 'job-1', queue: 'context:distill', failedAt: '2026-07-14T02:00:00.000Z', retryCount: 3 }]);
    expect(result.distillation).toMatchObject({ available: true, total: 10, pending: 1, errors: 1, activeErrors: 1, acceptedHistoricalErrors: 0 });
    expect(result.distillation.recentErrors).toEqual([{
      eventId: '42', eventType: 'git_commit', attemptedAt: '2026-07-14T02:00:00.000Z', errorClass: 'schema_error', disposition: 'active',
    }]);
    expect(JSON.stringify(result)).not.toContain('raw detail');
    expect(result.audit).toMatchObject({ available: true, events: 12, redactions: 8, ignoredPaths: 3, regulatedEvents: 1 });
    expect(result.worker.status).toBe('ok');
  });

  test('accepts only the exact pre-fix brownfield schema errors while preserving them as evidence', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('GROUP BY name, state') || sql.includes('WITH failed_jobs')) return [] as never;
      if (sql.includes("distillation_status = 'error'")) {
        return [{
          id: '83', event_type: 'git_commit', attempted_at: '2026-07-14T10:59:05.000Z',
          distillation_error: 'column "payload" of relation "memory_candidates" does not exist', accepted_historical: true,
        }] as never;
      }
      return [] as never;
    });
    queryOneMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM event_outcomes')) {
        return {
          total: '26', pending: '0', skipped: '18', candidates: '0', auto_approved: '0', errors: '8',
          active_errors: '0', accepted_historical_errors: '8',
          last_attempted_at: '2026-07-14T10:59:05.000Z', last_error_at: '2026-07-14T10:59:05.000Z',
          last_active_error_at: null, accepted_baseline_applied_at: '2026-07-14T15:09:53.000Z',
        } as never;
      }
      if (sql.includes('FROM context_capture_audit_log')) {
        return { events: '0', submitted: '0', suppressed: '0', redactions: '0', ignored_paths: '0', truncated: '0', regulated_events: '0', last_audit_at: null } as never;
      }
      if (sql.includes('FROM worker_heartbeat')) return { pid: 123, last_seen: new Date().toISOString() } as never;
      return undefined;
    });

    const result = await getContextCaptureMonitoring('rorca', 24);

    expect(result.distillation).toMatchObject({
      errors: 8,
      activeErrors: 0,
      acceptedHistoricalErrors: 8,
      lastActiveErrorAt: null,
      acceptedBaseline: {
        id: 'brownfield_candidate_payload_compatibility',
        migrationVersion: 20260714143000,
        appliedAt: '2026-07-14T15:09:53.000Z',
        errorClass: 'schema_error',
      },
    });
    expect(result.distillation.recentErrors[0]).toMatchObject({ disposition: 'accepted_historical', errorClass: 'schema_error' });
    const aggregateCall = queryOneMock.mock.calls.find(([sql]) => sql.includes('FROM event_outcomes'));
    expect(aggregateCall?.[0]).toContain('FROM public.schema_migrations');
    expect(aggregateCall?.[0]).toContain("table_schema = 'rorca'");
    expect(aggregateCall?.[0]).toContain("column_name = 'payload'");
    expect(aggregateCall?.[1]).toEqual([
      'rorca', 20260714143000, 'column "payload" of relation "memory_candidates" does not exist',
    ]);
  });

  test('queries only the configured pg-boss schema', async () => {
    const previousSchema = process.env.RORCA_PGBOSS_SCHEMA;
    process.env.RORCA_PGBOSS_SCHEMA = 'pgboss_cert_alt';
    try {
      queryMock.mockResolvedValue([] as never);
      queryOneMock.mockResolvedValue(undefined);

      await getContextCaptureMonitoring('configured-workspace', 24);

      const queueSql = queryMock.mock.calls
        .map(([sql]) => String(sql))
        .filter((sql) => sql.includes('.job') || sql.includes('.archive'));
      expect(queueSql.length).toBeGreaterThan(0);
      for (const sql of queueSql) {
        expect(sql).toContain('"pgboss_cert_alt".');
        expect(sql).not.toMatch(/\bpgboss\.(?:job|archive)\b/);
      }
    } finally {
      if (previousSchema === undefined) delete process.env.RORCA_PGBOSS_SCHEMA;
      else process.env.RORCA_PGBOSS_SCHEMA = previousSchema;
    }
  });

  test('fails closed with explicit unavailable signals when monitoring tables are absent', async () => {
    queryMock.mockRejectedValue(new Error('relation missing'));
    queryOneMock.mockRejectedValue(new Error('relation missing'));

    const result = await getContextCaptureMonitoring('fresh-workspace', 9999);

    expect(result.windowHours).toBe(720);
    expect(result.queues.capture.available).toBe(false);
    expect(result.distillation.available).toBe(false);
    expect(result.audit.available).toBe(false);
    expect(result.worker.status).toBe('unknown');
  });
});
