/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { Story } from '../components/StoryCard';

/* ─── Types ───────────────────────────────────────────────────────── */

export type { Story };

export interface ContextUsedMeta {
  standards: boolean;
  conventions: boolean;
  project: boolean;
  memory: boolean;
  schema: boolean;
  scopesMatched: string[];
  totalTokens: number;
}

export interface ContextUsed {
  text: string;
  meta: ContextUsedMeta;
}

export interface ContextSummary {
  directionLayers: {
    l1: boolean;
    l2: { present: boolean; domain: string | null };
    l3: boolean;
    // CU-002: layer titles + token estimates (optional for backward compat with old logs)
    l1Title?: string | null;
    l2Title?: string | null;
    l3Title?: string | null;
    l1Tokens?: number;
    l2Tokens?: number;
    l3Tokens?: number;
  };
  skills: string[];
  memoryEntries: number;
  agentsMd: boolean;
  template: string | null;
  schemaSnapshot: boolean;
  gitMemory: boolean;
  estimatedTokens: number;
  modelContextWindow: number;
  vectorHits?: number;
  graphHits?: number;
  retrievalTier?: 'cache' | 'search' | 'hybrid';
  retrievalLatencyMs?: number;
  /** SW-010: Full semantic retrieval metrics from memory-router */
  retrieval?: {
    cagHits: number;
    ragHits: number;
    graphHits: number;
    tier: 'cache' | 'search' | 'hybrid';
    latencyMs: number;
    ontologyExplainability?: {
      status: 'available' | 'partial' | 'unavailable';
      activeCount: number;
      suppressedCount: number;
      conflictCount: number;
      hiddenExplanationCount: number;
      examples: string[];
      message: string;
    };
  };
  /** CU-004: Predicted injected file paths from context-router (up to 30 paths) */
  predictedFiles?: string[];
}

export interface GeneratedSpec {
  slug?: string;
  specName: string;
  stories: Story[];
  diagram?: string;
  diagramType?: 'mermaid-flowchart' | 'mermaid-sequence' | 'ascii';
  savedPath?: string;
  generatedAt: string;
  contextUsed?: ContextUsed;
  contextSummary?: ContextSummary;
}
