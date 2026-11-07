/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  classifySpecEditChange,
  CONTEXT_BEARING_STORY_FIELDS,
  METADATA_ONLY_STORY_FIELDS,
  resolveSpecEditPostSaveDecision,
  STORY_CONTENT_ONLY_FIELDS,
} from '../spec-edit-change-class';
import {
  computeSpecStageFingerprints,
  ENRICH_CONTEXT_BEARING_STORY_FIELDS,
  MATCH_SKILLS_STORY_FIELDS,
} from '../spec-stage-fingerprints';

const baseSpec = {
  title: 'Original title',
  model: 'claude',
  userStories: [
    {
      id: 'RER-001',
      title: 'Original story title',
      description: 'Original story description',
      acceptanceCriteria: ['Original AC'],
      dependsOn: [] as string[],
      complexity: 2,
      priority: 3,
      timeoutMinutes: 45,
      model: 'claude',
      excluded: false,
    },
  ],
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('spec edit change classification', () => {
  it('codifies context-bearing vs story-content vs metadata-only fields', () => {
    expect(CONTEXT_BEARING_STORY_FIELDS).toEqual(['description', 'acceptanceCriteria']);
    expect(ENRICH_CONTEXT_BEARING_STORY_FIELDS).toEqual(CONTEXT_BEARING_STORY_FIELDS);
    expect(STORY_CONTENT_ONLY_FIELDS).toEqual(['title', 'dependsOn']);
    expect(MATCH_SKILLS_STORY_FIELDS).toEqual(['title', 'description', 'acceptanceCriteria', 'dependsOn']);
    expect(METADATA_ONLY_STORY_FIELDS).toEqual(['complexity', 'priority', 'timeoutMinutes', 'model', 'excluded']);
  });

  it('classifies top-level and story metadata changes as metadata-only', () => {
    const next = clone(baseSpec);
    next.title = 'Renamed spec';
    next.userStories[0].complexity = 5;
    next.userStories[0].priority = 1;
    next.userStories[0].timeoutMinutes = 120;
    next.userStories[0].model = 'opencode/default';
    next.userStories[0].excluded = true;

    expect(classifySpecEditChange(baseSpec, next)).toMatchObject({
      changeClass: 'metadata-only',
    });
  });

  it('classifies title and dependsOn changes as story-content-only', () => {
    const next = clone(baseSpec);
    next.userStories[0].title = 'Retitled story';
    next.userStories[0].dependsOn = ['RER-000'];

    expect(classifySpecEditChange(baseSpec, next)).toMatchObject({
      changeClass: 'story-content-only',
    });
  });

  it('classifies description and acceptance criteria changes as context-bearing', () => {
    const descriptionOnly = clone(baseSpec);
    descriptionOnly.userStories[0].description = 'Changed description';
    expect(classifySpecEditChange(baseSpec, descriptionOnly)).toMatchObject({
      changeClass: 'context-bearing',
    });

    const criteriaOnly = clone(baseSpec);
    criteriaOnly.userStories[0].acceptanceCriteria = ['Changed AC'];
    expect(classifySpecEditChange(baseSpec, criteriaOnly)).toMatchObject({
      changeClass: 'context-bearing',
    });
  });

  it('resolves deterministic enrich/match-skills booleans for each change class', () => {
    const requestedPostSave = { enrich: true, matchSkills: true, memorySynthesis: true };

    const metadataOnly = clone(baseSpec);
    metadataOnly.title = 'Renamed spec';
    metadataOnly.userStories[0].priority = 1;
    expect(resolveSpecEditPostSaveDecision({ before: baseSpec, after: metadataOnly, requestedPostSave }).effectivePostSave)
      .toEqual({ enrich: false, matchSkills: false, memorySynthesis: true });

    const storyContentOnly = clone(baseSpec);
    storyContentOnly.userStories[0].title = 'Retitled story';
    expect(resolveSpecEditPostSaveDecision({ before: baseSpec, after: storyContentOnly, requestedPostSave }).effectivePostSave)
      .toEqual({ enrich: false, matchSkills: true, memorySynthesis: true });

    const contextBearing = clone(baseSpec);
    contextBearing.userStories[0].acceptanceCriteria = ['Changed AC'];
    expect(resolveSpecEditPostSaveDecision({ before: baseSpec, after: contextBearing, requestedPostSave }).effectivePostSave)
      .toEqual({ enrich: true, matchSkills: true, memorySynthesis: true });
  });

  it('keeps fingerprints aligned with the deterministic rerun decision', () => {
    const original = computeSpecStageFingerprints(baseSpec);

    const metadataOnly = clone(baseSpec);
    metadataOnly.title = 'Renamed spec';
    metadataOnly.userStories[0].complexity = 4;
    expect(computeSpecStageFingerprints(metadataOnly)).toEqual(original);

    const storyContentOnly = clone(baseSpec);
    storyContentOnly.userStories[0].title = 'Retitled story';
    storyContentOnly.userStories[0].dependsOn = ['RER-000'];
    const storyContentFingerprints = computeSpecStageFingerprints(storyContentOnly);
    expect(storyContentFingerprints.enrichFingerprint).toBe(original.enrichFingerprint);
    expect(storyContentFingerprints.matchSkillsFingerprint).not.toBe(original.matchSkillsFingerprint);

    const contextBearing = clone(baseSpec);
    contextBearing.userStories[0].description = 'Changed description';
    const contextFingerprints = computeSpecStageFingerprints(contextBearing);
    expect(contextFingerprints.enrichFingerprint).not.toBe(original.enrichFingerprint);
    expect(contextFingerprints.matchSkillsFingerprint).not.toBe(original.matchSkillsFingerprint);
  });
});
