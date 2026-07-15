/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash } from 'node:crypto';

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
}

export interface RetryPlanStatus {
  storyId: string;
  status: 'passed' | 'failed' | 'skipped' | 'excluded' | 'other';
}

export interface RetryExecutionOptions {
  agent: 'claude' | 'opencode' | 'codex' | 'pi';
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
  options: RetryExecutionOptions;
  forceSequential: boolean;
  requiresApproval: boolean;
  destructiveOperations: readonly ['reset', 'branch_delete', 'force_push', 'auto_merge', 'deploy', 'external_send'];
  previewHash: string;
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

/** Freeze an executable-only retry spec without claiming unselected failures passed. */
export function buildGovernedRetrySpec<T extends Record<string, unknown>>(spec: T, scope: RetryScopePacket): T {
  const executable = new Set(scope.executable.map((entry) => entry.storyId));
  const transform = (stories: RetryPlanStory[]): RetryPlanStory[] => stories.map((story) => ({
    ...story,
    // Passed evidence remains passed but is also excluded from this attempt, so
    // copied results never receive manifests or executable scheduler slots.
    // Unselected failures are excluded rather than falsely projected as passed.
    excluded: !executable.has(story.id),
  }));
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
