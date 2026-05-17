/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { matchSkillsToQuery, rankRetrievalCandidates, type RetrievalCandidateInput } from '../retrieval-pipeline';
import { clearRetrievalTelemetry, getRecentRetrievalTelemetry, recordRetrievalTelemetry } from '../retrieval-telemetry';
import { meanReciprocalRank, ndcgAtK, precisionAtK } from '../retrieval-evals';

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
        graphRelationship: 'conflict',
        graphHops: 1,
      },
    ];

    const result = rankRetrievalCandidates({
      queryText: 'Fix admin auth middleware',
      predictedPaths: ['backend/routes/auth.ts'],
      candidates,
      skills: [{ name: 'Auth Security', content: 'auth middleware jwt bearer token authorization' }],
      tokenBudget: 2000,
    });

    expect(result.contradictions).toEqual([[ 'memory:2', 'memory:1' ]]);
    expect(result.selected[0]?.id).toBe('2');
    expect(result.candidates.find(c => c.id === '1')?.conflictsWith).toContain('memory:2');
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

    const result = rankRetrievalCandidates({
      queryText: 'Need SSE guidance and queue worker gotchas',
      candidates,
      skills: [{ name: 'Backend', content: 'sse queue worker pg-boss events' }],
      tokenBudget: 2000,
    });

    expect(result.selected.map(candidate => candidate.id)).toContain('1');
    expect(result.selected.map(candidate => candidate.id)).toContain('3');
    expect(result.selected.map(candidate => candidate.id)).not.toContain('2');
    expect(result.candidates.find(candidate => candidate.id === '2')?.supersededBy).toBe('memory:1');
  });

  test('records telemetry events for ranked retrievals', () => {
    const event = recordRetrievalTelemetry({
      workspaceId: 'ws-1',
      queryPreview: 'auth middleware',
      matchedSkills: ['Auth Security'],
      selectedCandidateKeys: ['memory:1'],
      droppedCandidateKeys: ['memory:2'],
      needsMoreEvidence: false,
      candidateCount: 2,
      selectedCount: 1,
      tokenBudget: 1200,
      contradictions: [],
      candidates: [],
    });

    expect(event.id).toContain('rt-');
    expect(getRecentRetrievalTelemetry(1)[0]?.workspaceId).toBe('ws-1');
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
