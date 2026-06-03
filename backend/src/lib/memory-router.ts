/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * PG-014: Unified Memory Router
 *
 * Orchestrates context retrieval through a tiered chain:
 *   1. CAG (Cache-Augmented Generation) — hot cache via context-cache.ts
 *   2. RAG (Retrieval-Augmented Generation) — hybrid search via search.ts
 *   3. Graph (Knowledge Graph) — future PG-015 hook
 *
 * Token budget enforcement:
 *   - Direction layers: always included (non-negotiable)
 *   - Remaining budget: 60% memory, 25% skills, 15% graph
 *   - Underflow in any category redistributes to others
 */

import {
  getDirectionLayers,
  getRecentMemory,
  getInstalledSkills,
  cacheStats,
  type DirectionLayers,
} from './context-cache';
import { hybridSearch, type SearchResult } from './search';
import { logger } from './logger';
import {
  buildFileNodeKey,
  buildMemoryNodeKey,
  buildSpecNodeKey,
  buildStoryNodeKey,
  queryRelated,
  queryImpact,
  graphStats,
} from './knowledge-graph';
import { getGraphContext } from './graph-context';
import {
  buildGraphRagExplainability,
  rankRetrievalCandidates,
  type GraphProjectionSignal,
  type GraphRagCandidateExplainability,
  type GraphRagScoreContract,
  type RetrievalCandidateInput,
} from './retrieval-pipeline';
import { persistRetrievalTelemetry, recordRetrievalTelemetry } from './retrieval-telemetry';
import { getHistoricalUsefulnessMap, recordRetrievalSelection } from './retrieval-feedback';
import { checkAge } from './age-guard';
import { resolveGraphScoringRollout } from './graph-scoring-rollout';
import { loadRorcaConfig, defaultRorcaConfig, type RetrievalGuardrailsConfig } from './rorca-config';
import { lookupMemoryOntologyAdjustments, type MemoryOntologyLookupResult } from './memory-ontology';
import { query as dbQuery } from '../db/index';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MemoryEntryResult {
  text: string;
  score: number;
  source: 'cache' | 'search';
  id?: string;
  sourceType?: string;
  canonicalKey?: string;
  preRerankPosition?: number | null;
  rerankedBy?: 'graph' | 'semantic';
  scoring?: GraphRagScoreContract;
  explainability?: GraphRagCandidateExplainability;
}

export interface SkillContent {
  name: string;
  content: string;
}

export interface GraphContext {
  relatedStories: Array<{ id: string; title: string; relevance: number }>;
  fileTouches: Array<{ path: string; storyIds: string[] }>;
  conventionLinks: Array<{ from: string; to: string; type: string }>;
}

interface MemoryMetadataRow {
  id: string;
  category: string;
  content: string;
  confidence: string | null;
  related_files: string | null;
  source_type: string | null;
  source: string | null;
  pinned: boolean;
  created_at: string;
  updated_at: string | null;
  source_story_id: string | null;
  source_spec_id: string | null;
  source_run_id: number | null;
}

interface WorkspacePathRow {
  path: string;
}

interface GraphMemorySignal {
  relationship: string;
  hops: number;
  matchedPath?: string;
}

export interface RetrievedContext {
  direction: {
    standards?: string;
    conventions?: string;
    project?: string;
  };
  memory: MemoryEntryResult[];
  skills: SkillContent[];
  graphContext?: GraphContext;
  /** PG-016: formatted graph context section for prompt injection */
  graphSection?: string;
  meta: {
    cagHits: number;
    ragHits: number;
    graphHits: number;
    totalTokens: number;
    latencyMs: number;
    tier: 'cache' | 'search' | 'hybrid';
    needsMoreEvidence?: boolean;
    matchedSkills?: string[];
    selectedCandidateIds?: string[];
    selectedCandidateKeys?: string[];
    graphScoreWeight?: number;
    graphRerankAppliedWeight?: number;
    graphRerankChanged?: boolean;
    graphRerankedCandidateKeys?: string[];
    telemetryId?: string;
  };
}

export interface RetrieveContextOptions {
  maxTokens?: number;
  includeGraph?: boolean;
  graphScoreWeight?: number;
  workspacePath?: string;
  explain?: boolean;
  /** Predicted file paths for graph traversal (PG-016) */
  predictedPaths?: string[];
  /** Current story ID for graph traversal context */
  storyId?: string;
  /** Current spec ID for canonical graph scoping */
  specId?: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_MAX_TOKENS = 32000;

/** Budget split for remaining tokens after direction layers */
const MEMORY_BUDGET_RATIO = 0.60;
const SKILLS_BUDGET_RATIO = 0.25;
const GRAPH_BUDGET_RATIO = 0.15;

/** Minimum percentage of key phrases that must appear in cached memory to skip RAG */
const CACHE_COVERAGE_THRESHOLD = 0.50;

/** Common English stopwords for key phrase extraction */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
  'her', 'was', 'one', 'our', 'out', 'has', 'have', 'been', 'some', 'them',
  'than', 'its', 'over', 'such', 'that', 'this', 'with', 'will', 'each',
  'make', 'like', 'from', 'when', 'what', 'there', 'which', 'their', 'said',
  'into', 'does', 'then', 'they', 'been', 'would', 'about', 'could', 'other',
  'more', 'very', 'just', 'also', 'should', 'must', 'where', 'after', 'back',
  'only', 'come', 'made', 'these', 'being', 'well', 'much', 'those', 'every',
  'need', 'most', 'upon', 'using', 'used',
]);

// ─── Token Estimation ───────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function formatGraphMemoryLine(memory: { text: string; relationship: string; hops: number }): string {
  if (memory.relationship === 'conflict') {
    return `- **CONFLICT**: ${memory.text}`;
  }
  return `- ${memory.text} (${memory.relationship}, ${memory.hops} hops)`;
}

function formatGraphConventionLine(convention: { name: string; appliesTo: string }): string {
  return `- Follow convention "${convention.name}" for files matching ${convention.appliesTo}`;
}

function formatGraphHistoryLine(history: { path: string; touchedByStories: string[]; lastModifiedSpec: string }): string {
  return (
    `- \`${history.path}\` was modified by stories: ${history.touchedByStories.join(', ')}` +
    (history.lastModifiedSpec ? ` (spec: ${history.lastModifiedSpec})` : '')
  );
}

function trimGraphContextForBudget(
  ctx: {
    relatedMemories: Array<{ memoryId: string; text: string; relationship: string; hops: number }>;
    relatedConventions: Array<{ name: string; content: string; appliesTo: string }>;
    fileHistory: Array<{ path: string; touchedByStories: string[]; lastModifiedSpec: string }>;
  },
  budgetTokens: number,
): { graphSection: string; graphTokens: number } {
  if (budgetTokens <= 0) {
    return { graphSection: '', graphTokens: 0 };
  }

  const lines = ['## Related History (from knowledge graph)'];
  let estimated = estimateTokens(lines[0]);

  const addLine = (line: string): boolean => {
    const nextTokens = estimateTokens(lines.join('\n') + '\n' + line);
    if (nextTokens > budgetTokens) return false;
    lines.push(line);
    estimated = nextTokens;
    return true;
  };

  for (const memory of ctx.relatedMemories) {
    if (!addLine(formatGraphMemoryLine(memory))) break;
  }

  if (ctx.relatedConventions.length > 0) {
    if (addLine('')) {
      if (addLine('### Convention Context')) {
        for (const convention of ctx.relatedConventions) {
          if (!addLine(formatGraphConventionLine(convention))) break;
        }
      }
    }
  }

  if (ctx.fileHistory.length > 0) {
    if (addLine('')) {
      if (addLine('### File Touch History')) {
        for (const history of ctx.fileHistory) {
          if (!addLine(formatGraphHistoryLine(history))) break;
        }
      }
    }
  }

  if (lines.length === 1) {
    return { graphSection: '', graphTokens: 0 };
  }

  return { graphSection: lines.join('\n'), graphTokens: estimated };
}

function parseRelatedFiles(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

async function resolveWorkspacePath(workspaceId: string): Promise<string | undefined> {
  try {
    const rows = await dbQuery<WorkspacePathRow>(
      'SELECT path FROM workspaces WHERE id = $1 LIMIT 1',
      [workspaceId],
    );
    return rows[0]?.path;
  } catch {
    return undefined;
  }
}

async function resolveRetrievalSettings(
  workspaceId: string,
  options?: RetrieveContextOptions,
): Promise<{ graphScoreWeight: number; guardrails: RetrievalGuardrailsConfig }> {
  const defaults = defaultRorcaConfig().context.retrieval;
  const workspacePath = options?.workspacePath ?? await resolveWorkspacePath(workspaceId);

  if (!workspacePath) {
    return {
      graphScoreWeight: resolveGraphScoringRollout({
        explicitWeight: options?.graphScoreWeight,
        configWeight: defaults.graphScoreWeight,
      }).weight,
      guardrails: defaults.guardrails,
    };
  }

  try {
    const retrieval = loadRorcaConfig(workspacePath).context.retrieval;
    return {
      graphScoreWeight: resolveGraphScoringRollout({
        explicitWeight: options?.graphScoreWeight,
        configWeight: retrieval.graphScoreWeight,
      }).weight,
      guardrails: retrieval.guardrails,
    };
  } catch (error) {
    logger.warn({ error, workspaceId }, '[memory-router] Failed to load retrieval config — falling back to defaults');
    return {
      graphScoreWeight: resolveGraphScoringRollout({
        explicitWeight: options?.graphScoreWeight,
        configWeight: defaults.graphScoreWeight,
      }).weight,
      guardrails: defaults.guardrails,
    };
  }
}

function appendGraphSignal(
  candidate: RetrievalCandidateInput,
  signal: GraphProjectionSignal,
): void {
  const existing = candidate.graphSignals ?? [];
  const duplicate = existing.some((entry) =>
    entry.fromCanonicalKey === signal.fromCanonicalKey
    && entry.toCanonicalKey === signal.toCanonicalKey
    && entry.relationship === signal.relationship
    && entry.hops === signal.hops,
  );
  if (duplicate) return;
  candidate.graphSignals = [...existing, signal];
}

// ─── Key Phrase Extraction ──────────────────────────────────────────────────

/**
 * Extract key noun phrases from story text.
 * Simple heuristic: split by whitespace/punctuation, filter stopwords,
 * keep words > 4 chars as likely meaningful nouns/concepts.
 */
function extractKeyPhrases(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 4 && !STOPWORDS.has(w))
    .filter((w, i, arr) => arr.indexOf(w) === i); // deduplicate
}

/**
 * Extract file paths mentioned in story text.
 * Matches patterns like src/foo/bar.ts, backend/routes/auth.ts, etc.
 */
function extractFilePaths(text: string): string[] {
  const pathPattern = /(?:^|\s)((?:[\w.-]+\/)+[\w.-]+\.\w+)/g;
  const paths: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pathPattern.exec(text)) !== null) {
    paths.push(match[1]);
  }
  return [...new Set(paths)];
}

/**
 * Extract story IDs from text (e.g. US-001, CIE-005, PG-015).
 */
function extractStoryIds(text: string): string[] {
  const idPattern = /\b([A-Z]{1,5}-\d{2,4})\b/g;
  const ids: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = idPattern.exec(text)) !== null) {
    ids.push(match[1]);
  }
  return [...new Set(ids)];
}

/**
 * Check what fraction of key phrases appear in the cached memory entries.
 * Returns a coverage ratio 0..1.
 */
function computeCacheCoverage(
  keyPhrases: string[],
  cachedMemory: Array<{ text: string }>,
): number {
  if (keyPhrases.length === 0) return 1; // No phrases = fully covered

  const joinedCache = cachedMemory.map(m => m.text.toLowerCase()).join(' ');
  let covered = 0;

  for (const phrase of keyPhrases) {
    if (joinedCache.includes(phrase)) {
      covered++;
    }
  }

  return covered / keyPhrases.length;
}

// ─── Budget Calculator ──────────────────────────────────────────────────────

interface TokenBudgets {
  memory: number;
  skills: number;
  graph: number;
}

/**
 * Calculate token budgets for each category.
 * Direction layers are pre-subtracted. Remaining tokens are split by ratio.
 * Underflow in any category is redistributed proportionally to others.
 */
function calculateBudgets(
  remainingTokens: number,
  includeGraph: boolean,
): TokenBudgets {
  if (remainingTokens <= 0) {
    return { memory: 0, skills: 0, graph: 0 };
  }

  let memoryBudget = Math.floor(remainingTokens * MEMORY_BUDGET_RATIO);
  let skillsBudget = Math.floor(remainingTokens * SKILLS_BUDGET_RATIO);
  let graphBudget = includeGraph
    ? Math.floor(remainingTokens * GRAPH_BUDGET_RATIO)
    : 0;

  // If graph not requested, redistribute its share
  if (!includeGraph) {
    const graphShare = Math.floor(remainingTokens * GRAPH_BUDGET_RATIO);
    // Redistribute proportionally: 60/85 to memory, 25/85 to skills
    memoryBudget += Math.floor(graphShare * (MEMORY_BUDGET_RATIO / (MEMORY_BUDGET_RATIO + SKILLS_BUDGET_RATIO)));
    skillsBudget += graphShare - Math.floor(graphShare * (MEMORY_BUDGET_RATIO / (MEMORY_BUDGET_RATIO + SKILLS_BUDGET_RATIO)));
  }

  return { memory: memoryBudget, skills: skillsBudget, graph: graphBudget };
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

/**
 * Unified context retrieval with tiered chain:
 *   Step 1 — CAG: direction layers + recent memory + skills from cache
 *   Step 2 — RAG: hybrid search for unfamiliar concepts (if cache coverage < 50%)
 *   Step 3 — Graph: knowledge graph context (if includeGraph, future PG-015)
 */
export async function retrieveContext(
  workspaceId: string | number,
  storyText: string,
  options?: RetrieveContextOptions,
): Promise<RetrievedContext> {
  const start = Date.now();
  const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
  const includeGraph = options?.includeGraph ?? false;
  const wsId = String(workspaceId);
  const retrievalSettings = await resolveRetrievalSettings(wsId, options);
  const graphScoreWeight = retrievalSettings.graphScoreWeight;
  const ageAvailable = includeGraph ? await checkAge() : false;

  let cagHits = 0;
  let ragHits = 0;
  let graphHits = 0;

  // ── Step 1: CAG — Cache-first retrieval ──────────────────────────────────

  // Record cache stats before to measure hits
  const statsBefore = cacheStats();

  // Fetch direction layers (always included, non-negotiable)
  const layers: DirectionLayers = await getDirectionLayers(wsId);

  // Fetch cached memory + skills in parallel
  const [cachedMemory, cachedSkills] = await Promise.all([
    getRecentMemory(wsId),
    getInstalledSkills(wsId),
  ]);

  // Measure cache hits from this batch
  const statsAfter = cacheStats();
  cagHits = statsAfter.hits - statsBefore.hits;

  // Build direction context (NEVER dropped)
  const direction = {
    standards: layers.teamL1?.trim() || layers.l1?.trim() || undefined,
    conventions: layers.teamL2?.trim() || layers.l2?.trim() || undefined,
    project: layers.l3?.trim() || undefined,
  };

  // Calculate direction token cost
  const directionTokens = estimateTokens(direction.standards || '')
    + estimateTokens(direction.conventions || '')
    + estimateTokens(direction.project || '')
    + estimateTokens(layers.schemaSnapshot || '');

  const remainingTokens = maxTokens - directionTokens;
  const budgets = calculateBudgets(remainingTokens, includeGraph && ageAvailable);

  const predictedPaths = options?.predictedPaths ?? extractFilePaths(storyText);

  // ── Hydrate memory metadata once so the pipeline can use stable IDs/provenance ──

  let memoryRows: MemoryMetadataRow[] = [];
  try {
    memoryRows = await dbQuery<MemoryMetadataRow>(
      `SELECT
         id::text AS id,
         category,
         content,
         confidence,
         related_files,
         source_type,
         source,
         COALESCE(pinned, false) AS pinned,
         created_at,
         updated_at,
         source_story_id,
         source_spec_id,
         source_run_id
       FROM memories
       WHERE workspace_id = $1 AND deleted_at IS NULL
       ORDER BY pinned DESC, COALESCE(updated_at, created_at) DESC
       LIMIT 250`,
      [wsId],
    );
  } catch {
    memoryRows = [];
  }

  const rowsById = new Map(memoryRows.map(row => [String(row.id), row]));
  const rowsByContent = new Map(memoryRows.map(row => [row.content, row]));
  const retrievalCandidates: RetrievalCandidateInput[] = [];
  const seenCandidateIds = new Set<string>();
  const pinnedTexts = new Set<string>();

  const addCandidate = (candidate: RetrievalCandidateInput): void => {
    const key = `${candidate.origin}:${candidate.id}`;
    if (seenCandidateIds.has(key)) return;
    seenCandidateIds.add(key);
    retrievalCandidates.push(candidate);
  };

  const rowToCandidate = (
    row: MemoryMetadataRow,
    origin: RetrievalCandidateInput['origin'],
    baseScore: number,
    matchType: RetrievalCandidateInput['matchType'],
  ): RetrievalCandidateInput => {
    const relatedFiles = parseRelatedFiles(row.related_files);
    const canonicalKey = buildMemoryNodeKey(wsId, String(row.id));
    const relatedFileKeys = relatedFiles.map(filePath => buildFileNodeKey(wsId, filePath)).filter(Boolean).sort();
    const sourceStoryCanonicalKey = row.source_story_id && row.source_spec_id
      ? buildStoryNodeKey(wsId, row.source_spec_id, row.source_story_id)
      : undefined;
    const sourceSpecCanonicalKey = row.source_spec_id
      ? buildSpecNodeKey(wsId, row.source_spec_id)
      : undefined;
    const graphSignals = [
      ...(sourceStoryCanonicalKey ? [{
        fromCanonicalKey: canonicalKey,
        toCanonicalKey: sourceStoryCanonicalKey,
        relationship: 'LEARNED_FROM',
        hops: 1,
        active: true,
        updatedAt: row.updated_at ?? row.created_at,
      }] : []),
      ...(sourceSpecCanonicalKey ? [{
        fromCanonicalKey: canonicalKey,
        toCanonicalKey: sourceSpecCanonicalKey,
        relationship: 'FROM_SPEC',
        hops: 1,
        active: true,
        updatedAt: row.updated_at ?? row.created_at,
      }] : []),
      ...relatedFileKeys.map(fileKey => ({
        fromCanonicalKey: canonicalKey,
        toCanonicalKey: fileKey,
        relationship: 'ABOUT',
        hops: 1,
        active: true,
        updatedAt: row.updated_at ?? row.created_at,
      })),
    ];
    return {
      id: String(row.id),
      text: row.content,
      title: row.category || 'Memory Entry',
      origin,
      baseScore,
      matchType,
      category: row.category,
      confidence: row.confidence,
      sourceType: row.source_type,
      source: row.source,
      pinned: row.pinned,
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? row.created_at,
      relatedFiles,
      relatedFileKeys,
      sourceStoryId: row.source_story_id,
      sourceStoryCanonicalKey,
      sourceSpecId: row.source_spec_id,
      sourceSpecCanonicalKey,
      sourceRunId: row.source_run_id,
      graphNodeType: 'memory',
      graphActive: true,
      graphUpdatedAt: row.updated_at ?? row.created_at,
      graphSignals,
      canonicalKey,
    };
  };

  // ── PG-022: Pinned memories become top-priority candidates ──────────────

  for (const row of memoryRows) {
    if (!row.pinned) continue;
    pinnedTexts.add(row.content);
    addCandidate(rowToCandidate(row, 'pinned', 1, 'cache'));
  }

  // ── Cache memories become candidates with stable provenance when possible ──

  for (const entry of cachedMemory) {
    if (pinnedTexts.has(entry.text)) continue;
    const row = rowsByContent.get(entry.text);
    addCandidate(row
      ? rowToCandidate(row, 'cache', 0.55, 'cache')
      : {
          id: `cache:${entry.ts}:${entry.text.slice(0, 32)}`,
          text: entry.text,
          title: 'Memory Entry',
          origin: 'cache',
          baseScore: 0.45,
          matchType: 'cache',
          createdAt: entry.ts,
          relatedFiles: [],
          relatedFileKeys: [],
        });
  }

  // ── Populate skills from cache (skill validator will reorder them later) ──

  const skills: SkillContent[] = [];
  let skillsTokensUsed = 0;
  for (const skill of cachedSkills) {
    const tokens = estimateTokens(skill.content);
    if (skillsTokensUsed + tokens <= budgets.skills) {
      skills.push({ name: skill.name, content: skill.content });
      skillsTokensUsed += tokens;
    }
  }

  // ── Step 2: RAG — Check if cache coverage is sufficient ──────────────────

  const keyPhrases = extractKeyPhrases(storyText);
  const coverage = computeCacheCoverage(
    keyPhrases,
    [...cachedMemory, ...memoryRows.filter(row => row.pinned).map(row => ({ text: row.content }))],
  );

  if (coverage < CACHE_COVERAGE_THRESHOLD && storyText.length > 0) {
    logger.debug(
      { workspaceId: wsId, coverage: Math.round(coverage * 100), keyPhrases: keyPhrases.length },
      '[memory-router] Cache coverage below threshold — triggering RAG search',
    );

    const ragResults: SearchResult[] = await hybridSearch(storyText, {
      sourceTypes: ['memory'],
      workspaceId: wsId,
      limit: 15,
    });

    ragHits = ragResults.length;

    for (const result of ragResults) {
      const row = rowsById.get(result.sourceId) ?? rowsByContent.get(result.snippet || result.title);
      addCandidate(row
        ? rowToCandidate(row, 'search', result.score, result.matchType)
        : {
            id: result.sourceId,
            text: result.snippet || result.title,
            title: result.title,
            origin: 'search',
            baseScore: result.score,
            matchType: result.matchType,
            sourceType: result.sourceType,
            relatedFiles: [],
            relatedFileKeys: [],
            canonicalKey: result.sourceId ? buildMemoryNodeKey(wsId, result.sourceId) : undefined,
          });
    }
  }

  let memoryEntries: MemoryEntryResult[] = [];
  let memoryTokensUsed = 0;

  // ── Step 3: Graph — Knowledge graph context via Apache AGE ───────────────

  let graphContext: GraphContext | undefined;
  let graphSection: string | undefined;
  let graphTokensUsed = 0;
  let graphProximityAvailable = ageAvailable;
  if (includeGraph) {
    try {
      // PG-016: Use getGraphContext() for deep traversal when predictedPaths provided
      const currentStoryId = options?.storyId ?? '';
      const currentSpecId = options?.specId;
      const graphSignalsByMemoryId = new Map<string, GraphMemorySignal[]>();
      const graphSignalsByText = new Map<string, GraphMemorySignal[]>();

      const rememberGraphSignal = (memoryId: string, text: string, signal: GraphMemorySignal): void => {
        const mergeInto = (store: Map<string, GraphMemorySignal[]>, key: string): void => {
          if (!key) return;
          const existing = store.get(key) ?? [];
          store.set(key, [...existing, signal]);
        };
        mergeInto(graphSignalsByMemoryId, memoryId);
        mergeInto(graphSignalsByText, text);
      };

      const applyCandidateGraphSignals = (): void => {
        for (const candidate of retrievalCandidates) {
          if (!candidate.canonicalKey) {
            continue;
          }
          const signals = [
            ...(graphSignalsByMemoryId.get(candidate.id) ?? []),
            ...(graphSignalsByText.get(candidate.text) ?? []),
          ];
          if (signals.length === 0) {
            continue;
          }

          for (const signal of signals) {
            if (!signal.matchedPath) {
              continue;
            }
            const matchedFileKey = buildFileNodeKey(wsId, signal.matchedPath);
            if (!matchedFileKey) {
              continue;
            }

            appendGraphSignal(candidate, {
              fromCanonicalKey: candidate.canonicalKey,
              toCanonicalKey: matchedFileKey,
              relationship: signal.relationship,
              hops: signal.hops,
              active: true,
              updatedAt: candidate.graphUpdatedAt ?? candidate.createdAt ?? null,
            });
            candidate.graphRelationship = signal.relationship;
            candidate.graphHops = candidate.graphHops == null
              ? signal.hops
              : Math.min(candidate.graphHops, signal.hops);
            candidate.graphNodeType = candidate.graphNodeType ?? 'memory';
            candidate.graphActive = candidate.graphActive ?? true;
            candidate.graphUpdatedAt = candidate.graphUpdatedAt ?? candidate.createdAt ?? null;
            candidate.relatedFiles = [...new Set([...(candidate.relatedFiles ?? []), signal.matchedPath])].sort();
            candidate.relatedFileKeys = [...new Set([...(candidate.relatedFileKeys ?? []), matchedFileKey])].sort();
          }
        }
      };

      if (predictedPaths.length > 0 && currentStoryId) {
        const fullCtx = await getGraphContext(currentStoryId, predictedPaths, workspaceId, 2, currentSpecId);
        graphProximityAvailable = !fullCtx.proximityUnavailable;

        const relatedStories: GraphContext['relatedStories'] = fullCtx.fileHistory.flatMap(fh =>
          fh.touchedByStories.map(sid => ({ id: sid, title: sid, relevance: 0.7 })),
        );
        const seenIds = new Set<string>();
        const dedupedStories = relatedStories.filter(s => {
          if (seenIds.has(s.id)) return false;
          seenIds.add(s.id);
          return true;
        });

        const fileTouches: GraphContext['fileTouches'] = fullCtx.fileHistory.map(fh => ({
          path: fh.path,
          storyIds: fh.touchedByStories,
        }));

        const conventionLinks: GraphContext['conventionLinks'] = fullCtx.relatedConventions.map(c => ({
          from: c.name,
          to: c.appliesTo,
          type: 'APPLIES_TO',
        }));

        graphHits = fullCtx.relatedMemories.length + fullCtx.relatedConventions.length + fullCtx.fileHistory.length;
        graphContext = { relatedStories: dedupedStories, fileTouches, conventionLinks };
        for (const memory of fullCtx.relatedMemories) {
          if (memory.relationship === 'conflict') continue;
          rememberGraphSignal(memory.memoryId, memory.text, {
            relationship: memory.relationship,
            hops: memory.hops,
            matchedPath: memory.matchedPath,
          });
        }
        applyCandidateGraphSignals();
        const budgeted = trimGraphContextForBudget(fullCtx, budgets.graph);
        graphSection = budgeted.graphSection;
        graphTokensUsed = budgeted.graphTokens;
      } else if (ageAvailable) {
        const stats = await graphStats();
        if (stats.available && stats.vertexCount > 0) {
          const filePaths = extractFilePaths(storyText);
          const storyIds = extractStoryIds(storyText);

          const relatedStories: GraphContext['relatedStories'] = [];
          const fileTouches: GraphContext['fileTouches'] = [];
          const conventionLinks: GraphContext['conventionLinks'] = [];

          for (const fp of filePaths.slice(0, 5)) {
            const impact = await queryImpact(fp, wsId);
            for (const s of impact.stories) {
              if (!relatedStories.some(rs => rs.id === s.id)) {
                relatedStories.push({ id: s.id, title: s.title, relevance: 0.8 });
              }
            }
            if (impact.stories.length > 0) {
              fileTouches.push({ path: fp, storyIds: impact.stories.map(s => s.id) });
            }
            for (const c of impact.conventions) {
              conventionLinks.push({ from: c.name, to: fp, type: 'APPLIES_TO' });
            }
          }

          for (const sid of storyIds.slice(0, 5)) {
            const related = await queryRelated('Story', sid, 2, ['DEPENDS_ON', 'TOUCHES'], {
              workspaceId: wsId,
              specId: currentSpecId,
            });
            for (const r of related) {
              const props = r.properties as Record<string, string>;
              if (r.label === 'Story' && props.id && !relatedStories.some(rs => rs.id === props.id)) {
                relatedStories.push({ id: props.id, title: props.title || props.id, relevance: 0.6 });
              }
            }
          }

          graphHits = relatedStories.length + fileTouches.length + conventionLinks.length;
          graphContext = { relatedStories, fileTouches, conventionLinks };
          const budgeted = trimGraphContextForBudget({
            relatedMemories: [],
            relatedConventions: conventionLinks.map(c => ({ name: c.from, content: c.from, appliesTo: c.to })),
            fileHistory: fileTouches.map(f => ({ path: f.path, touchedByStories: f.storyIds, lastModifiedSpec: '' })),
          }, budgets.graph);
          graphSection = budgeted.graphSection;
          graphTokensUsed = budgeted.graphTokens;
        } else {
          graphProximityAvailable = false;
          graphContext = { relatedStories: [], fileTouches: [], conventionLinks: [] };
        }
      } else {
        graphProximityAvailable = false;
        logger.warn({ workspaceId: wsId }, '[memory-router] AGE unavailable in lite mode — skipping Cypher graph traversal and keeping semantic ranking only');
        graphContext = { relatedStories: [], fileTouches: [], conventionLinks: [] };
      }

      logger.debug(
        { workspaceId: wsId, graphHits, graphTokensUsed, graphScoreWeight },
        '[memory-router] Graph context retrieved',
      );
    } catch (err) {
      graphProximityAvailable = false;
      logger.warn({ err, workspaceId: wsId }, '[memory-router] Graph context retrieval failed — using empty');
      graphContext = { relatedStories: [], fileTouches: [], conventionLinks: [] };
    }
  }

  // ── Step 4: bounded ontology precedence lookup (post-retrieval) ─────────

  const ontologyCandidateIds = retrievalCandidates
    .filter((candidate) => candidate.graphNodeType === 'memory' && candidate.canonicalKey && !candidate.id.startsWith('cache:'))
    .map(candidate => candidate.id);

  let ontologyLookup: MemoryOntologyLookupResult = {
    applied: false,
    ageUnavailable: false,
    candidateIds: [],
    adjustments: {},
  };

  try {
    ontologyLookup = await lookupMemoryOntologyAdjustments(wsId, ontologyCandidateIds);
  } catch (error) {
    logger.warn({ error, workspaceId: wsId }, '[memory-router] Ontology precedence lookup failed — using semantic retrieval fallback');
  }

  const ontologyCandidateIdSet = new Set(ontologyLookup.candidateIds);
  for (const candidate of retrievalCandidates) {
    if (!candidate.canonicalKey || candidate.graphNodeType !== 'memory') {
      continue;
    }
    candidate.ontologyLookupApplied = ontologyLookup.applied && ontologyCandidateIdSet.has(candidate.id);
    candidate.ontologyRelations = ontologyLookup.adjustments[candidate.id]?.relations ?? [];
  }

  // ── Phase 2/3: provenance-aware ranking, validator pass, telemetry ──────

  const historicalUsefulness = await getHistoricalUsefulnessMap(
    wsId,
    [...new Set(retrievalCandidates.flatMap(candidate => [
      candidate.canonicalKey,
      `memory:${candidate.id}`,
    ].filter((value): value is string => Boolean(value))))],
  );

  const ranked = rankRetrievalCandidates({
    workspaceId: wsId,
    specId: options?.specId,
    storyId: options?.storyId,
    queryText: storyText,
    predictedPaths,
    candidates: retrievalCandidates,
    skills: cachedSkills,
    historicalUsefulness,
    tokenBudget: budgets.memory,
    graphProximityAvailable,
    graphScoreWeight,
    guardrails: retrievalSettings.guardrails,
  });

  memoryEntries = ranked.selected.map(candidate => ({
    text: candidate.text,
    score: candidate.finalScore,
    source: candidate.origin === 'search' ? 'search' : 'cache',
    id: candidate.id,
    sourceType: candidate.sourceType || candidate.origin,
    canonicalKey: candidate.canonicalKey,
    preRerankPosition: candidate.preRerankPosition,
    rerankedBy: candidate.rerankedBy,
    scoring: options?.explain ? candidate.scoring : undefined,
    explainability: options?.explain ? buildGraphRagExplainability(candidate) : undefined,
  }));
  memoryTokensUsed = ranked.selected.reduce((sum, candidate) => sum + candidate.tokenCount, 0);

  const skillScoreMap = new Map(ranked.matchedSkills.map(skill => [skill.name.toLowerCase(), skill.score]));
  skills.sort((a, b) => (skillScoreMap.get(b.name.toLowerCase()) || 0) - (skillScoreMap.get(a.name.toLowerCase()) || 0));

  // ── Redistribute unused budget ───────────────────────────────────────────

  // If memory underflowed, give surplus to skills
  const memoryUnderflow = budgets.memory - memoryTokensUsed;
  if (memoryUnderflow > 0 && skillsTokensUsed < budgets.skills + memoryUnderflow) {
    const extraBudget = budgets.skills + memoryUnderflow;
    for (const skill of cachedSkills) {
      if (skills.some(s => s.name === skill.name)) continue; // already included
      const tokens = estimateTokens(skill.content);
      if (skillsTokensUsed + tokens <= extraBudget) {
        skills.push({ name: skill.name, content: skill.content });
        skillsTokensUsed += tokens;
      }
    }
  }

  // ── Compute total tokens and tier ────────────────────────────────────────

  const totalTokens = directionTokens + memoryTokensUsed + skillsTokensUsed + graphTokensUsed;
  const latencyMs = Date.now() - start;

  let tier: 'cache' | 'search' | 'hybrid';
  if (ragHits > 0 && cagHits > 0) {
    tier = 'hybrid';
  } else if (ragHits > 0) {
    tier = 'search';
  } else {
    tier = 'cache';
  }

  const telemetry = recordRetrievalTelemetry({
    workspaceId: wsId,
    queryPreview: storyText.slice(0, 240),
    matchedSkills: ranked.matchedSkills.map(skill => skill.name),
    selectedCandidateKeys: ranked.selected.map(candidate => candidate.key),
    droppedCandidateKeys: ranked.candidates.filter(candidate => !ranked.selected.some(selected => selected.key === candidate.key)).map(candidate => candidate.key),
    needsMoreEvidence: ranked.needsMoreEvidence,
    candidateCount: ranked.candidates.length,
    selectedCount: ranked.selected.length,
    tokenBudget: budgets.memory,
    contradictions: ranked.contradictions,
    candidates: ranked.candidates.map(candidate => ({
      key: candidate.key,
      origin: candidate.origin,
      sourceType: candidate.sourceType || undefined,
      finalScore: candidate.finalScore,
      semanticRankScore: candidate.semanticRankScore,
      preRerankPosition: candidate.preRerankPosition,
      rerankedBy: candidate.rerankedBy,
      decision: candidate.decision,
      freshnessScore: candidate.freshnessScore,
      validatorScore: candidate.validatorScore,
      graphScore: candidate.graphScore,
      historicalScore: candidate.historicalScore,
      reasons: candidate.reasons,
      conflictsWith: candidate.conflictsWith,
      supersededBy: candidate.supersededBy,
      scoring: candidate.scoring,
      explainability: buildGraphRagExplainability(candidate),
    })),
    latencyMs,
    retrievalTier: tier,
  });

  await persistRetrievalTelemetry(telemetry);

  await recordRetrievalSelection(
    wsId,
    ranked.selected.map(candidate => ({
      candidateKey: candidate.key,
      candidateKind: 'memory',
      skillName: ranked.matchedSkills[0]?.name,
    })),
  );

  logger.info(
    {
      workspaceId: wsId,
      tier,
      cagHits,
      ragHits,
      graphHits,
      totalTokens,
      latencyMs,
      graphScoreWeight,
      graphRerankAppliedWeight: ranked.graphRerankAppliedWeight,
      graphRerankChanged: ranked.graphRerankChanged,
    },
    '[memory-router] Context retrieved',
  );

  return {
    direction,
    memory: memoryEntries,
    skills,
    graphContext,
    graphSection,
    meta: {
      cagHits,
      ragHits,
      graphHits,
      totalTokens,
      latencyMs,
      tier,
      needsMoreEvidence: ranked.needsMoreEvidence,
      matchedSkills: ranked.matchedSkills.map(skill => skill.name),
      selectedCandidateIds: ranked.selected.map(candidate => candidate.id),
      selectedCandidateKeys: ranked.selected.map(candidate => candidate.key),
      graphScoreWeight: ranked.graphScoreWeight,
      graphRerankAppliedWeight: ranked.graphRerankAppliedWeight,
      graphRerankChanged: ranked.graphRerankChanged,
      graphRerankedCandidateKeys: ranked.graphRerankedCandidateKeys,
      telemetryId: telemetry.id,
    },
  };
}
