/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * US-021: Context bundle contracts — backend-local mirror.
 *
 * These match the root `shared/contracts/context-bundle.ts`,
 * `shared/contracts/trust.ts`, and `shared/contracts/primitives.ts`
 * contracts but live inside the backend `src/` tree so they are
 * reachable from `rootDir: "src"`.
 *
 * See docs/context-intelligence-platform.md §6 (Shared Contracts).
 */

// ════════════════════════════════════════════════════════════════════════════
// TRUST TIERS (mirror of shared/contracts/trust.ts)
// ════════════════════════════════════════════════════════════════════════════

export const TRUST_TIERS = [
  'authoritative',
  'reviewed',
  'derived',
  'captured',
  'unverified',
] as const;
export type TrustTier = (typeof TRUST_TIERS)[number];

/** Normalized authority weight per tier (higher = more trusted). */
export const TRUST_TIER_WEIGHT: Record<TrustTier, number> = {
  authoritative: 1.0,
  reviewed: 0.8,
  derived: 0.6,
  captured: 0.3,
  unverified: 0.1,
};

// ════════════════════════════════════════════════════════════════════════════
// GRAPH MODE (mirror of shared/contracts/primitives.ts)
// ════════════════════════════════════════════════════════════════════════════

export const GRAPH_MODES = ['full', 'lite', 'disabled'] as const;
export type GraphMode = (typeof GRAPH_MODES)[number];

// ════════════════════════════════════════════════════════════════════════════
// PROVENANCE
// ════════════════════════════════════════════════════════════════════════════

export const PROVENANCE_SOURCES = [
  'direction',
  'memory',
  'doc',
  'source',
  'test',
  'graph',
  'diff',
  'risk',
  'candidate',
] as const;
export type ProvenanceSource = (typeof PROVENANCE_SOURCES)[number];

export interface Provenance {
  source: ProvenanceSource;
  ref: string;
  trust: TrustTier;
  reason?: string;
  confidence?: number;
  traceId?: string;
}

// ════════════════════════════════════════════════════════════════════════════
// BUNDLE ITEMS & SECTIONS
// ════════════════════════════════════════════════════════════════════════════

export interface BundleItem {
  content: string;
  tokens?: number;
  provenance: Provenance;
}

export const BUNDLE_SECTIONS = [
  'directions',
  'memories',
  'docs',
  'sourceFiles',
  'tests',
  'graphSummary',
  'branchDiff',
  'risksGotchas',
] as const;
export type BundleSectionName = (typeof BUNDLE_SECTIONS)[number];

export interface ContextBundleSection {
  section: BundleSectionName;
  items: BundleItem[];
  tokenBudget?: number;
  tokensUsed?: number;
}

// ════════════════════════════════════════════════════════════════════════════
// SPEC CONTEXT BUNDLE
// ════════════════════════════════════════════════════════════════════════════

export interface SpecContextBundle {
  schemaVersion: 'v1';
  workspaceId: string;
  briefHash: string;
  gitSha?: string;
  createdAt: string;
  sections: ContextBundleSection[];
  totalTokens?: number;
  traceIds?: string[];
  degraded?: boolean;
}

// ════════════════════════════════════════════════════════════════════════════
// CONTEXT SUMMARY (backward-compatible with existing flows)
// ════════════════════════════════════════════════════════════════════════════

export interface ContextSummaryJson {
  directionLayers?: {
    l1?: string | null;
    l2?: { present?: unknown; domain?: unknown } | null;
    l3?: string | null;
  };
  skills?: string[];
  memoryEntries?: number;
  agentsMd?: boolean;
  template?: unknown;
  schemaSnapshot?: boolean;
  gitMemory?: boolean;
  estimatedTokens?: number;
  modelContextWindow?: number;
  vectorHits?: number;
  graphHits?: number;
  retrievalTier?: string;
  retrievalLatencyMs?: number;
  retrieval?: {
    cagHits?: number;
    ragHits?: number;
    graphHits?: number;
    tier?: string;
    latencyMs?: number;
  };
  postSaveStages?: unknown;
  saveGeneration?: unknown;
  workspaceId?: string;
  briefHash?: string;
  composedAt?: string;
  degradationReasons?: string[];
  gitSha?: string;
  [key: string]: unknown;
}

// ════════════════════════════════════════════════════════════════════════════
// CONTRACT VERSION
// ════════════════════════════════════════════════════════════════════════════

export const CONTEXT_CONTRACTS_VERSION = 'v1' as const;

// ════════════════════════════════════════════════════════════════════════════
// FACTORY: createEmptyBundle
// ════════════════════════════════════════════════════════════════════════════

export function createEmptyBundle(
  workspaceId: string,
  briefHash: string,
  gitSha?: string,
): SpecContextBundle {
  return {
    schemaVersion: 'v1',
    workspaceId,
    briefHash,
    gitSha,
    createdAt: new Date().toISOString(),
    sections: BUNDLE_SECTIONS.map((section) => ({
      section,
      items: [],
      tokenBudget: 0,
      tokensUsed: 0,
    })),
    totalTokens: 0,
    degraded: false,
  };
}
