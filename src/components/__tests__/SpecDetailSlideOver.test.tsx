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
  parsePostSaveStages,
  classifyContextState,
  type PostSaveStageMap,
  type ContextCaptureStatus,
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

/* ─── PSE-003: parsePostSaveStages contract ────────────────────── */

const SAMPLE_STAGES: PostSaveStageMap = {
  enrich: { requested: true, status: 'completed', reason: 'job_completed', jobId: 'aaa-111', bossJobId: 'bbb-222' },
  matchSkills: { requested: true, status: 'running', reason: 'job_started', jobId: 'ccc-333' },
  memorySynthesis: { requested: false, status: 'skipped', reason: 'disabled_by_caller' },
};

describe('PSE-003: parsePostSaveStages', () => {
  it('reads postSaveStages from top-level field (surfaced by backend)', () => {
    const result = parsePostSaveStages({
      postSaveStages: SAMPLE_STAGES,
    } as any);

    expect(result).toEqual(SAMPLE_STAGES);
  });

  it('falls back to nested context_summary_json.postSaveStages', () => {
    const result = parsePostSaveStages({
      context_summary_json: JSON.stringify({ postSaveStages: SAMPLE_STAGES }),
    } as any);

    expect(result).toEqual(SAMPLE_STAGES);
  });

  it('prefers top-level field over nested when both exist', () => {
    const topLevel: PostSaveStageMap = {
      ...SAMPLE_STAGES,
      enrich: { ...SAMPLE_STAGES.enrich, status: 'failed', reason: 'job_failed' },
    };
    const result = parsePostSaveStages({
      postSaveStages: topLevel,
      context_summary_json: JSON.stringify({ postSaveStages: SAMPLE_STAGES }),
    } as any);

    expect(result!.enrich.status).toBe('failed');
  });

  it('returns null for logs without any postSaveStages', () => {
    expect(parsePostSaveStages({} as any)).toBeNull();
    expect(parsePostSaveStages({ context_summary_json: '{}' } as any)).toBeNull();
    expect(parsePostSaveStages({ context_summary_json: 'not json' } as any)).toBeNull();
  });

  it('returns null when context_summary_json.postSaveStages is incomplete', () => {
    // Missing memorySynthesis key → not a valid PostSaveStageMap
    expect(parsePostSaveStages({
      context_summary_json: JSON.stringify({
        postSaveStages: {
          enrich: { requested: true, status: 'completed', reason: 'job_completed' },
          matchSkills: { requested: false, status: 'skipped', reason: 'disabled_by_caller' },
        },
      }),
    } as any)).toBeNull();
  });

  it('handles already-parsed context_summary_json objects', () => {
    // pg driver returns JSONB as an object, not a string
    const result = parsePostSaveStages({
      context_summary_json: { postSaveStages: SAMPLE_STAGES },
    } as any);

    expect(result).toEqual(SAMPLE_STAGES);
  });

  it('distinguishes skipped-because-not-requested from failed-after-request', () => {
    const stages: PostSaveStageMap = {
      enrich: { requested: true, status: 'failed', reason: 'job_failed', error: 'Timeout' },
      matchSkills: { requested: false, status: 'skipped', reason: 'disabled_by_caller' },
      memorySynthesis: { requested: false, status: 'skipped', reason: 'disabled_by_caller' },
    };
    const result = parsePostSaveStages({ postSaveStages: stages } as any);

    expect(result!.enrich.requested).toBe(true);
    expect(result!.enrich.status).toBe('failed');
    expect(result!.enrich.error).toBe('Timeout');
    expect(result!.matchSkills.requested).toBe(false);
    expect(result!.matchSkills.status).toBe('skipped');
    expect(result!.matchSkills.error).toBeUndefined();
  });

  it('carries jobId and bossJobId when available', () => {
    const result = parsePostSaveStages({ postSaveStages: SAMPLE_STAGES } as any);
    expect(result!.enrich.jobId).toBe('aaa-111');
    expect(result!.enrich.bossJobId).toBe('bbb-222');
    expect(result!.matchSkills.jobId).toBe('ccc-333');
    expect(result!.matchSkills.bossJobId).toBeUndefined();
  });
});

/* ─── PSE-007: classifyContextState contract ────────────────────── */

describe('PSE-007: classifyContextState', () => {
  const makeMissing: ContextCaptureStatus = {
    status: 'missing',
    reason: 'caller_context_not_supplied',
    contextUsed: 'missing',
    contextSummary: 'missing',
  };

  const makeProvided: ContextCaptureStatus = {
    status: 'provided',
    reason: 'caller_supplied_context',
    contextUsed: 'provided',
    contextSummary: 'provided',
  };

  const makeStages = (overrides: Partial<Record<keyof PostSaveStageMap, Partial<PostSaveStageMap['enrich']>>>): PostSaveStageMap => ({
    enrich: { requested: true, status: 'completed', reason: 'job_completed', ...overrides.enrich },
    matchSkills: { requested: true, status: 'completed', reason: 'job_completed', ...overrides.matchSkills },
    memorySynthesis: { requested: false, status: 'skipped', reason: 'disabled_by_caller', ...overrides.memorySynthesis },
  });

  it('returns null when context summary is available (no diagnostic needed)', () => {
    const context = { directionLayers: { l1: true } } as any;
    expect(classifyContextState(context, null, null)).toBeNull();
  });

  it('returns null when context is present even with failed stages', () => {
    const context = { directionLayers: { l1: true } } as any;
    const stages = makeStages({ enrich: { status: 'failed', reason: 'job_failed' } });
    expect(classifyContextState(context, stages, null)).toBeNull();
  });

  it('classifies pending_post_save when any requested stage is pending/queued/running', () => {
    const stages = makeStages({ enrich: { status: 'running', reason: 'job_started' } });
    expect(classifyContextState(null, stages, null)).toBe('pending_post_save');
  });

  it('classifies pending_post_save for queued stage', () => {
    const stages = makeStages({
      enrich: { status: 'queued', reason: 'durable_job_enqueued' },
    });
    expect(classifyContextState(null, stages, null)).toBe('pending_post_save');
  });

  it('classifies pending_post_save for pending stage', () => {
    const stages = makeStages({
      enrich: { status: 'completed', reason: 'job_completed' },
      matchSkills: { status: 'pending', reason: 'waiting_for_enrich' },
    });
    expect(classifyContextState(null, stages, null)).toBe('pending_post_save');
  });

  it('classifies post_save_failed when any requested stage has failed', () => {
    const stages = makeStages({
      enrich: { status: 'failed', reason: 'job_failed', error: 'Timeout' },
    });
    expect(classifyContextState(null, stages, null)).toBe('post_save_failed');
  });

  it('classifies persisted_without_context when capture status is missing', () => {
    expect(classifyContextState(null, null, makeMissing)).toBe('persisted_without_context');
  });

  it('classifies persisted_without_context as fallback with no stages and no capture', () => {
    expect(classifyContextState(null, null, null)).toBe('persisted_without_context');
  });

  it('ignores non-requested failed stages (skipped stages are not failures)', () => {
    const stages = makeStages({
      enrich: { requested: false, status: 'skipped', reason: 'disabled_by_caller' },
      matchSkills: { requested: false, status: 'skipped', reason: 'disabled_by_caller' },
    });
    // No requested stage is failed/pending, capture is missing → persisted_without_context
    expect(classifyContextState(null, stages, makeMissing)).toBe('persisted_without_context');
  });

  it('prioritizes pending over failed when both exist', () => {
    const stages = makeStages({
      enrich: { status: 'failed', reason: 'job_failed' },
      matchSkills: { status: 'running', reason: 'job_started' },
    });
    // Running takes priority → pending_post_save
    expect(classifyContextState(null, stages, null)).toBe('pending_post_save');
  });
});
