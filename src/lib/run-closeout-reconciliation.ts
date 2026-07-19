/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Pure Run View reconciliation. Process completion is transport evidence;
 * `run_closeout` is the authoritative semantic outcome. Story success is only
 * derived from explicit result/state/WAL evidence, never list position.
 */

export type RunViewStatus =
  | 'running'
  | 'paused'
  | 'blocked'
  | 'done'
  | 'failed'
  | 'partial_failure'
  | 'cancelled'
  | 'scope_passed'
  | 'incomplete';

export type ReconciledStoryStatus =
  | 'pending'
  | 'running'
  | 'pass'
  | 'fail'
  | 'blocked'
  | 'skip'
  | 'excluded'
  | 'retry'
  | 'no_result';

export interface ReconciliationEvent {
  id?: number;
  event_type: string;
  story_id?: string | null;
  payload?: unknown;
}

export interface ReconciliationStoryResult {
  story_id: string;
  status: string;
  reason?: string | null;
  blocked_by?: string | null;
  finished_at?: string | null;
}

export interface ReconciliationRunStateStory {
  storyId: string;
  status: 'passed' | 'failed' | 'skipped';
  finishedAt?: string | null;
}

export interface ReconciliationRunState {
  completedStories?: ReconciliationRunStateStory[];
  failedStories?: ReconciliationRunStateStory[];
  skippedStories?: ReconciliationRunStateStory[];
  currentStory?: string | null;
  resumedFromStory?: string | null;
}

export interface ReconciliationSpecStory {
  id: string;
  excluded?: boolean;
}

export interface ReconcileRunCloseoutInput {
  runId?: number;
  persistedStatus: string;
  runStartedAt?: string | null;
  retriedFromRunId?: number | null;
  events?: ReconciliationEvent[];
  storyResults?: ReconciliationStoryResult[];
  specStories?: ReconciliationSpecStory[];
  runState?: ReconciliationRunState | null;
}

export interface RunCloseoutReconciliation {
  status: RunViewStatus;
  terminal: boolean;
  authoritativeCloseout: boolean;
  storyStatuses: Map<string, ReconciledStoryStatus>;
  carriedForwardStoryIds: Set<string>;
  counts: {
    passed: number;
    failed: number;
    blocked: number;
    skipped: number;
    unresolved: number;
    total: number;
  };
}

const TERMINAL_STATUSES = new Set<RunViewStatus>([
  'done',
  'failed',
  'partial_failure',
  'cancelled',
  'scope_passed',
  'incomplete',
]);

function objectPayload(payload: unknown): Record<string, unknown> | null {
  let value = payload;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function eventBelongsToRun(event: ReconciliationEvent, runId?: number): boolean {
  if (runId == null) return true;
  const payload = objectPayload(event.payload);
  return payload?.run_id == null || String(payload.run_id) === String(runId);
}

function normalizeStatus(value: unknown): RunViewStatus | null {
  if (typeof value !== 'string') return null;
  switch (value.toLowerCase()) {
    case 'done':
    case 'passed':
    case 'finished': return 'done';
    case 'failed': return 'failed';
    case 'partial':
    case 'partial_failure': return 'partial_failure';
    case 'cancelled':
    case 'canceled': return 'cancelled';
    case 'scope_passed': return 'scope_passed';
    case 'incomplete': return 'incomplete';
    case 'paused': return 'paused';
    case 'blocked': return 'blocked';
    case 'running':
    case 'starting':
    case 'pty_attached':
    case 'validating': return 'running';
    default: return null;
  }
}

function isBeforeOrAt(value: string | null | undefined, boundary: string | null | undefined): boolean {
  if (!value || !boundary) return false;
  const time = Date.parse(value);
  const boundaryTime = Date.parse(boundary);
  return Number.isFinite(time) && Number.isFinite(boundaryTime) && time <= boundaryTime;
}

function isPreviouslyPassed(payload: Record<string, unknown> | null): boolean {
  return payload?.reason === 'previously_passed';
}

function blockedByPayload(payload: Record<string, unknown> | null): boolean {
  return payload?.reason === 'blocked_by' && Array.isArray(payload.blockedBy);
}

function deriveStoryEvidence(
  input: ReconcileRunCloseoutInput,
  events: ReconciliationEvent[],
): { statuses: Map<string, ReconciledStoryStatus>; carried: Set<string> } {
  const statuses = new Map<string, ReconciledStoryStatus>();
  const carried = new Set<string>();
  const runState = input.runState;

  for (const story of runState?.completedStories ?? []) statuses.set(story.storyId, 'pass');
  for (const story of runState?.failedStories ?? []) statuses.set(story.storyId, 'fail');
  for (const story of runState?.skippedStories ?? []) statuses.set(story.storyId, 'skip');

  for (const story of runState?.completedStories ?? []) {
    if (story.status === 'passed' && runState?.resumedFromStory && isBeforeOrAt(story.finishedAt, input.runStartedAt)) {
      carried.add(story.storyId);
    }
  }

  if (runState?.currentStory && !statuses.has(runState.currentStory)) {
    statuses.set(runState.currentStory, 'running');
  }

  for (const result of input.storyResults ?? []) {
    if (result.status === 'pass') {
      statuses.set(result.story_id, 'pass');
      // Governed retries copy canonical prior pass rows with their original
      // completion timestamp. That timestamp is explicit carry-forward evidence.
      if (input.retriedFromRunId != null && isBeforeOrAt(result.finished_at, input.runStartedAt)) {
        carried.add(result.story_id);
      }
    } else if (result.status === 'fail') {
      statuses.set(result.story_id, 'fail');
    } else if (result.status === 'skip') {
      if (result.reason === 'previously_passed') {
        statuses.set(result.story_id, 'pass');
        carried.add(result.story_id);
      } else {
        statuses.set(result.story_id, result.blocked_by ? 'blocked' : 'skip');
      }
    } else if (result.status === 'excluded') {
      statuses.set(result.story_id, 'excluded');
    } else if (result.status === 'retry') {
      statuses.set(result.story_id, 'retry');
    } else if (result.status === 'running') {
      statuses.set(result.story_id, 'running');
    }
  }

  for (const event of events) {
    if (!event.story_id) continue;
    const payload = objectPayload(event.payload);
    switch (event.event_type) {
      case 'story_started':
      case 'story_retried':
        statuses.set(event.story_id, 'running');
        break;
      case 'story_passed':
        statuses.set(event.story_id, 'pass');
        break;
      case 'story_failed':
        statuses.set(event.story_id, blockedByPayload(payload) ? 'blocked' : 'fail');
        break;
      case 'story_skipped':
        if (isPreviouslyPassed(payload)) {
          statuses.set(event.story_id, 'pass');
          carried.add(event.story_id);
        } else {
          statuses.set(event.story_id, 'skip');
        }
        break;
      case 'story_excluded_from_run':
        statuses.set(event.story_id, 'excluded');
        break;
    }
  }

  for (const story of input.specStories ?? []) {
    if (!statuses.has(story.id)) statuses.set(story.id, story.excluded ? 'excluded' : 'pending');
  }

  return { statuses, carried };
}

function deriveProcessStatus(persistedStatus: string, events: ReconciliationEvent[]): RunViewStatus {
  const persisted = normalizeStatus(persistedStatus) ?? 'running';
  const adverse: RunViewStatus[] = [];
  let finishedStatus: RunViewStatus | null = null;
  let activeStatus: RunViewStatus | null = null;

  if (persisted === 'failed' || persisted === 'partial_failure' || persisted === 'cancelled') adverse.push(persisted);
  else if (persisted === 'done' || persisted === 'scope_passed' || persisted === 'incomplete') finishedStatus = persisted;

  for (const event of events) {
    const payload = objectPayload(event.payload);
    if (event.event_type === 'run_failed') adverse.push('failed');
    else if (event.event_type === 'run_cancelled') adverse.push('cancelled');
    else if (event.event_type === 'run_finished') {
      const status = normalizeStatus(payload?.status) ?? 'done';
      if (status === 'failed' || status === 'partial_failure' || status === 'cancelled') adverse.push(status);
      else finishedStatus = status;
    } else if (event.event_type === 'run_paused') activeStatus = 'paused';
    else if (event.event_type === 'run_blocked') activeStatus = 'blocked';
    else if (event.event_type === 'run_resumed' || event.event_type === 'run_started') activeStatus = 'running';
  }

  // A process-level success event can never erase terminal adverse evidence.
  if (adverse.includes('cancelled')) return 'cancelled';
  if (adverse.includes('failed')) return 'failed';
  if (adverse.includes('partial_failure')) return 'partial_failure';
  return finishedStatus ?? activeStatus ?? persisted;
}

function latestCloseoutStatus(events: ReconciliationEvent[]): RunViewStatus | null {
  let status: RunViewStatus | null = null;
  for (const event of events) {
    if (event.event_type !== 'run_closeout') continue;
    const candidate = normalizeStatus(objectPayload(event.payload)?.status);
    if (candidate) status = candidate;
  }
  return status;
}

export function isTerminalRunViewStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status as RunViewStatus);
}

export function reconcileRunCloseout(input: ReconcileRunCloseoutInput): RunCloseoutReconciliation {
  const events = (input.events ?? []).filter((event) => eventBelongsToRun(event, input.runId));
  const { statuses: initialStoryStatuses, carried } = deriveStoryEvidence(input, events);
  const closeoutStatus = latestCloseoutStatus(events);
  let status = closeoutStatus ?? deriveProcessStatus(input.persistedStatus, events);
  const authoritativeCloseout = closeoutStatus !== null;

  const retryPayloads = events
    .filter((event) => event.event_type === 'run_finished' || event.event_type === 'run_closeout')
    .map((event) => objectPayload(event.payload))
    .filter((payload): payload is Record<string, unknown> => payload !== null);
  const isRetry = input.retriedFromRunId != null || retryPayloads.some((payload) =>
    payload.original_run_id != null || payload.source === 'worker_retry'
  );
  const explicitFullSpecComplete = retryPayloads.some((payload) => payload.full_spec_complete === true);

  const requiredStoryIds = (input.specStories ?? []).filter((story) => !story.excluded).map((story) => story.id);
  const requiredStatuses = requiredStoryIds.map((storyId) => initialStoryStatuses.get(storyId) ?? 'pending');
  const hasFailedStory = requiredStatuses.some((storyStatus) => storyStatus === 'fail');
  const hasBlockedStory = requiredStatuses.some((storyStatus) => storyStatus === 'blocked');
  const hasExplicitPass = requiredStatuses.some((storyStatus) => storyStatus === 'pass');
  const hasFullExplicitCoverage = requiredStoryIds.length === 0 || requiredStatuses.every((storyStatus) => storyStatus === 'pass');

  // A nominal success cannot coexist with failed or missing story evidence.
  // This is a consistency guard, not a new pass/failure inference.
  if (status === 'done') {
    if (hasFailedStory || hasBlockedStory) {
      status = 'partial_failure';
    } else if (requiredStoryIds.length > 0 && !hasFullExplicitCoverage) {
      status = isRetry && !explicitFullSpecComplete && hasExplicitPass ? 'scope_passed' : 'incomplete';
    } else if (isRetry && !explicitFullSpecComplete) {
      status = hasExplicitPass ? 'scope_passed' : 'incomplete';
    }
  }

  const terminal = isTerminalRunViewStatus(status);
  const storyStatuses = new Map(initialStoryStatuses);
  if (terminal) {
    for (const [storyId, storyStatus] of storyStatuses) {
      if (storyStatus === 'running' || storyStatus === 'retry') storyStatuses.set(storyId, 'no_result');
    }
  }

  let passed = 0;
  let failed = 0;
  let blocked = 0;
  let skipped = 0;
  let unresolved = 0;
  for (const story of input.specStories ?? []) {
    const storyStatus = storyStatuses.get(story.id) ?? 'pending';
    if (storyStatus === 'pass') passed++;
    else if (storyStatus === 'fail') failed++;
    else if (storyStatus === 'blocked') blocked++;
    else if (storyStatus === 'skip' || storyStatus === 'excluded') skipped++;
    else unresolved++;
  }

  return {
    status,
    terminal,
    authoritativeCloseout,
    storyStatuses,
    carriedForwardStoryIds: carried,
    counts: { passed, failed, blocked, skipped, unresolved, total: input.specStories?.length ?? storyStatuses.size },
  };
}
