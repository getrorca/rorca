/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, expect, it } from 'vitest';
import { reconcileRunCloseout, type ReconciliationEvent } from '../run-closeout-reconciliation';

const specStories = [
  { id: 'US-001' },
  { id: 'US-002' },
  { id: 'US-003' },
];

function event(event_type: string, payload: Record<string, unknown>, story_id: string | null = null): ReconciliationEvent {
  return { event_type, payload, story_id };
}

function allPassed() {
  return specStories.map((story) => ({ story_id: story.id, status: 'pass', finished_at: '2026-03-16T00:04:00.000Z' }));
}

describe('reconcileRunCloseout lifecycle authority', () => {
  it('keeps a failed semantic closeout authoritative when it follows process success', () => {
    const result = reconcileRunCloseout({
      persistedStatus: 'done',
      specStories,
      storyResults: [],
      events: [
        event('run_finished', { run_id: 42, status: 'done', exit_code: 0 }),
        event('run_closeout', { run_id: 42, status: 'failed' }),
      ],
    });

    expect(result.status).toBe('failed');
    expect(result.authoritativeCloseout).toBe(true);
  });

  it('does not let a later process success overwrite an earlier failed closeout', () => {
    const result = reconcileRunCloseout({
      persistedStatus: 'done',
      specStories,
      storyResults: [],
      events: [
        event('run_closeout', { run_id: 42, status: 'partial_failure' }),
        event('run_finished', { run_id: 42, status: 'done', exit_code: 0 }),
      ],
    });

    expect(result.status).toBe('partial_failure');
  });

  it('keeps an authoritative cancelled closeout terminal after process success', () => {
    expect(reconcileRunCloseout({
      persistedStatus: 'done',
      events: [
        event('run_closeout', { status: 'cancelled' }),
        event('run_finished', { status: 'done', exit_code: 0 }),
      ],
    }).status).toBe('cancelled');
  });

  it('uses semantic closeout over an adverse process event in either event direction', () => {
    for (const events of [
      [event('run_finished', { status: 'failed', exit_code: 1 }), event('run_closeout', { status: 'done' })],
      [event('run_closeout', { status: 'done' }), event('run_finished', { status: 'failed', exit_code: 1 })],
    ]) {
      expect(reconcileRunCloseout({
        persistedStatus: 'failed',
        specStories,
        storyResults: allPassed(),
        events,
      }).status).toBe('done');
    }
  });

  it('keeps adverse process outcomes sticky when no semantic closeout exists', () => {
    expect(reconcileRunCloseout({
      persistedStatus: 'running',
      events: [
        event('run_finished', { status: 'failed', exit_code: 1 }),
        event('run_finished', { status: 'done', exit_code: 0 }),
      ],
    }).status).toBe('failed');
  });

  it('consumes the dedicated reconciliation receipt as semantic closeout authority', () => {
    const result = reconcileRunCloseout({
      runId: 20260316000550,
      persistedStatus: 'done',
      specStories: [{ id: 'US-001' }],
      storyResults: [{ story_id: 'US-001', status: 'pass' }],
      events: [],
      dedicatedReconciliation: {
        schemaVersion: 'rorca.run-closeout-reconciliation-public.v1',
        runId: 20260316000550,
        workspaceId: 'proof',
        state: 'completed',
        previewHash: `sha256:${'a'.repeat(64)}`,
        immutableAuthorityHash: `sha256:${'b'.repeat(64)}`,
        expiresAt: '2026-07-28T00:00:00.000Z',
        reconciliationEventId: 'event-1',
        reconciledAt: '2026-07-27T00:00:00.000Z',
        resultReceiptHash: `sha256:${'c'.repeat(64)}`,
      },
    });
    expect(result.status).toBe('done');
    expect(result.authoritativeCloseout).toBe(true);
  });

  it('preserves release_pending as explicit non-terminal truth', () => {
    const result = reconcileRunCloseout({
      persistedStatus: 'release_pending',
      specStories: [{ id: 'US-001' }],
      storyResults: [{ story_id: 'US-001', status: 'pass' }],
      events: [],
    });
    expect(result.status).toBe('release_pending');
    expect(result.terminal).toBe(false);
    expect(result.authoritativeCloseout).toBe(false);
  });
});

describe('reconcileRunCloseout story truth', () => {
  it('cannot present Passed when terminal success has zero story evidence', () => {
    const result = reconcileRunCloseout({
      persistedStatus: 'done',
      specStories,
      storyResults: [],
      events: [event('run_closeout', { status: 'done' })],
    });

    expect(result.status).toBe('incomplete');
    expect(result.counts).toMatchObject({ passed: 0, unresolved: 3, total: 3 });
  });

  it('settles terminal orphaned running stories without inventing outcomes', () => {
    const result = reconcileRunCloseout({
      persistedStatus: 'failed',
      specStories,
      storyResults: [],
      runState: {
        completedStories: [],
        failedStories: [],
        skippedStories: [],
        currentStory: 'US-002',
      },
      events: [
        event('story_started', { run_id: 42 }, 'US-001'),
        event('run_closeout', { run_id: 42, status: 'failed' }),
      ],
    });

    expect(result.terminal).toBe(true);
    expect(result.storyStatuses.get('US-001')).toBe('no_result');
    expect(result.storyStatuses.get('US-002')).toBe('no_result');
    expect(result.storyStatuses.get('US-003')).toBe('no_result');
    expect([...result.storyStatuses.values()]).not.toContain('running');
    expect(result.counts.passed).toBe(0);
  });

  it('settles rows from explicit story pass/fail/blocked evidence at closeout', () => {
    const result = reconcileRunCloseout({
      persistedStatus: 'failed',
      specStories,
      storyResults: [],
      events: [
        event('story_started', { run_id: 42 }, 'US-001'),
        event('story_passed', { run_id: 42 }, 'US-001'),
        event('story_started', { run_id: 42 }, 'US-002'),
        event('story_failed', { run_id: 42 }, 'US-002'),
        event('story_started', { run_id: 42 }, 'US-003'),
        event('story_failed', { run_id: 42, reason: 'blocked_by', blockedBy: ['US-002'] }, 'US-003'),
        event('run_closeout', { run_id: 42, status: 'failed' }),
      ],
    });

    expect(result.storyStatuses.get('US-001')).toBe('pass');
    expect(result.storyStatuses.get('US-002')).toBe('fail');
    expect(result.storyStatuses.get('US-003')).toBe('blocked');
    expect(result.counts).toMatchObject({ passed: 1, failed: 1, blocked: 1, unresolved: 0 });
  });
});

describe('reconcileRunCloseout retry scope and carry-forward evidence', () => {
  it('labels a successful one-story retry as scope passed, not full-spec Passed', () => {
    const result = reconcileRunCloseout({
      persistedStatus: 'done',
      retriedFromRunId: 41,
      specStories,
      storyResults: [{ story_id: 'US-002', status: 'pass', finished_at: '2026-03-16T00:06:00.000Z' }],
      events: [event('run_finished', {
        source: 'worker_retry',
        status: 'done',
        retry_scope_complete: true,
        full_spec_complete: false,
        remaining_story_ids: ['US-003'],
      })],
    });

    expect(result.status).toBe('scope_passed');
    expect(result.counts).toMatchObject({ passed: 1, unresolved: 2, total: 3 });
  });

  it('allows full-spec Passed for a retry only with explicit full completion and complete story evidence', () => {
    const result = reconcileRunCloseout({
      persistedStatus: 'done',
      retriedFromRunId: 41,
      specStories,
      storyResults: allPassed(),
      events: [event('run_finished', {
        source: 'worker_retry',
        status: 'done',
        retry_scope_complete: true,
        full_spec_complete: true,
      })],
    });

    expect(result.status).toBe('done');
  });

  it('counts only explicit prior pass/completion evidence as carried forward', () => {
    const result = reconcileRunCloseout({
      persistedStatus: 'running',
      runStartedAt: '2026-03-16T00:05:00.000Z',
      retriedFromRunId: 41,
      specStories,
      storyResults: [
        { story_id: 'US-001', status: 'pass', finished_at: '2026-03-16T00:04:00.000Z' },
        { story_id: 'US-003', status: 'retry', finished_at: null },
      ],
      runState: {
        resumedFromStory: 'US-001',
        currentStory: 'US-003',
        completedStories: [
          { storyId: 'US-001', status: 'passed', finishedAt: '2026-03-16T00:04:00.000Z' },
          // A completion from this run is explicit pass evidence, but not carry-forward.
          { storyId: 'US-002', status: 'passed', finishedAt: '2026-03-16T00:06:00.000Z' },
        ],
      },
    });

    expect([...result.carriedForwardStoryIds]).toEqual(['US-001']);
    expect(result.carriedForwardStoryIds.has('US-002')).toBe(false);
    expect(result.carriedForwardStoryIds.has('US-003')).toBe(false);
  });

  it('does not infer prior stories as carried forward from a later current story', () => {
    const result = reconcileRunCloseout({
      persistedStatus: 'running',
      specStories,
      storyResults: [],
      runState: { currentStory: 'US-003', completedStories: [] },
    });

    expect(result.carriedForwardStoryIds.size).toBe(0);
    expect(result.storyStatuses.get('US-001')).toBe('pending');
    expect(result.storyStatuses.get('US-002')).toBe('pending');
  });
});
