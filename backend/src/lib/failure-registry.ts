/**
 * Failure Registry — CP-002
 *
 * Replaces the `failedIds: Set<string>` with a richer `Map<string, FailureRecord>`
 * that tracks per-failure metadata: when it failed, what wave, classification,
 * recovery attempts, and worktree state.
 *
 * Pure data structure + helpers — no side effects, no DB calls.
 */

import type { RecoveryClass, FailureReason } from './failure-classifier';

// ─── FailureRecord ──────────────────────────────────────────────────────────

export interface FailureRecord {
  storyId: string;
  waveIndex: number;
  failedAt: number;                 // Date.now() epoch ms
  reason: string;                   // human-readable or FailureReason string
  recoveryClass: RecoveryClass;
  recoveryAttempts: number;
  lastRecoveryAt: number | null;    // epoch ms of last recovery attempt, null if none
  recoveryInFlight: boolean;
  conflictingFiles?: string[];
  stderrTail?: string;              // last ~500 chars of stderr for diagnostics
}

// ─── Type alias for the registry itself ─────────────────────────────────────

export type FailureRegistryMap = Map<string, FailureRecord>;

// ─── Helper: create a new empty registry ────────────────────────────────────

export function createFailureRegistry(): FailureRegistryMap {
  return new Map<string, FailureRecord>();
}

// ─── Helper: mark a story as failed ─────────────────────────────────────────

export function markFailed(
  registry: FailureRegistryMap,
  record: FailureRecord,
): void {
  registry.set(record.storyId, record);
}

// ─── Helper: check if a story is in the failure registry ────────────────────

export function isFailed(
  registry: FailureRegistryMap,
  storyId: string,
): boolean {
  return registry.has(storyId);
}

// ─── Helper: get a failure record (or undefined) ────────────────────────────

export function getFailureRecord(
  registry: FailureRegistryMap,
  storyId: string,
): FailureRecord | undefined {
  return registry.get(storyId);
}

// ─── Helper: remove a story from the registry (recovery succeeded) ──────────

export function removeFailure(
  registry: FailureRegistryMap,
  storyId: string,
): boolean {
  return registry.delete(storyId);
}

// ─── Helper: extract a Set<string> of failed IDs for compatibility ──────────
// computeBlockedStories and other consumers that only need the key set.

export function failedIdSet(registry: FailureRegistryMap): Set<string> {
  return new Set(registry.keys());
}
