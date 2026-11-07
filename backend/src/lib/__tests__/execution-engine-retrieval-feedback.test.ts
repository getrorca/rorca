/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  formatRetrievedMemorySection,
  buildStoryRetrievalSelections,
} from '../execution-engine';
import type { RetrievedContext } from '../memory-router';

function makeRetrievedContext(overrides: Partial<RetrievedContext> = {}): RetrievedContext {
  return {
    direction: {},
    memory: [],
    skills: [],
    graphContext: undefined,
    graphSection: undefined,
    meta: {
      cagHits: 0,
      ragHits: 0,
      graphHits: 0,
      totalTokens: 0,
      latencyMs: 0,
      tier: 'cache',
      needsMoreEvidence: false,
      matchedSkills: [],
      selectedCandidateIds: [],
      telemetryId: undefined,
    },
    ...overrides,
  };
}

describe('execution-engine retrieval feedback helpers', () => {
  test('formatRetrievedMemorySection adds weak-evidence warning and caps list at 8 items', () => {
    const retrieved = makeRetrievedContext({
      memory: Array.from({ length: 10 }, (_, idx) => ({
        text: `Memory ${idx + 1}`,
        score: 0.9 - (idx * 0.01),
        source: 'search',
        id: String(idx + 1),
        sourceType: 'manual',
      })),
      meta: {
        cagHits: 0,
        ragHits: 10,
        graphHits: 0,
        totalTokens: 0,
        latencyMs: 0,
        tier: 'search',
        needsMoreEvidence: true,
        matchedSkills: ['Auth Security'],
        selectedCandidateIds: ['1', '2'],
        telemetryId: 'rt_123',
      },
    });

    const section = formatRetrievedMemorySection(retrieved);

    expect(section).toContain('Evidence is sparse or weak');
    expect(section).toContain('Memory 1');
    expect(section).toContain('Memory 8');
    expect(section).not.toContain('Memory 9');
    expect(section).not.toContain('Memory 10');
  });

  test('buildStoryRetrievalSelections carries readable memory details when available', () => {
    const retrieved = makeRetrievedContext({
      memory: [{
        id: '3861',
        canonicalKey: 'memory:rorca::3861',
        text: 'Stage fingerprints: Post-save enrichment should rerun only invalidated stages.',
        score: 0.82,
        source: 'search',
        sourceType: 'manual',
      }],
      meta: {
        cagHits: 1,
        ragHits: 2,
        graphHits: 0,
        totalTokens: 123,
        latencyMs: 9,
        tier: 'hybrid',
        needsMoreEvidence: false,
        matchedSkills: ['Spec Workflow'],
        selectedCandidateKeys: ['memory:rorca::3861'],
        selectedCandidateIds: ['3861'],
        telemetryId: 'rt_457',
      },
    });

    expect(buildStoryRetrievalSelections(retrieved)).toEqual([{
      candidateKey: 'memory:rorca::3861',
      candidateKind: 'memory',
      skillName: 'Spec Workflow',
      title: 'Stage fingerprints',
      snippet: 'Stage fingerprints: Post-save enrichment should rerun only invalidated stages.',
      score: 0.82,
      source: 'search',
      sourceType: 'manual',
    }]);
  });

  test('buildStoryRetrievalSelections prefixes memory ids and carries first matched skill', () => {
    const retrieved = makeRetrievedContext({
      meta: {
        cagHits: 1,
        ragHits: 2,
        graphHits: 1,
        totalTokens: 123,
        latencyMs: 9,
        tier: 'hybrid',
        needsMoreEvidence: false,
        matchedSkills: ['Auth Security', 'API Conventions'],
        selectedCandidateIds: ['42', '99'],
        telemetryId: 'rt_456',
      },
    });

    expect(buildStoryRetrievalSelections(retrieved)).toEqual([
      { candidateKey: 'memory:42', candidateKind: 'memory', skillName: 'Auth Security' },
      { candidateKey: 'memory:99', candidateKind: 'memory', skillName: 'Auth Security' },
    ]);
  });
});
