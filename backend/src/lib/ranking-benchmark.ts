/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { logger } from './logger';
import { ndcgAtK } from './retrieval-evals';
import { rankRetrievalCandidates, type RetrievalCandidateInput, type RetrievalSkill } from './retrieval-pipeline';

export const MAX_GRAPH_RERANK_DURATION_MS = 50;

export interface RankingBenchmarkScenario {
  id: string;
  storyId: string;
  workspaceId: string;
  specId: string;
  queryText: string;
  predictedPaths: string[];
  evaluationTimestamp: string;
  tags: string[];
  relevantIds: string[];
  baselineExpectedOrder: string[];
  graphExpectedOrder: string[];
  graphScoreWeight?: number;
  graphProximityAvailable?: boolean;
  candidates: RetrievalCandidateInput[];
  skills?: RetrievalSkill[];
}

export interface RankingBenchmarkFixture {
  version: number;
  suite: string;
  scenarios: RankingBenchmarkScenario[];
}

export interface RankingBenchmarkLog {
  workspace_id: string;
  storyId: string;
  method: 'baseline' | 'graph';
  requestedWeight: number;
  appliedWeight: number;
  orderedIds: string[];
  scores: number[];
  durationMs: number;
  ndcgAt5: number;
  overlapAt5: number;
  ts: string;
}

export interface RankingBenchmarkRun {
  method: 'baseline' | 'graph';
  orderedIds: string[];
  scores: number[];
  ndcgAt5: number;
  overlapAt5: number;
  requestedWeight: number;
  appliedWeight: number;
  durationMs: number;
  log: RankingBenchmarkLog;
}

export interface RankingBenchmarkComparison {
  scenarioId: string;
  storyId: string;
  workspaceId: string;
  tags: string[];
  relevantIds: string[];
  baseline: RankingBenchmarkRun;
  graph: RankingBenchmarkRun;
  logs: RankingBenchmarkLog[];
}

export interface RankingBenchmarkSummary {
  scenarioCount: number;
  baselineAvgNdcgAt5: number;
  graphAvgNdcgAt5: number;
  baselineAvgOverlapAt5: number;
  graphAvgOverlapAt5: number;
  graphWins: number;
  graphTies: number;
  graphLosses: number;
}

function roundMetric(value: number): number {
  return Number(value.toFixed(6));
}

export function rankOverlapAtK(rankedIds: string[], relevantIds: string[], k: number): number {
  const expected = new Set(relevantIds.slice(0, k));
  if (expected.size === 0) return 0;
  const actual = rankedIds.slice(0, k);
  const overlap = actual.filter(id => expected.has(id)).length;
  return roundMetric(overlap / expected.size);
}

function runScenario(
  scenario: RankingBenchmarkScenario,
  method: 'baseline' | 'graph',
  graphScoreWeight: number,
): RankingBenchmarkRun {
  const start = Date.now();
  const ranked = rankRetrievalCandidates({
    workspaceId: scenario.workspaceId,
    specId: scenario.specId,
    storyId: scenario.storyId,
    queryText: scenario.queryText,
    predictedPaths: scenario.predictedPaths,
    candidates: scenario.candidates,
    skills: scenario.skills ?? [],
    tokenBudget: 4000,
    graphProximityAvailable: scenario.graphProximityAvailable ?? true,
    graphScoreWeight,
    evaluationTimestamp: scenario.evaluationTimestamp,
  });
  const durationMs = Date.now() - start;
  const orderedIds = ranked.selected.map(candidate => candidate.id);
  const scores = ranked.selected.map(candidate => candidate.finalScore);
  const ndcgAt5 = roundMetric(ndcgAtK(orderedIds, scenario.relevantIds, 5));
  const overlapAt5 = rankOverlapAtK(orderedIds, scenario.relevantIds, 5);
  const log: RankingBenchmarkLog = {
    workspace_id: scenario.workspaceId,
    storyId: scenario.storyId,
    method,
    requestedWeight: graphScoreWeight,
    appliedWeight: ranked.graphRerankAppliedWeight,
    orderedIds,
    scores,
    durationMs,
    ndcgAt5,
    overlapAt5,
    ts: new Date().toISOString(),
  };

  logger.info(log, '[ranking-benchmark] scenario run');

  return {
    method,
    orderedIds,
    scores,
    ndcgAt5,
    overlapAt5,
    requestedWeight: graphScoreWeight,
    appliedWeight: ranked.graphRerankAppliedWeight,
    durationMs,
    log,
  };
}

export function rankBaseline(scenario: RankingBenchmarkScenario): RankingBenchmarkRun {
  return runScenario(scenario, 'baseline', 0);
}

export function rankWithGraph(scenario: RankingBenchmarkScenario): RankingBenchmarkRun {
  return runScenario(scenario, 'graph', scenario.graphScoreWeight ?? 1);
}

export function compareRankingStrategies(scenario: RankingBenchmarkScenario): RankingBenchmarkComparison {
  const baseline = rankBaseline(scenario);
  const graph = rankWithGraph(scenario);
  return {
    scenarioId: scenario.id,
    storyId: scenario.storyId,
    workspaceId: scenario.workspaceId,
    tags: scenario.tags,
    relevantIds: scenario.relevantIds,
    baseline,
    graph,
    logs: [baseline.log, graph.log],
  };
}

export function summarizeRankingComparisons(comparisons: RankingBenchmarkComparison[]): RankingBenchmarkSummary {
  if (comparisons.length === 0) {
    return {
      scenarioCount: 0,
      baselineAvgNdcgAt5: 0,
      graphAvgNdcgAt5: 0,
      baselineAvgOverlapAt5: 0,
      graphAvgOverlapAt5: 0,
      graphWins: 0,
      graphTies: 0,
      graphLosses: 0,
    };
  }

  let baselineNdcg = 0;
  let graphNdcg = 0;
  let baselineOverlap = 0;
  let graphOverlap = 0;
  let graphWins = 0;
  let graphTies = 0;
  let graphLosses = 0;

  for (const comparison of comparisons) {
    baselineNdcg += comparison.baseline.ndcgAt5;
    graphNdcg += comparison.graph.ndcgAt5;
    baselineOverlap += comparison.baseline.overlapAt5;
    graphOverlap += comparison.graph.overlapAt5;

    if (comparison.graph.ndcgAt5 > comparison.baseline.ndcgAt5) {
      graphWins++;
    } else if (comparison.graph.ndcgAt5 < comparison.baseline.ndcgAt5) {
      graphLosses++;
    } else {
      graphTies++;
    }
  }

  return {
    scenarioCount: comparisons.length,
    baselineAvgNdcgAt5: roundMetric(baselineNdcg / comparisons.length),
    graphAvgNdcgAt5: roundMetric(graphNdcg / comparisons.length),
    baselineAvgOverlapAt5: roundMetric(baselineOverlap / comparisons.length),
    graphAvgOverlapAt5: roundMetric(graphOverlap / comparisons.length),
    graphWins,
    graphTies,
    graphLosses,
  };
}
