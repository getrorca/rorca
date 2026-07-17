/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  computePostSaveWorkerMaterialHash,
  mergeEnrichmentIntoLatest,
  mergeSkillsIntoLatest,
} from '../spec-post-save-write';

function spec(): Record<string, unknown> {
  return {
    title: 'Original title',
    model: 'model-old',
    agentOverride: 'claude',
    effortLevel: 'medium',
    thinkingEnabled: false,
    thinkingBudget: 1000,
    autoWorktree: false,
    _notes: 'old notes',
    lifecycleMetadata: { generation: 1 },
    userStories: [{
      id: 'RACE-001',
      title: 'Preserve concurrent metadata',
      description: 'Original material description',
      acceptanceCriteria: ['All newer execution metadata survives'],
      dependsOn: [],
      passes: false,
      model: 'story-old',
      complexity: 2,
    }],
  };
}

test('metadata updates during enrichment survive worker completion', () => {
  const initial = spec();
  const hash = computePostSaveWorkerMaterialHash(initial);
  const latest = structuredClone(initial);
  Object.assign(latest, {
    model: 'model-new',
    agentOverride: 'codex',
    effortLevel: 'max',
    thinkingEnabled: true,
    thinkingBudget: 9000,
    autoWorktree: true,
    _notes: 'new notes',
    lifecycleMetadata: { generation: 2, acceptedPreflightHash: 'sha256:new' },
  });
  Object.assign((latest.userStories as Record<string, unknown>[])[0], {
    passes: true,
    model: 'story-new',
    complexity: 5,
    priority: 1,
  });

  const merged = mergeEnrichmentIntoLatest(latest, hash, [{
    storyId: 'RACE-001',
    annotation: '- Generated context only',
    sourceDescription: 'Original material description',
  }]);

  expect(merged).toMatchObject({
    model: 'model-new',
    agentOverride: 'codex',
    effortLevel: 'max',
    thinkingEnabled: true,
    thinkingBudget: 9000,
    autoWorktree: true,
    _notes: 'new notes',
    lifecycleMetadata: { generation: 2, acceptedPreflightHash: 'sha256:new' },
  });
  expect((merged.userStories as Record<string, unknown>[])[0]).toMatchObject({
    passes: true,
    model: 'story-new',
    complexity: 5,
    priority: 1,
    description: 'Original material description\n\n## Context\n- Generated context only',
  });
});

test('skill matching merges only suggestedSkills and preserves approved passes/history-facing content', () => {
  const initial = spec();
  const hash = computePostSaveWorkerMaterialHash(initial);
  const latest = structuredClone(initial);
  const story = (latest.userStories as Record<string, unknown>[])[0];
  story.passes = true;
  story.model = 'new-story-model';

  const merged = mergeSkillsIntoLatest(latest, hash, [{
    storyId: 'RACE-001',
    suggestedSkills: [{ name: 'security', relevance: 9 }],
    sourceSuggestedSkills: undefined,
  }]);
  expect((merged.userStories as Record<string, unknown>[])[0]).toMatchObject({
    passes: true,
    model: 'new-story-model',
    suggestedSkills: [{ name: 'security', relevance: 9 }],
  });
});

test('an older replay never replaces newer generated annotation or skill content', () => {
  const initial = spec();
  const hash = computePostSaveWorkerMaterialHash(initial);
  const latest = structuredClone(initial);
  const latestStory = (latest.userStories as Record<string, unknown>[])[0];
  latestStory.description = 'Original material description\n\n## Context\n- Newer context';
  latestStory.suggestedSkills = [{ name: 'newer-skill' }];

  mergeEnrichmentIntoLatest(latest, hash, [{
    storyId: 'RACE-001',
    annotation: '- Older context',
    sourceDescription: 'Original material description',
  }]);
  mergeSkillsIntoLatest(latest, hash, [{
    storyId: 'RACE-001',
    suggestedSkills: [{ name: 'older-skill' }],
    sourceSuggestedSkills: undefined,
  }]);

  expect(latestStory.description).toContain('Newer context');
  expect(latestStory.description).not.toContain('Older context');
  expect(latestStory.suggestedSkills).toEqual([{ name: 'newer-skill' }]);
});

test('a concurrent material story edit blocks an older worker with a retryable typed reason', () => {
  const initial = spec();
  const latest = structuredClone(initial);
  (latest.userStories as Record<string, unknown>[])[0].title = 'Newer story title';

  try {
    mergeEnrichmentIntoLatest(
      latest,
      computePostSaveWorkerMaterialHash(initial),
      [{ storyId: 'RACE-001', annotation: '- stale' }],
    );
    throw new Error('Expected stale worker merge to fail');
  } catch (error) {
    expect(error).toMatchObject({
      code: 'STALE_POST_SAVE_GENERATION',
      statusCode: 422,
      details: expect.objectContaining({ retryable: true }),
    });
  }
});
