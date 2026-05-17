/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

export interface RetrievalSkill {
  name: string;
  content: string;
}

export interface RetrievalCandidateInput {
  id: string;
  text: string;
  title?: string;
  origin: 'pinned' | 'cache' | 'search' | 'graph';
  baseScore: number;
  matchType?: 'keyword' | 'semantic' | 'hybrid' | 'cache' | 'graph';
  category?: string;
  confidence?: string | null;
  sourceType?: string | null;
  source?: string | null;
  pinned?: boolean;
  createdAt?: string | null;
  relatedFiles?: string[];
  sourceStoryId?: string | null;
  sourceSpecId?: string | null;
  sourceRunId?: number | null;
  graphRelationship?: string;
  graphHops?: number;
}

export interface MatchedSkill {
  name: string;
  score: number;
}

export interface RankedRetrievalCandidate extends RetrievalCandidateInput {
  key: string;
  tokenCount: number;
  lexicalScore: number;
  semanticScore: number;
  graphScore: number;
  freshnessScore: number;
  confidenceScore: number;
  fileOverlapScore: number;
  validatorScore: number;
  historicalScore: number;
  finalScore: number;
  decision: 'keep' | 'drop' | 'needs-more' | 'conflict';
  conflictsWith: string[];
  supersededBy?: string;
  reasons: string[];
}

export interface RankRetrievalCandidatesResult {
  matchedSkills: MatchedSkill[];
  selected: RankedRetrievalCandidate[];
  candidates: RankedRetrievalCandidate[];
  needsMoreEvidence: boolean;
  contradictions: Array<[string, string]>;
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'then', 'have', 'been',
  'will', 'your', 'about', 'there', 'their', 'would', 'could', 'should', 'after', 'only',
  'also', 'when', 'where', 'which', 'while', 'using', 'used', 'need', 'make', 'just',
]);

function clamp(value: number, min: number = 0, max: number = 1): number {
  return Math.max(min, Math.min(max, value));
}

function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / 4);
}

function tokenize(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9_./-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(token => token.length > 2 || /[./_-]/.test(token))
    .filter(token => !STOPWORDS.has(token));
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function tokenOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const aSet = new Set(a);
  const bSet = new Set(b);
  let overlap = 0;
  for (const token of aSet) {
    if (bSet.has(token)) overlap++;
  }
  return overlap / Math.max(aSet.size, bSet.size);
}

function inferSubject(text: string): string {
  const colon = text.indexOf(':');
  if (colon > 0 && colon <= 80) {
    return text.slice(0, colon).trim().toLowerCase();
  }
  return tokenize(text).slice(0, 6).join(' ');
}

function hasPositiveDirective(text: string): boolean {
  return /\b(use|prefer|always|must|should|do use|recommended)\b/i.test(text);
}

function hasNegativeDirective(text: string): boolean {
  return /\b(avoid|never|don't|do not|must not|should not|deprecated)\b/i.test(text);
}

function confidenceScore(confidence?: string | null): number {
  switch ((confidence || '').toLowerCase()) {
    case 'high': return 1;
    case 'medium': return 0.7;
    case 'low': return 0.45;
    default: return 0.6;
  }
}

function freshnessScore(candidate: RetrievalCandidateInput): number {
  if (candidate.pinned) return 1;
  if (!candidate.createdAt) return 0.6;

  const ageMs = Math.max(0, Date.now() - new Date(candidate.createdAt).getTime());
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  let halfLifeDays = 90;
  const category = (candidate.category || '').toLowerCase();
  const sourceType = (candidate.sourceType || '').toLowerCase();

  if (category.includes('convention')) halfLifeDays = 365;
  else if (category.includes('bug')) halfLifeDays = 120;
  else if (sourceType === 'synthesis') halfLifeDays = 45;
  else if (sourceType === 'manual' || sourceType === 'mcp') halfLifeDays = 180;

  return clamp(Math.exp(-Math.log(2) * (ageDays / halfLifeDays)));
}

function fileOverlapScore(predictedPaths: string[], relatedFiles: string[]): number {
  if (predictedPaths.length === 0 || relatedFiles.length === 0) return 0;
  const pathTokens = unique(predictedPaths.flatMap(tokenize));
  const relatedTokens = unique(relatedFiles.flatMap(tokenize));
  return tokenOverlap(pathTokens, relatedTokens);
}

export function matchSkillsToQuery(
  queryText: string,
  skills: RetrievalSkill[],
  predictedPaths: string[] = [],
): MatchedSkill[] {
  const queryTokens = unique([...tokenize(queryText), ...predictedPaths.flatMap(tokenize)]);
  const matched = skills
    .map(skill => {
      const skillTokens = unique(tokenize(`${skill.name} ${skill.content.slice(0, 1200)}`));
      const score = tokenOverlap(queryTokens, skillTokens);
      return { name: skill.name, score };
    })
    .filter(skill => skill.score >= 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return matched;
}

function validatorScore(candidate: RetrievalCandidateInput, matchedSkills: MatchedSkill[]): { score: number; reasons: string[] } {
  if (matchedSkills.length === 0) {
    return { score: 0.45, reasons: ['No matched skills; validator stayed neutral'] };
  }

  const candidateTokens = tokenize(candidate.text);
  const skillMatches = matchedSkills.filter(skill =>
    candidateTokens.some(token => tokenize(skill.name).includes(token)),
  );

  const best = skillMatches[0]?.score ?? matchedSkills[0]?.score ?? 0;
  const reasons = skillMatches.length > 0
    ? [`Matched skills supported this candidate: ${skillMatches.map(s => s.name).join(', ')}`]
    : ['Skills weakly related; candidate kept but not strongly endorsed'];

  return { score: clamp(0.35 + best), reasons };
}

function semanticScore(candidate: RetrievalCandidateInput): number {
  if (candidate.origin === 'cache' || candidate.origin === 'pinned') return 0.55;
  if (candidate.origin === 'graph') return 0.6;
  switch (candidate.matchType) {
    case 'semantic': return clamp(candidate.baseScore);
    case 'hybrid': return clamp(candidate.baseScore);
    case 'keyword': return clamp(candidate.baseScore * 0.75);
    default: return clamp(candidate.baseScore);
  }
}

function graphScore(candidate: RetrievalCandidateInput, predictedPaths: string[]): number {
  const fileScore = fileOverlapScore(predictedPaths, candidate.relatedFiles || []);
  if (candidate.origin === 'graph') {
    const hopPenalty = candidate.graphHops && candidate.graphHops > 1 ? 0.1 * (candidate.graphHops - 1) : 0;
    return clamp(0.85 + fileScore - hopPenalty);
  }
  return clamp(fileScore);
}

function lexicalScore(queryText: string, candidate: RetrievalCandidateInput): number {
  return tokenOverlap(tokenize(queryText), tokenize(candidate.text));
}

function mmrSimilarity(a: RankedRetrievalCandidate, b: RankedRetrievalCandidate): number {
  return tokenOverlap(tokenize(a.text), tokenize(b.text));
}

export function rankRetrievalCandidates(input: {
  queryText: string;
  predictedPaths?: string[];
  candidates: RetrievalCandidateInput[];
  skills: RetrievalSkill[];
  historicalUsefulness?: Map<string, number>;
  tokenBudget: number;
}): RankRetrievalCandidatesResult {
  const predictedPaths = input.predictedPaths ?? [];
  const historicalUsefulness = input.historicalUsefulness ?? new Map<string, number>();
  const matchedSkills = matchSkillsToQuery(input.queryText, input.skills, predictedPaths);
  const contradictions: Array<[string, string]> = [];

  const enriched: RankedRetrievalCandidate[] = input.candidates.map((candidate) => {
    const lexical = lexicalScore(input.queryText, candidate);
    const semantic = semanticScore(candidate);
    const graph = graphScore(candidate, predictedPaths);
    const fresh = freshnessScore(candidate);
    const conf = confidenceScore(candidate.confidence);
    const files = fileOverlapScore(predictedPaths, candidate.relatedFiles || []);
    const validator = validatorScore(candidate, matchedSkills);
    const historical = historicalUsefulness.get(`memory:${candidate.id}`)
      ?? historicalUsefulness.get(candidate.id)
      ?? 0.5;

    const finalScore = clamp(
      (candidate.baseScore * 0.22)
      + (lexical * 0.18)
      + (semantic * 0.14)
      + (graph * 0.14)
      + (fresh * 0.10)
      + (conf * 0.07)
      + (files * 0.05)
      + (validator.score * 0.07)
      + (historical * 0.03),
    );

    const rankedCandidate: RankedRetrievalCandidate = {
      ...candidate,
      key: `memory:${candidate.id}`,
      tokenCount: estimateTokens(candidate.text),
      lexicalScore: lexical,
      semanticScore: semantic,
      graphScore: graph,
      freshnessScore: fresh,
      confidenceScore: conf,
      fileOverlapScore: files,
      validatorScore: validator.score,
      historicalScore: historical,
      finalScore,
      decision: 'keep',
      conflictsWith: [],
      reasons: validator.reasons,
      supersededBy: undefined,
    };
    return rankedCandidate;
  });

  const bySubject = new Map<string, RankedRetrievalCandidate[]>();
  for (const candidate of enriched) {
    const subject = inferSubject(candidate.text);
    if (!subject) continue;
    const existing = bySubject.get(subject) ?? [];
    existing.push(candidate);
    bySubject.set(subject, existing);
  }

  for (const group of bySubject.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
    const newest = group[0];
    for (const older of group.slice(1)) {
      const similarity = tokenOverlap(tokenize(newest.text), tokenize(older.text));
      const newestNegative = hasNegativeDirective(newest.text);
      const olderNegative = hasNegativeDirective(older.text);
      const newestPositive = hasPositiveDirective(newest.text) && !newestNegative;
      const olderPositive = hasPositiveDirective(older.text) && !olderNegative;
      const conflicting = similarity >= 0.15
        && ((newestNegative && olderPositive) || (olderNegative && newestPositive));

      if (conflicting) {
        newest.conflictsWith.push(older.key);
        older.conflictsWith.push(newest.key);
        newest.decision = 'conflict';
        older.decision = 'conflict';
        older.finalScore = clamp(older.finalScore - 0.08);
        contradictions.push([newest.key, older.key]);
      } else if (similarity >= 0.55) {
        older.supersededBy = newest.key;
        older.decision = 'drop';
        older.finalScore = clamp(older.finalScore - 0.18);
        older.reasons.push(`Superseded by newer memory ${newest.id}`);
      }
    }
  }

  enriched.sort((a, b) => b.finalScore - a.finalScore);

  const selected: RankedRetrievalCandidate[] = [];
  let tokensUsed = 0;

  for (const candidate of enriched) {
    if (candidate.finalScore < 0.18) {
      candidate.decision = candidate.decision === 'conflict' ? 'conflict' : 'drop';
      candidate.reasons.push('Dropped for low final score');
      continue;
    }
    if (candidate.supersededBy) continue;

    const maxSimilarity = selected.length === 0
      ? 0
      : Math.max(...selected.map(existing => mmrSimilarity(existing, candidate)));
    const mmrScore = (0.78 * candidate.finalScore) - (0.22 * maxSimilarity);

    if (mmrScore < 0.12) {
      candidate.decision = 'drop';
      candidate.reasons.push('Dropped for low diversity-adjusted score');
      continue;
    }
    if (tokensUsed + candidate.tokenCount > input.tokenBudget) {
      candidate.decision = 'drop';
      candidate.reasons.push('Dropped for token budget');
      continue;
    }

    candidate.decision = candidate.decision === 'conflict' ? 'conflict' : 'keep';
    selected.push(candidate);
    tokensUsed += candidate.tokenCount;
  }

  const needsMoreEvidence = selected.length === 0 || selected[0].finalScore < 0.32;
  if (needsMoreEvidence) {
    for (const candidate of selected) {
      if (candidate.decision === 'keep') candidate.decision = 'needs-more';
    }
  }

  return {
    matchedSkills,
    selected,
    candidates: enriched,
    needsMoreEvidence,
    contradictions,
  };
}
