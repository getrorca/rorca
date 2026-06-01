/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import fixture from './fixtures/ranking-benchmark-phase2.json';
import { resolveGraphScoringRollout } from '../graph-scoring-rollout';
import {
  compareRankingStrategies,
  rankBaseline,
  rankWithGraph,
  summarizeRankingComparisons,
  type RankingBenchmarkFixture,
  type RankingBenchmarkScenario,
} from '../ranking-benchmark';

const benchmarkFixture = fixture as RankingBenchmarkFixture;
const MIN_NDCG_AT_5 = 0.95;
const MIN_RANK_OVERLAP_AT_5 = 0.95;

function collectCanonicalValues(candidate: Record<string, unknown>): string[] {
  const values: string[] = [];
  for (const key of ['canonicalKey', 'sourceStoryCanonicalKey', 'sourceSpecCanonicalKey']) {
    const value = candidate[key];
    if (typeof value === 'string') values.push(value);
  }
  const relatedFileKeys = candidate.relatedFileKeys;
  if (Array.isArray(relatedFileKeys)) {
    values.push(...relatedFileKeys.filter((entry): entry is string => typeof entry === 'string'));
  }
  const graphSignals = candidate.graphSignals;
  if (Array.isArray(graphSignals)) {
    for (const signal of graphSignals) {
      if (!signal || typeof signal !== 'object') continue;
      const row = signal as Record<string, unknown>;
      if (typeof row.fromCanonicalKey === 'string') values.push(row.fromCanonicalKey);
      if (typeof row.toCanonicalKey === 'string') values.push(row.toCanonicalKey);
    }
  }
  return values;
}

describe('ranking-benchmark', () => {
  test('ships a self-contained Phase 2 fixture set with scoped canonical identities', () => {
    expect(benchmarkFixture.suite).toBe('phase-2-graph-ranking');
    expect(benchmarkFixture.scenarios.map(scenario => scenario.id)).toEqual([
      'direct-relevance',
      'indirect-relevance',
      'duplicate-ids-across-scopes',
      'stale-artifacts',
      'pinned-content',
      'recency-decay',
    ]);

    for (const scenario of benchmarkFixture.scenarios) {
      expect(scenario.workspaceId).toBeTruthy();
      expect(scenario.specId).toBeTruthy();
      expect(scenario.storyId).toBeTruthy();
      expect(scenario.predictedPaths.length).toBeGreaterThan(0);
      expect(scenario.candidates.length).toBeGreaterThan(0);

      for (const candidate of scenario.candidates as unknown as Array<Record<string, unknown>>) {
        const canonicalValues = collectCanonicalValues(candidate);
        expect(canonicalValues.length).toBeGreaterThan(0);
        for (const value of canonicalValues) {
          expect(value).toMatch(/^[a-z]+:[^\s]+::/);
        }
      }
    }
  });

  test('asserts the expected baseline and graph-assisted ranking order for every benchmark scenario', () => {
    for (const scenario of benchmarkFixture.scenarios) {
      const comparison = compareRankingStrategies(scenario as RankingBenchmarkScenario);
      expect(comparison.baseline.orderedIds).toEqual(scenario.baselineExpectedOrder);
      expect(comparison.graph.orderedIds).toEqual(scenario.graphExpectedOrder);
    }
  });

  test('keeps semantic-only ordering unchanged when graph scoring is disabled or graph proximity is unavailable', () => {
    const scenario = benchmarkFixture.scenarios.find(entry => entry.id === 'direct-relevance') as RankingBenchmarkScenario;
    const baseline = rankBaseline(scenario);
    const unavailable = rankWithGraph({
      ...scenario,
      graphProximityAvailable: false,
    });

    expect(unavailable.orderedIds).toEqual(baseline.orderedIds);
    expect(unavailable.appliedWeight).toBe(0);
  });

  test('exposes env-based rollout controls with a safe semantic-only default', () => {
    expect(resolveGraphScoringRollout({ env: {} as NodeJS.ProcessEnv })).toEqual({
      enabled: false,
      weight: 0,
      source: 'default',
    });

    expect(resolveGraphScoringRollout({
      configWeight: 0.2,
      env: { RORCA_GRAPH_SCORING_ENABLED: 'false' },
    })).toEqual({
      enabled: false,
      weight: 0,
      source: 'default',
    });

    expect(resolveGraphScoringRollout({
      configWeight: 0.2,
      env: { RORCA_GRAPH_SCORING_ENABLED: 'true' },
    })).toEqual({
      enabled: true,
      weight: 0.2,
      source: 'workspace-config',
    });

    expect(resolveGraphScoringRollout({
      env: {
        RORCA_GRAPH_SCORING_ENABLED: 'true',
        RORCA_GRAPH_SCORING_WEIGHT: '0.6',
      },
    })).toEqual({
      enabled: true,
      weight: 0.6,
      source: 'env',
    });
  });

  test('emits structured side-by-side logs and enforces a numeric quality gate', () => {
    const comparisons = benchmarkFixture.scenarios.map((scenario) =>
      compareRankingStrategies(scenario as RankingBenchmarkScenario),
    );
    const summary = summarizeRankingComparisons(comparisons);
    const log = comparisons[0]?.logs[0];

    expect(log).toMatchObject({
      workspace_id: benchmarkFixture.scenarios[0]?.workspaceId,
      storyId: benchmarkFixture.scenarios[0]?.storyId,
      method: 'baseline',
      orderedIds: expect.any(Array),
      scores: expect.any(Array),
      durationMs: expect.any(Number),
      ndcgAt5: expect.any(Number),
      overlapAt5: expect.any(Number),
      ts: expect.any(String),
    });

    expect(summary.graphAvgNdcgAt5).toBeGreaterThanOrEqual(MIN_NDCG_AT_5);
    expect(summary.graphAvgOverlapAt5).toBeGreaterThanOrEqual(MIN_RANK_OVERLAP_AT_5);
    expect(summary.graphAvgNdcgAt5).toBeGreaterThanOrEqual(summary.baselineAvgNdcgAt5);
    expect(summary.graphWins).toBeGreaterThanOrEqual(2);
  });
});
