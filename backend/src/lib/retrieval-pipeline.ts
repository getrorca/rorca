/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import {
  buildFileNodeKey,
  buildMemoryNodeKey,
  buildSpecNodeKey,
  buildStoryNodeKey,
  normalizeGraphFilePath,
} from './knowledge-graph';
import { logger } from './logger';

export interface RetrievalSkill {
  name: string;
  content: string;
}

export type GraphProjectionNodeType = 'story' | 'memory' | 'file' | 'spec' | 'convention' | 'skill';

export interface GraphProjectionSignal {
  fromCanonicalKey: string;
  toCanonicalKey: string;
  relationship: string;
  hops: number;
  weight?: number;
  active?: boolean | null;
  updatedAt?: string | null;
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
  relatedFileKeys?: string[];
  sourceStoryId?: string | null;
  sourceStoryCanonicalKey?: string;
  sourceSpecId?: string | null;
  sourceSpecCanonicalKey?: string;
  sourceRunId?: number | null;
  graphRelationship?: string;
  graphHops?: number;
  graphNodeType?: GraphProjectionNodeType | string | null;
  graphActive?: boolean | null;
  graphUpdatedAt?: string | null;
  graphSignals?: GraphProjectionSignal[];
  canonicalKey?: string;
}

export interface MatchedSkill {
  name: string;
  score: number;
}

export type GraphRagScoreSchemaVersion = 'v1';

export interface GraphRagScoreComponent {
  score: number;
}

export interface GraphRagProximityComponent extends GraphRagScoreComponent {
  hops: number | null;
  relationship?: string;
  proximityUnavailable: boolean;
  nodeType?: GraphProjectionNodeType | 'unknown';
  signalCount?: number;
  scopeValid?: boolean;
  stale?: boolean;
}

export interface GraphRagScopeStrengthComponent extends GraphRagScoreComponent {
  workspace: number;
  spec: number;
  story: number;
  file: number;
  workspaceKey: string;
  specKey: string | null;
  storyKey: string | null;
  fileKeys: string[];
}

export interface GraphRagProvenanceComponent extends GraphRagScoreComponent {
  confidence: string | null;
  sourceType: string | null;
  source: string | null;
}

export interface GraphRagRetrievalSignalComponent extends GraphRagScoreComponent {
  base: number;
  lexical: number;
  semantic: number;
}

export interface GraphRagSkillAlignmentComponent extends GraphRagScoreComponent {
  matchedSkills: string[];
}

export interface GraphRagHistoricalComponent extends GraphRagScoreComponent {
  feedbackKey: string;
}

export interface GraphRagPenaltyComponent extends GraphRagScoreComponent {
  comparedTo: string | null;
  similarity: number;
}

export interface GraphRagScoreBreakdown {
  directGraphProximity: GraphRagProximityComponent;
  scopeStrength: GraphRagScopeStrengthComponent;
  recency: GraphRagScoreComponent;
  pinnedStatus: GraphRagScoreComponent;
  provenanceConfidence: GraphRagProvenanceComponent;
  retrievalSignal: GraphRagRetrievalSignalComponent;
  skillAlignment: GraphRagSkillAlignmentComponent;
  historicalUsefulness: GraphRagHistoricalComponent;
  diversityPenalty: GraphRagPenaltyComponent;
  duplicationPenalty: GraphRagPenaltyComponent;
}

export interface GraphRagTieBreak {
  canonicalKey: string;
  sourceStoryKey: string | null;
  storySlug: string | null;
  candidateId: string;
}

export interface GraphRagCandidateValidation {
  valid: boolean;
  issues: string[];
}

export interface GraphRagRerankMetadata {
  requestedGraphScoreWeight: number;
  appliedGraphScoreWeight: number;
  semanticRankScore: number;
  blendedScore: number;
  preRerankPosition: number | null;
  finalPosition: number | null;
  rerankedBy: 'graph' | 'semantic';
}

export interface GraphRagScoreContract {
  schemaVersion: GraphRagScoreSchemaVersion;
  score: number;
  bounded: true;
  deterministic: true;
  tieBreak: GraphRagTieBreak;
  breakdown: GraphRagScoreBreakdown;
  validation: GraphRagCandidateValidation;
  rerank: GraphRagRerankMetadata;
}

export interface RankedRetrievalCandidate extends RetrievalCandidateInput {
  key: string;
  tokenCount: number;
  canonicalKey: string;
  lexicalScore: number;
  semanticScore: number;
  graphScore: number;
  freshnessScore: number;
  confidenceScore: number;
  fileOverlapScore: number;
  validatorScore: number;
  historicalScore: number;
  semanticRankScore: number;
  finalScore: number;
  preRerankPosition: number | null;
  rerankedBy: 'graph' | 'semantic';
  decision: 'keep' | 'drop' | 'needs-more' | 'conflict';
  conflictsWith: string[];
  supersededBy?: string;
  reasons: string[];
  scoring: GraphRagScoreContract;
}

export interface RankRetrievalCandidatesResult {
  matchedSkills: MatchedSkill[];
  selected: RankedRetrievalCandidate[];
  candidates: RankedRetrievalCandidate[];
  needsMoreEvidence: boolean;
  contradictions: Array<[string, string]>;
  graphScoreWeight: number;
  graphRerankAppliedWeight: number;
  graphRerankChanged: boolean;
  graphRerankedCandidateKeys: string[];
}

export interface GraphRagSurfaceDocumentation {
  surface: string;
  file: string;
  mode: 'scored' | 'signal-provider' | 'semantic-only';
  details: string;
}

export const GRAPH_RAG_SCORE_SCHEMA_VERSION: GraphRagScoreSchemaVersion = 'v1';

export interface GraphRagScoreContractDocumentation {
  schemaVersion: GraphRagScoreSchemaVersion;
  purpose: string;
  ordering: string;
  scoreRange: { min: 0; max: 1 };
  liteModeBehavior: string;
  scoredSurfaces: GraphRagSurfaceDocumentation[];
  signalProviders: GraphRagSurfaceDocumentation[];
  semanticOnlySurfaces: GraphRagSurfaceDocumentation[];
}

export const GRAPH_RAG_SCORE_CONTRACT_DOCUMENTATION: GraphRagScoreContractDocumentation = {
  schemaVersion: GRAPH_RAG_SCORE_SCHEMA_VERSION,
  purpose: 'GraphRAG scoring is a deterministic reranking layer over semantically eligible canonical memory candidates. It never creates identity, scope, or candidate eligibility from graph score values.',
  ordering: 'Select eligible candidates with the semantic rank score first, then blend semanticRankScore with directGraphProximity by graph weight, then sort by blended score descending, semanticRankScore descending, tieBreak.canonicalKey ascending, tieBreak.sourceStoryKey ascending, tieBreak.storySlug ascending, then tieBreak.candidateId ascending.',
  scoreRange: { min: 0, max: 1 },
  liteModeBehavior: 'When Apache AGE is unavailable (lite mode), directGraphProximity.score is forced to 0, directGraphProximity.proximityUnavailable is set to true, and applied graph rerank weight is forced to 0.',
  scoredSurfaces: [
    {
      surface: 'retrieveContext()',
      file: 'backend/src/lib/memory-router.ts',
      mode: 'scored',
      details: 'Primary GraphRAG scoring surface. Canonical memory candidates are scored, tie-broken, and selected here before prompt assembly.',
    },
    {
      surface: 'Story prompt builders',
      file: 'backend/src/lib/execution-engine.ts, backend/src/lib/spec-job-handlers.ts, backend/src/routes/specs.ts',
      mode: 'scored',
      details: 'These surfaces consume retrieveContext() outputs, so story prompts inherit the GraphRAG scoring contract indirectly.',
    },
    {
      surface: 'Recall query ranking',
      file: 'backend/src/routes/recall.ts',
      mode: 'scored',
      details: 'GET /api/recall uses retrieveContext() when query/storyText is supplied, so returned memories are ranked by this contract.',
    },
    {
      surface: 'Context enrichment / direction synthesis',
      file: 'backend/src/lib/context-enrichment.ts, backend/src/lib/direction-stack.ts',
      mode: 'scored',
      details: 'Higher-level context assembly reuses retrieveContext() and therefore consumes the same scoring output.',
    },
  ],
  signalProviders: [
    {
      surface: 'getGraphContext()',
      file: 'backend/src/lib/graph-context.ts',
      mode: 'signal-provider',
      details: 'Produces canonical graph proximity inputs and restores search_path in finally blocks; it feeds the score contract but is not itself the scorer.',
    },
  ],
  semanticOnlySurfaces: [
    {
      surface: 'GET /api/specs/:specId/knowledge-graph',
      file: 'backend/src/routes/specs.ts',
      mode: 'semantic-only',
      details: 'Remains a raw graph exploration endpoint. It returns graph-linked memories, conventions, and stories without GraphRAG score objects.',
    },
    {
      surface: 'Spec review knowledge graph tab',
      file: 'src/components/GraphTabWithSubTabs.tsx',
      mode: 'semantic-only',
      details: 'Displays the knowledge-graph endpoint for operator review and stays semantic-only until explicitly upgraded.',
    },
  ],
};

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'then', 'have', 'been',
  'will', 'your', 'about', 'there', 'their', 'would', 'could', 'should', 'after', 'only',
  'also', 'when', 'where', 'which', 'while', 'using', 'used', 'need', 'make', 'just',
]);

const RETRIEVAL_SCORE_WEIGHTS = {
  directGraphProximity: 0.18,
  scopeStrength: 0.18,
  recency: 0.1,
  pinnedStatus: 0.1,
  provenanceConfidence: 0.12,
  retrievalSignal: 0.17,
  skillAlignment: 0.08,
  historicalUsefulness: 0.07,
} as const;

const DUPLICATION_PENALTIES = {
  contradiction: 0.08,
  superseded: 0.18,
} as const;

const WORKSPACE_SCOPED_GRAPH_TYPES = new Set<GraphProjectionNodeType>([
  'story',
  'memory',
  'file',
  'spec',
  'convention',
]);

const GRAPH_RELATIONSHIP_WEIGHTS: Record<string, number> = {
  TOUCHES: 1,
  ABOUT: 0.97,
  LEARNED_FROM: 0.95,
  FROM_SPEC: 0.92,
  BELONGS_TO: 0.9,
  APPLIES_TO: 0.88,
  USED_IN: 0.84,
  DEPENDS_ON: 0.72,
  IN_WORKSPACE: 0.55,
  conflict: 0.7,
};

const GRAPH_NODE_TYPE_WEIGHTS: Record<GraphProjectionNodeType, number> = {
  memory: 1,
  story: 0.96,
  file: 0.94,
  spec: 0.9,
  convention: 0.88,
  skill: 0.86,
};

const GRAPH_STALE_MAX_AGE_DAYS: Record<GraphProjectionNodeType, number> = {
  memory: 365,
  story: 180,
  file: 365,
  spec: 730,
  convention: 730,
  skill: 365,
};

function clamp(value: number, min: number = 0, max: number = 1): number {
  return Math.max(min, Math.min(max, value));
}

function roundScore(value: number): number {
  return Number(clamp(value).toFixed(6));
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
  return roundScore(overlap / Math.max(aSet.size, bSet.size));
}

function canonicalFileKeys(workspaceId: string, paths: string[]): string[] {
  return unique(
    paths
      .map(normalizeGraphFilePath)
      .filter(Boolean)
      .map(filePath => buildFileNodeKey(workspaceId, filePath)),
  ).sort();
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

function provenanceSourceScore(candidate: RetrievalCandidateInput): number {
  const sourceType = (candidate.sourceType || '').toLowerCase();
  const source = (candidate.source || '').toLowerCase();
  if (candidate.pinned) return 1;
  if (sourceType === 'manual' || sourceType === 'mcp') return 0.95;
  if (candidate.origin === 'graph') return 0.9;
  if (candidate.origin === 'search') return 0.85;
  if (source.includes('wal')) return 0.8;
  if (candidate.origin === 'cache') return 0.72;
  if (sourceType === 'synthesis') return 0.62;
  return 0.75;
}

function parseTimestamp(value?: string | null): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function inferReferenceTimestamp(explicit: string | undefined, candidates: RetrievalCandidateInput[]): number {
  const explicitTs = parseTimestamp(explicit);
  if (explicitTs != null) return explicitTs;

  const timestamps = candidates
    .map(candidate => parseTimestamp(candidate.createdAt))
    .filter((value): value is number => value != null);

  return timestamps.length > 0 ? Math.max(...timestamps) : 0;
}

function recencyScore(candidate: RetrievalCandidateInput, referenceTimestamp: number): number {
  const candidateTimestamp = parseTimestamp(candidate.createdAt);
  if (candidateTimestamp == null || referenceTimestamp <= 0) return 0.5;

  const ageMs = Math.max(0, referenceTimestamp - candidateTimestamp);
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  let halfLifeDays = 90;
  const category = (candidate.category || '').toLowerCase();
  const sourceType = (candidate.sourceType || '').toLowerCase();

  if (category.includes('convention')) halfLifeDays = 365;
  else if (category.includes('bug')) halfLifeDays = 120;
  else if (sourceType === 'synthesis') halfLifeDays = 45;
  else if (sourceType === 'manual' || sourceType === 'mcp') halfLifeDays = 180;

  return roundScore(Math.exp(-Math.log(2) * (ageDays / halfLifeDays)));
}

function fileOverlapScore(predictedFileKeys: string[], relatedFileKeys: string[]): number {
  if (predictedFileKeys.length === 0 || relatedFileKeys.length === 0) return 0;
  return tokenOverlap(predictedFileKeys, relatedFileKeys);
}

export function matchSkillsToQuery(
  queryText: string,
  skills: RetrievalSkill[],
  predictedPaths: string[] = [],
): MatchedSkill[] {
  const queryTokens = unique([...tokenize(queryText), ...predictedPaths.flatMap(tokenize)]);
  return skills
    .map(skill => {
      const skillTokens = unique(tokenize(`${skill.name} ${skill.content.slice(0, 1200)}`));
      return { name: skill.name, score: tokenOverlap(queryTokens, skillTokens) };
    })
    .filter(skill => skill.score >= 0.05)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.name.localeCompare(b.name);
    })
    .slice(0, 5);
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

  return { score: roundScore(0.35 + best), reasons };
}

function semanticScore(candidate: RetrievalCandidateInput): number {
  if (candidate.origin === 'cache' || candidate.origin === 'pinned') return 0.55;
  if (candidate.origin === 'graph') return 0.6;
  switch (candidate.matchType) {
    case 'semantic':
    case 'hybrid':
      return roundScore(candidate.baseScore);
    case 'keyword':
      return roundScore(candidate.baseScore * 0.75);
    default:
      return roundScore(candidate.baseScore);
  }
}

function lexicalScore(queryText: string, candidate: RetrievalCandidateInput): number {
  return tokenOverlap(tokenize(queryText), tokenize(candidate.text));
}

function retrievalSignalScore(baseScore: number, lexical: number, semantic: number): number {
  return roundScore((clamp(baseScore) * 0.4) + (lexical * 0.25) + (semantic * 0.35));
}

function parseGraphNodeType(candidate: RetrievalCandidateInput): GraphProjectionNodeType | null {
  const raw = (candidate.graphNodeType || '').trim().toLowerCase();
  if (raw === 'story' || raw === 'memory' || raw === 'file' || raw === 'spec' || raw === 'convention' || raw === 'skill') {
    return raw;
  }
  if (raw) return null;
  if (candidate.canonicalKey?.startsWith('story:')) return 'story';
  if (candidate.canonicalKey?.startsWith('memory:')) return 'memory';
  if (candidate.canonicalKey?.startsWith('file:')) return 'file';
  if (candidate.canonicalKey?.startsWith('spec:')) return 'spec';
  if (candidate.canonicalKey?.startsWith('convention:')) return 'convention';
  if (candidate.canonicalKey?.startsWith('skill:')) return 'skill';
  return candidate.id.startsWith('cache:') || candidate.id.startsWith('conflict:') ? null : 'memory';
}

function workspaceScopedKeyPrefix(nodeType: GraphProjectionNodeType, workspaceId: string): string | null {
  return WORKSPACE_SCOPED_GRAPH_TYPES.has(nodeType)
    ? `${nodeType}:${workspaceId}::`
    : null;
}

function keyBelongsToWorkspaceScope(key: string | undefined, workspaceId: string): boolean {
  if (!key) return false;
  const type = key.split(':', 1)[0]?.toLowerCase() as GraphProjectionNodeType | undefined;
  if (!type || !WORKSPACE_SCOPED_GRAPH_TYPES.has(type)) return false;
  return key.startsWith(`${type}:${workspaceId}::`);
}

function keyBelongsToForeignWorkspace(key: string | undefined, workspaceId: string): boolean {
  if (!key) return false;
  const type = key.split(':', 1)[0]?.toLowerCase() as GraphProjectionNodeType | undefined;
  if (!type || !WORKSPACE_SCOPED_GRAPH_TYPES.has(type)) return false;
  return !key.startsWith(`${type}:${workspaceId}::`);
}

function projectionFreshnessScore(
  updatedAt: string | null | undefined,
  nodeType: GraphProjectionNodeType,
  referenceTimestamp: number,
): number {
  const ts = parseTimestamp(updatedAt);
  if (ts == null || referenceTimestamp <= 0) return 0.55;
  const ageMs = Math.max(0, referenceTimestamp - ts);
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const maxAgeDays = GRAPH_STALE_MAX_AGE_DAYS[nodeType];
  if (ageDays > maxAgeDays) return 0;
  return roundScore(1 - (ageDays / maxAgeDays));
}

function projectionArtifactIsUsable(
  active: boolean | null | undefined,
  updatedAt: string | null | undefined,
  nodeType: GraphProjectionNodeType,
  referenceTimestamp: number,
): { usable: boolean; stale: boolean; freshness: number } {
  if (active === false) {
    return { usable: false, stale: true, freshness: 0 };
  }

  const hasSignal = active === true || parseTimestamp(updatedAt) != null;
  if (!hasSignal) {
    return { usable: false, stale: true, freshness: 0 };
  }

  const freshness = projectionFreshnessScore(updatedAt, nodeType, referenceTimestamp);
  if (freshness <= 0 && parseTimestamp(updatedAt) != null) {
    return { usable: false, stale: true, freshness: 0 };
  }

  return { usable: true, stale: false, freshness: active === true && parseTimestamp(updatedAt) == null ? 0.7 : freshness };
}

function deriveProjectionSignals(candidate: RetrievalCandidateInput): GraphProjectionSignal[] {
  if (candidate.graphSignals && candidate.graphSignals.length > 0) {
    return candidate.graphSignals;
  }

  if (!candidate.canonicalKey) return [];

  const updatedAt = candidate.graphUpdatedAt ?? candidate.createdAt ?? null;
  const active = candidate.graphActive;
  const hops = Math.max(1, candidate.graphHops ?? 1);
  const signals: GraphProjectionSignal[] = [];

  if (candidate.sourceStoryCanonicalKey) {
    signals.push({
      fromCanonicalKey: candidate.canonicalKey,
      toCanonicalKey: candidate.sourceStoryCanonicalKey,
      relationship: 'LEARNED_FROM',
      hops,
      active,
      updatedAt,
    });
  }

  if (candidate.sourceSpecCanonicalKey) {
    signals.push({
      fromCanonicalKey: candidate.canonicalKey,
      toCanonicalKey: candidate.sourceSpecCanonicalKey,
      relationship: 'FROM_SPEC',
      hops,
      active,
      updatedAt,
    });
  }

  for (const fileKey of candidate.relatedFileKeys ?? []) {
    signals.push({
      fromCanonicalKey: candidate.canonicalKey,
      toCanonicalKey: fileKey,
      relationship: candidate.graphRelationship || 'ABOUT',
      hops,
      active,
      updatedAt,
    });
  }

  return signals;
}

function signalScopeSpecificity(
  signal: GraphProjectionSignal,
  context: { workspaceId: string; specId?: string; storyId?: string; predictedFileKeys: string[] },
): number {
  const keys = [signal.fromCanonicalKey, signal.toCanonicalKey].filter(Boolean);
  const storyKey = context.specId && context.storyId
    ? buildStoryNodeKey(context.workspaceId, context.specId, context.storyId)
    : null;
  const specKey = context.specId ? buildSpecNodeKey(context.workspaceId, context.specId) : null;
  const specStoryPrefix = context.specId ? `story:${context.workspaceId}::${context.specId}::` : null;

  if (storyKey && keys.includes(storyKey)) return 1;
  if (keys.some(key => context.predictedFileKeys.includes(key))) return 0.95;
  if (specKey && (keys.includes(specKey) || keys.some(key => key.startsWith(specStoryPrefix || '')))) return 0.86;
  if (keys.some(key => keyBelongsToWorkspaceScope(key, context.workspaceId))) return 0.64;
  return 0;
}

function candidateScopeValid(
  candidate: RetrievalCandidateInput,
  nodeType: GraphProjectionNodeType,
  context: { workspaceId: string; specId?: string; storyId?: string; predictedFileKeys: string[] },
  signals: GraphProjectionSignal[],
): boolean {
  const storyKey = context.specId && context.storyId
    ? buildStoryNodeKey(context.workspaceId, context.specId, context.storyId)
    : null;
  const specKey = context.specId ? buildSpecNodeKey(context.workspaceId, context.specId) : null;
  const specStoryPrefix = context.specId ? `story:${context.workspaceId}::${context.specId}::` : null;

  if (candidate.canonicalKey && keyBelongsToForeignWorkspace(candidate.canonicalKey, context.workspaceId)) {
    return false;
  }
  if (candidate.sourceStoryCanonicalKey && keyBelongsToForeignWorkspace(candidate.sourceStoryCanonicalKey, context.workspaceId)) {
    return false;
  }
  if (candidate.sourceSpecCanonicalKey && keyBelongsToForeignWorkspace(candidate.sourceSpecCanonicalKey, context.workspaceId)) {
    return false;
  }
  if ((candidate.relatedFileKeys ?? []).some(key => keyBelongsToForeignWorkspace(key, context.workspaceId))) {
    return false;
  }
  if (signals.some(signal => keyBelongsToForeignWorkspace(signal.fromCanonicalKey, context.workspaceId) || keyBelongsToForeignWorkspace(signal.toCanonicalKey, context.workspaceId))) {
    return false;
  }

  const prefix = workspaceScopedKeyPrefix(nodeType, context.workspaceId);
  if (prefix && candidate.canonicalKey && !candidate.canonicalKey.startsWith(prefix)) {
    return false;
  }

  if (!context.specId) {
    return true;
  }

  if (nodeType === 'story') {
    return candidate.canonicalKey?.startsWith(specStoryPrefix || '') ?? false;
  }
  if (nodeType === 'spec') {
    return candidate.canonicalKey === specKey;
  }
  if (nodeType === 'memory') {
    if (candidate.sourceSpecCanonicalKey) return candidate.sourceSpecCanonicalKey === specKey;
    if (candidate.sourceStoryCanonicalKey) return candidate.sourceStoryCanonicalKey.startsWith(specStoryPrefix || '');
  }
  if (nodeType === 'file' && candidate.canonicalKey && context.predictedFileKeys.includes(candidate.canonicalKey)) {
    return true;
  }

  return signals.some(signal => signalScopeSpecificity(signal, context) > 0.8)
    || (storyKey ? candidate.sourceStoryCanonicalKey === storyKey : false)
    || (specKey ? candidate.sourceSpecCanonicalKey === specKey : false);
}

function relationshipWeight(relationship?: string): number {
  return GRAPH_RELATIONSHIP_WEIGHTS[relationship || ''] ?? 0.4;
}

function hopStrength(hops: number | null | undefined): number {
  if (!hops || hops <= 1) return 1;
  if (hops === 2) return 0.72;
  if (hops === 3) return 0.5;
  return 0.35;
}

function signalStrength(
  signal: GraphProjectionSignal,
  nodeType: GraphProjectionNodeType,
  context: { workspaceId: string; specId?: string; storyId?: string; predictedFileKeys: string[] },
  referenceTimestamp: number,
): number {
  const scopeSpecificity = signalScopeSpecificity(signal, context);
  if (scopeSpecificity <= 0) return 0;

  const freshness = projectionFreshnessScore(signal.updatedAt, nodeType, referenceTimestamp);
  const weight = clamp(signal.weight ?? 1);
  const score = (
    (relationshipWeight(signal.relationship) * 0.45)
    + (hopStrength(signal.hops) * 0.22)
    + (weight * 0.1)
    + (scopeSpecificity * 0.13)
    + (freshness * 0.1)
  ) * GRAPH_NODE_TYPE_WEIGHTS[nodeType];

  return roundScore(score);
}

export function scoreGraphCandidateFromProjection(input: {
  candidate: RetrievalCandidateInput;
  workspaceId: string;
  specId?: string;
  storyId?: string;
  predictedFileKeys: string[];
  graphProximityAvailable: boolean;
  referenceTimestamp: number;
}): GraphRagProximityComponent {
  const { candidate, graphProximityAvailable, predictedFileKeys, referenceTimestamp } = input;
  const nodeType = parseGraphNodeType(candidate);

  if (!graphProximityAvailable) {
    return {
      score: 0,
      hops: candidate.graphHops ?? null,
      relationship: candidate.graphRelationship,
      proximityUnavailable: true,
      nodeType: nodeType ?? 'unknown',
      signalCount: 0,
      scopeValid: true,
      stale: false,
    };
  }

  if (!nodeType) {
    if (candidate.graphNodeType) {
      logger.warn({ graphNodeType: candidate.graphNodeType, candidateId: candidate.id }, '[retrieval-pipeline] Unsupported graph node type — returning zero score');
    }
    return {
      score: 0,
      hops: candidate.graphHops ?? null,
      relationship: candidate.graphRelationship,
      proximityUnavailable: false,
      nodeType: 'unknown',
      signalCount: 0,
      scopeValid: false,
      stale: false,
    };
  }

  const context = {
    workspaceId: input.workspaceId,
    specId: input.specId,
    storyId: input.storyId,
    predictedFileKeys,
  };

  const candidateProjectionState = projectionArtifactIsUsable(
    candidate.graphActive,
    candidate.graphUpdatedAt ?? candidate.createdAt,
    nodeType,
    referenceTimestamp,
  );
  if (!candidateProjectionState.usable) {
    return {
      score: 0,
      hops: candidate.graphHops ?? null,
      relationship: candidate.graphRelationship,
      proximityUnavailable: false,
      nodeType,
      signalCount: 0,
      scopeValid: false,
      stale: candidateProjectionState.stale,
    };
  }

  const allSignals = deriveProjectionSignals(candidate);
  const scopeValid = candidateScopeValid(candidate, nodeType, context, allSignals);
  if (!scopeValid) {
    return {
      score: 0,
      hops: candidate.graphHops ?? null,
      relationship: candidate.graphRelationship,
      proximityUnavailable: false,
      nodeType,
      signalCount: 0,
      scopeValid: false,
      stale: false,
    };
  }

  const activeSignals = allSignals.filter((signal) => {
    const state = projectionArtifactIsUsable(
      signal.active ?? candidate.graphActive,
      signal.updatedAt ?? candidate.graphUpdatedAt ?? candidate.createdAt,
      nodeType,
      referenceTimestamp,
    );
    return state.usable && signalScopeSpecificity(signal, context) > 0;
  });

  const overlap = fileOverlapScore(predictedFileKeys, candidate.relatedFileKeys ?? []);
  if (activeSignals.length === 0) {
    return {
      score: roundScore(overlap * 0.18),
      hops: candidate.graphHops ?? null,
      relationship: candidate.graphRelationship,
      proximityUnavailable: false,
      nodeType,
      signalCount: 0,
      scopeValid: true,
      stale: false,
    };
  }

  const rankedSignals = activeSignals
    .map(signal => ({ signal, score: signalStrength(signal, nodeType, context, referenceTimestamp) }))
    .sort((a, b) => b.score - a.score);

  const strongest = rankedSignals[0];
  const second = rankedSignals[1];
  const combinedScore = roundScore(
    (strongest.score * 0.82)
    + ((second?.score ?? 0) * 0.08)
    + (overlap * 0.1),
  );

  return {
    score: combinedScore,
    hops: strongest.signal.hops ?? candidate.graphHops ?? null,
    relationship: strongest.signal.relationship || candidate.graphRelationship,
    proximityUnavailable: false,
    nodeType,
    signalCount: activeSignals.length,
    scopeValid: true,
    stale: false,
  };
}

function graphScore(
  candidate: RetrievalCandidateInput,
  predictedFileKeys: string[],
  graphProximityAvailable: boolean,
  context: { workspaceId: string; specId?: string; storyId?: string },
  referenceTimestamp: number,
): GraphRagProximityComponent {
  return scoreGraphCandidateFromProjection({
    candidate,
    workspaceId: context.workspaceId,
    specId: context.specId,
    storyId: context.storyId,
    predictedFileKeys,
    graphProximityAvailable,
    referenceTimestamp,
  });
}

function scopeStrength(
  candidate: RetrievalCandidateInput,
  context: { workspaceId: string; specId?: string; storyId?: string; predictedFileKeys: string[] },
): GraphRagScopeStrengthComponent {
  const workspaceKey = `workspace:${context.workspaceId}`;
  const specKey = context.specId ? buildSpecNodeKey(context.workspaceId, context.specId) : null;
  const storyKey = context.specId && context.storyId
    ? buildStoryNodeKey(context.workspaceId, context.specId, context.storyId)
    : null;
  const fileKeys = context.predictedFileKeys;

  const workspace = 1;
  const spec = context.specId
    ? (candidate.sourceSpecId === context.specId ? 1 : candidate.sourceSpecId ? 0.25 : 0)
    : 0;
  const story = context.storyId
    ? (candidate.sourceStoryId === context.storyId ? 1 : candidate.sourceStoryId ? 0.15 : 0)
    : 0;
  const file = fileOverlapScore(context.predictedFileKeys, candidate.relatedFileKeys ?? []);

  return {
    score: roundScore((workspace * 0.35) + (spec * 0.3) + (story * 0.2) + (file * 0.15)),
    workspace,
    spec: roundScore(spec),
    story: roundScore(story),
    file: roundScore(file),
    workspaceKey,
    specKey,
    storyKey,
    fileKeys,
  };
}

function provenanceConfidence(candidate: RetrievalCandidateInput): GraphRagProvenanceComponent {
  const confidence = confidenceScore(candidate.confidence);
  const sourceScore = provenanceSourceScore(candidate);
  return {
    score: roundScore((confidence * 0.75) + (sourceScore * 0.25)),
    confidence: candidate.confidence ?? null,
    sourceType: candidate.sourceType ?? null,
    source: candidate.source ?? null,
  };
}

function resolveCanonicalKey(candidate: RetrievalCandidateInput, workspaceId: string): string | undefined {
  if (candidate.canonicalKey?.trim()) return candidate.canonicalKey.trim();
  if (!candidate.id || candidate.id.startsWith('cache:') || candidate.id.startsWith('conflict:')) {
    return undefined;
  }
  return buildMemoryNodeKey(workspaceId, candidate.id);
}

function resolveRelatedFileKeys(candidate: RetrievalCandidateInput, workspaceId: string): string[] {
  if (candidate.relatedFileKeys && candidate.relatedFileKeys.length > 0) {
    return unique(candidate.relatedFileKeys.filter(Boolean)).sort();
  }
  return canonicalFileKeys(workspaceId, candidate.relatedFiles ?? []);
}

function buildTieBreak(
  candidate: RetrievalCandidateInput,
  canonicalKey: string,
  workspaceId: string,
): GraphRagTieBreak {
  const sourceStoryKey = candidate.sourceStoryCanonicalKey
    ?? (candidate.sourceSpecId && candidate.sourceStoryId
      ? buildStoryNodeKey(workspaceId, candidate.sourceSpecId, candidate.sourceStoryId)
      : null);

  return {
    canonicalKey,
    sourceStoryKey,
    storySlug: candidate.sourceStoryId ?? null,
    candidateId: candidate.id,
  };
}

function compareTieBreak(a: GraphRagTieBreak, b: GraphRagTieBreak): number {
  if (a.canonicalKey !== b.canonicalKey) {
    return a.canonicalKey.localeCompare(b.canonicalKey);
  }
  const aStoryKey = a.sourceStoryKey ?? '';
  const bStoryKey = b.sourceStoryKey ?? '';
  if (aStoryKey !== bStoryKey) {
    return aStoryKey.localeCompare(bStoryKey);
  }
  const aStorySlug = a.storySlug ?? '';
  const bStorySlug = b.storySlug ?? '';
  if (aStorySlug !== bStorySlug) {
    return aStorySlug.localeCompare(bStorySlug);
  }
  return a.candidateId.localeCompare(b.candidateId);
}

function compareByScore(a: RankedRetrievalCandidate, b: RankedRetrievalCandidate): number {
  if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
  if (b.semanticRankScore !== a.semanticRankScore) return b.semanticRankScore - a.semanticRankScore;
  return compareTieBreak(a.scoring.tieBreak, b.scoring.tieBreak);
}

function compareBySemanticRank(a: RankedRetrievalCandidate, b: RankedRetrievalCandidate): number {
  if (b.semanticRankScore !== a.semanticRankScore) return b.semanticRankScore - a.semanticRankScore;
  return compareTieBreak(a.scoring.tieBreak, b.scoring.tieBreak);
}

function mmrSimilarity(a: RankedRetrievalCandidate, b: RankedRetrievalCandidate): number {
  return tokenOverlap(tokenize(a.text), tokenize(b.text));
}

function buildValidation(
  candidate: RetrievalCandidateInput,
  canonicalKey: string | undefined,
  graph: GraphRagProximityComponent,
): GraphRagCandidateValidation {
  const issues: string[] = [];
  if (!canonicalKey) issues.push('Candidate is missing a resolvable canonical memory key; scoring consumes identity and cannot invent it');
  if (!candidate.text?.trim()) issues.push('Candidate text is empty');
  if (candidate.origin === 'graph' && graph.scopeValid === false) {
    issues.push('Graph candidate is outside the active workspace/spec scope or lacks scoped canonical projection evidence');
  }
  if (candidate.origin === 'graph' && graph.stale) {
    issues.push('Graph candidate is stale or inactive in the canonical projection');
  }
  if (candidate.graphNodeType && graph.nodeType === 'unknown') {
    issues.push(`Unsupported graph node type: ${candidate.graphNodeType}`);
  }
  return { valid: issues.length === 0, issues };
}

function scorePositiveSignals(breakdown: Omit<GraphRagScoreBreakdown, 'diversityPenalty' | 'duplicationPenalty'>): number {
  return roundScore(
    (breakdown.directGraphProximity.score * RETRIEVAL_SCORE_WEIGHTS.directGraphProximity)
    + (breakdown.scopeStrength.score * RETRIEVAL_SCORE_WEIGHTS.scopeStrength)
    + (breakdown.recency.score * RETRIEVAL_SCORE_WEIGHTS.recency)
    + (breakdown.pinnedStatus.score * RETRIEVAL_SCORE_WEIGHTS.pinnedStatus)
    + (breakdown.provenanceConfidence.score * RETRIEVAL_SCORE_WEIGHTS.provenanceConfidence)
    + (breakdown.retrievalSignal.score * RETRIEVAL_SCORE_WEIGHTS.retrievalSignal)
    + (breakdown.skillAlignment.score * RETRIEVAL_SCORE_WEIGHTS.skillAlignment)
    + (breakdown.historicalUsefulness.score * RETRIEVAL_SCORE_WEIGHTS.historicalUsefulness)
  );
}

export function rankRetrievalCandidates(input: {
  workspaceId: string;
  specId?: string;
  storyId?: string;
  queryText: string;
  predictedPaths?: string[];
  candidates: RetrievalCandidateInput[];
  skills: RetrievalSkill[];
  historicalUsefulness?: Map<string, number>;
  tokenBudget: number;
  graphProximityAvailable?: boolean;
  graphScoreWeight?: number;
  evaluationTimestamp?: string;
}): RankRetrievalCandidatesResult {
  const predictedPaths = input.predictedPaths ?? [];
  const predictedFileKeys = canonicalFileKeys(input.workspaceId, predictedPaths);
  const historicalUsefulness = input.historicalUsefulness ?? new Map<string, number>();
  const graphProximityAvailable = input.graphProximityAvailable ?? true;
  const requestedGraphScoreWeight = roundScore(input.graphScoreWeight ?? 0);
  const appliedGraphScoreWeight = graphProximityAvailable ? requestedGraphScoreWeight : 0;
  const matchedSkills = matchSkillsToQuery(input.queryText, input.skills, predictedPaths);
  const contradictions: Array<[string, string]> = [];
  const referenceTimestamp = inferReferenceTimestamp(input.evaluationTimestamp, input.candidates);

  const enriched: RankedRetrievalCandidate[] = input.candidates.map((candidate) => {
    const invalidCanonicalKey = `invalid:memory:${input.workspaceId}::${candidate.id || 'missing-id'}`;
    const canonicalKey = resolveCanonicalKey(candidate, input.workspaceId) ?? invalidCanonicalKey;
    const relatedFileKeys = resolveRelatedFileKeys(candidate, input.workspaceId);
    const graph = graphScore(
      { ...candidate, relatedFileKeys, canonicalKey },
      predictedFileKeys,
      graphProximityAvailable,
      {
        workspaceId: input.workspaceId,
        specId: input.specId,
        storyId: input.storyId,
      },
      referenceTimestamp,
    );
    const validation = buildValidation(candidate, canonicalKey === invalidCanonicalKey ? undefined : canonicalKey, graph);
    const lexical = lexicalScore(input.queryText, candidate);
    const semantic = semanticScore(candidate);
    const validator = validatorScore(candidate, matchedSkills);
    const scope = scopeStrength({ ...candidate, relatedFileKeys }, {
      workspaceId: input.workspaceId,
      specId: input.specId,
      storyId: input.storyId,
      predictedFileKeys,
    });
    const recency = recencyScore(candidate, referenceTimestamp);
    const provenance = provenanceConfidence(candidate);
    const retrievalSignal = {
      score: retrievalSignalScore(candidate.baseScore, lexical, semantic),
      base: roundScore(candidate.baseScore),
      lexical,
      semantic,
    };
    const skillAlignment = {
      score: roundScore(validator.score),
      matchedSkills: matchedSkills.map(skill => skill.name),
    };
    const feedbackKey = validation.valid ? canonicalKey : `invalid:memory:${candidate.id}`;
    const historical = roundScore(
      historicalUsefulness.get(feedbackKey)
      ?? historicalUsefulness.get(`memory:${candidate.id}`)
      ?? 0.5,
    );
    const positiveBreakdown = {
      directGraphProximity: graph,
      scopeStrength: scope,
      recency: { score: recency },
      pinnedStatus: { score: candidate.pinned ? 1 : 0 },
      provenanceConfidence: provenance,
      retrievalSignal,
      skillAlignment,
      historicalUsefulness: { score: historical, feedbackKey },
    };
    const semanticEligibilityBreakdown = {
      ...positiveBreakdown,
      directGraphProximity: {
        ...graph,
        score: 0,
      },
    };
    const provisionalScore = validation.valid ? scorePositiveSignals(semanticEligibilityBreakdown) : 0;

    return {
      ...candidate,
      canonicalKey,
      relatedFileKeys,
      key: canonicalKey,
      tokenCount: estimateTokens(candidate.text),
      lexicalScore: lexical,
      semanticScore: semantic,
      graphScore: graph.score,
      freshnessScore: recency,
      confidenceScore: provenance.score,
      fileOverlapScore: scope.file,
      validatorScore: validator.score,
      historicalScore: historical,
      semanticRankScore: provisionalScore,
      finalScore: provisionalScore,
      preRerankPosition: null,
      rerankedBy: 'semantic',
      decision: validation.valid ? 'keep' : 'drop',
      conflictsWith: [],
      reasons: [...validator.reasons, ...validation.issues],
      supersededBy: undefined,
      scoring: {
        schemaVersion: GRAPH_RAG_SCORE_SCHEMA_VERSION,
        score: provisionalScore,
        bounded: true,
        deterministic: true,
        tieBreak: buildTieBreak(candidate, canonicalKey, input.workspaceId),
        validation,
        breakdown: {
          ...positiveBreakdown,
          diversityPenalty: { score: 0, comparedTo: null, similarity: 0 },
          duplicationPenalty: { score: 0, comparedTo: null, similarity: 0 },
        },
        rerank: {
          requestedGraphScoreWeight,
          appliedGraphScoreWeight,
          semanticRankScore: provisionalScore,
          blendedScore: provisionalScore,
          preRerankPosition: null,
          finalPosition: null,
          rerankedBy: 'semantic',
        },
      },
    };
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
    group.sort((a, b) => {
      const aTs = parseTimestamp(a.createdAt) ?? 0;
      const bTs = parseTimestamp(b.createdAt) ?? 0;
      if (bTs !== aTs) return bTs - aTs;
      return compareTieBreak(a.scoring.tieBreak, b.scoring.tieBreak);
    });

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
        older.scoring.breakdown.duplicationPenalty = {
          score: DUPLICATION_PENALTIES.contradiction,
          comparedTo: newest.key,
          similarity,
        };
        older.reasons.push(`Conflicts with newer memory ${newest.id}`);
        contradictions.push([newest.key, older.key]);
      } else if (similarity >= 0.55) {
        older.supersededBy = newest.key;
        older.decision = 'drop';
        older.scoring.breakdown.duplicationPenalty = {
          score: DUPLICATION_PENALTIES.superseded,
          comparedTo: newest.key,
          similarity,
        };
        older.reasons.push(`Superseded by newer memory ${newest.id}`);
      }
    }
  }

  enriched.sort(compareBySemanticRank);

  for (let index = 0; index < enriched.length; index++) {
    const candidate = enriched[index];
    if (!candidate.scoring.validation.valid) {
      candidate.semanticRankScore = 0;
      candidate.finalScore = 0;
      candidate.scoring.score = 0;
      candidate.scoring.rerank.semanticRankScore = 0;
      candidate.scoring.rerank.blendedScore = 0;
      continue;
    }

    const stronger = enriched.slice(0, index).filter(other => other.scoring.validation.valid);
    const bestSimilar = stronger.reduce<{ similarity: number; key: string | null }>(
      (best, other) => {
        const similarity = mmrSimilarity(other, candidate);
        if (similarity > best.similarity) {
          return { similarity, key: other.key };
        }
        return best;
      },
      { similarity: 0, key: null },
    );

    candidate.scoring.breakdown.diversityPenalty = {
      score: roundScore(bestSimilar.similarity * 0.12),
      comparedTo: bestSimilar.key,
      similarity: roundScore(bestSimilar.similarity),
    };

    const penalties = candidate.scoring.breakdown.diversityPenalty.score
      + candidate.scoring.breakdown.duplicationPenalty.score;
    candidate.semanticRankScore = roundScore(candidate.scoring.score - penalties);
    candidate.finalScore = candidate.semanticRankScore;
    candidate.scoring.score = candidate.semanticRankScore;
    candidate.scoring.rerank.semanticRankScore = candidate.semanticRankScore;
    candidate.scoring.rerank.blendedScore = candidate.semanticRankScore;
  }

  enriched.sort(compareBySemanticRank);

  const selected: RankedRetrievalCandidate[] = [];
  let tokensUsed = 0;

  for (const candidate of enriched) {
    if (!candidate.scoring.validation.valid) {
      candidate.decision = 'drop';
      continue;
    }
    if (candidate.semanticRankScore < 0.18) {
      candidate.decision = candidate.decision === 'conflict' ? 'conflict' : 'drop';
      candidate.reasons.push('Dropped for low semantic rank score');
      continue;
    }
    if (candidate.supersededBy) continue;

    const maxSimilarity = selected.length === 0
      ? 0
      : Math.max(...selected.map(existing => mmrSimilarity(existing, candidate)));
    const mmrScore = roundScore((0.78 * candidate.semanticRankScore) - (0.22 * maxSimilarity));

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

  const needsMoreEvidence = selected.length === 0 || selected[0].semanticRankScore < 0.32;
  if (needsMoreEvidence) {
    for (const candidate of selected) {
      if (candidate.decision === 'keep') candidate.decision = 'needs-more';
    }
  }

  selected.forEach((candidate, index) => {
    candidate.preRerankPosition = index + 1;
    candidate.finalScore = candidate.semanticRankScore;
    candidate.rerankedBy = 'semantic';
    candidate.scoring.score = candidate.semanticRankScore;
    candidate.scoring.rerank.semanticRankScore = candidate.semanticRankScore;
    candidate.scoring.rerank.blendedScore = candidate.semanticRankScore;
    candidate.scoring.rerank.preRerankPosition = index + 1;
    candidate.scoring.rerank.finalPosition = index + 1;
    candidate.scoring.rerank.rerankedBy = 'semantic';
  });

  if (appliedGraphScoreWeight > 0) {
    for (const candidate of selected) {
      const blendedScore = roundScore(
        (candidate.semanticRankScore * (1 - appliedGraphScoreWeight))
        + (candidate.graphScore * appliedGraphScoreWeight),
      );
      candidate.finalScore = blendedScore;
      candidate.scoring.score = blendedScore;
      candidate.scoring.rerank.blendedScore = blendedScore;
    }

    selected.sort(compareByScore);
  }

  selected.forEach((candidate, index) => {
    const finalPosition = index + 1;
    const orderChanged = candidate.preRerankPosition !== finalPosition;
    const rerankedBy: 'graph' | 'semantic' = appliedGraphScoreWeight > 0 && candidate.graphScore > 0 && orderChanged
      ? 'graph'
      : 'semantic';
    candidate.rerankedBy = rerankedBy;
    candidate.scoring.rerank.finalPosition = finalPosition;
    candidate.scoring.rerank.rerankedBy = rerankedBy;
  });

  const graphRerankedCandidateKeys = selected
    .filter(candidate => candidate.rerankedBy === 'graph')
    .map(candidate => candidate.key);
  const graphRerankChanged = graphRerankedCandidateKeys.length > 0;

  const selectedIdentity = new Set(selected.map(candidate => `${candidate.key}::${candidate.id}::${candidate.origin}`));
  const orderedCandidates = [
    ...selected,
    ...enriched
      .filter(candidate => !selectedIdentity.has(`${candidate.key}::${candidate.id}::${candidate.origin}`))
      .sort(compareBySemanticRank),
  ];

  return {
    matchedSkills,
    selected,
    candidates: orderedCandidates,
    needsMoreEvidence,
    contradictions,
    graphScoreWeight: requestedGraphScoreWeight,
    graphRerankAppliedWeight: appliedGraphScoreWeight,
    graphRerankChanged,
    graphRerankedCandidateKeys,
  };
}
