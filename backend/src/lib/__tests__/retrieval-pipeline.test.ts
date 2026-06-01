/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import {
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

function runRanking(candidates: RetrievalCandidateInput[]) {
  return rankRetrievalCandidates({
    workspaceId: WORKSPACE_ID,
    specId: SPEC_ID,
    storyId: STORY_ID,
    queryText: 'Fix admin auth middleware and preserve deterministic retrieval ordering',
    predictedPaths: ['backend/routes/auth.ts'],
    candidates,
    skills: [{ name: 'Auth Security', content: 'auth middleware jwt bearer token authorization retrieval ranking' }],
    tokenBudget: 2000,
    evaluationTimestamp: '2026-05-31T00:00:00.000Z',
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

  test('documents scored and semantic-only GraphRAG surfaces', () => {
    expect(GRAPH_RAG_SCORE_SCHEMA_VERSION).toBe('v1');
    expect(GRAPH_RAG_SCORE_CONTRACT_DOCUMENTATION.schemaVersion).toBe('v1');
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
