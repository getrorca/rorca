/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * recall-types.ts — Shared types and Zod schemas for the /api/recall endpoint.
 *
 * Defines the RecallResponse shape (8 named sections + meta) and query param
 * validation. Imported by both the Express route and the MCP tool.
 */

import { z } from 'zod';
import type { MemoryEntry } from '../lib/memory-ledger';
import type { EcholocationReport } from '../lib/workspace-echolocation';

// ─── Re-exports for consumer convenience ────────────────────────────────────

export type { MemoryEntry, EcholocationReport };

// ─── Domain types (defined here to avoid coupling to internal DB row shapes) ─

export interface RunSummary {
  id: number;
  specPath: string;
  status: string;
  agent: string;
  model: string | null;
  startedAt: string;
  finishedAt: string | null;
  passedStories: number;
  failedStories: number;
  skippedStories: number;
  totalTokens: number | null;
  costUsd: number | null;
}

export interface StoryProgress {
  passed: number;
  failed: number;
  inProgress: number;
  total: number;
}

export interface ActiveRun {
  id: number;
  specPath: string;
  status: 'running' | 'queued';
  agent: string;
  model: string | null;
  startedAt: string;
  queuePosition: number | null;
  storyProgress: StoryProgress | null;
}

export interface SkillPreview {
  name: string;
  contentPreview: string;
  description: string;
  category: string | null;
  tags: string[];
  source: string;
}

export interface SkillFull {
  name: string;
  content: string;
  description: string;
  category: string | null;
  tags: string[];
  source: string;
}

export interface DirectionLayer {
  layer: number;
  content: string;
  domain: string | null;
  workspaceId: string | null;
}

export interface WorkspaceMetadata {
  id: string;
  label: string;
  path: string;
  domain: string | null;
}

// ─── Response types ─────────────────────────────────────────────────────────

export type RetrievalTier = 'cag' | 'rag' | 'graph' | 'none';

export interface RecallMeta {
  totalTokens: number;
  latencyMs: number;
  retrievalTier: RetrievalTier;
  generatedAt: string;
}

export interface RecallResponse {
  directionStack: string;
  memories: MemoryEntry[];
  health: EcholocationReport | null;
  recentRuns: RunSummary[];
  skills: SkillPreview[];
  workspaceContext: {
    schemaSnapshot: string | null;
    gitMemory: string | null;
  };
  metadata: WorkspaceMetadata;
  activeRuns: ActiveRun[];
  meta: RecallMeta;
}

export interface DumpMeta {
  latencyMs: number;
  generatedAt: string;
}

export interface DumpResponse {
  memories: MemoryEntry[] | null;
  directionLayers: DirectionLayer[] | null;
  skills: SkillFull[] | null;
  workspaceContext: {
    schemaSnapshot: string | null;
    gitMemory: string | null;
  } | null;
  recentRuns: RunSummary[] | null;
  metadata: WorkspaceMetadata;
  activeRuns: ActiveRun[] | null;
  meta: DumpMeta;
}

// ─── Zod query param schema ─────────────────────────────────────────────────

export const RecallQuerySchema = z.object({
  workspaceId: z.string().min(1),
  category: z.enum([
    'Architecture',
    'Convention',
    'Bug Fix',
    'Decision',
    'Pattern',
    'Gotcha',
  ]).optional(),
  includeRuns: z
    .string()
    .optional()
    .default('true')
    .transform((v) => v === 'true'),
  includeHealth: z
    .string()
    .optional()
    .default('true')
    .transform((v) => v === 'true'),
  storyText: z.string().optional(),
  /** Preferred alias for storyText — anchors semantic retrieval to a feature brief. Takes precedence over storyText if both provided. */
  query: z.string().optional(),
  /** When true, strips full memory content from the response and returns only {date, category, title, source} per entry — ~2K tokens vs ~50K+ for a full dump. Use for spec generation context loading. */
  titlesOnly: z
    .string()
    .optional()
    .default('false')
    .transform((v) => v === 'true'),
});

export type RecallQueryParams = z.infer<typeof RecallQuerySchema>;

