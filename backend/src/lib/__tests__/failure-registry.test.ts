import {
  createFailureRegistry,
  markFailed,
  isFailed,
  getFailureRecord,
  removeFailure,
  failedIdSet,
  type FailureRecord,
} from '../failure-registry';

describe('failure-registry', () => {
  // ── createFailureRegistry ──────────────────────────────────────────

  test('creates an empty registry', () => {
    const reg = createFailureRegistry();
    expect(reg.size).toBe(0);
  });

  // ── markFailed ─────────────────────────────────────────────────────

  test('marking a story failed creates a record with waveIndex', () => {
    const reg = createFailureRegistry();
    const record: FailureRecord = {
      storyId: 'US-001',
      waveIndex: 2,
      failedAt: Date.now(),
      reason: 'merge_conflict',
      recoveryClass: 'transient',
      recoveryAttempts: 0,
      lastRecoveryAt: null,
      recoveryInFlight: false,
    };
    markFailed(reg, record);
    expect(reg.size).toBe(1);
    expect(reg.get('US-001')).toEqual(record);
  });

  test('markFailed overwrites an existing record for the same storyId', () => {
    const reg = createFailureRegistry();
    markFailed(reg, {
      storyId: 'US-001', waveIndex: 0, failedAt: 1000,
      reason: 'timeout', recoveryClass: 'transient',
      recoveryAttempts: 0, lastRecoveryAt: null, recoveryInFlight: false,
    });
    markFailed(reg, {
      storyId: 'US-001', waveIndex: 1, failedAt: 2000,
      reason: 'merge_conflict', recoveryClass: 'transient',
      recoveryAttempts: 1, lastRecoveryAt: 1500, recoveryInFlight: false,
    });
    expect(reg.size).toBe(1);
    expect(reg.get('US-001')!.waveIndex).toBe(1);
    expect(reg.get('US-001')!.recoveryAttempts).toBe(1);
  });

  test('markFailed stores conflictingFiles and stderrTail', () => {
    const reg = createFailureRegistry();
    markFailed(reg, {
      storyId: 'US-002', waveIndex: 0, failedAt: Date.now(),
      reason: 'merge_conflict', recoveryClass: 'transient',
      recoveryAttempts: 0, lastRecoveryAt: null, recoveryInFlight: false,
      conflictingFiles: ['src/index.ts', 'package.json'],
      stderrTail: 'CONFLICT: Merge conflict in src/index.ts',
    });
    const rec = reg.get('US-002')!;
    expect(rec.conflictingFiles).toEqual(['src/index.ts', 'package.json']);
    expect(rec.stderrTail).toBe('CONFLICT: Merge conflict in src/index.ts');
  });

  // ── isFailed ───────────────────────────────────────────────────────

  test('checking a non-failed story returns false', () => {
    const reg = createFailureRegistry();
    expect(isFailed(reg, 'US-999')).toBe(false);
  });

  test('checking a failed story returns true', () => {
    const reg = createFailureRegistry();
    markFailed(reg, {
      storyId: 'US-001', waveIndex: 0, failedAt: Date.now(),
      reason: 'agent_timeout', recoveryClass: 'transient',
      recoveryAttempts: 0, lastRecoveryAt: null, recoveryInFlight: false,
    });
    expect(isFailed(reg, 'US-001')).toBe(true);
  });

  // ── getFailureRecord ───────────────────────────────────────────────

  test('getFailureRecord returns undefined for non-failed story', () => {
    const reg = createFailureRegistry();
    expect(getFailureRecord(reg, 'US-001')).toBeUndefined();
  });

  test('getFailureRecord returns the stored record', () => {
    const reg = createFailureRegistry();
    const now = Date.now();
    markFailed(reg, {
      storyId: 'US-003', waveIndex: 1, failedAt: now,
      reason: 'wrong_api_key', recoveryClass: 'terminal',
      recoveryAttempts: 0, lastRecoveryAt: null, recoveryInFlight: false,
    });
    const rec = getFailureRecord(reg, 'US-003');
    expect(rec).toBeDefined();
    expect(rec!.storyId).toBe('US-003');
    expect(rec!.waveIndex).toBe(1);
    expect(rec!.failedAt).toBe(now);
    expect(rec!.recoveryClass).toBe('terminal');
  });

  // ── removeFailure ──────────────────────────────────────────────────

  test('removing a record makes it non-failed', () => {
    const reg = createFailureRegistry();
    markFailed(reg, {
      storyId: 'US-001', waveIndex: 0, failedAt: Date.now(),
      reason: 'merge_conflict', recoveryClass: 'transient',
      recoveryAttempts: 0, lastRecoveryAt: null, recoveryInFlight: false,
    });
    expect(isFailed(reg, 'US-001')).toBe(true);

    const removed = removeFailure(reg, 'US-001');
    expect(removed).toBe(true);
    expect(isFailed(reg, 'US-001')).toBe(false);
    expect(reg.size).toBe(0);
  });

  test('removing a non-existent story returns false', () => {
    const reg = createFailureRegistry();
    expect(removeFailure(reg, 'US-NOPE')).toBe(false);
  });

  // ── failedIdSet ────────────────────────────────────────────────────

  test('failedIdSet returns a Set of all failed story IDs', () => {
    const reg = createFailureRegistry();
    markFailed(reg, {
      storyId: 'US-001', waveIndex: 0, failedAt: Date.now(),
      reason: 'timeout', recoveryClass: 'transient',
      recoveryAttempts: 0, lastRecoveryAt: null, recoveryInFlight: false,
    });
    markFailed(reg, {
      storyId: 'US-002', waveIndex: 1, failedAt: Date.now(),
      reason: 'merge_conflict', recoveryClass: 'transient',
      recoveryAttempts: 0, lastRecoveryAt: null, recoveryInFlight: false,
    });

    const ids = failedIdSet(reg);
    expect(ids).toBeInstanceOf(Set);
    expect(ids.size).toBe(2);
    expect(ids.has('US-001')).toBe(true);
    expect(ids.has('US-002')).toBe(true);
  });

  test('failedIdSet returns empty set for empty registry', () => {
    const reg = createFailureRegistry();
    const ids = failedIdSet(reg);
    expect(ids.size).toBe(0);
  });

  // ── Multiple stories in registry ───────────────────────────────────

  test('registry tracks multiple independent failures', () => {
    const reg = createFailureRegistry();
    markFailed(reg, {
      storyId: 'US-001', waveIndex: 0, failedAt: 1000,
      reason: 'agent_timeout', recoveryClass: 'transient',
      recoveryAttempts: 0, lastRecoveryAt: null, recoveryInFlight: false,
    });
    markFailed(reg, {
      storyId: 'US-003', waveIndex: 0, failedAt: 2000,
      reason: 'wrong_api_key', recoveryClass: 'terminal',
      recoveryAttempts: 0, lastRecoveryAt: null, recoveryInFlight: false,
    });
    markFailed(reg, {
      storyId: 'US-005', waveIndex: 1, failedAt: 3000,
      reason: 'blocked_by: US-001', recoveryClass: 'terminal',
      recoveryAttempts: 0, lastRecoveryAt: null, recoveryInFlight: false,
    });

    expect(reg.size).toBe(3);
    expect(isFailed(reg, 'US-001')).toBe(true);
    expect(isFailed(reg, 'US-002')).toBe(false);
    expect(isFailed(reg, 'US-003')).toBe(true);
    expect(isFailed(reg, 'US-005')).toBe(true);

    // Remove one — others unaffected
    removeFailure(reg, 'US-001');
    expect(reg.size).toBe(2);
    expect(isFailed(reg, 'US-001')).toBe(false);
    expect(isFailed(reg, 'US-003')).toBe(true);
  });
});
