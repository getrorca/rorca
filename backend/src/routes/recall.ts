/**
 * recall.ts — Unified recall endpoint for MCP and external consumers.
 *
 * GET /api/recall?workspaceId=...&category=...&storyText=...
 *
 * Returns direction stack, memories, health, recent runs, skills,
 * workspace context, and metadata in a single payload.
 */

import { Router, Request, Response } from 'express';
import { query as dbQuery, queryOne } from '../db/index';
import { synthesizeDirectionStack } from '../lib/direction-stack';
import { retrieveContext } from '../lib/memory-router';
import { echolocate } from '../lib/workspace-echolocation';
import { ValidationError, NotFoundError } from '../lib/errors';
import {
  RecallQuerySchema,
  type RecallResponse,
  type RecallMemory,
  type RetrievalTier,
} from './recall-types';

const router = Router();

// ─── DB row shape for memories query ────────────────────────────────────────

interface MemoryRow {
  id: number;
  category: string;
  content: string;
  confidence: string;
  source_type: string;
  related_files: string[] | string;
  pinned: boolean;
  created_at: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Derive a short title from memory content (first sentence or first 80 chars). */
function deriveTitle(content: string): string {
  // Try first sentence (ending with period, question mark, or newline)
  const sentenceMatch = content.match(/^(.+?)[.\n]/);
  if (sentenceMatch && sentenceMatch[1].length <= 120) {
    return sentenceMatch[1].trim();
  }
  // Fallback: first 80 chars with ellipsis
  if (content.length <= 80) return content.trim();
  return content.slice(0, 77).trim() + '...';
}

/** Parse related_files — handles both JSON string and already-parsed array. */
function parseRelatedFiles(raw: string[] | string | null): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Map memory-router tier to RecallResponse retrievalTier. */
function mapRetrievalTier(routerTier: string): RetrievalTier {
  switch (routerTier) {
    case 'cache': return 'cag';
    case 'search': return 'rag';
    case 'hybrid': return 'rag'; // hybrid = CAG + RAG, report as rag since RAG was needed
    default: return 'none';
  }
}

// ─── GET /api/recall ────────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  const start = Date.now();

  // Validate query params
  const parsed = RecallQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => i.message).join('; '),
    );
  }
  const { workspaceId, category, storyText } = parsed.data;

  // Verify workspace exists
  const workspace = await queryOne<{
    id: string;
    label: string;
    path: string;
    domain: string | null;
  }>('SELECT id, label, path, domain FROM workspaces WHERE id = $1', [
    workspaceId,
  ]);
  if (!workspace) {
    throw new NotFoundError(`Workspace ${workspaceId} not found`);
  }

  // ── Memories section ────────────────────────────────────────────────────

  let memories: RecallMemory[];
  let retrievalTier: RetrievalTier = 'none';

  if (storyText) {
    // 3-tier memory-router retrieval: CAG → RAG → Graph
    const ctx = await retrieveContext(workspaceId, storyText, {
      includeGraph: true,
    });

    retrievalTier = mapRetrievalTier(ctx.meta.tier);
    if (ctx.meta.graphHits > 0) {
      retrievalTier = 'graph';
    }

    // Memory-router returns text blobs; also fetch full DB rows for structured data
    const params: (string | undefined)[] = [workspaceId];
    let categoryClause = '';
    if (category) {
      categoryClause = ' AND category = $2';
      params.push(category);
    }

    const rows = await dbQuery<MemoryRow>(
      `SELECT id, category, content, confidence, source_type, related_files, pinned, created_at
       FROM memories
       WHERE workspace_id = $1 AND deleted_at IS NULL${categoryClause}
       ORDER BY pinned DESC, created_at DESC`,
      params,
    );

    memories = rows.map((r) => ({
      id: r.id,
      category: r.category,
      title: deriveTitle(r.content),
      content: r.content,
      confidence: r.confidence,
      sourceType: r.source_type,
      relatedFiles: parseRelatedFiles(r.related_files),
      pinned: r.pinned,
      createdAt: typeof r.created_at === 'string'
        ? r.created_at
        : new Date(r.created_at).toISOString(),
    }));
  } else {
    // Direct SQL query — no storyText, no retrieval chain
    const params: (string | undefined)[] = [workspaceId];
    let categoryClause = '';
    if (category) {
      categoryClause = ' AND category = $2';
      params.push(category);
    }

    const rows = await dbQuery<MemoryRow>(
      `SELECT id, category, content, confidence, source_type, related_files, pinned, created_at
       FROM memories
       WHERE workspace_id = $1 AND deleted_at IS NULL${categoryClause}
       ORDER BY pinned DESC, created_at DESC`,
      params,
    );

    memories = rows.map((r) => ({
      id: r.id,
      category: r.category,
      title: deriveTitle(r.content),
      content: r.content,
      confidence: r.confidence,
      sourceType: r.source_type,
      relatedFiles: parseRelatedFiles(r.related_files),
      pinned: r.pinned,
      createdAt: typeof r.created_at === 'string'
        ? r.created_at
        : new Date(r.created_at).toISOString(),
    }));

    retrievalTier = 'none';
  }

  // ── Stub remaining sections (populated by subsequent stories) ─────────

  const latencyMs = Date.now() - start;

  const response: RecallResponse = {
    directionStack: '',
    memories,
    health: null,
    recentRuns: [],
    skills: [],
    workspaceContext: { schemaSnapshot: null, gitMemory: null },
    metadata: {
      id: workspace.id,
      label: workspace.label,
      path: workspace.path,
      domain: workspace.domain,
    },
    activeRuns: [],
    meta: {
      totalTokens: 0,
      latencyMs,
      retrievalTier,
      generatedAt: new Date().toISOString(),
    },
  };

  res.json(response);
});

export default router;
