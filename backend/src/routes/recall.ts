/**
 * recall.ts — GET /api/recall
 *
 * Single-call context retrieval endpoint. Assembles multiple context sections
 * (direction stack, memories, health, recent runs, skills, workspace metadata)
 * into one RecallResponse payload for MCP tool consumption.
 *
 * Each section is gated by a query param flag (e.g. includeRuns, includeHealth)
 * so callers can skip expensive sections they don't need.
 */

import { Router, Request, Response } from 'express';
import { query } from '../db/index';
import {
  RecallQuerySchema,
  type RunSummary,
  type RecallResponse,
} from './recall-types';

const router = Router();

// ─── Helpers ────────────────────────────────────────────────────────────────

interface RunRow {
  id: number;
  spec_path: string;
  status: string;
  agent_type: string;
  agent_model: string | null;
  started_at: string;
  finished_at: string | null;
  pass_count: string;
  fail_count: string;
  skip_count: string;
  total_stories: string;
}

async function fetchRecentRuns(workspaceId: string): Promise<RunSummary[]> {
  const sql = `
    SELECT
      pr.id,
      pr.spec_path,
      pr.status,
      COALESCE(pr.agent_type, pr.agent, 'claude') AS agent_type,
      pr.agent_model,
      pr.started_at,
      pr.finished_at,
      COALESCE(SUM(CASE WHEN sr.status = 'pass' THEN 1 ELSE 0 END), 0) AS pass_count,
      COALESCE(SUM(CASE WHEN sr.status = 'fail' THEN 1 ELSE 0 END), 0) AS fail_count,
      COALESCE(SUM(CASE WHEN sr.status IN ('skip', 'excluded') THEN 1 ELSE 0 END), 0) AS skip_count,
      COALESCE(COUNT(sr.id), 0) AS total_stories
    FROM pipeline_runs pr
    LEFT JOIN story_results sr ON sr.run_id = pr.id
    WHERE pr.workspace_id = $1
      AND pr.status IN ('done', 'failed', 'partial_failure', 'cancelled')
    GROUP BY pr.id
    ORDER BY pr.started_at DESC
    LIMIT 5
  `;

  const rows = await query<RunRow>(sql, [workspaceId]);

  return rows.map((r) => {
    const passCount = Number(r.pass_count);
    const failCount = Number(r.fail_count);
    const skipCount = Number(r.skip_count);
    const totalStories = Number(r.total_stories);
    const passRate = totalStories > 0 ? passCount / totalStories : 0;

    return {
      id: r.id,
      specPath: r.spec_path,
      status: r.status,
      agentType: r.agent_type,
      model: r.agent_model,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      storyResults: {
        passCount,
        failCount,
        skipCount,
        totalStories,
        passRate: Math.round(passRate * 1000) / 1000, // 3 decimal places
      },
    };
  });
}

// ─── Route ──────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/recall:
 *   get:
 *     summary: Single-call context retrieval for MCP tools
 *     tags: [Recall]
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: includeRuns
 *         schema:
 *           type: string
 *           default: "true"
 *       - in: query
 *         name: includeHealth
 *         schema:
 *           type: string
 *           default: "true"
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *       - in: query
 *         name: storyText
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Assembled recall context
 */
router.get('/', async (req: Request, res: Response) => {
  const parsed = RecallQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid query parameters',
      details: parsed.error.flatten().fieldErrors,
    });
  }

  const { workspaceId, includeRuns } = parsed.data;
  const startMs = Date.now();

  // US-005: Recent runs section
  const recentRuns = includeRuns ? await fetchRecentRuns(workspaceId) : [];

  // Stub sections — will be populated by subsequent stories
  const response: RecallResponse = {
    directionStack: '',
    memories: [],
    health: null,
    recentRuns,
    skills: [],
    workspaceContext: {
      schemaSnapshot: null,
      gitMemory: null,
    },
    metadata: {
      id: workspaceId,
      label: '',
      path: '',
      domain: null,
    },
    activeRuns: [],
    meta: {
      totalTokens: 0,
      latencyMs: Date.now() - startMs,
      retrievalTier: 'cag',
      generatedAt: new Date().toISOString(),
    },
  };

  res.json(response);
});

export default router;
