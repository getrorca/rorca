/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  buildGovernedRetrySpec,
  compareRetryPlanToPreview,
  createRetryPreview,
  createRetryPreviewIdentity,
  resolveRetryScope,
  verifyRetryPreview,
  verifyRetryPreviewIdentity,
  type RetryExecutionOptions,
} from '../retry-governance';

const options: RetryExecutionOptions = {
  agent: 'pi',
  model: 'openai-codex/gpt-5.6-sol',
  effort: 'xhigh',
  terminalMode: 'pty',
  includeGraph: true,
  worktree: { enabled: true, path: '/tmp/story-worktree', branch: 'feat/retry' },
  merge: { strategy: 'branch-only', autoMerge: false },
  safety: { deploy: false, externalSend: false, policyLocked: true, allowBackendJest: false },
};

const stories = [
  { id: 'US-001', dependsOn: [], passes: true },
  { id: 'US-002', dependsOn: ['US-001'] },
  { id: 'US-003', dependsOn: ['US-002'] },
  { id: 'US-004', dependsOn: [] },
  { id: 'US-005', dependsOn: [], excluded: true },
];

const statuses = [
  { storyId: 'US-001', status: 'passed' as const },
  { storyId: 'US-002', status: 'failed' as const },
  { storyId: 'US-003', status: 'failed' as const },
  { storyId: 'US-004', status: 'failed' as const },
  { storyId: 'US-005', status: 'excluded' as const },
];

describe('retry governance', () => {
  test('retry one failed story includes its failed dependency but never copied passed work', () => {
    const scope = resolveRetryScope({ stories, statuses, requestedStoryIds: ['US-003'] });
    expect(scope.requested).toEqual([{ storyId: 'US-003', reasonCode: 'REQUESTED_FAILED_STORY' }]);
    expect(scope.requiredDependency).toEqual([{ storyId: 'US-002', reasonCode: 'REQUIRED_FAILED_DEPENDENCY' }]);
    expect(scope.executable.map((entry) => entry.storyId)).toEqual(['US-002', 'US-003']);
    expect(scope.copiedPassed).toEqual([{ storyId: 'US-001', reasonCode: 'PASSED_RESULT_COPIED_NOT_EXECUTABLE' }]);
    expect(scope.remaining).toEqual([{ storyId: 'US-004', reasonCode: 'REMAINING_FAILED_WORK' }]);
    expect(scope.excluded).toContainEqual({ storyId: 'US-005', reasonCode: 'SPEC_MARKED_EXCLUDED' });
  });

  test('freezes original options and detects generated-plan mismatch immediately before dispatch', () => {
    const scope = resolveRetryScope({ stories, statuses, requestedStoryIds: ['US-003'] });
    const preview = createRetryPreview({
      originalRunId: 42,
      scope,
      options,
      forceSequential: true,
      requiresApproval: false,
    });
    expect(verifyRetryPreview(preview)).toBe(true);
    expect(preview.options).toEqual(options);

    const governed = buildGovernedRetrySpec({ userStories: stories }, scope);
    expect(compareRetryPlanToPreview(governed, preview)).toMatchObject({
      matches: true,
      approved: ['US-002', 'US-003'],
      actual: ['US-002', 'US-003'],
    });

    const widened = structuredClone(governed);
    widened.userStories.find((story) => story.id === 'US-004')!.excluded = false;
    expect(compareRetryPlanToPreview(widened, preview)).toMatchObject({
      matches: false,
      actual: ['US-002', 'US-003', 'US-004'],
    });
  });

  test('tampered preview cannot authorize a broader scope', () => {
    const scope = resolveRetryScope({ stories, statuses, requestedStoryIds: ['US-002'] });
    const preview = createRetryPreview({ originalRunId: 7, scope, options, forceSequential: false, requiresApproval: false });
    const tampered = structuredClone(preview);
    tampered.scope.executable.push({ storyId: 'US-004', reasonCode: 'EXECUTABLE_RETRY_WORK' });
    expect(verifyRetryPreview(tampered)).toBe(false);
  });

  test('self-verifying preview identity survives restart secrets and expires closed', () => {
    const now = new Date('2026-07-15T12:00:00.000Z');
    const scope = resolveRetryScope({ stories, statuses, requestedStoryIds: ['US-002'] });
    const preview = createRetryPreview({ originalRunId: 7, scope, options, forceSequential: false, requiresApproval: false });
    const identity = createRetryPreviewIdentity(preview, now, 60_000);

    expect(verifyRetryPreviewIdentity(identity, preview, new Date('2026-07-15T12:00:30.000Z'))).toEqual({ valid: true, reason: 'valid' });
    expect(verifyRetryPreviewIdentity(identity, preview, new Date('2026-07-15T12:01:00.000Z'))).toEqual({ valid: false, reason: 'expired' });

    const mismatch = { ...identity, previewHash: `sha256:${'f'.repeat(64)}` };
    expect(verifyRetryPreviewIdentity(mismatch, preview, now)).toEqual({ valid: false, reason: 'mismatch' });
  });
});
