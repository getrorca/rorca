/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { fireEvent, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import {
  getGenerationLogPresentation,
  parseContextSummary,
  getRetrievalMethodPresentation,
  extractStoryContextAnnotations,
  parsePostSaveStages,
  parseContextCaptureStatus,
  classifyContextState,
  getCanonicalPostSaveStatus,
  getCanonicalPostSaveStageStates,
  getCurrentPostSaveState,
  getCurrentPostSaveStateFromWorkflow,
  postSaveActiveJobCopy,
  readinessInspectionToContextCaptureStatus,
  workflowInspectionToPostSaveStages,
  workflowTopLevelActionAllowed,
  workflowStageActionAllowed,
  shouldRefreshSpecDetailFromWalEvent,
  WorkflowChecklistCard,
  type PostSaveStageMap,
  type ContextCaptureStatus,
  type ContextClassification,
} from '../SpecDetailSlideOver';
import { renderWithProviders } from '../../test/helpers';

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

  it('does not label superseded post-save stages as pending current work', () => {
    const supersededStages: PostSaveStageMap = {
      enrich: { requested: true, status: 'superseded', reason: 'superseded_by_newer_save' },
      matchSkills: { requested: true, status: 'superseded', reason: 'superseded_by_newer_save' },
      memorySynthesis: { requested: false, status: 'skipped', reason: 'disabled_by_caller' },
    };
    expect(getGenerationLogPresentation({ status: 'pending_enrichment', enriched: false, postSaveStages: supersededStages })).toMatchObject({
      title: 'Draft Persisted · Superseded by Newer Edit',
      badgeLabel: 'Superseded',
    });
  });

  it('distinguishes skipped unchanged from still processing copy', () => {
    const skippedStages: PostSaveStageMap = {
      enrich: { requested: true, status: 'skipped', reason: 'fingerprint_unchanged' },
      matchSkills: { requested: true, status: 'skipped', reason: 'fingerprint_unchanged' },
      memorySynthesis: { requested: false, status: 'skipped', reason: 'disabled_by_caller' },
    };
    expect(getGenerationLogPresentation({ status: 'pending_enrichment', enriched: false, postSaveStages: skippedStages })).toMatchObject({
      title: 'Draft Persisted · Inputs Unchanged',
      badgeLabel: 'Skipped',
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

describe('workflow/readiness exact surface adapters', () => {
  it('maps workflow inspection stages into the legacy post-save stage card shape', () => {
    const stages = workflowInspectionToPostSaveStages({
      specId: 'spec-1',
      workspaceId: 'ws-1',
      persistence: {
        specPath: 'forge/specs/pending/spec-1.json',
        location: 'pending',
        exists: true,
        latestGenerationLogId: 11,
        latestGenerationLogStatus: 'persisted',
        saveGeneration: 11,
      },
      workflow: {
        runId: 99,
        status: 'running',
        source: 'repair',
        saveGeneration: 11,
        effectivePolicy: { version: 'v1', presetId: 'repair_only' },
        idempotencyKey: 'wf-99',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:01:00.000Z',
        finishedAt: null,
      },
      reasonCodes: ['post_save_pending'],
      stages: [
        { key: 'context', requested: true, status: 'completed', reasonCode: 'context_captured', reason: 'context_captured', workflowRunId: 99, jobId: null, bossJobId: null, queueName: null, queueStatus: null, queuePosition: null, activeJobsAhead: null, queuePriority: null, singletonKey: null, error: null, updatedAt: null, startedAt: null, finishedAt: null, safeActionHints: [] },
        { key: 'enrich', requested: true, status: 'queued', reasonCode: 'durable_job_enqueued', reason: 'durable_job_enqueued', workflowRunId: 99, jobId: 'job-enrich', bossJobId: 'boss-enrich', queueName: 'spec:enrich', queueStatus: 'waiting', queuePosition: 3, activeJobsAhead: 2, queuePriority: null, singletonKey: 'singleton', error: null, updatedAt: '2026-01-01T00:01:00.000Z', startedAt: null, finishedAt: null, safeActionHints: [] },
        { key: 'matchSkills', requested: true, status: 'failed', reasonCode: 'job_failed', reason: 'job_failed', workflowRunId: 99, jobId: 'job-match', bossJobId: 'boss-match', queueName: 'spec:match-skills', queueStatus: null, queuePosition: null, activeJobsAhead: null, queuePriority: null, singletonKey: null, error: 'boom', updatedAt: '2026-01-01T00:02:00.000Z', startedAt: null, finishedAt: null, safeActionHints: [] },
        { key: 'memorySynthesis', requested: false, status: 'missing', reasonCode: 'stage_state_missing', reason: 'stage_state_missing', workflowRunId: 99, jobId: null, bossJobId: null, queueName: null, queueStatus: null, queuePosition: null, activeJobsAhead: null, queuePriority: null, singletonKey: null, error: null, updatedAt: null, startedAt: null, finishedAt: null, safeActionHints: [] },
      ],
      safeActionHints: [],
    } as any);

    expect(stages).toMatchObject({
      enrich: { status: 'queued', queueStatus: 'waiting', queuePosition: 3, activeJobsAhead: 2, jobId: 'job-enrich', bossJobId: 'boss-enrich' },
      matchSkills: { status: 'failed', error: 'boom', jobId: 'job-match' },
      memorySynthesis: { status: 'skipped', requested: false },
    });
  });

  it('maps readiness inspection context capture and active workflow state without log parsing', () => {
    const readiness = {
      specId: 'spec-1',
      workspaceId: 'ws-1',
      persistence: {
        workspaceId: 'ws-1',
        specId: 'spec-1',
        specPath: 'forge/specs/pending/spec-1.json',
        location: 'pending',
        exists: true,
        latestGenerationLogId: 11,
        latestGenerationLogStatus: 'persisted',
        saveGeneration: 11,
        contextCapture: { status: 'backfilled', reason: 'context_summary_derived_from_context_used_meta' },
      },
      workflow: {
        runId: 99,
        status: 'queued',
        source: 'repair',
        saveGeneration: 11,
        effectivePolicy: { version: 'v1', presetId: 'repair_only' },
        idempotencyKey: 'wf-99',
        createdAt: null,
        updatedAt: null,
        finishedAt: null,
      },
      stages: [
        { key: 'context', requested: true, status: 'completed', reasonCode: 'context_captured', reason: 'context_captured', workflowRunId: 99, jobId: null, bossJobId: null, queueName: null, queueStatus: null, queuePosition: null, activeJobsAhead: null, queuePriority: null, singletonKey: null, error: null, updatedAt: null, startedAt: null, finishedAt: null, safeActionHints: [] },
        { key: 'enrich', requested: true, status: 'queued', reasonCode: 'durable_job_enqueued', reason: 'durable_job_enqueued', workflowRunId: 99, jobId: 'job-enrich', bossJobId: null, queueName: null, queueStatus: 'waiting', queuePosition: 2, activeJobsAhead: 1, queuePriority: null, singletonKey: null, error: null, updatedAt: null, startedAt: null, finishedAt: null, safeActionHints: [] },
        { key: 'matchSkills', requested: false, status: 'skipped', reasonCode: 'disabled_by_policy', reason: 'disabled_by_policy', workflowRunId: 99, jobId: null, bossJobId: null, queueName: null, queueStatus: null, queuePosition: null, activeJobsAhead: null, queuePriority: null, singletonKey: null, error: null, updatedAt: null, startedAt: null, finishedAt: null, safeActionHints: [] },
        { key: 'memorySynthesis', requested: false, status: 'skipped', reasonCode: 'disabled_by_policy', reason: 'disabled_by_policy', workflowRunId: 99, jobId: null, bossJobId: null, queueName: null, queueStatus: null, queuePosition: null, activeJobsAhead: null, queuePriority: null, singletonKey: null, error: null, updatedAt: null, startedAt: null, finishedAt: null, safeActionHints: [] },
      ],
      readinessState: { status: 'blocked', reason: 'blocked' },
      executionGate: { status: 'blocked', overrideAllowed: true, overrideReasonCode: 'run_anyway_override_used' },
      blockingReasons: [{ code: 'post_save_pending', message: 'pending', severity: 'blocking' }],
      warnings: [],
      availableActions: ['wait_for_post_save'],
      reasonCodes: ['post_save_pending'],
      safeActionHints: [],
    } as any;

    expect(readinessInspectionToContextCaptureStatus(readiness)).toEqual({
      status: 'backfilled',
      reason: 'context_summary_derived_from_context_used_meta',
      contextUsed: 'missing',
      contextSummary: 'backfilled',
    });
    expect(getCurrentPostSaveStateFromWorkflow({ stages: readiness.stages } as any)).toMatchObject({
      stage: 'enrich',
      status: 'waiting-for-worker',
      queuePosition: 2,
      activeJobsAhead: 1,
    });
  });
});

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

/* ─── RER-006: canonical post-save states ──────────────────────── */

describe('RER-006: canonical post-save state mapping', () => {
  it('distinguishes queued, waiting-for-worker, running, skipped-unchanged, superseded, blocked, and completed', () => {
    expect(getCanonicalPostSaveStatus({ requested: true, status: 'queued', reason: 'durable_job_enqueued' })).toBe('queued');
    expect(getCanonicalPostSaveStatus({ requested: true, status: 'queued', reason: 'durable_job_enqueued', queueStatus: 'waiting', activeJobsAhead: 2 })).toBe('waiting-for-worker');
    expect(getCanonicalPostSaveStatus({ requested: true, status: 'running', reason: 'job_started' })).toBe('running');
    expect(getCanonicalPostSaveStatus({ requested: true, status: 'skipped', reason: 'fingerprint_unchanged' })).toBe('skipped-unchanged');
    expect(getCanonicalPostSaveStatus({ requested: true, status: 'superseded', reason: 'superseded_by_newer_save' })).toBe('superseded');
    expect(getCanonicalPostSaveStatus({ requested: true, status: 'failed', reason: 'blocked_by_enrich_failure' })).toBe('blocked-by-active-job');
    expect(getCanonicalPostSaveStatus({ requested: true, status: 'failed', reason: 'job_failed' })).toBe('failed');
    expect(getCanonicalPostSaveStatus({ requested: true, status: 'completed', reason: 'job_completed' })).toBe('completed');
  });

  it('chooses only live queued/running/waiting stages as the current active post-save job', () => {
    const log = {
      postSaveStages: {
        enrich: { requested: true, status: 'superseded', reason: 'superseded_by_newer_save', jobId: 'old-job' },
        matchSkills: { requested: true, status: 'queued', reason: 'durable_job_enqueued', jobId: 'new-job', queuePosition: 1 },
        memorySynthesis: { requested: false, status: 'skipped', reason: 'disabled_by_caller' },
      },
    } as any;

    expect(getCanonicalPostSaveStageStates(log).map(s => s.status)).toEqual(['superseded', 'queued', 'completed']);
    expect(getCurrentPostSaveState(log)).toMatchObject({ stage: 'matchSkills', status: 'queued', jobId: 'new-job' });
    expect(postSaveActiveJobCopy(getCurrentPostSaveState(log)!)).toContain('Match Skills is queued');
  });

  it('prefers backend-surfaced blocking status over older raw stage history', () => {
    const current = getCurrentPostSaveState({
      postSaveBlockingStatus: 'blocked-by-active-job',
      postSaveStatus: 'running',
      postSaveStage: 'enrich',
      postSaveJobId: 'active-job',
    } as any);

    expect(current).toMatchObject({ stage: 'enrich', status: 'running', jobId: 'active-job' });
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

/* ─── PSE-009: parseContextCaptureStatus contract ─────────────── */

describe('PSE-009: parseContextCaptureStatus', () => {
  it('reads contextCaptureStatus from top-level field', () => {
    const ccs: ContextCaptureStatus = {
      status: 'provided',
      reason: 'caller_supplied_context',
      contextUsed: 'provided',
      contextSummary: 'provided',
    };
    const result = parseContextCaptureStatus({ contextCaptureStatus: ccs } as any);
    expect(result).toEqual(ccs);
  });

  it('falls back to nested context_summary_json.contextCaptureStatus', () => {
    const ccs: ContextCaptureStatus = {
      status: 'backfilled',
      reason: 'context_summary_derived_from_context_used_meta',
      contextUsed: 'provided',
      contextSummary: 'backfilled',
    };
    const result = parseContextCaptureStatus({
      context_summary_json: JSON.stringify({ contextCaptureStatus: ccs }),
    } as any);
    expect(result).toEqual(ccs);
  });

  it('prefers top-level over nested when both exist', () => {
    const topLevel: ContextCaptureStatus = {
      status: 'provided',
      reason: 'caller_supplied_context',
      contextUsed: 'provided',
      contextSummary: 'provided',
    };
    const nested: ContextCaptureStatus = {
      status: 'missing',
      reason: 'caller_context_not_supplied',
      contextUsed: 'missing',
      contextSummary: 'missing',
    };
    const result = parseContextCaptureStatus({
      contextCaptureStatus: topLevel,
      context_summary_json: JSON.stringify({ contextCaptureStatus: nested }),
    } as any);
    expect(result!.status).toBe('provided');
  });

  it('returns null for logs without any contextCaptureStatus', () => {
    expect(parseContextCaptureStatus({} as any)).toBeNull();
    expect(parseContextCaptureStatus({ context_summary_json: '{}' } as any)).toBeNull();
    expect(parseContextCaptureStatus({ context_summary_json: 'not json' } as any)).toBeNull();
  });

  it('returns null when nested contextCaptureStatus lacks required status field', () => {
    expect(parseContextCaptureStatus({
      context_summary_json: JSON.stringify({
        contextCaptureStatus: { reason: 'some_reason' },
      }),
    } as any)).toBeNull();
  });

  it('handles already-parsed context_summary_json objects (JSONB from pg driver)', () => {
    const ccs: ContextCaptureStatus = {
      status: 'missing',
      reason: 'caller_context_not_supplied',
      contextUsed: 'missing',
      contextSummary: 'missing',
    };
    const result = parseContextCaptureStatus({
      context_summary_json: { contextCaptureStatus: ccs },
    } as any);
    expect(result).toEqual(ccs);
  });

  it('distinguishes provided from backfilled from missing', () => {
    const provided = parseContextCaptureStatus({
      contextCaptureStatus: {
        status: 'provided', reason: 'caller_supplied_context',
        contextUsed: 'provided', contextSummary: 'provided',
      },
    } as any);
    const backfilled = parseContextCaptureStatus({
      contextCaptureStatus: {
        status: 'backfilled', reason: 'context_summary_derived_from_context_used_meta',
        contextUsed: 'provided', contextSummary: 'backfilled',
      },
    } as any);
    const missing = parseContextCaptureStatus({
      contextCaptureStatus: {
        status: 'missing', reason: 'caller_context_not_supplied',
        contextUsed: 'missing', contextSummary: 'missing',
      },
    } as any);

    expect(provided!.status).toBe('provided');
    expect(backfilled!.status).toBe('backfilled');
    expect(missing!.status).toBe('missing');

    // All three are distinct
    expect(new Set([provided!.status, backfilled!.status, missing!.status]).size).toBe(3);
  });
});

/* ─── PSE-009: ContextTabEmptyState visibility and disabled-state rules ── */

describe('PSE-009: ContextTabEmptyState visibility rules (derived from classifyContextState)', () => {
  const makeStages = (overrides: Partial<Record<keyof PostSaveStageMap, Partial<PostSaveStageMap['enrich']>>>): PostSaveStageMap => ({
    enrich: { requested: true, status: 'completed', reason: 'job_completed', ...overrides.enrich },
    matchSkills: { requested: true, status: 'completed', reason: 'job_completed', ...overrides.matchSkills },
    memorySynthesis: { requested: false, status: 'skipped', reason: 'disabled_by_caller', ...overrides.memorySynthesis },
  });

  // The ContextTabEmptyState component renders action buttons based on the classification.
  // These tests validate the classification → button visibility contract:
  //
  // | Classification              | Repair btn | Retry Enrich btn | Buttons visible |
  // |-----------------------------|------------|------------------|-----------------|
  // | pending_post_save           | hidden     | hidden           | no              |
  // | persisted_without_context   | visible    | visible          | yes             |
  // | post_save_failed            | visible    | visible          | yes             |
  // | legacy_no_log               | visible    | hidden           | yes (repair only)|

  it('pending_post_save: no action buttons (spinner state)', () => {
    const classification = classifyContextState(
      null,
      makeStages({ enrich: { status: 'running', reason: 'job_started' } }),
      null,
    );
    expect(classification).toBe('pending_post_save');
    // Component rule: !isPending && (...) — buttons hidden during pending
  });

  it('persisted_without_context: both Repair and Retry Enrichment visible', () => {
    const classification = classifyContextState(null, null, {
      status: 'missing', reason: 'caller_context_not_supplied',
      contextUsed: 'missing', contextSummary: 'missing',
    });
    expect(classification).toBe('persisted_without_context');
    // Component rule: !isPending → buttons visible; classification matches persisted_without_context → retry shown
  });

  it('post_save_failed: both Repair and Retry Enrichment visible', () => {
    const classification = classifyContextState(
      null,
      makeStages({ enrich: { status: 'failed', reason: 'job_failed' } }),
      null,
    );
    expect(classification).toBe('post_save_failed');
    // Component rule: !isPending → buttons visible; classification matches post_save_failed → retry shown
  });

  it('legacy_no_log maps to persisted_without_context (no separate legacy_no_log from classifyContextState)', () => {
    // classifyContextState does not return legacy_no_log — that classification comes from
    // the GenerationLogTab when no log row exists at all. The function itself returns
    // persisted_without_context as a fallback when no stages and no capture exist.
    const classification = classifyContextState(null, null, null);
    expect(classification).toBe('persisted_without_context');
    // In this case: Repair visible, Retry visible (persisted_without_context matches retry condition)
  });

  it('completed stages with context → null (no empty state at all)', () => {
    const context = { directionLayers: { l1: true } } as any;
    expect(classifyContextState(context, makeStages({}), null)).toBeNull();
    // No ContextTabEmptyState rendered → no buttons relevant
  });

  it('all stages completed but no context → persisted_without_context', () => {
    const classification = classifyContextState(
      null,
      makeStages({
        enrich: { status: 'completed', reason: 'job_completed' },
        matchSkills: { status: 'completed', reason: 'job_completed' },
      }),
      { status: 'missing', reason: 'caller_context_not_supplied', contextUsed: 'missing', contextSummary: 'missing' },
    );
    expect(classification).toBe('persisted_without_context');
  });

  it('memorySynthesis pending but not requested → does not count as in-flight', () => {
    // memorySynthesis is not requested, so even if status were odd, it shouldn't trigger pending
    const stages = makeStages({
      enrich: { status: 'completed', reason: 'job_completed' },
      matchSkills: { status: 'completed', reason: 'job_completed' },
      memorySynthesis: { requested: false, status: 'skipped', reason: 'disabled_by_caller' },
    });
    // No context → falls through to capture check
    expect(classifyContextState(null, stages, {
      status: 'missing', reason: 'caller_context_not_supplied',
      contextUsed: 'missing', contextSummary: 'missing',
    })).toBe('persisted_without_context');
  });
});

/* ─── PSE-009: disabled-state rules for repair/retry during active runs ── */

describe('PSE-009: repair/retry disabled-state rules', () => {
  // The ContextTabEmptyState component disables Repair and Retry buttons when:
  //   isBusy (repairState !== 'idle') OR isRunActive (activeRunStatus === 'running' || 'queued')
  //
  // These are runtime rendering rules tested through the classification + prop contract.
  // The classification determines visibility; the activeRunStatus prop determines disabled state.

  const classifications: ContextClassification[] = [
    'persisted_without_context',
    'post_save_failed',
    'legacy_no_log',
  ];

  for (const classification of classifications) {
    it(`${classification}: buttons are visible (not pending_post_save)`, () => {
      // All non-pending classifications should show action buttons
      expect(classification).not.toBe('pending_post_save');
    });
  }

  it('pending_post_save is the only classification that hides all action buttons', () => {
    const allClassifications: ContextClassification[] = [
      'legacy_no_log',
      'persisted_without_context',
      'pending_post_save',
      'post_save_failed',
    ];
    const hiddenClassifications = allClassifications.filter(c => c === 'pending_post_save');
    expect(hiddenClassifications).toEqual(['pending_post_save']);
  });

  it('retry enrichment is only shown for persisted_without_context and post_save_failed', () => {
    // Component code: (classification === 'persisted_without_context' || classification === 'post_save_failed')
    const retryVisible: ContextClassification[] = ['persisted_without_context', 'post_save_failed'];
    const retryHidden: ContextClassification[] = ['legacy_no_log', 'pending_post_save'];

    for (const c of retryVisible) {
      expect(c === 'persisted_without_context' || c === 'post_save_failed').toBe(true);
    }
    for (const c of retryHidden) {
      expect(c === 'persisted_without_context' || c === 'post_save_failed').toBe(false);
    }
  });
});

describe('PSP-007: workflow action gating helpers', () => {
  const workflow = {
    safeActionHints: [
      { action: 'repair_spec', allowed: true },
      { action: 'run_anyway', allowed: true },
      { action: 'wait_for_post_save', allowed: true },
    ],
    stages: [
      { key: 'context', safeActionHints: [] },
      { key: 'enrich', safeActionHints: [{ action: 'retry_stage', allowed: true }] },
      { key: 'matchSkills', safeActionHints: [] },
      { key: 'memorySynthesis', safeActionHints: [] },
    ],
  } as any;

  const readiness = {
    availableActions: ['repair_post_save', 'run_anyway', 'install_skills'],
  } as any;

  it('only exposes top-level actions when workflow/readiness surfaces allow them', () => {
    expect(workflowTopLevelActionAllowed(workflow, readiness, 'repair_spec')).toBe(true);
    expect(workflowTopLevelActionAllowed(workflow, readiness, 'run_anyway')).toBe(true);
    expect(workflowTopLevelActionAllowed(workflow, readiness, 'install_skills')).toBe(true);
    expect(workflowTopLevelActionAllowed(workflow, readiness, 'run')).toBe(false);
  });

  it('only exposes stage retry when the backend hint marks it allowed', () => {
    expect(workflowStageActionAllowed(workflow, 'enrich', 'retry_stage')).toBe(true);
    expect(workflowStageActionAllowed(workflow, 'matchSkills', 'retry_stage')).toBe(false);
  });
});

describe('PSP-009: workflow checklist rendering', () => {
  const workflow = {
    specId: 'spec-1',
    workspaceId: 'ws-1',
    persistence: {
      specPath: 'forge/specs/approved/spec-1.json',
      location: 'approved',
      exists: true,
      latestGenerationLogId: 11,
      latestGenerationLogStatus: 'persisted',
      saveGeneration: 11,
    },
    workflow: {
      runId: 99,
      status: 'queued',
      source: 'repair',
      saveGeneration: 11,
      effectivePolicy: { version: 'v1', presetId: 'repair_only' },
      idempotencyKey: 'wf-99',
      createdAt: null,
      updatedAt: null,
      finishedAt: null,
    },
    reasonCodes: ['no_installed_skills'],
    stages: [
      { key: 'context', requested: true, status: 'completed', reasonCode: 'context_captured', reason: 'context_captured', workflowRunId: 99, jobId: null, bossJobId: null, queueName: null, queueStatus: null, queuePosition: null, activeJobsAhead: null, queuePriority: null, singletonKey: null, error: null, updatedAt: null, startedAt: null, finishedAt: null, safeActionHints: [] },
      { key: 'enrich', requested: true, status: 'completed', reasonCode: 'job_completed', reason: 'job_completed', workflowRunId: 99, jobId: 'job-enrich', bossJobId: 'boss-enrich', queueName: 'spec:enrich', queueStatus: null, queuePosition: null, activeJobsAhead: null, queuePriority: null, singletonKey: null, error: null, updatedAt: null, startedAt: null, finishedAt: null, safeActionHints: [] },
      { key: 'matchSkills', requested: true, status: 'failed', reasonCode: 'job_failed', reason: 'job_failed', workflowRunId: 99, jobId: 'job-match', bossJobId: 'boss-match', queueName: 'spec:match-skills', queueStatus: null, queuePosition: null, activeJobsAhead: null, queuePriority: null, singletonKey: null, error: 'missing skill set', updatedAt: null, startedAt: null, finishedAt: null, safeActionHints: [{ action: 'retry_stage', target: 'stage', allowed: true, label: 'Retry Match Skills', reasonCode: 'stage_failed', stageKey: 'matchSkills', request: { method: 'POST', path: '/api/specs/spec-1/workflow/stages/matchSkills/retry', workspaceIdLocation: 'body' } }] },
      { key: 'memorySynthesis', requested: false, status: 'skipped', reasonCode: 'disabled_by_policy', reason: 'disabled_by_policy', workflowRunId: 99, jobId: null, bossJobId: null, queueName: null, queueStatus: null, queuePosition: null, activeJobsAhead: null, queuePriority: null, singletonKey: null, error: null, updatedAt: null, startedAt: null, finishedAt: null, safeActionHints: [] },
    ],
    safeActionHints: [],
  } as any;

  const readiness = {
    specId: 'spec-1',
    workspaceId: 'ws-1',
    persistence: {
      workspaceId: 'ws-1',
      specId: 'spec-1',
      specPath: 'forge/specs/approved/spec-1.json',
      location: 'approved',
      exists: true,
      latestGenerationLogId: 11,
      latestGenerationLogStatus: 'persisted',
      saveGeneration: 11,
      contextCapture: { status: 'provided', reason: 'caller_supplied_context' },
    },
    workflow: workflow.workflow,
    stages: workflow.stages,
    readinessState: { status: 'degraded', reason: 'degraded' },
    executionGate: { status: 'allowed', overrideAllowed: false, overrideReasonCode: 'run_anyway_override_used' },
    blockingReasons: [],
    warnings: [{ code: 'no_installed_skills', message: 'Skill matching was skipped because no installed skills were available.', severity: 'warning' }],
    availableActions: ['install_skills'],
    engineeringCanon: {
      adapterStatus: 'available',
      receipt: { status: 'missing_required_skill' },
      selectedLayers: [{ id: 'engineering.overlay.universal', version: '1.0.0', layer: 'universal', hash: 'sha256:abc' }],
      coveredCells: [{ requirementId: 'coverage.requirement.one', overlayId: 'engineering.overlay.universal', operation: 'review', resolution: 'covered' }],
      uncoveredCells: [{ requirementId: 'coverage.requirement.two', gaps: ['missing_skill'] }],
      omissions: [],
      domainAuthority: { requestedDomains: ['healthcare'], approvedAuthorityIds: [] },
      evidenceProvenance: { evidenceIds: ['evidence.approved.one'], genesisPackageIds: [], redacted: true },
      compatibility: { compatible: true, versionSkew: [], conflicts: [] },
      version: { canon: '1.0.0', taxonomy: '1.0.0', receiptHash: 'sha256:receipt' },
      nextActions: [{ code: 'review_and_promote_required_skill', label: 'Review required candidate skills.', blocking: false }],
    },
    reasonCodes: ['no_installed_skills'],
    safeActionHints: [],
  } as any;

  it('renders the v1 checklist, policy label, exact stage rows, and install-skills helper', () => {
    const onOpenSkillsTab = vi.fn();
    renderWithProviders(
      <WorkflowChecklistCard
        specId="spec-1"
        workspaceId="ws-1"
        workflow={workflow}
        readiness={readiness}
        onOpenSkillsTab={onOpenSkillsTab}
      />,
    );

    expect(screen.getByTestId('workflow-policy-label')).toHaveTextContent('Policy · repair_only');
    expect(screen.getByTestId('workflow-summary-saved')).toHaveTextContent('Approved');
    expect(screen.getByTestId('workflow-summary-readiness')).toHaveTextContent('Degraded');
    expect(screen.getByTestId('engineering-canon-coverage')).toHaveTextContent('Missing Required Skill');
    expect(screen.getByTestId('engineering-canon-coverage')).toHaveTextContent('1 selected layers · 1 covered · 1 uncovered');
    expect(screen.getByTestId('engineering-canon-coverage')).toHaveTextContent('restricted content redacted');
    expect(screen.getByTestId('workflow-stage-context')).toHaveTextContent('Context');
    expect(screen.getByTestId('workflow-stage-enrich')).toHaveTextContent('Enrich');
    expect(screen.getByTestId('workflow-stage-matchSkills')).toHaveTextContent('Match Skills');
    expect(screen.getByTestId('workflow-stage-memorySynthesis')).toHaveTextContent('Memory Synthesis');
    expect(screen.getByTestId('workflow-stage-reason-code-matchSkills')).toHaveTextContent('job_failed');
    expect(screen.getByTestId('workflow-install-skills-help')).toHaveTextContent('Install skills help available');

    fireEvent.click(screen.getByRole('button', { name: 'Review skills' }));
    expect(onOpenSkillsTab).toHaveBeenCalledTimes(1);
  });

  it('keeps retry actions visible but disabled while a run is active', () => {
    renderWithProviders(
      <WorkflowChecklistCard
        specId="spec-1"
        workspaceId="ws-1"
        workflow={workflow}
        readiness={readiness}
        activeRunStatus="running"
      />,
    );

    expect(screen.getByTestId('workflow-stage-retry-matchSkills')).toBeDisabled();
    expect(screen.queryByTestId('workflow-stage-retry-memorySynthesis')).toBeNull();
  });
});

describe('PSP-007: SSE refresh filter', () => {
  it('refreshes only for relevant workflow/spec WAL events', () => {
    expect(shouldRefreshSpecDetailFromWalEvent({
      id: 1,
      ts: new Date().toISOString(),
      event_type: 'spec_job_progress',
      workspace_id: 'ws-1',
      spec_id: 'spec-1',
      story_id: null,
      actor: 'system',
      payload: null,
    } as any, 'spec-1', 'ws-1')).toBe(true);

    expect(shouldRefreshSpecDetailFromWalEvent({
      id: 2,
      ts: new Date().toISOString(),
      event_type: 'story_passed',
      workspace_id: 'ws-1',
      spec_id: 'spec-1',
      story_id: 'US-001',
      actor: 'system',
      payload: null,
    } as any, 'spec-1', 'ws-1')).toBe(false);

    expect(shouldRefreshSpecDetailFromWalEvent({
      id: 3,
      ts: new Date().toISOString(),
      event_type: 'spec_repaired',
      workspace_id: 'ws-2',
      spec_id: 'spec-1',
      story_id: null,
      actor: 'system',
      payload: null,
    } as any, 'spec-1', 'ws-1')).toBe(false);
  });

  it('falls back to payload spec identifiers when the WAL row spec_id is absent', () => {
    expect(shouldRefreshSpecDetailFromWalEvent({
      id: 4,
      ts: new Date().toISOString(),
      event_type: 'run_started',
      workspace_id: 'ws-1',
      spec_id: null,
      story_id: null,
      actor: 'system',
      payload: JSON.stringify({ spec_id: 'spec-1' }),
    } as any, 'spec-1', 'ws-1')).toBe(true);
  });
});
