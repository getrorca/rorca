/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
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
import { queryRelated, queryImpact, graphStats } from './knowledge-graph';
import {
  getGraphContext,
  formatGraphContext,
} from './graph-context';
import { query as dbQuery } from '../db/index';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MemoryEntryResult {
  text: string;
  score: number;
  source: 'cache' | 'search';
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
  };
}

export interface RetrieveContextOptions {
  maxTokens?: number;
  includeGraph?: boolean;
  /** Predicted file paths for graph traversal (PG-016) */
  predictedPaths?: string[];
  /** Current story ID for graph traversal context */
  storyId?: string;
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
  const budgets = calculateBudgets(remainingTokens, includeGraph);

  // ── PG-022: Fetch pinned memories first (always included) ───────────────

  const memoryEntries: MemoryEntryResult[] = [];
  let memoryTokensUsed = 0;
  const pinnedTexts = new Set<string>();

  try {
    const pinnedRows = await dbQuery<{ content: string }>(
      `SELECT content FROM memories WHERE workspace_id = $1 AND pinned = true AND deleted_at IS NULL ORDER BY created_at DESC`,
      [wsId],
    );
    for (const row of pinnedRows) {
      const tokens = estimateTokens(row.content);
      memoryEntries.push({ text: row.content, score: 1, source: 'cache' });
      memoryTokensUsed += tokens;
      pinnedTexts.add(row.content);
    }
  } catch {
    // pinned column may not exist yet — graceful fallback
  }

  // ── Populate memory from cache (skip pinned duplicates) ────────────────

  for (const entry of cachedMemory) {
    if (pinnedTexts.has(entry.text)) continue;
    const tokens = estimateTokens(entry.text);
    if (memoryTokensUsed + tokens <= budgets.memory) {
      memoryEntries.push({ text: entry.text, score: 0, source: 'cache' });
      memoryTokensUsed += tokens;
    }
  }

  // ── Populate skills from cache ───────────────────────────────────────────

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
  const coverage = computeCacheCoverage(keyPhrases, cachedMemory);

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

    // Deduplicate against cached entries by text content
    const existingTexts = new Set(memoryEntries.map(m => m.text));

    for (const result of ragResults) {
      const text = result.snippet || result.title;
      if (existingTexts.has(text)) continue; // already from cache

      const tokens = estimateTokens(text);
      if (memoryTokensUsed + tokens <= budgets.memory) {
        memoryEntries.push({ text, score: result.score, source: 'search' });
        memoryTokensUsed += tokens;
        existingTexts.add(text);
      }
    }
  }

  // ── Step 3: Graph — Knowledge graph context via Apache AGE ───────────────

  let graphContext: GraphContext | undefined;
  let graphSection: string | undefined;
  if (includeGraph) {
    try {
      // PG-016: Use getGraphContext() for deep traversal when predictedPaths provided
      const predictedPaths = options?.predictedPaths ?? extractFilePaths(storyText);
      const currentStoryId = options?.storyId ?? '';

      if (predictedPaths.length > 0 && currentStoryId) {
        const fullCtx = await getGraphContext(currentStoryId, predictedPaths, workspaceId);

        // Map full graph context to the simpler GraphContext for backward compat
        const relatedStories: GraphContext['relatedStories'] = fullCtx.fileHistory.flatMap(fh =>
          fh.touchedByStories.map(sid => ({ id: sid, title: sid, relevance: 0.7 })),
        );
        // Deduplicate
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
        graphSection = formatGraphContext(fullCtx);
      } else {
        // Fallback: use queryImpact for file-path-based lookup
        const stats = await graphStats();
        if (stats.available && stats.vertexCount > 0) {
          const filePaths = extractFilePaths(storyText);
          const storyIds = extractStoryIds(storyText);

          const relatedStories: GraphContext['relatedStories'] = [];
          const fileTouches: GraphContext['fileTouches'] = [];
          const conventionLinks: GraphContext['conventionLinks'] = [];

          for (const fp of filePaths.slice(0, 5)) {
            const impact = await queryImpact(fp);
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
            const related = await queryRelated('Story', sid, 2, ['DEPENDS_ON', 'TOUCHES']);
            for (const r of related) {
              const props = r.properties as Record<string, string>;
              if (r.label === 'Story' && props.id && !relatedStories.some(rs => rs.id === props.id)) {
                relatedStories.push({ id: props.id, title: props.title || props.id, relevance: 0.6 });
              }
            }
          }

          graphHits = relatedStories.length + fileTouches.length + conventionLinks.length;
          graphContext = { relatedStories, fileTouches, conventionLinks };
        } else {
          graphContext = { relatedStories: [], fileTouches: [], conventionLinks: [] };
        }
      }

      logger.debug(
        { workspaceId: wsId, graphHits },
        '[memory-router] Graph context retrieved',
      );
    } catch (err) {
      logger.warn({ err, workspaceId: wsId }, '[memory-router] Graph context retrieval failed — using empty');
      graphContext = { relatedStories: [], fileTouches: [], conventionLinks: [] };
    }
  }

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

  const totalTokens = directionTokens + memoryTokensUsed + skillsTokensUsed;
  const latencyMs = Date.now() - start;

  let tier: 'cache' | 'search' | 'hybrid';
  if (ragHits > 0 && cagHits > 0) {
    tier = 'hybrid';
  } else if (ragHits > 0) {
    tier = 'search';
  } else {
    tier = 'cache';
  }

  logger.info(
    { workspaceId: wsId, tier, cagHits, ragHits, graphHits, totalTokens, latencyMs },
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
    },
  };
}
