/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/** Coherent whole-run ownership bounds shared by every pipeline send/requeue path. */

export const DEFAULT_STORY_TIMEOUT_MINUTES = 90;
export const MIN_STORY_TIMEOUT_MINUTES = 5;
export const MAX_STORY_TIMEOUT_MINUTES = 240;
export const PIPELINE_STORY_ATTEMPT_BUDGET = 16;
export const MIN_PIPELINE_EXECUTION_TIMEOUT_SECONDS = 2 * 60 * 60;
export const MAX_PIPELINE_EXECUTION_TIMEOUT_SECONDS = 14 * 24 * 60 * 60;
export const PIPELINE_CLOSEOUT_GRACE_SECONDS = 24 * 60 * 60;
/**
 * pg-boss hard-asserts job expiration strictly below 24 hours (attorney
 * POLICY.MAX_EXPIRATION_HOURS = 24). The transport expiration is a liveness
 * signal for the queue, NOT the execution bound: the worker's heartbeat-aware
 * reconciliation keeps a live engine running even after the job expires, and
 * the payload executionTimeoutSeconds is the authoritative whole-run bound.
 * Keep expireInSeconds just under the pg-boss ceiling so long specs (which may
 * legitimately exceed 24h of execution) can still be dispatched.
 */
export const PGBOSS_EXPIRE_IN_CEILING_SECONDS = 23 * 60 * 60;

interface StoryLike {
  id?: unknown;
  timeoutMinutes?: unknown;
  excluded?: unknown;
  passes?: unknown;
}

function storiesFromSpec(spec: Record<string, unknown>): StoryLike[] {
  if (Array.isArray(spec.userStories)) return spec.userStories as StoryLike[];
  if (!Array.isArray(spec.phases)) return [];
  return spec.phases.flatMap((phase) => {
    if (!phase || typeof phase !== 'object' || Array.isArray(phase)) return [];
    const stories = (phase as Record<string, unknown>).stories;
    return Array.isArray(stories) ? stories as StoryLike[] : [];
  });
}

export function normalizeStoryTimeoutMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_STORY_TIMEOUT_MINUTES;
  return Math.min(MAX_STORY_TIMEOUT_MINUTES, Math.max(MIN_STORY_TIMEOUT_MINUTES, Math.ceil(value)));
}

/**
 * The engine permits bounded retries, rate-limit retries, and one fallback
 * engine. Sixteen full story-timeout windows is a deliberately conservative
 * upper bound. A 14-day cap is the worker-enforced hard run limit.
 */
export function computePipelineExecutionTimeoutSeconds(
  spec: Record<string, unknown>,
  selectedStoryIds?: readonly string[],
): number {
  const selected = selectedStoryIds ? new Set(selectedStoryIds) : null;
  const executable = storiesFromSpec(spec).filter((story) => {
    if (typeof story.id !== 'string' || !story.id.trim()) return false;
    if (selected) return selected.has(story.id);
    return story.excluded !== true && story.passes !== true;
  });
  const boundedStories = executable.length > 0 ? executable : [{ timeoutMinutes: DEFAULT_STORY_TIMEOUT_MINUTES }];
  const storySeconds = boundedStories.reduce(
    (total, story) => total + normalizeStoryTimeoutMinutes(story.timeoutMinutes) * 60 * PIPELINE_STORY_ATTEMPT_BUDGET,
    0,
  );
  // Include one hour for engine setup, validation, telemetry flushing, and
  // process TERM/KILL escalation before semantic closeout begins.
  const requested = storySeconds + 60 * 60;
  return Math.min(
    MAX_PIPELINE_EXECUTION_TIMEOUT_SECONDS,
    Math.max(MIN_PIPELINE_EXECUTION_TIMEOUT_SECONDS, requested),
  );
}

export function assertPipelineExecutionTimeoutSeconds(value: unknown): number {
  if (!Number.isSafeInteger(value)
    || Number(value) < MIN_PIPELINE_EXECUTION_TIMEOUT_SECONDS
    || Number(value) > MAX_PIPELINE_EXECUTION_TIMEOUT_SECONDS) {
    throw new Error('Pipeline job lacks a valid worker-enforced whole-run timeout');
  }
  return Number(value);
}

/** pg-boss transport ownership always outlives the hard child/run bound. */
export function pipelineExecutionJobSendOptions(
  payload: { executionTimeoutSeconds?: unknown },
): { expireInSeconds: number } {
  const requested = assertPipelineExecutionTimeoutSeconds(payload.executionTimeoutSeconds)
    + PIPELINE_CLOSEOUT_GRACE_SECONDS;
  return {
    // Clamp to the pg-boss transport ceiling; the run itself is bounded by the
    // payload execution timeout and the worker's heartbeat-aware reconciliation.
    expireInSeconds: Math.min(requested, PGBOSS_EXPIRE_IN_CEILING_SECONDS),
  };
}
