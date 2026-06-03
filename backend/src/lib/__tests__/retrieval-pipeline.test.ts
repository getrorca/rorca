/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  buildGraphRagExplainability,
  GRAPH_RAG_SCORE_CONTRACT_DOCUMENTATION,
  GRAPH_RAG_SCORE_SCHEMA_VERSION,
  matchSkillsToQuery,
  rankRetrievalCandidates,
  scoreGraphCandidateFromProjection,
  type RetrievalCandidateInput,
} from '../retrieval-pipeline';
import {
  buildConventionNodeKey,
  buildFileNodeKey,
  buildMemoryNodeKey,
  buildSkillNodeKey,
  buildSpecNodeKey,
  buildStoryNodeKey,
} from '../knowledge-graph';
import { clearRetrievalTelemetry, getRecentRetrievalTelemetry, recordRetrievalTelemetry } from '../retrieval-telemetry';
import { meanReciprocalRank, ndcgAtK, precisionAtK } from '../retrieval-evals';

const WORKSPACE_ID = 'ws-1';
const SPEC_ID = 'spec-graph';
const STORY_ID = 'GR2-001';

function runRanking(
  candidates: RetrievalCandidateInput[],
  options: {
    graphScoreWeight?: number;
    graphProximityAvailable?: boolean;
    specId?: string;
    guardrails?: Parameters<typeof rankRetrievalCandidates>[0]['guardrails'];
  } = {},
) {
  return rankRetrievalCandidates({
    workspaceId: WORKSPACE_ID,
    specId: options.specId ?? SPEC_ID,
    storyId: STORY_ID,
    queryText: 'Fix admin auth middleware and preserve deterministic retrieval ordering',
    predictedPaths: ['backend/routes/auth.ts'],
    candidates,
    skills: [{ name: 'Auth Security', content: 'auth middleware jwt bearer token authorization retrieval ranking' }],
    tokenBudget: 2000,
    graphScoreWeight: options.graphScoreWeight,
    graphProximityAvailable: options.graphProximityAvailable,
    evaluationTimestamp: '2026-05-31T00:00:00.000Z',
    guardrails: options.guardrails,
  });
}

function scoreProjection(candidate: RetrievalCandidateInput, specId: string = SPEC_ID) {
  return scoreGraphCandidateFromProjection({
    candidate,
    workspaceId: WORKSPACE_ID,
    specId,
    storyId: STORY_ID,
    predictedFileKeys: [buildFileNodeKey(WORKSPACE_ID, 'backend/routes/auth.ts')],
    graphProximityAvailable: true,
    referenceTimestamp: new Date('2026-05-31T00:00:00.000Z').getTime(),
  });
}

describe('retrieval-pipeline', () => {
  beforeEach(() => {
    clearRetrievalTelemetry();
  });

  test('matches skills from query text and path hints', () => {
    const matched = matchSkillsToQuery(
      'Improve authentication middleware in backend/routes/auth.ts',
      [
        { name: 'Auth Security', content: 'Authentication, authorization, JWT, sessions, auth middleware.' },
        { name: 'Styling', content: 'Tailwind and component polish.' },
      ],
      ['backend/routes/auth.ts'],
    );

    expect(matched[0]?.name).toBe('Auth Security');
    expect(matched[0]?.score).toBeGreaterThan(matched[1]?.score ?? 0);
  });

  test('prefers newer memory and flags contradictions within the same subject', () => {
    const candidates: RetrievalCandidateInput[] = [
      {
        id: '1',
        text: 'Auth middleware: Always use session cookies for admin auth',
        origin: 'search',
        baseScore: 0.8,
        matchType: 'hybrid',
        category: 'Convention',
        confidence: 'high',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: '2',
        text: 'Auth middleware: Do not use session cookies for admin auth; prefer JWT bearer verification',
        origin: 'graph',
        baseScore: 0.78,
        matchType: 'graph',
        category: 'Convention',
        confidence: 'high',
        createdAt: '2026-05-01T00:00:00.000Z',
        sourceSpecId: SPEC_ID,
        sourceStoryId: 'US-002',
        sourceStoryCanonicalKey: buildStoryNodeKey(WORKSPACE_ID, SPEC_ID, 'US-002'),
        sourceSpecCanonicalKey: buildSpecNodeKey(WORKSPACE_ID, SPEC_ID),
        relatedFiles: ['backend/routes/auth.ts'],
        graphNodeType: 'memory',
        graphActive: true,
        graphUpdatedAt: '2026-05-01T00:00:00.000Z',
        graphRelationship: 'conflict',
        graphHops: 1,
      },
    ];

    const result = runRanking(candidates);

    expect(result.contradictions).toEqual([['memory:ws-1::2', 'memory:ws-1::1']]);
    expect(result.selected[0]?.id).toBe('2');
    expect(result.candidates.find(c => c.id === '1')?.conflictsWith).toContain('memory:ws-1::2');
  });

  test('suppresses explicitly superseded memories via ontology precedence even when stale memory scores higher', () => {
    const newerKey = buildMemoryNodeKey(WORKSPACE_ID, '2');
    const olderKey = buildMemoryNodeKey(WORKSPACE_ID, '1');
    const candidates: RetrievalCandidateInput[] = [
      {
        id: '1',
        text: 'Auth middleware: Always use session cookies for admin auth',
        origin: 'search',
        baseScore: 0.92,
        matchType: 'hybrid',
        category: 'Convention',
        confidence: 'high',
        createdAt: '2026-01-01T00:00:00.000Z',
        ontologyLookupApplied: true,
        ontologyRelations: [{
          relationType: 'SUPERSEDES',
          relationKey: 'memory-relation:ws-1::SUPERSEDES::2::1',
          direction: 'incoming',
          otherMemoryId: '2',
          otherCanonicalKey: newerKey,
          counterpartRetrieved: true,
          active: true,
          status: 'active',
          updatedAt: '2026-05-01T00:00:00.000Z',
        }],
      },
      {
        id: '2',
        text: 'Auth middleware: Do not use session cookies for admin auth; prefer JWT bearer verification',
        origin: 'search',
        baseScore: 0.71,
        matchType: 'hybrid',
        category: 'Convention',
        confidence: 'high',
        createdAt: '2026-05-01T00:00:00.000Z',
        ontologyLookupApplied: true,
        ontologyRelations: [{
          relationType: 'SUPERSEDES',
          relationKey: 'memory-relation:ws-1::SUPERSEDES::2::1',
          direction: 'outgoing',
          otherMemoryId: '1',
          otherCanonicalKey: olderKey,
          counterpartRetrieved: true,
          active: true,
          status: 'active',
          updatedAt: '2026-05-01T00:00:00.000Z',
        }],
      },
    ];

    const result = runRanking(candidates);
    const stale = result.candidates.find(candidate => candidate.id === '1');

    expect(result.selected.map(candidate => candidate.id)).toEqual(['2']);
    expect(stale?.decision).toBe('drop');
    expect(stale?.supersededBy).toBe(newerKey);
    expect(stale?.scoring.ontology).toMatchObject({
      applied: true,
      stale: true,
      suppressed: true,
    });
    expect(stale?.scoring.ontology.reasons.map(reason => reason.kind)).toEqual(
      expect.arrayContaining(['suppression', 'supersession']),
    );

    const staleExplainability = buildGraphRagExplainability(stale!);
    expect(staleExplainability.ontologyExplainability.status).toBe('available');
    expect(staleExplainability.ontologyExplainability.explanations.map(item => item.label)).toEqual(
      expect.arrayContaining(['Superseded by memory #2']),
    );
  });

  test('drops near-duplicates through supersession/diversity', () => {
    const candidates: RetrievalCandidateInput[] = [
      {
        id: '1',
        text: 'SSE transport: Use the shared sse-hub.ts helper for all event streams',
        origin: 'search',
        baseScore: 0.85,
        matchType: 'hybrid',
        category: 'Convention',
        confidence: 'high',
        createdAt: '2026-05-01T00:00:00.000Z',
      },
      {
        id: '2',
        text: 'SSE transport: Use the shared sse-hub.ts helper for event streams',
        origin: 'cache',
        baseScore: 0.72,
        matchType: 'cache',
        category: 'Convention',
        confidence: 'medium',
        createdAt: '2026-04-01T00:00:00.000Z',
      },
      {
        id: '3',
        text: 'Queue worker: createQueue must run before boss.send on pg-boss v10',
        origin: 'search',
        baseScore: 0.7,
        matchType: 'keyword',
        category: 'Gotcha',
        confidence: 'high',
        createdAt: '2026-05-02T00:00:00.000Z',
      },
    ];

    const result = runRanking(candidates);

    expect(result.selected.map(candidate => candidate.id)).toContain('1');
    expect(result.selected.map(candidate => candidate.id)).toContain('3');
    expect(result.selected.map(candidate => candidate.id)).not.toContain('2');
    expect(result.candidates.find(candidate => candidate.id === '2')?.supersededBy).toBe('memory:ws-1::1');
  });

  test('conflict-flags candidates from explicit ontology relations without suppressing both sides', () => {
    const leftKey = buildMemoryNodeKey(WORKSPACE_ID, 'left');
    const rightKey = buildMemoryNodeKey(WORKSPACE_ID, 'right');
    const candidates: RetrievalCandidateInput[] = [
      {
        id: 'left',
        text: 'JWT auth: prefer bearer verification for admin APIs',
        origin: 'search',
        baseScore: 0.84,
        matchType: 'hybrid',
        category: 'Convention',
        confidence: 'high',
        createdAt: '2026-05-04T00:00:00.000Z',
        ontologyLookupApplied: true,
        ontologyRelations: [{
          relationType: 'CONFLICTS_WITH',
          relationKey: 'memory-relation:ws-1::CONFLICTS_WITH::left::right',
          direction: 'symmetric',
          otherMemoryId: 'right',
          otherCanonicalKey: rightKey,
          counterpartRetrieved: true,
          active: true,
          status: 'active',
          updatedAt: '2026-05-05T00:00:00.000Z',
        }],
      },
      {
        id: 'right',
        text: 'JWT auth: never use bearer verification for admin APIs',
        origin: 'search',
        baseScore: 0.82,
        matchType: 'hybrid',
        category: 'Convention',
        confidence: 'high',
        createdAt: '2026-05-05T00:00:00.000Z',
        ontologyLookupApplied: true,
        ontologyRelations: [{
          relationType: 'CONFLICTS_WITH',
          relationKey: 'memory-relation:ws-1::CONFLICTS_WITH::left::right',
          direction: 'symmetric',
          otherMemoryId: 'left',
          otherCanonicalKey: leftKey,
          counterpartRetrieved: true,
          active: true,
          status: 'active',
          updatedAt: '2026-05-05T00:00:00.000Z',
        }],
      },
    ];

    const result = runRanking(candidates);

    expect(result.contradictions).toEqual([[leftKey, rightKey]]);
    expect(result.selected.map(candidate => candidate.id)).toEqual(['left', 'right']);
    expect(result.selected.every(candidate => candidate.decision === 'conflict')).toBe(true);
    expect(result.selected[0]?.scoring.ontology.conflict).toBe(true);
    expect(result.selected[0]?.scoring.ontology.reasons[0]).toMatchObject({
      kind: 'conflict',
      code: 'graph_conflict_requires_arbiter',
    });
  });

  test('returns identical ordering and scores for identical inputs', () => {
    const candidates: RetrievalCandidateInput[] = [
      {
        id: '10',
        text: 'Auth routes: Preserve JWT bearer verification for admin APIs',
        origin: 'search',
        baseScore: 0.82,
        matchType: 'hybrid',
        category: 'Convention',
        confidence: 'high',
        createdAt: '2026-05-10T00:00:00.000Z',
        sourceSpecId: SPEC_ID,
        sourceStoryId: 'US-010',
      },
      {
        id: '11',
        text: 'Recall route: prefer canonical graph keys over local slugs in ranking metadata',
        origin: 'graph',
        baseScore: 0.77,
        matchType: 'graph',
        category: 'Pattern',
        confidence: 'medium',
        createdAt: '2026-05-08T00:00:00.000Z',
        sourceSpecId: SPEC_ID,
        sourceStoryId: 'US-011',
        sourceStoryCanonicalKey: buildStoryNodeKey(WORKSPACE_ID, SPEC_ID, 'US-011'),
        sourceSpecCanonicalKey: buildSpecNodeKey(WORKSPACE_ID, SPEC_ID),
        graphNodeType: 'memory',
        graphActive: true,
        graphUpdatedAt: '2026-05-08T00:00:00.000Z',
        graphRelationship: 'TOUCHES',
        graphHops: 1,
        relatedFiles: ['backend/routes/auth.ts'],
      },
    ];

    const first = runRanking(candidates);
    const second = runRanking(candidates);

    expect(first.candidates.map(candidate => ({
      id: candidate.id,
      score: candidate.finalScore,
      tieBreak: candidate.scoring.tieBreak,
    }))).toEqual(second.candidates.map(candidate => ({
      id: candidate.id,
      score: candidate.finalScore,
      tieBreak: candidate.scoring.tieBreak,
    })));
    expect(first.selected.map(candidate => candidate.id)).toEqual(second.selected.map(candidate => candidate.id));
  });

  test('builds a stable flat explainability payload for ranked candidates', () => {
    const candidates: RetrievalCandidateInput[] = [
      {
        id: 'debug-1',
        text: 'Auth routing: keep workspace-scoped graph retrieval deterministic and debuggable',
        origin: 'graph',
        baseScore: 0.83,
        matchType: 'graph',
        category: 'Pattern',
        confidence: 'high',
        source: 'retrieval-feedback',
        sourceType: 'memory',
        createdAt: '2026-05-30T00:00:00.000Z',
        sourceSpecId: SPEC_ID,
        sourceStoryId: 'US-012',
        sourceStoryCanonicalKey: buildStoryNodeKey(WORKSPACE_ID, SPEC_ID, 'US-012'),
        sourceSpecCanonicalKey: buildSpecNodeKey(WORKSPACE_ID, SPEC_ID),
        graphNodeType: 'memory',
        graphActive: true,
        graphUpdatedAt: '2026-05-30T00:00:00.000Z',
        graphRelationship: 'DEPENDS_ON',
        graphHops: 1,
        relatedFiles: ['backend/routes/auth.ts'],
        graphSignals: [
          {
            fromCanonicalKey: buildMemoryNodeKey(WORKSPACE_ID, 'debug-1'),
            toCanonicalKey: buildStoryNodeKey(WORKSPACE_ID, SPEC_ID, 'US-012'),
            relationship: 'DEPENDS_ON',
            hops: 1,
            active: true,
            updatedAt: '2026-05-30T00:00:00.000Z',
          },
          {
            fromCanonicalKey: buildMemoryNodeKey(WORKSPACE_ID, 'debug-1'),
            toCanonicalKey: buildSpecNodeKey(WORKSPACE_ID, SPEC_ID),
            relationship: 'DEPENDS_ON',
            hops: 1,
            active: true,
            updatedAt: '2026-05-30T00:00:00.000Z',
          },
          {
            fromCanonicalKey: buildMemoryNodeKey(WORKSPACE_ID, 'debug-1'),
            toCanonicalKey: buildFileNodeKey(WORKSPACE_ID, 'backend/routes/auth.ts'),
            relationship: 'CITED_BY',
            hops: 2,
            active: true,
            updatedAt: '2026-05-30T00:00:00.000Z',
          },
        ],
      },
    ];

    const first = runRanking(candidates, { graphScoreWeight: 0.35 });
    const second = runRanking(candidates, { graphScoreWeight: 0.35 });
    const firstExplainability = buildGraphRagExplainability(first.selected[0]!);
    const secondExplainability = buildGraphRagExplainability(second.selected[0]!);

    expect(Object.keys(firstExplainability.scoreBreakdown)).toEqual([
      'total',
      'semantic',
      'structural',
      'graph',
      'provenance',
      'recency',
      'pinned',
      'skills',
      'historical',
      'diversityPenalty',
      'echoChamberPenalty',
      'repetitionPenalty',
      'duplicationPenalty',
    ]);
    expect(firstExplainability).toMatchObject({
      scoringVersion: GRAPH_RAG_SCORE_SCHEMA_VERSION,
      retrievalMode: 'graph-reranked',
      provenanceEdges: ['DEPENDS_ON x2', 'CITED_BY x1'],
      provenanceEdgeOverflow: 0,
      provenanceConfidence: 'high',
      provenanceSourceType: 'memory',
      provenanceSource: 'retrieval-feedback',
      graphSignalCount: 3,
      rankReasonOverflow: 0,
      ontologyReasonOverflow: 0,
      ontologyExplainability: {
        status: 'partial',
        explanations: [],
      },
      rerankedBy: expect.stringMatching(/graph|semantic/),
      tieBreak: {
        canonicalKey: 'memory:ws-1::debug-1',
        sourceStoryKey: 'story:ws-1::spec-graph::US-012',
        storySlug: 'US-012',
        candidateId: 'debug-1',
      },
      scoreBreakdown: {
        total: expect.any(Number),
        semantic: expect.any(Number),
        structural: expect.any(Number),
        graph: expect.any(Number),
        provenance: expect.any(Number),
        recency: expect.any(Number),
        pinned: expect.any(Number),
        skills: expect.any(Number),
        historical: expect.any(Number),
        diversityPenalty: expect.any(Number),
        echoChamberPenalty: expect.any(Number),
        repetitionPenalty: expect.any(Number),
        duplicationPenalty: expect.any(Number),
      },
    });
    expect(firstExplainability).toEqual(secondExplainability);
  });

  test('resolves score ties consistently across shuffled input order using canonical keys then story scope', () => {
    const tiedCandidates: RetrievalCandidateInput[] = [
      {
        id: 'left',
        canonicalKey: 'memory:ws-1::shared',
        text: 'Deterministic ranking: keep canonical identity first in the score contract',
        origin: 'search',
        baseScore: 0.6,
        matchType: 'hybrid',
        category: 'Pattern',
        confidence: 'medium',
        createdAt: '2026-05-10T00:00:00.000Z',
        sourceSpecId: SPEC_ID,
        sourceStoryId: 'US-010',
        sourceStoryCanonicalKey: 'story:ws-1::spec-graph::US-010',
      },
      {
        id: 'right',
        canonicalKey: 'memory:ws-1::shared',
        text: 'Deterministic ranking: keep canonical identity first in the score contract',
        origin: 'search',
        baseScore: 0.6,
        matchType: 'hybrid',
        category: 'Pattern',
        confidence: 'medium',
        createdAt: '2026-05-10T00:00:00.000Z',
        sourceSpecId: SPEC_ID,
        sourceStoryId: 'US-002',
        sourceStoryCanonicalKey: 'story:ws-1::spec-graph::US-002',
      },
      {
        id: 'later-key',
        canonicalKey: 'memory:ws-1::zzz',
        text: 'Deterministic ranking: keep canonical identity first in the score contract',
        origin: 'search',
        baseScore: 0.6,
        matchType: 'hybrid',
        category: 'Pattern',
        confidence: 'medium',
        createdAt: '2026-05-10T00:00:00.000Z',
        sourceSpecId: SPEC_ID,
        sourceStoryId: 'US-001',
        sourceStoryCanonicalKey: 'story:ws-1::spec-graph::US-001',
      },
    ];

    const forward = runRanking(tiedCandidates);
    const reversed = runRanking([...tiedCandidates].reverse());

    expect(forward.candidates.map(candidate => candidate.id)).toEqual(['right', 'left', 'later-key']);
    expect(reversed.candidates.map(candidate => candidate.id)).toEqual(['right', 'left', 'later-key']);
    expect(forward.candidates[0]?.scoring.tieBreak).toMatchObject({
      canonicalKey: 'memory:ws-1::shared',
      sourceStoryKey: 'story:ws-1::spec-graph::US-002',
      storySlug: 'US-002',
    });
  });

  test('reranks only the semantically eligible slice when graph weight is enabled', () => {
    const candidates: RetrievalCandidateInput[] = [
      {
        id: 'semantic-first',
        text: 'Fix admin auth middleware and preserve deterministic retrieval ordering for bearer verification',
        origin: 'search',
        baseScore: 0.88,
        matchType: 'hybrid',
        category: 'Pattern',
        confidence: 'high',
        createdAt: '2026-05-10T00:00:00.000Z',
        canonicalKey: buildMemoryNodeKey(WORKSPACE_ID, 'semantic-first'),
        sourceSpecId: SPEC_ID,
        sourceSpecCanonicalKey: buildSpecNodeKey(WORKSPACE_ID, SPEC_ID),
        sourceStoryId: 'US-010',
        sourceStoryCanonicalKey: buildStoryNodeKey(WORKSPACE_ID, SPEC_ID, 'US-010'),
        graphNodeType: 'memory',
        graphActive: true,
        graphUpdatedAt: '2026-05-10T00:00:00.000Z',
      },
      {
        id: 'graph-close',
        text: 'Auth middleware: preserve ordering in backend/routes/auth.ts',
        origin: 'search',
        baseScore: 0.62,
        matchType: 'hybrid',
        category: 'Pattern',
        confidence: 'high',
        createdAt: '2026-05-10T00:00:00.000Z',
        canonicalKey: buildMemoryNodeKey(WORKSPACE_ID, 'graph-close'),
        sourceSpecId: SPEC_ID,
        sourceSpecCanonicalKey: buildSpecNodeKey(WORKSPACE_ID, SPEC_ID),
        sourceStoryId: 'US-011',
        sourceStoryCanonicalKey: buildStoryNodeKey(WORKSPACE_ID, SPEC_ID, 'US-011'),
        relatedFiles: ['backend/routes/auth.ts'],
        graphNodeType: 'memory',
        graphActive: true,
        graphUpdatedAt: '2026-05-10T00:00:00.000Z',
        graphSignals: [{
          fromCanonicalKey: buildMemoryNodeKey(WORKSPACE_ID, 'graph-close'),
          toCanonicalKey: buildFileNodeKey(WORKSPACE_ID, 'backend/routes/auth.ts'),
          relationship: 'ABOUT',
          hops: 1,
          active: true,
          updatedAt: '2026-05-10T00:00:00.000Z',
        }],
      },
      {
        id: 'cache:filtered-out',
        text: 'Low quality unrelated memory',
        origin: 'search',
        baseScore: 0.1,
        matchType: 'keyword',
        category: 'Pattern',
        confidence: 'low',
        createdAt: '2026-05-10T00:00:00.000Z',
      },
    ];

    const semanticOnly = runRanking(candidates, { graphScoreWeight: 0 });
    const reranked = runRanking(candidates, { graphScoreWeight: 1 });

    expect(semanticOnly.selected.map(candidate => candidate.id)).toEqual(['semantic-first', 'graph-close']);
    expect(reranked.selected.map(candidate => candidate.id)).toEqual(['graph-close', 'semantic-first']);
    expect(reranked.selected.map(candidate => candidate.id)).not.toContain('cache:filtered-out');
    expect(reranked.selected[0]?.preRerankPosition).toBe(2);
    expect(reranked.selected[0]?.rerankedBy).toBe('graph');
    expect(reranked.graphRerankChanged).toBe(true);
    expect(reranked.graphRerankedCandidateKeys).toContain('memory:ws-1::graph-close');
  });

  test('falls back to the semantic order when graph reranking is disabled or unavailable', () => {
    const candidates: RetrievalCandidateInput[] = [
      {
        id: 'semantic-first',
        text: 'Fix admin auth middleware and preserve deterministic retrieval ordering for bearer verification',
        origin: 'search',
        baseScore: 0.88,
        matchType: 'hybrid',
        category: 'Pattern',
        confidence: 'high',
        createdAt: '2026-05-10T00:00:00.000Z',
        canonicalKey: buildMemoryNodeKey(WORKSPACE_ID, 'semantic-first'),
        sourceSpecId: SPEC_ID,
        sourceSpecCanonicalKey: buildSpecNodeKey(WORKSPACE_ID, SPEC_ID),
        graphNodeType: 'memory',
        graphActive: true,
        graphUpdatedAt: '2026-05-10T00:00:00.000Z',
      },
      {
        id: 'graph-close',
        text: 'Auth middleware: preserve ordering in backend/routes/auth.ts',
        origin: 'search',
        baseScore: 0.62,
        matchType: 'hybrid',
        category: 'Pattern',
        confidence: 'high',
        createdAt: '2026-05-10T00:00:00.000Z',
        canonicalKey: buildMemoryNodeKey(WORKSPACE_ID, 'graph-close'),
        sourceSpecId: SPEC_ID,
        sourceSpecCanonicalKey: buildSpecNodeKey(WORKSPACE_ID, SPEC_ID),
        relatedFiles: ['backend/routes/auth.ts'],
        graphNodeType: 'memory',
        graphActive: true,
        graphUpdatedAt: '2026-05-10T00:00:00.000Z',
        graphSignals: [{
          fromCanonicalKey: buildMemoryNodeKey(WORKSPACE_ID, 'graph-close'),
          toCanonicalKey: buildFileNodeKey(WORKSPACE_ID, 'backend/routes/auth.ts'),
          relationship: 'ABOUT',
          hops: 1,
          active: true,
          updatedAt: '2026-05-10T00:00:00.000Z',
        }],
      },
    ];

    const configuredOff = runRanking(candidates, { graphScoreWeight: 0 });
    const unavailable = runRanking(candidates, { graphScoreWeight: 0.35, graphProximityAvailable: false });

    expect(unavailable.selected.map(candidate => candidate.id)).toEqual(configuredOff.selected.map(candidate => candidate.id));
    expect(unavailable.graphRerankAppliedWeight).toBe(0);
    expect(unavailable.graphRerankChanged).toBe(false);
    expect(unavailable.selected.every(candidate => candidate.rerankedBy === 'semantic')).toBe(true);
  });

  test('never lets foreign workspace graph signals promote a candidate during reranking', () => {
    const candidates: RetrievalCandidateInput[] = [
      {
        id: 'local-graph',
        text: 'Local auth memory with in-scope graph proximity',
        origin: 'search',
        baseScore: 0.6,
        matchType: 'hybrid',
        category: 'Pattern',
        confidence: 'high',
        createdAt: '2026-05-10T00:00:00.000Z',
        canonicalKey: buildMemoryNodeKey(WORKSPACE_ID, 'local-graph'),
        sourceSpecId: SPEC_ID,
        sourceSpecCanonicalKey: buildSpecNodeKey(WORKSPACE_ID, SPEC_ID),
        relatedFiles: ['backend/routes/auth.ts'],
        graphNodeType: 'memory',
        graphActive: true,
        graphUpdatedAt: '2026-05-10T00:00:00.000Z',
        graphSignals: [{
          fromCanonicalKey: buildMemoryNodeKey(WORKSPACE_ID, 'local-graph'),
          toCanonicalKey: buildFileNodeKey(WORKSPACE_ID, 'backend/routes/auth.ts'),
          relationship: 'ABOUT',
          hops: 1,
          active: true,
          updatedAt: '2026-05-10T00:00:00.000Z',
        }],
      },
      {
        id: 'foreign-graph',
        text: 'Foreign workspace auth memory that should not be promoted',
        origin: 'search',
        baseScore: 0.79,
        matchType: 'hybrid',
        category: 'Pattern',
        confidence: 'high',
        createdAt: '2026-05-10T00:00:00.000Z',
        canonicalKey: buildMemoryNodeKey(WORKSPACE_ID, 'foreign-graph'),
        sourceSpecId: SPEC_ID,
        sourceSpecCanonicalKey: buildSpecNodeKey(WORKSPACE_ID, SPEC_ID),
        relatedFileKeys: [buildFileNodeKey('ws-2', 'backend/routes/auth.ts')],
        graphNodeType: 'memory',
        graphActive: true,
        graphUpdatedAt: '2026-05-10T00:00:00.000Z',
        graphSignals: [{
          fromCanonicalKey: buildMemoryNodeKey('ws-2', 'foreign-graph'),
          toCanonicalKey: buildFileNodeKey('ws-2', 'backend/routes/auth.ts'),
          relationship: 'ABOUT',
          hops: 1,
          active: true,
          updatedAt: '2026-05-10T00:00:00.000Z',
        }],
      },
    ];

    const result = runRanking(candidates, { graphScoreWeight: 1 });

    expect(result.selected.map(candidate => candidate.id)).toEqual(['local-graph', 'foreign-graph']);
    expect(result.selected[0]?.graphScore).toBeGreaterThan(result.selected[1]?.graphScore ?? 0);
    expect(result.selected[1]?.rerankedBy).toBe('semantic');
    expect(result.selected[1]?.scoring.breakdown.directGraphProximity.scopeValid).toBe(false);
    expect(result.selected[1]?.graphScore).toBe(0);
  });

  test('drops candidates without resolvable canonical keys and marks lite-mode proximity gaps explicitly', () => {
    const result = rankRetrievalCandidates({
      workspaceId: WORKSPACE_ID,
      specId: SPEC_ID,
      storyId: STORY_ID,
      queryText: 'Investigate graph scoring in lite mode',
      predictedPaths: ['backend/src/lib/graph-context.ts'],
      candidates: [{
        id: 'cache:ephemeral',
        text: 'Transient cache entry without persisted canonical identity',
        origin: 'cache',
        baseScore: 0.4,
        matchType: 'cache',
        relatedFiles: ['backend/src/lib/graph-context.ts'],
      }],
      skills: [],
      tokenBudget: 200,
      graphProximityAvailable: false,
      evaluationTimestamp: '2026-05-31T00:00:00.000Z',
    });

    expect(result.selected).toEqual([]);
    expect(result.candidates[0]?.decision).toBe('drop');
    expect(result.candidates[0]?.finalScore).toBe(0);
    expect(result.candidates[0]?.scoring.breakdown.directGraphProximity).toMatchObject({
      score: 0,
      proximityUnavailable: true,
    });
    expect(result.candidates[0]?.scoring.validation.issues).toContain(
      'Candidate is missing a resolvable canonical memory key; scoring consumes identity and cannot invent it',
    );
    expect(result.candidates[0]?.scoring.tieBreak.canonicalKey).toBe('invalid:memory:ws-1::cache:ephemeral');
  });

  test('handles empty candidate arrays without throwing', () => {
    const result = runRanking([]);

    expect(result.candidates).toEqual([]);
    expect(result.selected).toEqual([]);
    expect(result.contradictions).toEqual([]);
    expect(result.needsMoreEvidence).toBe(true);
  });

  test('scores supported canonical projection node types in scope', () => {
    const specKey = buildSpecNodeKey(WORKSPACE_ID, SPEC_ID);
    const storyKey = buildStoryNodeKey(WORKSPACE_ID, SPEC_ID, STORY_ID);
    const fileKey = buildFileNodeKey(WORKSPACE_ID, 'backend/routes/auth.ts');

    const candidates: RetrievalCandidateInput[] = [
      {
        id: 'story-node',
        text: 'Story candidate',
        origin: 'graph',
        baseScore: 0.6,
        canonicalKey: storyKey,
        graphNodeType: 'story',
        graphActive: true,
        graphUpdatedAt: '2026-05-30T00:00:00.000Z',
        graphSignals: [{ fromCanonicalKey: storyKey, toCanonicalKey: specKey, relationship: 'BELONGS_TO', hops: 1, active: true, updatedAt: '2026-05-30T00:00:00.000Z' }],
      },
      {
        id: 'memory-node',
        text: 'Memory candidate',
        origin: 'graph',
        baseScore: 0.6,
        canonicalKey: buildMemoryNodeKey(WORKSPACE_ID, 'mem-1'),
        graphNodeType: 'memory',
        graphActive: true,
        graphUpdatedAt: '2026-05-30T00:00:00.000Z',
        sourceSpecCanonicalKey: specKey,
        sourceStoryCanonicalKey: storyKey,
        graphSignals: [{ fromCanonicalKey: buildMemoryNodeKey(WORKSPACE_ID, 'mem-1'), toCanonicalKey: fileKey, relationship: 'ABOUT', hops: 1, active: true, updatedAt: '2026-05-30T00:00:00.000Z' }],
      },
      {
        id: 'file-node',
        text: 'File candidate',
        origin: 'graph',
        baseScore: 0.6,
        canonicalKey: fileKey,
        graphNodeType: 'file',
        graphActive: true,
        graphUpdatedAt: '2026-05-30T00:00:00.000Z',
        graphSignals: [{ fromCanonicalKey: fileKey, toCanonicalKey: storyKey, relationship: 'TOUCHES', hops: 1, active: true, updatedAt: '2026-05-30T00:00:00.000Z' }],
      },
      {
        id: 'spec-node',
        text: 'Spec candidate',
        origin: 'graph',
        baseScore: 0.6,
        canonicalKey: specKey,
        graphNodeType: 'spec',
        graphActive: true,
        graphUpdatedAt: '2026-05-30T00:00:00.000Z',
        graphSignals: [{ fromCanonicalKey: specKey, toCanonicalKey: storyKey, relationship: 'BELONGS_TO', hops: 1, active: true, updatedAt: '2026-05-30T00:00:00.000Z' }],
      },
      {
        id: 'convention-node',
        text: 'Convention candidate',
        origin: 'graph',
        baseScore: 0.6,
        canonicalKey: buildConventionNodeKey(WORKSPACE_ID, 'auth-convention'),
        graphNodeType: 'convention',
        graphActive: true,
        graphUpdatedAt: '2026-05-30T00:00:00.000Z',
        graphSignals: [{ fromCanonicalKey: buildConventionNodeKey(WORKSPACE_ID, 'auth-convention'), toCanonicalKey: fileKey, relationship: 'APPLIES_TO', hops: 1, active: true, updatedAt: '2026-05-30T00:00:00.000Z' }],
      },
      {
        id: 'skill-node',
        text: 'Skill candidate',
        origin: 'graph',
        baseScore: 0.6,
        canonicalKey: buildSkillNodeKey('Auth Security', 'auto-match'),
        graphNodeType: 'skill',
        graphActive: true,
        graphUpdatedAt: '2026-05-30T00:00:00.000Z',
        graphSignals: [{ fromCanonicalKey: buildSkillNodeKey('Auth Security', 'auto-match'), toCanonicalKey: storyKey, relationship: 'USED_IN', hops: 1, active: true, updatedAt: '2026-05-30T00:00:00.000Z' }],
      },
    ];

    for (const candidate of candidates) {
      const score = scoreProjection(candidate);
      expect(score.score).toBeGreaterThan(0);
      expect(score.scopeValid).toBe(true);
      expect(score.nodeType).toBe(candidate.graphNodeType);
    }
  });

  test('keeps duplicate story ids distinct by canonical spec-scoped keys', () => {
    const specAStoryKey = buildStoryNodeKey(WORKSPACE_ID, 'spec-a', 'US-001');
    const specBStoryKey = buildStoryNodeKey(WORKSPACE_ID, 'spec-b', 'US-001');

    const inScope = scoreProjection({
      id: 'US-001',
      text: 'Story in active spec',
      origin: 'graph',
      baseScore: 0.6,
      canonicalKey: specAStoryKey,
      graphNodeType: 'story',
      graphActive: true,
      graphUpdatedAt: '2026-05-30T00:00:00.000Z',
      graphSignals: [{ fromCanonicalKey: specAStoryKey, toCanonicalKey: buildSpecNodeKey(WORKSPACE_ID, 'spec-a'), relationship: 'BELONGS_TO', hops: 1, active: true, updatedAt: '2026-05-30T00:00:00.000Z' }],
    }, 'spec-a');

    const outOfScope = scoreProjection({
      id: 'US-001',
      text: 'Story in other spec',
      origin: 'graph',
      baseScore: 0.6,
      canonicalKey: specBStoryKey,
      graphNodeType: 'story',
      graphActive: true,
      graphUpdatedAt: '2026-05-30T00:00:00.000Z',
      graphSignals: [{ fromCanonicalKey: specBStoryKey, toCanonicalKey: buildSpecNodeKey(WORKSPACE_ID, 'spec-b'), relationship: 'BELONGS_TO', hops: 1, active: true, updatedAt: '2026-05-30T00:00:00.000Z' }],
    }, 'spec-a');

    expect(inScope.score).toBeGreaterThan(0);
    expect(outOfScope.score).toBe(0);
    expect(outOfScope.scopeValid).toBe(false);
    expect(specAStoryKey).not.toBe(specBStoryKey);
  });

  test('keeps duplicate file paths distinct by workspace-scoped canonical keys', () => {
    const localPath = 'src/index.ts';
    const fileWs1 = buildFileNodeKey(WORKSPACE_ID, localPath);
    const fileWs2 = buildFileNodeKey('ws-2', localPath);
    const storyKey = buildStoryNodeKey(WORKSPACE_ID, SPEC_ID, STORY_ID);

    const inScope = scoreProjection({
      id: localPath,
      text: 'Workspace-local file',
      origin: 'graph',
      baseScore: 0.6,
      canonicalKey: fileWs1,
      graphNodeType: 'file',
      graphActive: true,
      graphUpdatedAt: '2026-05-30T00:00:00.000Z',
      graphSignals: [{ fromCanonicalKey: fileWs1, toCanonicalKey: storyKey, relationship: 'TOUCHES', hops: 1, active: true, updatedAt: '2026-05-30T00:00:00.000Z' }],
    });

    const leaked = scoreProjection({
      id: localPath,
      text: 'Foreign workspace file',
      origin: 'graph',
      baseScore: 0.6,
      canonicalKey: fileWs2,
      graphNodeType: 'file',
      graphActive: true,
      graphUpdatedAt: '2026-05-30T00:00:00.000Z',
      graphSignals: [{ fromCanonicalKey: fileWs2, toCanonicalKey: buildStoryNodeKey('ws-2', SPEC_ID, STORY_ID), relationship: 'TOUCHES', hops: 1, active: true, updatedAt: '2026-05-30T00:00:00.000Z' }],
    });

    expect(inScope.score).toBeGreaterThan(0);
    expect(leaked.score).toBe(0);
    expect(leaked.scopeValid).toBe(false);
    expect(fileWs1).not.toBe(fileWs2);
  });

  test('suppresses stale projection artifacts and mixed weak graph signals', () => {
    const freshDirect = scoreProjection({
      id: 'mem-fresh',
      text: 'Fresh direct memory',
      origin: 'graph',
      baseScore: 0.6,
      canonicalKey: buildMemoryNodeKey(WORKSPACE_ID, 'mem-fresh'),
      graphNodeType: 'memory',
      graphActive: true,
      graphUpdatedAt: '2026-05-30T00:00:00.000Z',
      relatedFileKeys: [buildFileNodeKey(WORKSPACE_ID, 'backend/routes/auth.ts')],
      graphSignals: [{ fromCanonicalKey: buildMemoryNodeKey(WORKSPACE_ID, 'mem-fresh'), toCanonicalKey: buildFileNodeKey(WORKSPACE_ID, 'backend/routes/auth.ts'), relationship: 'ABOUT', hops: 1, active: true, updatedAt: '2026-05-30T00:00:00.000Z' }],
    });

    const staleIndirect = scoreProjection({
      id: 'mem-stale',
      text: 'Stale indirect memory',
      origin: 'graph',
      baseScore: 0.6,
      canonicalKey: buildMemoryNodeKey(WORKSPACE_ID, 'mem-stale'),
      graphNodeType: 'memory',
      graphActive: false,
      graphUpdatedAt: '2023-01-01T00:00:00.000Z',
      graphSignals: [{ fromCanonicalKey: buildMemoryNodeKey(WORKSPACE_ID, 'mem-stale'), toCanonicalKey: buildSpecNodeKey(WORKSPACE_ID, SPEC_ID), relationship: 'DEPENDS_ON', hops: 3, active: false, updatedAt: '2023-01-01T00:00:00.000Z' }],
    });

    const weakIndirect = scoreProjection({
      id: 'mem-indirect',
      text: 'Weak indirect memory',
      origin: 'graph',
      baseScore: 0.6,
      canonicalKey: buildMemoryNodeKey(WORKSPACE_ID, 'mem-indirect'),
      graphNodeType: 'memory',
      graphActive: true,
      graphUpdatedAt: '2026-05-30T00:00:00.000Z',
      graphSignals: [{ fromCanonicalKey: buildMemoryNodeKey(WORKSPACE_ID, 'mem-indirect'), toCanonicalKey: buildSpecNodeKey(WORKSPACE_ID, SPEC_ID), relationship: 'DEPENDS_ON', hops: 3, active: true, updatedAt: '2026-05-30T00:00:00.000Z' }],
    });

    expect(freshDirect.score).toBeGreaterThan(weakIndirect.score);
    expect(staleIndirect.score).toBe(0);
    expect(staleIndirect.stale).toBe(true);
  });

  test('gracefully returns zero for missing graph data and unsupported node types', () => {
    const missingGraph = scoreProjection({
      id: 'mem-missing',
      text: 'Missing graph data',
      origin: 'graph',
      baseScore: 0.6,
      canonicalKey: buildMemoryNodeKey(WORKSPACE_ID, 'mem-missing'),
      graphNodeType: 'memory',
      graphActive: true,
      graphUpdatedAt: '2026-05-30T00:00:00.000Z',
      graphSignals: [],
    });

    const unsupported = scoreProjection({
      id: 'unknown-1',
      text: 'Unknown graph node type',
      origin: 'graph',
      baseScore: 0.6,
      canonicalKey: 'workspace:ws-1::mystery:1',
      graphNodeType: 'mystery',
      graphActive: true,
      graphUpdatedAt: '2026-05-30T00:00:00.000Z',
      graphSignals: [],
    });

    expect(missingGraph.score).toBe(0);
    expect(missingGraph.signalCount).toBe(0);
    expect(unsupported.score).toBe(0);
    expect(unsupported.nodeType).toBe('unknown');
  });

  test('drops stale graph candidates during ranking instead of throwing', () => {
    const result = runRanking([
      {
        id: 'live-graph',
        text: 'Auth route memory with fresh direct evidence',
        origin: 'graph',
        baseScore: 0.75,
        matchType: 'graph',
        category: 'Pattern',
        confidence: 'high',
        createdAt: '2026-05-30T00:00:00.000Z',
        canonicalKey: buildMemoryNodeKey(WORKSPACE_ID, 'live-graph'),
        graphNodeType: 'memory',
        graphActive: true,
        graphUpdatedAt: '2026-05-30T00:00:00.000Z',
        sourceSpecId: SPEC_ID,
        sourceSpecCanonicalKey: buildSpecNodeKey(WORKSPACE_ID, SPEC_ID),
        sourceStoryId: 'US-050',
        sourceStoryCanonicalKey: buildStoryNodeKey(WORKSPACE_ID, SPEC_ID, 'US-050'),
        relatedFiles: ['backend/routes/auth.ts'],
      },
      {
        id: 'stale-graph',
        text: 'Stale graph artifact',
        origin: 'graph',
        baseScore: 0.8,
        matchType: 'graph',
        category: 'Pattern',
        confidence: 'high',
        createdAt: '2024-01-01T00:00:00.000Z',
        canonicalKey: buildMemoryNodeKey(WORKSPACE_ID, 'stale-graph'),
        graphNodeType: 'memory',
        graphActive: false,
        graphUpdatedAt: '2024-01-01T00:00:00.000Z',
        sourceSpecId: SPEC_ID,
        sourceSpecCanonicalKey: buildSpecNodeKey(WORKSPACE_ID, SPEC_ID),
        relatedFiles: ['backend/routes/auth.ts'],
      },
    ]);

    expect(result.selected.map(candidate => candidate.id)).toContain('live-graph');
    expect(result.selected.map(candidate => candidate.id)).not.toContain('stale-graph');
    expect(result.candidates.find(candidate => candidate.id === 'stale-graph')?.scoring.validation.issues).toContain(
      'Graph candidate is stale or inactive in the canonical projection',
    );
  });

  test('newer direct evidence outranks an older repetitive low-confidence pattern', () => {
    const candidates: RetrievalCandidateInput[] = [
      {
        id: 'pattern-old-1',
        text: 'Auth retries: always retry admin bearer failures three times before surfacing errors',
        origin: 'search',
        baseScore: 0.71,
        matchType: 'hybrid',
        category: 'Pattern',
        confidence: 'low',
        createdAt: '2025-12-01T00:00:00.000Z',
        sourceSpecId: SPEC_ID,
        sourceSpecCanonicalKey: buildSpecNodeKey(WORKSPACE_ID, SPEC_ID),
        relatedFiles: ['backend/routes/auth.ts'],
      },
      {
        id: 'pattern-old-2',
        text: 'Auth retries: retry admin bearer failures repeatedly before surfacing errors',
        origin: 'search',
        baseScore: 0.68,
        matchType: 'hybrid',
        category: 'Pattern',
        confidence: 'low',
        createdAt: '2026-01-10T00:00:00.000Z',
        sourceSpecId: SPEC_ID,
        sourceSpecCanonicalKey: buildSpecNodeKey(WORKSPACE_ID, SPEC_ID),
        relatedFiles: ['backend/routes/auth.ts'],
      },
      {
        id: 'fresh-direct',
        text: 'Auth middleware: preserve deterministic JWT bearer verification and fail immediately on invalid admin tokens',
        origin: 'search',
        baseScore: 0.79,
        matchType: 'hybrid',
        category: 'Pattern',
        confidence: 'high',
        createdAt: '2026-05-30T00:00:00.000Z',
        sourceSpecId: SPEC_ID,
        sourceSpecCanonicalKey: buildSpecNodeKey(WORKSPACE_ID, SPEC_ID),
        relatedFiles: ['backend/routes/auth.ts'],
      },
    ];

    const result = runRanking(candidates);

    expect(result.selected[0]?.id).toBe('fresh-direct');
    expect(result.selected.map(candidate => candidate.id)).not.toEqual(['pattern-old-1', 'pattern-old-2']);
    expect(result.candidates.find(candidate => candidate.id === 'pattern-old-2')?.scoring.breakdown.repetitionPenalty.score ?? 0).toBeGreaterThan(0);
  });

  test('pinned content can intentionally outrank newer unpinned content', () => {
    const candidates: RetrievalCandidateInput[] = [
      {
        id: 'pinned-old',
        text: 'Pinned auth memory: keep JWT bearer verification as the canonical admin path',
        origin: 'pinned',
        baseScore: 1,
        matchType: 'cache',
        category: 'Convention',
        confidence: 'high',
        pinned: true,
        createdAt: '2025-06-01T00:00:00.000Z',
        sourceSpecId: SPEC_ID,
        sourceSpecCanonicalKey: buildSpecNodeKey(WORKSPACE_ID, SPEC_ID),
        relatedFiles: ['backend/routes/auth.ts'],
      },
      {
        id: 'fresh-unpinned',
        text: 'Fresh auth memory: deterministic ordering matters for admin bearer verification',
        origin: 'search',
        baseScore: 0.88,
        matchType: 'hybrid',
        category: 'Pattern',
        confidence: 'high',
        createdAt: '2026-05-30T00:00:00.000Z',
        sourceSpecId: SPEC_ID,
        sourceSpecCanonicalKey: buildSpecNodeKey(WORKSPACE_ID, SPEC_ID),
        relatedFiles: ['backend/routes/auth.ts'],
      },
    ];

    const result = runRanking(candidates);

    expect(result.selected[0]?.id).toBe('pinned-old');
    expect(result.selected[0]?.freshnessScore).toBe(1);
  });

  test('anti-echo-chamber guardrail caps one file cluster from dominating the top results', () => {
    const result = runRanking([
      {
        id: 'cluster-a-1',
        text: 'Auth cluster memory one for backend/routes/auth.ts',
        origin: 'search',
        baseScore: 0.74,
        matchType: 'hybrid',
        category: 'Pattern',
        confidence: 'medium',
        createdAt: '2026-05-28T00:00:00.000Z',
        sourceSpecId: SPEC_ID,
        sourceSpecCanonicalKey: buildSpecNodeKey(WORKSPACE_ID, SPEC_ID),
        relatedFiles: ['backend/routes/auth.ts'],
      },
      {
        id: 'cluster-a-2',
        text: 'Auth cluster memory two for backend/routes/auth.ts',
        origin: 'search',
        baseScore: 0.73,
        matchType: 'hybrid',
        category: 'Pattern',
        confidence: 'medium',
        createdAt: '2026-05-27T00:00:00.000Z',
        sourceSpecId: SPEC_ID,
        sourceSpecCanonicalKey: buildSpecNodeKey(WORKSPACE_ID, SPEC_ID),
        relatedFiles: ['backend/routes/auth.ts'],
      },
      {
        id: 'cluster-a-3',
        text: 'Auth cluster memory three for backend/routes/auth.ts',
        origin: 'search',
        baseScore: 0.72,
        matchType: 'hybrid',
        category: 'Pattern',
        confidence: 'medium',
        createdAt: '2026-05-26T00:00:00.000Z',
        sourceSpecId: SPEC_ID,
        sourceSpecCanonicalKey: buildSpecNodeKey(WORKSPACE_ID, SPEC_ID),
        relatedFiles: ['backend/routes/auth.ts'],
      },
      {
        id: 'cluster-b-1',
        text: 'Worker queue memory for backend/src/worker.ts',
        origin: 'search',
        baseScore: 0.7,
        matchType: 'hybrid',
        category: 'Pattern',
        confidence: 'medium',
        createdAt: '2026-05-29T00:00:00.000Z',
        sourceSpecId: SPEC_ID,
        sourceSpecCanonicalKey: buildSpecNodeKey(WORKSPACE_ID, SPEC_ID),
        relatedFiles: ['backend/src/worker.ts'],
      },
      {
        id: 'cluster-c-1',
        text: 'Graph context memory for backend/src/lib/graph-context.ts',
        origin: 'search',
        baseScore: 0.69,
        matchType: 'hybrid',
        category: 'Pattern',
        confidence: 'medium',
        createdAt: '2026-05-29T12:00:00.000Z',
        sourceSpecId: SPEC_ID,
        sourceSpecCanonicalKey: buildSpecNodeKey(WORKSPACE_ID, SPEC_ID),
        relatedFiles: ['backend/src/lib/graph-context.ts'],
      },
    ], {
      guardrails: {
        dominanceThreshold: 0.4,
        dominanceTopN: 5,
        minDiversityFloor: 2,
        highConfidenceExempt: false,
      },
    });

    const dominantClusterSelections = result.selected.filter(candidate =>
      candidate.relatedFileKeys?.includes(buildFileNodeKey(WORKSPACE_ID, 'backend/routes/auth.ts')),
    );

    expect(dominantClusterSelections.length).toBeLessThanOrEqual(2);
    expect(result.selected.some(candidate => candidate.id === 'cluster-b-1' || candidate.id === 'cluster-c-1')).toBe(true);
    expect(result.candidates.find(candidate => candidate.id === 'cluster-a-3')?.decision).toBe('drop');
  });

  test('stops the bad-pattern-resurfacing failure mode from accumulating across runs', () => {
    const result = runRanking([
      {
        id: 'bad-run-1',
        text: 'Bad auth pattern: retry invalid admin bearer tokens until they succeed',
        origin: 'search',
        baseScore: 0.67,
        matchType: 'hybrid',
        category: 'Pattern',
        confidence: 'low',
        createdAt: '2026-02-01T00:00:00.000Z',
        sourceRunId: 101,
        sourceSpecId: SPEC_ID,
        sourceSpecCanonicalKey: buildSpecNodeKey(WORKSPACE_ID, SPEC_ID),
        relatedFiles: ['backend/routes/auth.ts'],
      },
      {
        id: 'bad-run-2',
        text: 'Bad auth pattern: keep retrying invalid bearer tokens before failing',
        origin: 'search',
        baseScore: 0.66,
        matchType: 'hybrid',
        category: 'Pattern',
        confidence: 'low',
        createdAt: '2026-03-01T00:00:00.000Z',
        sourceRunId: 102,
        sourceSpecId: SPEC_ID,
        sourceSpecCanonicalKey: buildSpecNodeKey(WORKSPACE_ID, SPEC_ID),
        relatedFiles: ['backend/routes/auth.ts'],
      },
      {
        id: 'bad-run-3',
        text: 'Bad auth pattern: repeated bearer retries on invalid admin auth',
        origin: 'search',
        baseScore: 0.65,
        matchType: 'hybrid',
        category: 'Pattern',
        confidence: 'low',
        createdAt: '2026-04-01T00:00:00.000Z',
        sourceRunId: 103,
        sourceSpecId: SPEC_ID,
        sourceSpecCanonicalKey: buildSpecNodeKey(WORKSPACE_ID, SPEC_ID),
        relatedFiles: ['backend/routes/auth.ts'],
      },
      {
        id: 'good-direct',
        text: 'Good auth evidence: reject invalid admin bearer tokens immediately and log the failure once',
        origin: 'search',
        baseScore: 0.8,
        matchType: 'hybrid',
        category: 'Pattern',
        confidence: 'high',
        createdAt: '2026-05-30T00:00:00.000Z',
        sourceRunId: 104,
        sourceSpecId: SPEC_ID,
        sourceSpecCanonicalKey: buildSpecNodeKey(WORKSPACE_ID, SPEC_ID),
        relatedFiles: ['backend/routes/auth.ts'],
      },
    ]);

    const selectedBadPatterns = result.selected.filter(candidate => candidate.id.startsWith('bad-run-'));

    expect(result.selected[0]?.id).toBe('good-direct');
    expect(selectedBadPatterns.length).toBeLessThanOrEqual(1);
    expect(result.candidates.find(candidate => candidate.id === 'bad-run-2')?.scoring.breakdown.repetitionPenalty.score ?? 0).toBeGreaterThan(0);
    expect(result.candidates.find(candidate => candidate.id === 'bad-run-3')?.scoring.breakdown.repetitionPenalty.score ?? 0).toBeGreaterThan(0);
  });

  test('documents scored and semantic-only GraphRAG surfaces', () => {
    expect(GRAPH_RAG_SCORE_SCHEMA_VERSION).toBe('v2');
    expect(GRAPH_RAG_SCORE_CONTRACT_DOCUMENTATION.schemaVersion).toBe('v2');
    expect(GRAPH_RAG_SCORE_CONTRACT_DOCUMENTATION.ordering).toContain('tieBreak.canonicalKey');
    expect(GRAPH_RAG_SCORE_CONTRACT_DOCUMENTATION.liteModeBehavior).toContain('proximityUnavailable');
    expect(GRAPH_RAG_SCORE_CONTRACT_DOCUMENTATION.scoredSurfaces.some(surface => surface.surface === 'retrieveContext()')).toBe(true);
    expect(GRAPH_RAG_SCORE_CONTRACT_DOCUMENTATION.semanticOnlySurfaces.some(surface => surface.surface === 'GET /api/specs/:specId/knowledge-graph')).toBe(true);
  });

  test('records telemetry events for ranked retrievals', () => {
    const event = recordRetrievalTelemetry({
      workspaceId: WORKSPACE_ID,
      queryPreview: 'auth middleware',
      matchedSkills: ['Auth Security'],
      selectedCandidateKeys: ['memory:ws-1::1'],
      droppedCandidateKeys: ['memory:ws-1::2'],
      needsMoreEvidence: false,
      candidateCount: 2,
      selectedCount: 1,
      tokenBudget: 1200,
      contradictions: [],
      candidates: [],
    });

    expect(event.id).toContain('rt-');
    expect(getRecentRetrievalTelemetry(1)[0]?.workspaceId).toBe(WORKSPACE_ID);
  });

  test('offline eval metrics score rankings deterministically', () => {
    expect(precisionAtK(['a', 'b', 'c'], ['a', 'c'], 2)).toBe(0.5);
    expect(ndcgAtK(['a', 'b', 'c'], ['a', 'c'], 3)).toBeGreaterThan(0.9);
    expect(meanReciprocalRank([
      { rankedIds: ['x', 'a'], relevantIds: ['a'] },
      { rankedIds: ['b', 'c'], relevantIds: ['b'] },
    ])).toBe(0.75);
  });
});
