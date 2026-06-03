/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, it, expect } from 'vitest';
import {
  getGenerationLogPresentation,
  parseContextSummary,
  getRetrievalMethodPresentation,
  extractStoryContextAnnotations,
} from '../SpecDetailSlideOver';

describe('parseContextSummary', () => {
  it('extracts a nested contextSummary from persisted explicit-draft logs', () => {
    const summary = parseContextSummary({
      context_summary_json: JSON.stringify({
        source: 'skill-first',
        contextSummary: {
          directionLayers: {
            l1: true,
            l2: { present: true, domain: 'devtools' },
            l3: true,
          },
          skills: ['rorca-forge'],
          memoryEntries: 4,
          agentsMd: true,
          template: null,
          schemaSnapshot: true,
          gitMemory: false,
          estimatedTokens: 1234,
          modelContextWindow: 200000,
          retrieval: {
            cagHits: 2,
            ragHits: 5,
            graphHits: 3,
            tier: 'hybrid',
            latencyMs: 42,
          },
        },
      }),
    } as any);

    expect(summary).toMatchObject({
      directionLayers: {
        l1: true,
        l2: { present: true, domain: 'devtools' },
        l3: true,
      },
      retrieval: {
        cagHits: 2,
        ragHits: 5,
        graphHits: 3,
        tier: 'hybrid',
        latencyMs: 42,
      },
    });
  });

  it('preserves the richer summary shape (layer titles, token sizes, injected files)', () => {
    const summary = parseContextSummary({
      context_summary_json: JSON.stringify({
        directionLayers: {
          l1: true,
          l2: { present: true, domain: 'frontend' },
          l3: true,
          l1Title: 'Engineering Standards',
          l2Title: 'React Conventions',
          l3Title: 'Rorca Project',
          l1Tokens: 1200,
          l2Tokens: 800,
          l3Tokens: 400,
        },
        skills: ['react', 'tailwind'],
        memoryEntries: 3,
        agentsMd: true,
        template: 'feature',
        schemaSnapshot: true,
        gitMemory: true,
        estimatedTokens: 5400,
        modelContextWindow: 200000,
        predictedFiles: ['src/App.tsx', 'src/main.tsx'],
      }),
    } as any);

    // Standard-shaped payload passes through untouched, retaining the richer fields.
    expect(summary).toMatchObject({
      directionLayers: {
        l1Title: 'Engineering Standards',
        l2Title: 'React Conventions',
        l3Title: 'Rorca Project',
        l1Tokens: 1200,
        l2Tokens: 800,
        l3Tokens: 400,
      },
      predictedFiles: ['src/App.tsx', 'src/main.tsx'],
    });
  });

  it('stays backward compatible with older flat contextUsed/meta payloads', () => {
    // Older logs persisted only a contextUsed.meta blob without directionLayers.
    const summary = parseContextSummary({
      context_summary_json: JSON.stringify({
        contextUsed: {
          meta: {
            standards: true,
            conventions: false,
            project: true,
            schema: true,
            totalTokens: 2048,
          },
        },
      }),
    } as any);

    expect(summary).toMatchObject({
      directionLayers: {
        l1: true,
        l2: { present: false, domain: null },
        l3: true,
      },
      schemaSnapshot: true,
      estimatedTokens: 2048,
    });
  });

  it('returns null for empty or unparseable context payloads', () => {
    expect(parseContextSummary({ context_summary_json: '{}' } as any)).toBeNull();
    expect(parseContextSummary({ context_summary_json: 'not json' } as any)).toBeNull();
    expect(parseContextSummary({} as any)).toBeNull();
  });
});

describe('getGenerationLogPresentation', () => {
  it('renders persisted explicit drafts as successful persistence, not failure', () => {
    expect(getGenerationLogPresentation({ status: 'persisted', enriched: false })).toMatchObject({
      tone: 'success',
      title: 'Draft Persisted',
      badgeLabel: 'Persisted',
    });
  });

  it('renders pending_enrichment as persisted with pending enrichment messaging', () => {
    expect(getGenerationLogPresentation({ status: 'pending_enrichment', enriched: false })).toMatchObject({
      tone: 'success',
      title: 'Draft Persisted · Enrichment Pending',
      badgeLabel: 'Persisted',
    });
  });

  it('keeps completed generation as success', () => {
    expect(getGenerationLogPresentation({ status: 'completed', enriched: false })).toMatchObject({
      tone: 'success',
      title: 'Generation Succeeded',
      badgeLabel: 'Generated',
    });
  });

  it('keeps failed enrichment as an error state', () => {
    expect(getGenerationLogPresentation({ status: 'failed', enriched: true })).toMatchObject({
      tone: 'error',
      title: 'Enrichment Failed',
      badgeLabel: 'Enriched',
    });
  });
});

describe('getRetrievalMethodPresentation', () => {
  it('maps known retrieval methods to their distinct badge classes', () => {
    expect(getRetrievalMethodPresentation('pgvector')).toMatchObject({
      label: 'pgvector',
      badgeClassName: expect.stringContaining('blue'),
    });
    expect(getRetrievalMethodPresentation('graph').badgeClassName).toContain('purple');
    expect(getRetrievalMethodPresentation('fulltext').badgeClassName).toContain('amber');
  });

  it('falls back to direction-only styling for unknown methods', () => {
    const known = getRetrievalMethodPresentation('direction-only');
    const unknown = getRetrievalMethodPresentation('some-future-method');
    expect(unknown.label).toBe('some-future-method');
    expect(unknown.badgeClassName).toBe(known.badgeClassName);
  });
});

describe('extractStoryContextAnnotations', () => {
  it('extracts per-story ## Context previews from story descriptions', () => {
    const annotations = extractStoryContextAnnotations([
      {
        id: 'US-001',
        title: 'Login flow',
        description: 'Base description\n\n## Context\nLine 1\nLine 2\nLine 3\nLine 4\n## Notes\nignored',
      },
      { id: 'US-002', title: 'No context', description: 'Just a plain description' },
    ]);

    expect(annotations).toHaveLength(1);
    expect(annotations[0]).toMatchObject({
      storyId: 'US-001',
      storyTitle: 'Login flow',
      preview: 'Line 1\nLine 2\nLine 3',
      hasMore: true,
    });
    // The trailing ## Notes section must not bleed into the captured context.
    expect(annotations[0].fullText).toContain('Line 4');
    expect(annotations[0].fullText).not.toContain('Notes');
  });

  it('returns no annotations when descriptions lack a ## Context section', () => {
    expect(
      extractStoryContextAnnotations([
        { id: 'US-001', title: 'A', description: 'plain' },
        { id: 'US-002', title: 'B', description: undefined },
      ]),
    ).toEqual([]);
  });

  it('marks short annotations as not having more lines', () => {
    const [annotation] = extractStoryContextAnnotations([
      { id: 'US-009', title: 'Short', description: '## Context\nOnly one line' },
    ]);
    expect(annotation.hasMore).toBe(false);
    expect(annotation.preview).toBe('Only one line');
  });
});
