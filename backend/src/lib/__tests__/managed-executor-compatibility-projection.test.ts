/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import fs from 'node:fs';
import path from 'node:path';
import { governedMissionMode, managedExecutorProjectionForPersistence, projectLegacyManagedExecution } from '../managed-executor-compatibility-projection';
const facts = { workspaceId: 'workspace-one', runId: 1, storyId: 'W2-001', attempt: 1, generation: 1,
  specRevision: `sha256:${'a'.repeat(64)}`, gitSha: 'b'.repeat(40), worktreeId: 'worktree-one', status: 'passed', closeoutDecisionId: null };

test('governed compatibility projection is disabled by default and preserves legacy behavior', () => {
  expect(governedMissionMode({})).toBe('off');
  expect(projectLegacyManagedExecution(facts, 'off')).toBeNull();
});

test('observe projection is explicitly non-authoritative and never infers pass from status', () => {
  expect(projectLegacyManagedExecution(facts, 'observe')).toEqual(expect.objectContaining({
    authoritative: false, availability: 'available', observedStatus: 'passed', storyCompletionAuthority: 'none',
    executionAuthority: 'none', mergeAuthority: 'none', deploymentAuthority: 'none',
  }));
});

test.each(['passed', 'failed', 'retry', 'cancelled', 'crashed'])('legacy %s remains observation-only without changing executor behavior', (status) => {
  expect(projectLegacyManagedExecution({ ...facts, status }, 'observe')).toEqual(expect.objectContaining({
    mode: 'observe', observedStatus: status, authoritative: false, executionAuthority: 'none',
    mergeAuthority: 'none', deploymentAuthority: 'none',
  }));
});

test('an existing exact closeout decision is referenced but never fabricated or replaced', () => {
  expect(projectLegacyManagedExecution({ ...facts, closeoutDecisionId: 'closeout:one' }, 'observe')).toEqual(expect.objectContaining({
    closeoutDecisionId: 'closeout:one', storyCompletionAuthority: 'referenced_existing_decision',
  }));
});

test('legacy records without exact revision/SHA/worktree remain unmappable rather than fabricated', () => {
  expect(projectLegacyManagedExecution({ ...facts, gitSha: null }, 'observe')).toEqual(expect.objectContaining({
    availability: 'legacy_unmappable', executionAuthority: 'none',
  }));
  expect(() => managedExecutorProjectionForPersistence({ ...facts, gitSha: null }, 'enforce'))
    .toThrow('enforce mode requires exact spec revision, Git SHA, and worktree identity');
});

test('canonical story-result persistence consumes the compatibility boundary in production code', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../story-result-persistence.ts'), 'utf8');
  expect(source).toContain('managedExecutorProjectionForPersistence');
  expect(source).toContain('INSERT INTO managed_executor_compatibility_events');
  expect(source).toContain('await persistManagedExecutorProjection');
});
