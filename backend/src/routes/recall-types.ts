/**
 * recall-types.ts — Shared types and Zod schemas for the /api/recall endpoint.
 *
 * Defines the RecallResponse shape (8 named sections + meta) and query param
 * validation. Imported by both the Express route and the MCP tool.
 */

import { z } from 'zod';
import type { MemoryEntry } from '../lib/memory-ledger.js';
import type { EcholocationReport } from '../lib/workspace-echolocation.js';

// ─── Re-exports for consumer convenience ────────────────────────────────────

export type { MemoryEntry, EcholocationReport };

// ─── DB-backed memory shape (matches memories table, not MEMORY.md file) ────

export interface RecallMemory {
  id: number;
  category: string;
  title: string;
  content: string;
  confidence: string;
  sourceType: string;
  relatedFiles: string[];
  pinned: boolean;
  createdAt: string;
}

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

export interface ActiveRun {
  id: number;
  specPath: string;
  status: 'running' | 'queued';
  agent: string;
  model: string | null;
  startedAt: string;
  queuePosition: number | null;
  storiesCompleted: number;
  storiesTotal: number;
}

export interface SkillPreview {
  name: string;
  description: string;
  category: string | null;
  tags: string[];
  source: string;
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
  memories: RecallMemory[];
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
});

export type RecallQueryParams = z.infer<typeof RecallQuerySchema>;
