/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { logger } from './logger';
import { getDirectionLayers as getCachedDirectionLayers } from './context-cache';
import { retrieveContext } from './memory-router';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SynthesizeParams {
  l1?: string;           // Global Brain YAML
  l2?: string;           // Domain Profile YAML
  l3?: string;           // Project Brief YAML
  specBrief: string;     // L4 — always required
  storyAnnotations?: string; // L5 — optional per-story overrides
  // Team-scoped layers (override global, overridden by workspace)
  teamL1?: string;       // Team-level L1 override
  teamL2?: string;       // Team-level L2 override
  // Auto-injected by hydration engine:
  schemaSnapshot?: string;  // Raw CREATE TABLE blocks
}

export interface SynthesizeMeta {
  standards: boolean;
  conventions: boolean;
  project: boolean;
  memory: boolean;
  schema: boolean;
  totalTokens: number;
}

export interface SynthesizeResult {
  text: string;
  meta: SynthesizeMeta;
}

/** PG-012: ContextMetadata returned by semantic-aware synthesize() */
export interface ContextMetadata {
  totalTokens: number;
  layers: {
    standards: boolean;
    conventions: boolean;
    project: boolean;
  };
  memoryEntries: {
    included: number;
    total: number;
    relevanceRange: [number, number];
  };
  droppedItems: Array<{ type: string; reason: string }>;
  searchMode: 'semantic' | 'keyword' | 'full-dump';
}

/** PG-012: Return type from semantic-aware synthesize() */
export interface SynthesizedContext {
  text: string;
  metadata: ContextMetadata;
}

/** Options for PG-012 semantic-aware synthesis */
export interface SynthesizeOptions {
  storyText?: string;
  maxTokens?: number;
}

// ─── Token Estimation ────────────────────────────────────────────────────────

/** Estimate tokens from text length (~4 chars per token). Consistent with context-router.ts. */
function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// ─── Legacy Sync Functions ───────────────────────────────────────────────────

/**
 * Synchronous direction stack synthesis from pre-fetched layers.
 * Returns the synthesized text string directly.
 */
export function synthesizeLayers(params: SynthesizeParams): string {
  return synthesizeLayersWithMeta(params).text;
}

/**
 * Synchronous direction stack synthesis with metadata.
 * Returns { text, meta } from pre-fetched layer content.
 */
export function synthesizeLayersWithMeta(params: SynthesizeParams): SynthesizeResult {
  const sections: string[] = [];
  const effectiveL1 = params.teamL1?.trim() || params.l1?.trim();
  const effectiveL2 = params.teamL2?.trim() || params.l2?.trim();
  if (effectiveL1) sections.push(`=== GLOBAL STANDARDS (L1) ===\n${effectiveL1}`);
  if (effectiveL2) sections.push(`=== DOMAIN PROFILE (L2) ===\n${effectiveL2}`);
  if (params.l3?.trim()) sections.push(`=== PROJECT CONTEXT (L3) ===\n${params.l3.trim()}`);
  if (params.schemaSnapshot?.trim()) {
    sections.push(`=== DATABASE SCHEMA (Auto-Hydrated) ===\n${params.schemaSnapshot.trim()}`);
  }
  sections.push(`=== SPEC BRIEF (L4) ===\n${params.specBrief.trim()}`);
  if (params.storyAnnotations?.trim()) sections.push(`=== STORY ANNOTATIONS (L5) ===\n${params.storyAnnotations.trim()}`);

  const text = sections.join('\n\n');
  const totalTokens = Math.ceil(text.length / 4);

  return {
    text,
    meta: {
      standards: !!effectiveL1,
      conventions: !!effectiveL2,
      project: !!params.l3?.trim(),
      memory: false,
      schema: !!params.schemaSnapshot?.trim(),
      totalTokens,
    },
  };
}

// Backward-compatible aliases
export const synthesize = synthesizeLayers;
export const synthesizeWithMeta = synthesizeLayersWithMeta;

// ─── PG-012 + PG-014: Semantic-Aware Synthesis via Memory Router ────────────

const DEFAULT_MAX_TOKENS = 32000;

/**
 * PG-014: Semantic-aware direction stack synthesis.
 *
 * Thin wrapper around retrieveContext() (memory-router.ts) that formats
 * the unified retrieval result into the existing SynthesizedContext contract.
 *
 * The memory router handles the tiered retrieval chain:
 *   1. CAG — cache-first direction layers + recent memory + skills
 *   2. RAG — hybrid search for unfamiliar concepts
 *   3. Graph — knowledge graph (PG-015, future)
 */
export async function synthesizeDirectionStack(
  workspaceId: string,
  options?: SynthesizeOptions,
): Promise<SynthesizedContext> {
  const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
  const storyText = options?.storyText;

  // Delegate to unified memory router
  const retrieved = await retrieveContext(
    parseInt(workspaceId, 10) || 0,
    storyText || '',
    { maxTokens },
  );

  // Also fetch raw direction layers for schema/git context (not in memory-router scope)
  const layers = await getCachedDirectionLayers(workspaceId);
  const droppedItems: Array<{ type: string; reason: string }> = [];

  // Build direction sections from retrieved context
  const sections: string[] = [];

  if (retrieved.direction.standards) {
    sections.push(`=== GLOBAL STANDARDS (L1) ===\n${retrieved.direction.standards}`);
  }
  if (retrieved.direction.conventions) {
    sections.push(`=== DOMAIN PROFILE (L2) ===\n${retrieved.direction.conventions}`);
  }
  if (retrieved.direction.project) {
    sections.push(`=== PROJECT CONTEXT (L3) ===\n${retrieved.direction.project}`);
  }

  let usedTokens = estimateTokens(sections.join('\n\n'));

  // Include schema snapshot if budget allows
  if (layers.schemaSnapshot?.trim()) {
    const schemaTokens = estimateTokens(layers.schemaSnapshot);
    if (usedTokens + schemaTokens <= maxTokens) {
      sections.push(`=== DATABASE SCHEMA (Auto-Hydrated) ===\n${layers.schemaSnapshot.trim()}`);
      usedTokens += schemaTokens;
    } else {
      droppedItems.push({ type: 'schema_snapshot', reason: 'token_budget_exceeded' });
    }
  }

  // Include memory entries from retrieval
  if (retrieved.memory.length > 0) {
    const searchMode = retrieved.meta.tier === 'cache' ? 'full-dump'
      : retrieved.meta.ragHits > 0 ? 'semantic'
      : 'full-dump';
    const memoryLines = retrieved.memory.map(m => `- ${m.text}`).join('\n');
    sections.push(`=== RELEVANT MEMORY (${searchMode}) ===\n${memoryLines}`);
  }

  // Include skills context
  if (retrieved.skills.length > 0) {
    const skillLines = retrieved.skills.map(s => `### ${s.name}\n${s.content}`).join('\n\n');
    sections.push(`=== SKILLS ===\n${skillLines}`);
  }

  const text = sections.join('\n\n');
  const finalTokens = estimateTokens(text);

  // Compute relevance range from memory scores
  const scores = retrieved.memory.map(m => m.score).filter(s => s > 0);
  const relevanceRange: [number, number] = scores.length > 0
    ? [Math.min(...scores), Math.max(...scores)]
    : [0, 0];

  // Map tier to searchMode for backward compatibility
  const searchMode: 'semantic' | 'keyword' | 'full-dump' =
    retrieved.meta.tier === 'search' || retrieved.meta.tier === 'hybrid'
      ? 'semantic'
      : 'full-dump';

  logger.debug(
    {
      workspaceId,
      tier: retrieved.meta.tier,
      cagHits: retrieved.meta.cagHits,
      ragHits: retrieved.meta.ragHits,
      memoryEntries: retrieved.memory.length,
      skills: retrieved.skills.length,
      totalTokens: finalTokens,
      latencyMs: retrieved.meta.latencyMs,
    },
    '[direction-stack] synthesizeDirectionStack via memory-router',
  );

  return {
    text,
    metadata: {
      totalTokens: finalTokens,
      layers: {
        standards: !!retrieved.direction.standards,
        conventions: !!retrieved.direction.conventions,
        project: !!retrieved.direction.project,
      },
      memoryEntries: {
        included: retrieved.memory.length,
        total: retrieved.memory.length, // Total from router scope
        relevanceRange,
      },
      droppedItems,
      searchMode,
    },
  };
}
