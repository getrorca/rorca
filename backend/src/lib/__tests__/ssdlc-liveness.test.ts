/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  classifyRunLiveness,
  classifySSDLCLiveness,
  SSDLC_LIVENESS_MAX_FUTURE_SKEW_MS,
  SSDLC_LIVENESS_SIGNAL_LIMIT,
  type LivenessCollectorDependencies,
  type LivenessEvidenceReference,
  type SSDLCLivenessSignals,
} from '../ssdlc-liveness';

const NOW = new Date('2026-07-15T12:00:00.000Z');
const RECENT = '2026-07-15T11:59:30.000Z';
const OLD = '2026-07-15T11:55:00.000Z';

function evidence(
  source: LivenessEvidenceReference['source'],
  observedAt: string | null,
  detail: string = source,
  meaningful = true,
): LivenessEvidenceReference {
  return {
    source,
    reference: `${source}:fixture`,
    observedAt,
    available: true,
    meaningful,
    detail,
  };
}

function signals(overrides: Partial<SSDLCLivenessSignals> = {}): SSDLCLivenessSignals {
  return {
    runId: 42,
    workspaceId: 'ws-liveness',
    dbStatus: 'running',
    startedAt: OLD,
    finishedAt: null,
    process: { available: true, alive: true, owned: true, pid: 1234 },
    worker: { available: false, lastSeen: null, fresh: false },
    activities: [],
    completion: {
      available: true,
      packetPresent: false,
      packetValidated: false,
      allStoriesTerminal: false,
      truncated: false,
      observedAt: null,
      reference: 'completion:42',
    },
    blockers: [],
    git: { available: true, dirty: false, commitAt: null, reference: 'git:fixture' },
    ...overrides,
  };
}

const classify = (input: SSDLCLivenessSignals) => classifySSDLCLiveness(input, { now: () => NOW });

describe('classifySSDLCLiveness', () => {
  it('keeps a low-CPU Pi story active from recent token WAL without a run heartbeat', () => {
    const result = classify(signals({
      activities: [evidence('wal', RECENT, 'story_token_update')],
      worker: { available: false, lastSeen: null, fresh: false },
    }));

    expect(result.state).toBe('active');
    expect(result.lastMeaningfulActivity).toBe(RECENT);
    expect(result.nextSafeAction.action).toBe('wait');
  });

  it('treats recent optional PTY output as activity', () => {
    expect(classify(signals({ activities: [evidence('pty', RECENT)] })).state).toBe('active');
  });

  it('classifies a newly started live but silent process as quiet_active', () => {
    const result = classify(signals({
      startedAt: '2026-07-15T11:59:15.000Z',
      activities: [evidence('database', null, 'no activity', false)],
    }));

    expect(result.state).toBe('quiet_active');
    expect(result.nextSafeAction.action).toBe('wait');
  });

  it('classifies a live process as stalled only after the policy threshold and not from CPU', () => {
    const beforeThreshold = classifySSDLCLiveness(signals({ startedAt: '2026-07-15T11:59:00.001Z' }), {
      now: () => NOW,
      inactivityThresholdMs: 60_000,
    });
    const afterThreshold = classifySSDLCLiveness(signals({ activities: [evidence('log', OLD)] }), {
      now: () => NOW,
      inactivityThresholdMs: 60_000,
    });

    expect(beforeThreshold.state).toBe('quiet_active');
    expect(afterThreshold.state).toBe('stalled');
    expect(afterThreshold.nextSafeAction.explanation).toContain('CPU level was not used');
  });

  it.each([
    ['credential', 'API key credential expired', 'inspect evidence'],
    ['environment', 'missing tool binary ENOENT', 'inspect evidence'],
    ['policy_approval', 'policy approval required', 'request approval'],
    ['worktree', 'worktree branch stale', 'refresh worktree'],
    ['testing', 'validation test_failed', 'inspect evidence'],
    ['retry_scope', 'retry_scope_mismatch', 'retry smallest scope'],
  ] as const)('maps %s failures to a typed blocker and actionable remediation', (type, text, action) => {
    const result = classify(signals({
      dbStatus: 'failed',
      process: { available: true, alive: false, owned: null, pid: 1234 },
      blockers: [{ text, observedAt: RECENT, evidenceReference: 'wal:9' }],
      activities: [evidence('wal', RECENT, text)],
    }));

    expect(result.state).toBe('blocked');
    expect(result.blocker?.type).toBe(type);
    expect(result.blocker?.remediation.length).toBeGreaterThan(10);
    expect(result.nextSafeAction.action).toBe(action);
  });

  it('requires terminal DB state, accepted packets, all stories terminal, and process exit for completed', () => {
    const result = classify(signals({
      dbStatus: 'done',
      finishedAt: RECENT,
      process: { available: true, alive: false, owned: null, pid: 1234 },
      activities: [evidence('completion_packet', RECENT)],
      completion: {
        available: true,
        packetPresent: true,
        packetValidated: true,
        allStoriesTerminal: true,
        truncated: false,
        observedAt: RECENT,
        reference: 'closeout:CLO-fixture',
      },
    }));

    expect(result.state).toBe('completed');
    expect(result.confidence).toBe(0.99);
    expect(result.nextSafeAction.action).toBe('none');
  });

  it('does not call a terminal DB row completed while its process is still live', () => {
    const result = classify(signals({
      dbStatus: 'done',
      finishedAt: RECENT,
      process: { available: true, alive: true, owned: true, pid: 1234 },
      activities: [evidence('completion_packet', RECENT)],
      completion: {
        available: true,
        packetPresent: true,
        packetValidated: true,
        allStoriesTerminal: true,
        truncated: false,
        observedAt: RECENT,
        reference: 'closeout:CLO-fixture',
      },
    }));

    expect(result.state).toBe('unknown');
    expect(result.nextSafeAction.action).toBe('inspect evidence');
  });

  it('does not trust a foreign process as the owner of a quiet run', () => {
    const result = classify(signals({
      process: { available: true, alive: true, owned: false, pid: 1234 },
      activities: [],
    }));

    expect(result.state).toBe('unknown');
  });

  it('does not let a far-future activity timestamp keep an orphan active forever', () => {
    const farFuture = new Date(NOW.getTime() + SSDLC_LIVENESS_MAX_FUTURE_SKEW_MS + 86_400_000).toISOString();
    const result = classify(signals({
      process: { available: false, alive: null, owned: null },
      activities: [evidence('wal', farFuture, 'poisoned future token timestamp')],
    }));

    expect(result.state).toBe('unknown');
    expect(result.lastMeaningfulActivity).toBeNull();
    expect(result.nextSafeAction.action).toBe('inspect evidence');
  });

  it('ignores activity outside the configured lookback instead of reviving the run', () => {
    const result = classifySSDLCLiveness(signals({
      process: { available: true, alive: false, owned: null },
      activities: [evidence('wal', '2026-07-13T11:59:30.000Z', 'ancient token event')],
    }), { now: () => NOW, lookbackMs: 60_000, inactivityThresholdMs: 60_000 });

    expect(result.state).toBe('stalled');
    expect(result.lastMeaningfulActivity).toBeNull();
  });

  it('classifies a stale running DB row with a dead process as stalled', () => {
    const result = classify(signals({
      process: { available: true, alive: false, owned: null, pid: 9999 },
      activities: [evidence('database', OLD, 'stale DB row', false)],
    }));

    expect(result.state).toBe('stalled');
    expect(result.nextSafeAction.action).toBe('retry smallest scope');
  });

  it('does not infer stalled when process, PTY, Git, and packet signals are missing', () => {
    const result = classify(signals({
      process: { available: false, alive: null, owned: null },
      activities: [
        { ...evidence('pty', null, 'PTY unavailable', false), available: false },
        { ...evidence('git', null, 'Git unavailable', false), available: false },
      ],
      completion: {
        available: false,
        packetPresent: false,
        packetValidated: false,
        allStoriesTerminal: false,
        truncated: false,
        observedAt: null,
        reference: 'completion:unavailable',
      },
      git: { available: false, dirty: null, commitAt: null, reference: 'git:unavailable' },
    }));

    expect(result.state).toBe('unknown');
    expect(result.nextSafeAction.action).toBe('inspect evidence');
  });

  it('bounds evidence returned to the public report', () => {
    const activities = Array.from({ length: SSDLC_LIVENESS_SIGNAL_LIMIT + 10 }, (_, index) =>
      evidence('wal', new Date(NOW.getTime() - index * 1_000).toISOString(), `event ${index}`));
    const result = classify(signals({ activities }));

    expect(result.evidence).toHaveLength(SSDLCLIVENESS_SIGNAL_LIMIT_FIXTURE());
  });
});

// Keep the assertion readable while preventing a magic duplicate of the exported cap.
function SSDLCLIVENESS_SIGNAL_LIMIT_FIXTURE(): number {
  return SSDLC_LIVENESS_SIGNAL_LIMIT;
}

describe('classifyRunLiveness evidence collection', () => {
  const processProbe = jest.fn() as jest.MockedFunction<LivenessCollectorDependencies['processProbe']>;
  const statMtime = jest.fn() as jest.MockedFunction<LivenessCollectorDependencies['statMtime']>;
  const gitProbe = jest.fn() as jest.MockedFunction<LivenessCollectorDependencies['gitProbe']>;
  const queryMock = jest.fn() as jest.MockedFunction<LivenessCollectorDependencies['query']>;
  const queryOneMock = jest.fn() as jest.MockedFunction<LivenessCollectorDependencies['queryOne']>;

  beforeEach(() => {
    jest.clearAllMocks();
    processProbe.mockReturnValue({ available: true, alive: true, owned: true });
    statMtime.mockResolvedValue(null);
    gitProbe.mockResolvedValue({ available: false, dirty: null, commitAt: null, detail: 'unavailable fixture' });
    queryOneMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM pipeline_runs')) {
        return {
          id: 42,
          workspace_id: 'ws-liveness',
          status: 'running',
          pid: 1234,
          started_at: OLD,
          finished_at: null,
          log_path: null,
          worktree_path: '/workspace/run-42',
          branch_name: 'feat/run-42',
          summary: null,
          merge_error: null,
          workspace_path: '/workspace',
          worker_last_seen: null,
        } as never;
      }
      if (sql.includes('run_output_chunks')) return undefined;
      if (sql.includes('run_pty_sessions')) throw new Error('node-pty/table unavailable fixture');
      return undefined;
    });
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM wal_events')) {
        return [{ id: 7, ts: RECENT, event_type: 'story_token_update', story_id: 'LFC-012', payload: { run_id: 42 } }] as never;
      }
      if (sql.includes('FROM story_results')) return [] as never;
      return [] as never;
    });
  });

  it('uses workspace/run/time/limit scoped WAL and degrades when PTY is unavailable', async () => {
    const result = await classifyRunLiveness(42, { now: () => NOW, workspaceId: 'ws-liveness' }, {
      query: queryMock,
      queryOne: queryOneMock,
      processProbe,
      statMtime,
      gitProbe,
    });

    expect(result?.state).toBe('active');
    const walCall = queryMock.mock.calls.find(([sql]) => String(sql).includes('FROM wal_events'));
    expect(walCall?.[0]).toContain("payload->>'run_id' = $2::text");
    expect(walCall?.[0]).toContain('ts > $3');
    expect(walCall?.[0]).toContain('ORDER BY ts DESC');
    expect(walCall?.[0]).toContain('LIMIT $5');
    expect(walCall?.[1]).toEqual(['ws-liveness', 42, expect.any(String), null, SSDLC_LIVENESS_SIGNAL_LIMIT]);
    expect(result?.evidence.some((item) => item.source === 'pty' && !item.available)).toBe(true);
    const outputCall = queryOneMock.mock.calls.find(([sql]) => String(sql).includes('run_output_chunks'));
    expect(outputCall?.[0]).toContain('created_at > $2');
  });

  it('does not count a newly created silent PTY session as output activity', async () => {
    queryMock.mockResolvedValue([] as never);
    queryOneMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM pipeline_runs')) {
        return {
          id: 42,
          workspace_id: 'ws-liveness',
          status: 'running',
          pid: 1234,
          started_at: OLD,
          finished_at: null,
          log_path: null,
          worktree_path: '/workspace/run-42',
          branch_name: 'feat/run-42',
          summary: null,
          merge_error: null,
          workspace_path: '/workspace',
          worker_last_seen: null,
        } as never;
      }
      if (sql.includes('run_pty_sessions')) {
        return { status: 'active', last_output_at: RECENT, exited_at: null, exit_code: null, total_output_bytes: 0 } as never;
      }
      return undefined;
    });

    const result = await classifyRunLiveness(42, { now: () => NOW }, {
      query: queryMock,
      queryOne: queryOneMock,
      processProbe,
      statMtime,
      gitProbe,
    });

    expect(result?.state).toBe('stalled');
    expect(result?.evidence.find((item) => item.source === 'pty')?.meaningful).toBe(false);
  });

  it('uses an injected dead-process fixture and never spawns a subprocess', async () => {
    processProbe.mockReturnValue({ available: true, alive: false, owned: null });
    queryMock.mockResolvedValue([] as never);

    const result = await classifyRunLiveness(42, { now: () => NOW }, {
      query: queryMock,
      queryOne: queryOneMock,
      processProbe,
      statMtime,
      gitProbe,
    });

    expect(processProbe).toHaveBeenCalledWith(1234);
    expect(result?.state).toBe('stalled');
  });
});
