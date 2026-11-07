/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * US-009: Run findings feed-forward — derivation, idempotent persistence,
 * capture-candidate posture, and the memory-synthesis feed.
 */

const mockQuery = jest.fn();
const mockQueryOne = jest.fn();
const mockExecute = jest.fn();
const mockBroadcastAll = jest.fn();

jest.mock('../../db/index', () => ({
  query: mockQuery,
  queryOne: mockQueryOne,
  execute: mockExecute,
}));

jest.mock('../sse-hub', () => ({
  broadcastAll: mockBroadcastAll,
}));

jest.mock('../logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  deriveRunFindings,
  persistRunFindings,
  deriveAndPersistRunFindings,
  tryDeriveAndPersistRunFindings,
  loadRunFindings,
  RUN_FINDING_KINDS,
  RUN_FINDING_STATUSES,
} from '../run-findings';

function walEvent(overrides: Partial<{ id: number; event_type: string; story_id: string | null; payload: string | null }>) {
  return {
    id: 1,
    event_type: 'story_failed',
    story_id: 'US-001',
    payload: JSON.stringify({ run_id: 41, story_id: 'US-001', reason: 'timeout' }),
    ...overrides,
  };
}

describe('deriveRunFindings', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockQueryOne.mockResolvedValue({ id: 41, workspace_id: 'ws-1', status: 'done' });
  });

  it('derives a deviation finding for a failed story with the WAL reason', async () => {
    mockQuery
      .mockResolvedValueOnce([{ story_id: 'US-001', status: 'fail', retries: 2 }])   // story_results
      .mockResolvedValueOnce([walEvent({ id: 7 }), walEvent({ id: 9 })])             // story_failed events
      .mockResolvedValueOnce([walEvent({ id: 1, event_type: 'story_passed', payload: '{"run_id":41}' })]) // run wal events
      .mockResolvedValueOnce([]);                                                     // memories

    const findings = await deriveRunFindings(41, 'ws-1');

    const deviation = findings.find(f => f.kind === 'deviation');
    expect(deviation).toBeDefined();
    expect(deviation!.findingKey).toBe('deviation:story:US-001');
    expect(deviation!.title).toContain('deviated from spec');
    expect(deviation!.detail).toContain('reason: timeout');
    expect(deviation!.evidence).toEqual([
      { kind: 'story_result', reference: 'story_result:US-001', detail: 'fail' },
      { kind: 'wal_event', reference: 'wal:story_failed:US-001', detail: 'timeout' },
    ]);
  });

  it('derives a skip deviation, run-level deviation, and flaky risk', async () => {
    mockQuery
      .mockResolvedValueOnce([
        { story_id: 'US-001', status: 'pass', retries: 3 },
        { story_id: 'US-002', status: 'skip', retries: 0 },
      ])
      .mockResolvedValueOnce([])   // story_failed events (none)
      .mockResolvedValueOnce([])   // run wal events (none)
      .mockResolvedValueOnce([]);  // memories

    mockQueryOne.mockResolvedValueOnce({ id: 41, workspace_id: 'ws-1', status: 'partial_failure' });

    const findings = await deriveRunFindings(41, 'ws-1');

    expect(findings.map(f => f.findingKey).sort()).toEqual([
      'deviation:run:partial_failure',
      'deviation:skip:US-002',
      'risk:flaky:US-001',
    ]);
    const flaky = findings.find(f => f.findingKey === 'risk:flaky:US-001')!;
    expect(flaky.title).toContain('3 retries');
  });

  it('derives risks from escalation and recovery-path run_finished events', async () => {
    mockQuery
      // story_results (no failures -> no story_failed query runs)
      .mockResolvedValueOnce([{ story_id: 'US-001', status: 'pass', retries: 0 }])
      // run WAL events
      .mockResolvedValueOnce([
        walEvent({ id: 11, event_type: 'story_escalated', story_id: 'US-001', payload: JSON.stringify({ run_id: 41, fromModel: 'haiku', toModel: 'sonnet' }) }),
        walEvent({ id: 12, event_type: 'run_finished', story_id: null, payload: JSON.stringify({ run_id: 41, status: 'failed', reason: 'worker_crash_recovery' }) }),
        walEvent({ id: 13, event_type: 'run_finished', story_id: null, payload: JSON.stringify({ run_id: 41, status: 'done', reason: 'ordinary' }) }),
      ])
      // memories
      .mockResolvedValueOnce([]);

    const findings = await deriveRunFindings(41, 'ws-1');

    const risks = findings.filter(f => f.kind === 'risk').map(f => f.findingKey).sort();
    expect(risks).toEqual(['risk:escalation:wal:11', 'risk:run_finished:worker_crash_recovery']);
    const escalation = findings.find(f => f.findingKey === 'risk:escalation:wal:11')!;
    expect(escalation.title).toContain('haiku -> sonnet');
  });

  it('maps run memories to decision and convention findings', async () => {
    mockQuery
      // story_results (no failures -> no story_failed query runs)
      .mockResolvedValueOnce([{ story_id: 'US-001', status: 'pass', retries: 0 }])
      // run WAL events
      .mockResolvedValueOnce([])
      // memories
      .mockResolvedValueOnce([
        { id: 55, category: 'Decision', content: 'Use hash-based routing for run views.' },
        { id: 56, category: 'Convention', content: 'Panels live in src/panels/.' },
        { id: 57, category: 'Gotcha', content: 'Not mapped to a finding kind.' },
      ]);

    const findings = await deriveRunFindings(41, 'ws-1');

    expect(findings.map(f => f.findingKey).sort()).toEqual([
      'convention:memory:56',
      'decision:memory:55',
    ]);
    const decision = findings.find(f => f.findingKey === 'decision:memory:55')!;
    expect(decision.kind).toBe('decision');
    expect(decision.title).toContain('Decision');
  });

  it('returns no findings for an unknown run or a workspace mismatch', async () => {
    mockQueryOne.mockResolvedValueOnce(undefined);
    expect(await deriveRunFindings(41, 'ws-1')).toEqual([]);
    mockQueryOne.mockResolvedValueOnce({ id: 41, workspace_id: 'ws-other', status: 'done' });
    expect(await deriveRunFindings(41, 'ws-1')).toEqual([]);
  });
});

describe('persistRunFindings / loadRunFindings', () => {
  beforeEach(() => jest.resetAllMocks());

  it('persists findings with the run and reports the inserted count', async () => {
    mockExecute.mockResolvedValue({ rowCount: 2 });
    const inserted = await persistRunFindings(41, 'ws-1', [
      { findingKey: 'deviation:story:US-001', kind: 'deviation', title: 't', detail: 'd', evidence: [] },
      { findingKey: 'risk:flaky:US-001', kind: 'risk', title: 't2', detail: 'd2', evidence: [] },
    ]);
    expect(inserted).toBe(2);
    const sql = String(mockExecute.mock.calls[0][0]);
    expect(sql).toContain('INSERT INTO run_findings');
    expect(sql).toContain('ON CONFLICT (run_id, finding_key) DO NOTHING');
    // Status is never written by persistence — rows keep the capture_candidate default.
    expect(sql).not.toContain('captured');
  });

  it('returns 0 inserts for an empty finding set', async () => {
    expect(await persistRunFindings(41, 'ws-1', [])).toBe(0);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('loads findings as capture candidates with normalized timestamps', async () => {
    mockQuery.mockResolvedValueOnce([
      {
        id: 1,
        finding_key: 'deviation:story:US-001',
        kind: 'deviation',
        title: 'Story US-001 deviated',
        detail: 'detail',
        evidence: [{ kind: 'wal_event', reference: 'wal:1', detail: 'timeout' }],
        status: 'capture_candidate',
        captured_at: null,
        created_at: '2026-08-10T10:00:00.000Z',
      },
    ]);
    const rows = await loadRunFindings(41, 'ws-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      findingKey: 'deviation:story:US-001',
      kind: 'deviation',
      status: 'capture_candidate',
      capturedAt: null,
    });
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toContain('FROM run_findings');
    expect(sql).toContain('run_id = $1 AND workspace_id = $2');
  });
});

describe('deriveAndPersistRunFindings (no silent promotion)', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockQueryOne
      .mockResolvedValueOnce({ id: 41, workspace_id: 'ws-1', status: 'done' })  // run row
      .mockResolvedValueOnce({ id: 500 });                                        // wal insert
    mockQuery
      // story_results (one failure -> story_failed query runs next)
      .mockResolvedValueOnce([{ story_id: 'US-001', status: 'fail', retries: 0 }])
      // story_failed WAL events
      .mockResolvedValueOnce([walEvent({ id: 7 })])
      // run WAL events
      .mockResolvedValueOnce([])
      // memories
      .mockResolvedValueOnce([]);
  });

  it('emits a bounded run_findings WAL event only when new rows were inserted', async () => {
    mockExecute.mockResolvedValueOnce({ rowCount: 1 });
    const result = await deriveAndPersistRunFindings(41, 'ws-1');

    expect(result.ok).toBe(true);
    expect(result.inserted).toBe(1);
    expect(mockBroadcastAll).toHaveBeenCalledTimes(1);
    const event = mockBroadcastAll.mock.calls[0][0];
    expect(event.event_type).toBe('run_findings');
    const payload = JSON.parse(event.payload);
    expect(payload).toMatchObject({ run_id: 41, workspace_id: 'ws-1', inserted: 1, status: 'capture_candidate' });
  });

  it('does not re-emit when re-derivation inserts nothing (idempotent)', async () => {
    mockExecute.mockResolvedValueOnce({ rowCount: 0 });
    const result = await deriveAndPersistRunFindings(41, 'ws-1');
    expect(result.ok).toBe(true);
    expect(result.inserted).toBe(0);
    expect(mockBroadcastAll).not.toHaveBeenCalled();
  });
});

describe('tryDeriveAndPersistRunFindings', () => {
  beforeEach(() => jest.resetAllMocks());

  it('never throws — returns the error payload instead', async () => {
    mockQueryOne.mockRejectedValueOnce(new Error('db down'));
    const result = await tryDeriveAndPersistRunFindings(41, 'ws-1');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('db down');
    expect(result.findings).toEqual([]);
    expect(result.inserted).toBe(0);
  });
});

describe('contract stability', () => {
  it('exposes the documented finding kinds and statuses', () => {
    expect(RUN_FINDING_KINDS).toEqual(['decision', 'deviation', 'risk', 'convention']);
    expect(RUN_FINDING_STATUSES).toEqual(['capture_candidate', 'captured', 'dismissed']);
  });
});
