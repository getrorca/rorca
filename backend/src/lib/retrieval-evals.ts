/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

export function reciprocalRank(rankedIds: string[], relevantIds: string[]): number {
  for (let i = 0; i < rankedIds.length; i++) {
    if (relevantIds.includes(rankedIds[i])) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

export function meanReciprocalRank(cases: Array<{ rankedIds: string[]; relevantIds: string[] }>): number {
  if (cases.length === 0) return 0;
  return cases.reduce((sum, testCase) => sum + reciprocalRank(testCase.rankedIds, testCase.relevantIds), 0) / cases.length;
}

export function precisionAtK(rankedIds: string[], relevantIds: string[], k: number): number {
  const topK = rankedIds.slice(0, k);
  if (topK.length === 0) return 0;
  const relevant = topK.filter(id => relevantIds.includes(id)).length;
  return relevant / topK.length;
}

function dcgAtK(rankedIds: string[], relevantIds: string[], k: number): number {
  return rankedIds.slice(0, k).reduce((sum, id, index) => {
    const gain = relevantIds.includes(id) ? 1 : 0;
    return sum + (gain / Math.log2(index + 2));
  }, 0);
}

export function ndcgAtK(rankedIds: string[], relevantIds: string[], k: number): number {
  const dcg = dcgAtK(rankedIds, relevantIds, k);
  const idealRanking = relevantIds.slice(0, k);
  const idcg = dcgAtK(idealRanking, relevantIds, k);
  if (idcg === 0) return 0;
  return dcg / idcg;
}
