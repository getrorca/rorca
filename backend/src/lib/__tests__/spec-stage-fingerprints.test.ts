/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { computeSpecStageFingerprints, stripAppendedContextBlock } from '../spec-stage-fingerprints';

const baseSpec = {
  title: 'Fingerprint fixture',
  model: 'claude-sonnet-4-5-20250929',
  _notes: 'operator note',
  userStories: [
    {
      id: 'RER-001',
      title: 'Match skills for story title',
      description: 'Implement durable matching.',
      acceptanceCriteria: ['Skills are matched deterministically.'],
      dependsOn: ['RER-000'],
    },
  ],
};

describe('spec stage fingerprints', () => {
  it('strips appended enrichment context blocks for enrich inputs', () => {
    expect(stripAppendedContextBlock('Base description\n\n## Context\nretrieved context')).toBe('Base description');
  });

  it('metadata-only edits do not change either stage fingerprint', () => {
    const before = computeSpecStageFingerprints(baseSpec);
    const afterMetadataOnly = {
      ...baseSpec,
      model: 'opencode/model',
      _notes: 'changed note',
      tags: ['metadata-only'],
    };
    const after = computeSpecStageFingerprints(afterMetadataOnly);

    expect(after).toEqual(before);
  });

  it('story-title-only edits change match-skills but not enrich', () => {
    const before = computeSpecStageFingerprints(baseSpec);
    const after = computeSpecStageFingerprints({
      ...baseSpec,
      userStories: [{ ...baseSpec.userStories[0], title: 'Retitled story for skill search' }],
    });

    expect(after.enrichFingerprint).toBe(before.enrichFingerprint);
    expect(after.matchSkillsFingerprint).not.toBe(before.matchSkillsFingerprint);
  });

  it('context-affecting story edits change enrich and match-skills fingerprints', () => {
    const before = computeSpecStageFingerprints(baseSpec);
    const after = computeSpecStageFingerprints({
      ...baseSpec,
      userStories: [{
        ...baseSpec.userStories[0],
        description: 'Implement durable matching with workspace context.',
      }],
    });

    expect(after.enrichFingerprint).not.toBe(before.enrichFingerprint);
    expect(after.matchSkillsFingerprint).not.toBe(before.matchSkillsFingerprint);
  });

  it('enrich fingerprint ignores appended context mutation while match-skills remains story-payload sensitive', () => {
    const before = computeSpecStageFingerprints(baseSpec);
    const after = computeSpecStageFingerprints({
      ...baseSpec,
      userStories: [{
        ...baseSpec.userStories[0],
        description: `${baseSpec.userStories[0].description}\n\n## Context\nRetrieved L5 context`,
      }],
    });

    expect(after.enrichFingerprint).toBe(before.enrichFingerprint);
    expect(after.matchSkillsFingerprint).not.toBe(before.matchSkillsFingerprint);
  });
});
