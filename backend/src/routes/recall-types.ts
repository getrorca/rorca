/**
 * recall-types.ts — Shared types and Zod schemas for the /api/recall endpoint
 * and rorca_recall MCP tool (US-001).
 *
 * Defines the RecallResponse interface (8 named sections + meta) and Zod
 * query-param validation schemas.
 */

import { z } from 'zod';
import type { MemoryEntry, MemoryCategory } from '../lib/memory-ledger';
import type { EcholocationReport } from '../lib/workspace-echolocation';
import type { SkillMetadata } from '../lib/skill-registry';

// Re-export for consumer convenience
export type { MemoryEntry, MemoryCategory, EcholocationReport, SkillMetadata };

// ─── Section Types ──────────────────────────────────────────────────────────

/** Lightweight run summary for the recall response. */
export interface RunSummary {
  id: number;
  specPath: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  passed: number;
  failed: number;
  skipped: number;
  agentType: string;
  agentModel: string | null;
}

/** Lightweight skill preview (metadata only, no full prompt text). */
export interface SkillPreview {
  name: string;
  description: string;
  category?: string;
  tags?: string[];
  source: string;
}

/** Workspace metadata surfaced in the recall bundle. */
export interface WorkspaceMetadata {
  id: string;
  label: string;
  path: string;
  domains: string[];
  createdAt: string;
}

/** Currently active or queued run. */
export interface ActiveRun {
  id: number;
  specPath: string;
  status: 'running' | 'queued';
  startedAt: string;
  pid: number | null;
  agentType: string;
  agentModel: string | null;
  queuePosition: number | null;
}

// ─── Meta ───────────────────────────────────────────────────────────────────

/** Retrieval tier used to assemble the recall response. */
export type RetrievalTier = 'cag' | 'rag' | 'graph' | 'none';

/** Response metadata — timing, token estimate, retrieval strategy. */
export interface RecallMeta {
  totalTokens: number;
  latencyMs: number;
  retrievalTier: RetrievalTier;
  generatedAt: string;
}

// ─── RecallResponse ─────────────────────────────────────────────────────────

/** Full recall endpoint response — 8 named sections + meta. */
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

// ─── Zod Query Schemas ──────────────────────────────────────────────────────

/** Valid memory categories for the category filter. */
const memoryCategoryEnum = z.enum([
  'Architecture',
  'Convention',
  'Bug Fix',
  'Decision',
  'Pattern',
  'Gotcha',
]);

/** Zod schema for GET /api/recall query parameters. */
export const RecallQuerySchema = z.object({
  workspaceId: z.string().min(1, 'workspaceId is required'),
  category: memoryCategoryEnum.optional(),
  includeRuns: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  includeHealth: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  storyText: z.string().optional(),
});

/** Inferred TypeScript type for validated query params. */
export type RecallQuery = z.infer<typeof RecallQuerySchema>;
