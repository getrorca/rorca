

/**
 * recall.ts — GET /api/recall — "Brain dump" endpoint.
 *
 * Composes the entire Rorca workspace context into a single JSON payload
 * for MCP tool injection. Each data section is populated by its own story;
 * sections not yet implemented return their null/empty defaults.
 */

import { Router, Request, Response } from 'express';
import { queryOne } from '../db/index.js';
import { NotFoundError } from '../lib/errors.js';
import {
  RecallQuerySchema,
  type RecallResponse,
} from './recall-types.js';

const router = Router();

/**
 * @swagger
 * /api/recall:
 *   get:
 *     operationId: getRecall
 *     summary: Full workspace context recall ("brain dump")
 *     description: >
 *       Composes the entire Rorca workspace brain into a single JSON payload —
 *       direction stack, memories, health, recent runs, skills, workspace context,
 *       metadata, and active runs.
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema:
 *           type: string
 *         description: Workspace ID to recall context for
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *           enum: [Architecture, Convention, Bug Fix, Decision, Pattern, Gotcha]
 *         description: Optional memory category filter
 *       - in: query
 *         name: includeRuns
 *         schema:
 *           type: string
 *           default: 'true'
 *         description: Include recent pipeline runs (default true)
 *       - in: query
 *         name: includeHealth
 *         schema:
 *           type: string
 *           default: 'true'
 *         description: Include workspace health report (default true)
 *       - in: query
 *         name: storyText
 *         schema:
 *           type: string
 *         description: Optional story text for semantic memory retrieval
 *     responses:
 *       200:
 *         description: Full recall payload
 *       400:
 *         description: Missing or invalid workspaceId
 *       404:
 *         description: Workspace not found
 */
router.get('/', async (req: Request, res: Response) => {
  const startMs = Date.now();

  // Validate query params
  const parsed = RecallQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues[0]?.message ?? 'Invalid query parameters',
      details: parsed.error.issues,
    });
    return;
  }

  const { workspaceId } = parsed.data;

  // ── Workspace metadata (required — 404 if missing) ──────────────────────
  const workspace = await queryOne<{
    id: string;
    label: string;
    path: string;
    domain: string | null;
  }>(
    `SELECT id, label, path, domain FROM workspaces WHERE id = $1`,
    [workspaceId],
  );

  if (!workspace) {
    throw new NotFoundError('Workspace not found');
  }

  // ── Workspace context (schema snapshot + git memory) ────────────────────
  const ctxRow = await queryOne<{
    schema_snapshot: string | null;
  }>(
    `SELECT schema_snapshot FROM workspace_context WHERE workspace_id = $1`,
    [workspaceId],
  );

  const workspaceContext = {
    schemaSnapshot: ctxRow?.schema_snapshot ?? null,
    // git_memory column was dropped (migration 075) — always null
    gitMemory: null as string | null,
  };

  // ── Assemble response ──────────────────────────────────────────────────
  const response: RecallResponse = {
    directionStack: '',
    memories: [],
    health: null,
    recentRuns: [],
    skills: [],
    workspaceContext,
    metadata: {
      id: workspace.id,
      label: workspace.label,
      path: workspace.path,
      domain: workspace.domain,
    },
    activeRuns: [],
    meta: {
      totalTokens: 0,
      latencyMs: Date.now() - startMs,
      retrievalTier: 'none',
      generatedAt: new Date().toISOString(),
    },
  };

  // Compute token estimate
  response.meta.totalTokens = Math.ceil(JSON.stringify(response).length / 4);
  response.meta.latencyMs = Date.now() - startMs;

  res.json(response);
});

export default router;
