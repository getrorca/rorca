/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import hermesFixture from './fixtures/hermes-task-manifest.json';
import { parseTaskManifest } from '../task-manifest';
import {
  HERMES_TASK_MANIFEST_SOURCE,
  assertTaskManifestDirectExecutionAllowed,
  createTaskManifestExecutionEnvelope,
} from '../task-manifest-execution-envelope';

function cloneFixture(): Record<string, any> {
  return JSON.parse(JSON.stringify(hermesFixture)) as Record<string, any>;
}

describe('task manifest execution envelope adapter', () => {
  test('generates a valid internal one-task execution spec with manifest prompt content', () => {
    const manifest = parseTaskManifest(cloneFixture());

    const spec = createTaskManifestExecutionEnvelope(manifest);

    expect(spec.internal).toBe(true);
    expect(spec.source).toBe(HERMES_TASK_MANIFEST_SOURCE);
    expect(spec.manifestId).toBe(manifest.manifestId);
    expect(spec.id).toBe(`hermes-task-manifest-${manifest.manifestId}`);
    expect(spec.userStories).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(spec, 'stories')).toBe(false);

    const story = spec.userStories[0];
    expect(story.id).toBe('TMB-001-contract');
    expect(story.description).toContain('## Objective');
    expect(story.description).toContain(manifest.objective);
    expect(story.description).toContain('## Full Manifest Task List');
    expect(story.description).toContain('## Bounded Scope');
    expect(story.description).toContain('## Policy Guardrails');
    expect(story.description).toContain('## Context References');
    expect(story.description).toContain('## Validation Commands');
    expect(story.description).toContain('## Evidence and Writeback Expectations');
    expect(story.description).toContain('Non-Goals / Out Of Scope');
    expect(story.acceptanceCriteria).toContain('Valid Hermes fixture parses successfully');
    expect(story.acceptanceCriteria).toContain('Schema accepts the valid Hermes fixture');
    expect(story.acceptanceCriteria).toContain('Required validation satisfied: typecheck');
    expect(story.acceptanceCriteria).toContain('Validation command completed or explicitly blocked with evidence: cd backend && npx tsc --noEmit');
  });

  test('generates one story per manifest task and preserves task dependencies', () => {
    const payload = cloneFixture();
    payload.tasks.push({
      taskId: 'TMB-001-tests',
      title: 'Add task manifest tests',
      description: 'Cover the adapter with multi-task envelope tests.',
      acceptanceCriteria: ['Multi-task manifest creates multiple execution stories'],
      targetPaths: ['backend/src/lib/__tests__/task-manifest-execution-envelope.test.ts'],
      commands: ['cd backend && npx tsc --noEmit'],
      dependsOn: ['TMB-001-contract'],
    });
    const manifest = parseTaskManifest(payload);

    const spec = createTaskManifestExecutionEnvelope(manifest);

    expect(spec.userStories.map((story) => story.id)).toEqual(['TMB-001-contract', 'TMB-001-tests']);
    expect(spec.userStories[1].dependsOn).toEqual(['TMB-001-contract']);
    expect(spec.userStories[0].description).toContain('TMB-001-tests — Add task manifest tests');
    expect(spec.userStories[1].description).toContain('TMB-001-contract — Define task manifest schema');
  });

  test('marks source spec, run, and story refs in internal metadata', () => {
    const payload = cloneFixture();
    payload.context.contextRefs.push({
      kind: 'story',
      ref: 'TMB-002',
      title: 'Previous task manifest story',
    });
    const manifest = parseTaskManifest(payload);

    const spec = createTaskManifestExecutionEnvelope(manifest);

    expect(spec.taskManifestExecution).toMatchObject({
      source: HERMES_TASK_MANIFEST_SOURCE,
      manifestId: manifest.manifestId,
      sourceSpecId: 'rorca-task-manifest-execution-bridge-for-hermes',
      sourceRunId: '20260316000440',
      internal: true,
    });
    expect(spec.sourceStoryIds).toEqual(['TMB-001', 'TMB-002']);
    expect(spec.taskManifestExecution.sourceStoryIds).toEqual(['TMB-001', 'TMB-002']);
    expect(spec.userStories[0].description).toContain('Source Story IDs: TMB-001, TMB-002');
  });

  test('includes validation commands in both prompt and acceptance criteria', () => {
    const payload = cloneFixture();
    payload.validation.requiredCommands.push('npm run build');
    const manifest = parseTaskManifest(payload);

    const spec = createTaskManifestExecutionEnvelope(manifest);
    const story = spec.userStories[0];

    expect(story.description).toContain('cd backend && npx tsc --noEmit');
    expect(story.description).toContain('npm run build');
    expect(story.acceptanceCriteria).toContain('Validation command completed or explicitly blocked with evidence: npm run build');
  });

  test('rejects high-risk and broad route decisions for direct task-manifest execution', () => {
    const highRiskPayload = cloneFixture();
    highRiskPayload.routeDecision = {
      route: 'hermes.task-manifest.direct',
      reason: 'High-risk broad repair should be routed through normal spec/run.',
    };
    const highRiskManifest = parseTaskManifest(highRiskPayload);

    expect(() => assertTaskManifestDirectExecutionAllowed(highRiskManifest)).toThrow(/broad or high-risk/);

    const broadPayload = cloneFixture();
    broadPayload.routeDecision = {
      route: 'rorca.spec.run',
      reason: 'Route back to normal Rorca spec run.',
    };
    const broadManifest = parseTaskManifest(broadPayload);

    expect(() => createTaskManifestExecutionEnvelope(broadManifest)).toThrow(/not eligible for direct task-manifest execution/);
  });
});
