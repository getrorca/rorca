/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  SingleStoryWaveDirectExecutionError,
  WAVE_REJECTION_MESSAGE_MAX_CHARS,
  WAVE_REJECTION_STACK_MAX_CHARS,
  accountWaveSettlement,
  assertSingleStoryWaveDirectExecution,
  attemptCompleteFailureEvidence,
  computeTransitivelyBlockedStories,
  normalizeWaveRejection,
  parallelRunExitCode,
  requiresPerStoryWorktree,
  selectWaveWorktreeCleanup,
  shouldRouteCompletedRunWorktree,
  type WaveAccountingState,
} from '../parallel-wave-core';

function accountingState(): WaveAccountingState {
  return {
    failedIds: new Set(),
    processedIds: new Set(),
    rejectedIds: new Set(),
    preserveWorktreeIds: new Set(),
    cleanupWorktreeIds: new Set(),
  };
}

describe('parallel-wave rejection evidence', () => {
  test('normalizes, bounds, and redacts durable rejection fields while retaining a local-only raw diagnostic', () => {
    const secret = 'sk-test_REALLY_SECRET_TOKEN_1234567890';
    const error = new Error(`dispatch exploded with token ${secret} ${'x'.repeat(3_000)}`);
    error.stack = `${error.name}: ${error.message}\n${`at worker (${secret})\n`.repeat(1_000)}`;

    const normalized = normalizeWaveRejection(error);

    expect(normalized.message.length).toBeLessThanOrEqual(WAVE_REJECTION_MESSAGE_MAX_CHARS);
    expect(normalized.stack.length).toBeLessThanOrEqual(WAVE_REJECTION_STACK_MAX_CHARS);
    expect(normalized.message).not.toContain(secret);
    expect(normalized.stack).not.toContain(secret);
    expect(normalized.rawDiagnostic).toContain(secret);
  });

  test('attempts spec, run-state, WAL, and story-result failure evidence even after an earlier rejection', async () => {
    const calls: string[] = [];
    const failures = await attemptCompleteFailureEvidence([
      { label: 'spec', run: () => { calls.push('spec'); } },
      { label: 'run-state', run: () => { calls.push('run-state'); throw new Error('disk busy'); } },
      { label: 'story_failed', run: async () => { calls.push('story_failed'); } },
      { label: 'story-result', run: async () => { calls.push('story-result'); } },
    ]);

    expect(calls).toEqual(['spec', 'run-state', 'story_failed', 'story-result']);
    expect(failures.map(failure => failure.label)).toEqual(['run-state']);
  });

  test('accounts a rejection as failed and processed before direct and transitive dependency analysis', () => {
    const state = accountingState();
    accountWaveSettlement({ storyId: 'US-001', settlement: 'rejected', hasWorktree: true }, state);
    const blocked = computeTransitivelyBlockedStories([
      { id: 'US-001' },
      { id: 'US-002', dependsOn: ['US-001'] },
      { id: 'US-003', dependsOn: ['US-002'] },
    ], state.failedIds, state.processedIds);

    expect(state.failedIds).toEqual(new Set(['US-001']));
    expect(state.processedIds).toEqual(new Set(['US-001']));
    expect(state.rejectedIds).toEqual(new Set(['US-001']));
    expect(state.preserveWorktreeIds).toEqual(new Set(['US-001']));
    expect(blocked).toEqual(new Map([
      ['US-002', ['US-001']],
      ['US-003', ['US-002']],
    ]));
  });
});

describe('parallel-wave worktree and closeout policy', () => {
  test('preserves exactly requested known worktrees and never cleans unrelated worktrees', () => {
    const selected = selectWaveWorktreeCleanup(
      ['rejected', 'ordinary-failure', 'success'],
      new Set(['rejected', 'ordinary-failure', 'success', 'unrelated']),
      new Set(['rejected', 'unrelated']),
    );

    expect(selected).toEqual({
      cleanupIds: ['ordinary-failure', 'success'],
      preservedIds: ['rejected'],
    });
  });

  test('any rejected, failed, unresolved closeout, or evidence gap forces non-zero semantics', () => {
    expect(parallelRunExitCode({ failedIds: new Set(), rejectedIds: new Set(), pendingCloseoutIds: new Set() })).toBe(0);
    expect(parallelRunExitCode({ failedIds: new Set(['failed']), rejectedIds: new Set(), pendingCloseoutIds: new Set() })).toBe(1);
    expect(parallelRunExitCode({ failedIds: new Set(), rejectedIds: new Set(['rejected']), pendingCloseoutIds: new Set() })).toBe(1);
    expect(parallelRunExitCode({ failedIds: new Set(), rejectedIds: new Set(), pendingCloseoutIds: new Set(['pending']) })).toBe(1);
    expect(parallelRunExitCode({ failedIds: new Set(), rejectedIds: new Set(), pendingCloseoutIds: new Set(), evidenceFailureIds: new Set(['gap']) })).toBe(1);
  });

  test('never routes a failed engine outcome into successful run-worktree closeout', () => {
    const completeWorktree = { hasWorktreePath: true, hasBranchName: true, allSpecStoriesPassed: true };
    expect(shouldRouteCompletedRunWorktree({ status: 'failed', ...completeWorktree })).toBe(false);
    expect(shouldRouteCompletedRunWorktree({ status: 'done', ...completeWorktree })).toBe(true);
  });

  test('uses the run branch for singleton waves and fails closed on a stale isolated manifest cwd', () => {
    expect(requiresPerStoryWorktree(1)).toBe(false);
    expect(requiresPerStoryWorktree(2)).toBe(true);
    expect(() => assertSingleStoryWaveDirectExecution('US-001', '/tmp/run', '/tmp/run')).not.toThrow();
    expect(() => assertSingleStoryWaveDirectExecution('US-001', '/tmp/run', '/tmp/old-story-worktree'))
      .toThrow(SingleStoryWaveDirectExecutionError);
  });
});
