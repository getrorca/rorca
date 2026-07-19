/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as path from 'node:path';
import { inspect } from 'node:util';
import { contextSafeString } from './context-safety';

export const WAVE_REJECTION_MESSAGE_MAX_CHARS = 2_048;
export const WAVE_REJECTION_STACK_MAX_CHARS = 8_192;
export const WAVE_REJECTION_RAW_MAX_CHARS = 65_536;

export interface NormalizedWaveRejection {
  message: string;
  stack: string;
  /** Local-only diagnostic. Never place this value in WAL or story-result payloads. */
  rawDiagnostic: string;
  rawTruncated: boolean;
}

function rawRejectionDiagnostic(reason: unknown): string {
  if (reason instanceof Error) return reason.stack || `${reason.name}: ${reason.message}`;
  if (typeof reason === 'string') return reason;
  return inspect(reason, { depth: 8, maxArrayLength: 200, maxStringLength: WAVE_REJECTION_RAW_MAX_CHARS, breakLength: 120 });
}

/**
 * Produce bounded, secret-redacted fields for durable evidence while retaining a
 * bounded raw value solely for a mode-0600 local diagnostic file.
 */
function boundedSafeDiagnostic(value: string, maxChars: number): string {
  // Bound the redaction workload as well as its final output. Two output windows
  // retain enough source for redaction patterns which straddle the first window.
  const source = value.slice(0, maxChars * 2);
  const safe = contextSafeString(source, { maxStringChars: source.length + 1 }).value;
  if (safe.length <= maxChars && value.length <= source.length) return safe;
  const suffix = '… [truncated]';
  return `${safe.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`;
}

export function normalizeWaveRejection(reason: unknown): NormalizedWaveRejection {
  const raw = rawRejectionDiagnostic(reason).replace(/\r\n/g, '\n');
  const rawTruncated = raw.length > WAVE_REJECTION_RAW_MAX_CHARS;
  const rawDiagnostic = rawTruncated
    ? `${raw.slice(0, WAVE_REJECTION_RAW_MAX_CHARS)}\n… [raw diagnostic truncated]`
    : raw;
  const unredactedMessage = reason instanceof Error
    ? `${reason.name}: ${reason.message}`
    : typeof reason === 'string'
      ? reason.split('\n', 1)[0]
      : 'Wave story promise rejected with a non-Error value';
  const unredactedStack = reason instanceof Error && reason.stack
    ? reason.stack
    : raw;

  return {
    message: boundedSafeDiagnostic(unredactedMessage, WAVE_REJECTION_MESSAGE_MAX_CHARS),
    stack: boundedSafeDiagnostic(unredactedStack, WAVE_REJECTION_STACK_MAX_CHARS),
    rawDiagnostic,
    rawTruncated,
  };
}

export type WaveStoryOutcome = 'passed' | 'failed' | 'skipped' | 'closeout_blocked';

export interface WaveAccountingState {
  failedIds: Set<string>;
  processedIds: Set<string>;
  rejectedIds: Set<string>;
  preserveWorktreeIds: Set<string>;
  cleanupWorktreeIds: Set<string>;
}

/** Correlate one settled task with its input story before any dependent analysis. */
export function accountWaveSettlement(input: {
  storyId: string;
  settlement: 'fulfilled' | 'rejected';
  outcome?: WaveStoryOutcome;
  hasWorktree: boolean;
}, state: WaveAccountingState): void {
  state.processedIds.add(input.storyId);
  if (input.settlement === 'rejected') {
    state.failedIds.add(input.storyId);
    state.rejectedIds.add(input.storyId);
    if (input.hasWorktree) state.preserveWorktreeIds.add(input.storyId);
    return;
  }

  if (input.outcome === 'passed') return;
  state.failedIds.add(input.storyId);
  if (!input.hasWorktree) return;
  if (input.outcome === 'closeout_blocked') state.preserveWorktreeIds.add(input.storyId);
  else state.cleanupWorktreeIds.add(input.storyId);
}

export interface FailureEvidenceStep {
  label: string;
  run: () => void | Promise<void>;
}

/** Attempt every durable failure projection even if one channel fails. */
export async function attemptCompleteFailureEvidence(steps: FailureEvidenceStep[]): Promise<Array<{ label: string; error: unknown }>> {
  const failures: Array<{ label: string; error: unknown }> = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (error: unknown) {
      failures.push({ label: step.label, error });
    }
  }
  return failures;
}

/**
 * Cleanup is constrained to worktrees created/resolved for this wave. A preserve
 * decision always wins, and unrelated repository worktrees cannot enter output.
 */
export function selectWaveWorktreeCleanup(
  knownStoryIds: Iterable<string>,
  cleanupRequestedIds: ReadonlySet<string>,
  preserveIds: ReadonlySet<string>,
): { cleanupIds: string[]; preservedIds: string[] } {
  const known = new Set(knownStoryIds);
  return {
    cleanupIds: [...cleanupRequestedIds].filter(id => known.has(id) && !preserveIds.has(id)).sort(),
    preservedIds: [...preserveIds].filter(id => known.has(id)).sort(),
  };
}

export function requiresPerStoryWorktree(compiledWaveSize: number): boolean {
  return compiledWaveSize > 1;
}

export class SingleStoryWaveDirectExecutionError extends Error {
  readonly code = 'SINGLE_STORY_WAVE_DIRECT_EXECUTION_UNSAFE';

  constructor(storyId: string, runCwd: string, guardedCwd: string) {
    super(`${storyId} cannot execute directly on the run branch: frozen guarded cwd ${guardedCwd} does not match run cwd ${runCwd}`);
    this.name = 'SingleStoryWaveDirectExecutionError';
  }
}

/** Fail closed before execution when an older frozen manifest requires another cwd. */
export function assertSingleStoryWaveDirectExecution(storyId: string, runCwd: string, guardedCwd?: string | null): void {
  if (!guardedCwd) return;
  if (path.resolve(guardedCwd) !== path.resolve(runCwd)) {
    throw new SingleStoryWaveDirectExecutionError(storyId, runCwd, guardedCwd);
  }
}

export interface BlockingStory {
  id: string;
  dependsOn?: string[];
  excluded?: boolean;
  skipped?: boolean;
  passed?: boolean;
  passes?: boolean;
  status?: string;
}

/** Compute direct and transitive blockers from the already-accounted failure set. */
export function computeTransitivelyBlockedStories(
  allStories: BlockingStory[],
  failedIds: ReadonlySet<string>,
  alreadyProcessed: ReadonlySet<string>,
): Map<string, string[]> {
  const blocked = new Map<string, string[]>();
  const unprocessed = allStories.filter(story => (
    !alreadyProcessed.has(story.id)
    && !failedIds.has(story.id)
    && !story.excluded
    && !story.skipped
    && !story.passed
    && story.passes !== true
    && story.status !== 'passed'
  ));
  const allBlockedIds = new Set(failedIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const story of unprocessed) {
      if (allBlockedIds.has(story.id)) continue;
      const blockers = (story.dependsOn ?? []).filter(dependency => allBlockedIds.has(dependency));
      if (blockers.length === 0) continue;
      allBlockedIds.add(story.id);
      blocked.set(story.id, blockers);
      changed = true;
    }
  }
  return blocked;
}

export function shouldRouteCompletedRunWorktree(input: {
  status: string;
  hasWorktreePath: boolean;
  hasBranchName: boolean;
  allSpecStoriesPassed: boolean;
}): boolean {
  return input.status === 'done'
    && input.hasWorktreePath
    && input.hasBranchName
    && input.allSpecStoriesPassed;
}

export function parallelRunExitCode(input: {
  failedIds: ReadonlySet<string>;
  rejectedIds: ReadonlySet<string>;
  pendingCloseoutIds: ReadonlySet<string>;
  evidenceFailureIds?: ReadonlySet<string>;
}): 0 | 1 {
  return input.failedIds.size > 0
    || input.rejectedIds.size > 0
    || input.pendingCloseoutIds.size > 0
    || (input.evidenceFailureIds?.size ?? 0) > 0
    ? 1
    : 0;
}
