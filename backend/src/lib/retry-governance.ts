/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { AuthoritativeRetryScope } from './governed-story-retry';

export const RETRY_PREVIEW_SCHEMA_VERSION = 'retry-preview.v1' as const;

export type RetryStoryReasonCode =
  | 'REQUESTED_FAILED_STORY'
  | 'REQUIRED_FAILED_DEPENDENCY'
  | 'PASSED_RESULT_COPIED_NOT_EXECUTABLE'
  | 'FAILED_NOT_REQUESTED'
  | 'SPEC_MARKED_SKIPPED'
  | 'SPEC_MARKED_EXCLUDED'
  | 'RECONCILED_NOT_FAILED'
  | 'EXECUTABLE_RETRY_WORK'
  | 'REMAINING_FAILED_WORK';

export interface RetryScopeStory {
  storyId: string;
  reasonCode: RetryStoryReasonCode;
}

export interface RetryScopePacket {
  requested: RetryScopeStory[];
  requiredDependency: RetryScopeStory[];
  copiedPassed: RetryScopeStory[];
  skipped: RetryScopeStory[];
  executable: RetryScopeStory[];
  remaining: RetryScopeStory[];
  excluded: RetryScopeStory[];
}

export interface RetryPlanStory {
  id: string;
  dependsOn?: string[];
  passes?: boolean;
  skipped?: boolean;
  excluded?: boolean;
  model?: string;
  effort?: string;
}

export interface RetryPlanStatus {
  storyId: string;
  status: 'passed' | 'failed' | 'skipped' | 'excluded' | 'other';
}

export interface RetryExecutionOptions {
  agent: 'claude' | 'opencode' | 'codex' | 'pi' | 'omp';
  model: string | null;
  effort: string | null;
  terminalMode: string;
  includeGraph: boolean;
  worktree: { enabled: boolean; path: string | null; branch: string | null };
  merge: { strategy: 'direct' | 'pr' | 'draft-pr' | 'branch-only'; autoMerge: boolean };
  safety: {
    deploy: boolean;
    externalSend: boolean;
    policyLocked: boolean;
    allowBackendJest: false;
  };
}

export interface RetryPreviewPacket {
  schemaVersion: typeof RETRY_PREVIEW_SCHEMA_VERSION;
  originalRunId: number;
  scope: RetryScopePacket;
  /** Present for wave retries; binds accepted integration ancestry and target revision. */
  authority?: AuthoritativeRetryScope;
  options: RetryExecutionOptions;
  forceSequential: boolean;
  requiresApproval: boolean;
  destructiveOperations: readonly ['reset', 'branch_delete', 'force_push', 'auto_merge', 'deploy', 'external_send'];
  previewHash: string;
}

export interface RetryPreviewIdentity {
  schemaVersion: 'retry-preview-identity.v1';
  previewHash: string;
  originalRunId: number;
  expiresAt: string;
  signature: string;
}

const RETRY_PREVIEW_IDENTITY_TTL_MS = 10 * 60 * 1_000;

function previewIdentitySecret(): string {
  return process.env.RORCA_RETRY_PREVIEW_SECRET
    ?? process.env.JWT_SECRET
    ?? 'rorca-local-retry-preview-identity-v1';
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function retryHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

function item(storyId: string, reasonCode: RetryStoryReasonCode): RetryScopeStory {
  return { storyId, reasonCode };
}

function uniqueSorted(items: RetryScopeStory[]): RetryScopeStory[] {
  return [...new Map(items.map((entry) => [entry.storyId, entry])).values()]
    .sort((a, b) => a.storyId.localeCompare(b.storyId));
}

/**
 * Resolve retry scope before dispatch. Dependencies are included only when they
 * are still failed; passed dependencies remain copied evidence and are never
 * executable work.
 */
export function resolveRetryScope(input: {
  stories: RetryPlanStory[];
  statuses: RetryPlanStatus[];
  requestedStoryIds?: string[];
}): RetryScopePacket {
  const storyById = new Map(input.stories.map((story) => [story.id, story]));
  const statusById = new Map(input.statuses.map((status) => [status.storyId, status.status]));
  const failedIds = new Set(input.statuses.filter((entry) => entry.status === 'failed').map((entry) => entry.storyId));
  const requestedIds = new Set(
    input.requestedStoryIds?.length
      ? input.requestedStoryIds.filter((id) => failedIds.has(id))
      : [...failedIds],
  );
  const dependencyIds = new Set<string>();
  const visit = (storyId: string): void => {
    for (const dependencyId of storyById.get(storyId)?.dependsOn ?? []) {
      if (dependencyIds.has(dependencyId)) continue;
      dependencyIds.add(dependencyId);
      visit(dependencyId);
    }
  };
  requestedIds.forEach(visit);

  const requested = [...requestedIds].map((id) => item(id, 'REQUESTED_FAILED_STORY'));
  const requiredDependency = [...dependencyIds]
    .filter((id) => failedIds.has(id) && !requestedIds.has(id))
    .map((id) => item(id, 'REQUIRED_FAILED_DEPENDENCY'));
  const executableIds = new Set([...requestedIds, ...requiredDependency.map((entry) => entry.storyId)]);
  const copiedPassed: RetryScopeStory[] = [];
  const skipped: RetryScopeStory[] = [];
  const excluded: RetryScopeStory[] = [];
  const remaining: RetryScopeStory[] = [];

  for (const story of input.stories) {
    const status = statusById.get(story.id) ?? 'other';
    if (story.excluded || status === 'excluded') {
      excluded.push(item(story.id, 'SPEC_MARKED_EXCLUDED'));
    } else if (story.skipped || status === 'skipped') {
      skipped.push(item(story.id, 'SPEC_MARKED_SKIPPED'));
    } else if (status === 'passed') {
      copiedPassed.push(item(story.id, 'PASSED_RESULT_COPIED_NOT_EXECUTABLE'));
    } else if (failedIds.has(story.id) && !executableIds.has(story.id)) {
      skipped.push(item(story.id, 'FAILED_NOT_REQUESTED'));
      remaining.push(item(story.id, 'REMAINING_FAILED_WORK'));
    } else if (!failedIds.has(story.id) && !executableIds.has(story.id)) {
      excluded.push(item(story.id, 'RECONCILED_NOT_FAILED'));
    }
  }

  return {
    requested: uniqueSorted(requested),
    requiredDependency: uniqueSorted(requiredDependency),
    copiedPassed: uniqueSorted(copiedPassed),
    skipped: uniqueSorted(skipped),
    executable: uniqueSorted([...executableIds].map((id) => item(id, 'EXECUTABLE_RETRY_WORK'))),
    remaining: uniqueSorted(remaining),
    excluded: uniqueSorted(excluded),
  };
}

export function createRetryPreview(input: Omit<RetryPreviewPacket, 'schemaVersion' | 'previewHash' | 'destructiveOperations'>): RetryPreviewPacket {
  const base = {
    schemaVersion: RETRY_PREVIEW_SCHEMA_VERSION,
    ...input,
    destructiveOperations: ['reset', 'branch_delete', 'force_push', 'auto_merge', 'deploy', 'external_send'] as const,
  };
  return { ...base, previewHash: retryHash(base) };
}

export function verifyRetryPreview(preview: RetryPreviewPacket): boolean {
  const { previewHash, ...base } = preview;
  return preview.schemaVersion === RETRY_PREVIEW_SCHEMA_VERSION && retryHash(base) === previewHash;
}

function previewIdentitySignature(value: Omit<RetryPreviewIdentity, 'signature'>): string {
  return `sha256:${createHmac('sha256', previewIdentitySecret()).update(canonical(value)).digest('hex')}`;
}

/** Create a restart-stable, self-verifying expiry identity without persisting preview state. */
export function createRetryPreviewIdentity(
  preview: RetryPreviewPacket,
  now = new Date(),
  ttlMs = RETRY_PREVIEW_IDENTITY_TTL_MS,
): RetryPreviewIdentity {
  const unsigned = {
    schemaVersion: 'retry-preview-identity.v1' as const,
    previewHash: preview.previewHash,
    originalRunId: preview.originalRunId,
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };
  return { ...unsigned, signature: previewIdentitySignature(unsigned) };
}

export function verifyRetryPreviewIdentity(
  identity: RetryPreviewIdentity,
  preview: RetryPreviewPacket,
  now = new Date(),
): { valid: boolean; reason: 'valid' | 'mismatch' | 'expired' | 'invalid_signature' } {
  if (identity.schemaVersion !== 'retry-preview-identity.v1'
    || identity.previewHash !== preview.previewHash
    || identity.originalRunId !== preview.originalRunId) {
    return { valid: false, reason: 'mismatch' };
  }
  const expiresAt = new Date(identity.expiresAt);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) {
    return { valid: false, reason: 'expired' };
  }
  const { signature, ...unsigned } = identity;
  const expected = previewIdentitySignature(unsigned);
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    return { valid: false, reason: 'invalid_signature' };
  }
  return { valid: true, reason: 'valid' };
}

/** Freeze an executable-only retry spec without claiming unselected failures passed. */
export function buildGovernedRetrySpec<T extends Record<string, unknown>>(
  spec: T,
  scope: RetryScopePacket,
  executionOverrides: { model?: string; effort?: string } = {},
): T {
  const executable = new Set(scope.executable.map((entry) => entry.storyId));
  const copiedPassed = new Set(scope.copiedPassed.map((entry) => entry.storyId));
  const transform = (stories: RetryPlanStory[]): RetryPlanStory[] => stories.map((story) => {
    const selected = executable.has(story.id);
    return {
      ...story,
      ...(selected && executionOverrides.model ? { model: executionOverrides.model } : {}),
      ...(selected && executionOverrides.effort ? { effort: executionOverrides.effort } : {}),
      // Passed evidence remains passed but is also excluded from this attempt, so
      // copied results never receive manifests or executable scheduler slots.
      // Unselected failures are excluded rather than falsely projected as passed.
      passes: copiedPassed.has(story.id),
      excluded: !selected,
    };
  });
  const copy = structuredClone(spec) as Record<string, unknown>;
  if (Array.isArray(copy.userStories)) {
    copy.userStories = transform(copy.userStories as RetryPlanStory[]);
  }
  if (Array.isArray(copy.phases)) {
    copy.phases = (copy.phases as Array<Record<string, unknown>>).map((phase) => ({
      ...phase,
      ...(Array.isArray(phase.stories) ? { stories: transform(phase.stories as RetryPlanStory[]) } : {}),
    }));
  }
  return copy as T;
}

export function executableStoryIdsFromSpec(spec: Record<string, unknown>): string[] {
  const phaseStories = Array.isArray(spec.phases)
    ? (spec.phases as Array<{ stories?: RetryPlanStory[] }>).flatMap((phase) => phase.stories ?? [])
    : [];
  const stories = (Array.isArray(spec.userStories) ? spec.userStories : phaseStories) as RetryPlanStory[];
  return stories
    .filter((story) => !story.passes && !story.skipped && !story.excluded)
    .map((story) => story.id)
    .sort();
}

export function compareRetryPlanToPreview(spec: Record<string, unknown>, preview: RetryPreviewPacket): {
  matches: boolean;
  approved: string[];
  actual: string[];
  scopeHash: string;
} {
  const approved = preview.scope.executable.map((entry) => entry.storyId).sort();
  const actual = executableStoryIdsFromSpec(spec);
  return {
    matches: canonical(approved) === canonical(actual),
    approved,
    actual,
    scopeHash: retryHash({ approved, actual }),
  };
}
