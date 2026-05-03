import { Router, Request, Response, NextFunction } from 'express';
import { graphStats, isGraphAvailable, populateFromRun, populateFromSpec } from '../lib/knowledge-graph';
import { query, queryOne } from '../db/index';
import { broadcastAll } from '../lib/sse-hub';
import { logger } from '../lib/logger';
import { requireAge } from '../lib/age-guard';

const router = Router();

// Track in-progress population to prevent double-trigger
const activePopulations = new Set<string>();

// ─── Types ──────────────────────────────────────────────────────────────────

interface GraphStatsResponse {
  available: boolean;
  vertexCount: number;
  edgeCount: number;
  graphName: string;
  lastPopulatedAt: string | null;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/graph/stats:
 *   get:
 *     tags: [Graph]
 *     summary: Get knowledge graph statistics
 *     operationId: getGraphStats
 *     description: Returns Apache AGE knowledge graph availability and basic statistics including vertex count, edge count, graph name, and last populated timestamp. When AGE is not installed, returns available=false with zeroed counts and null timestamps — never a 500 error.
 *     responses:
 *       200:
 *         description: Graph statistics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 available:
 *                   type: boolean
 *                   description: Whether Apache AGE extension is loaded
 *                 vertexCount:
 *                   type: integer
 *                   description: Total number of vertices in the graph
 *                 edgeCount:
 *                   type: integer
 *                   description: Total number of edges in the graph
 *                 graphName:
 *                   type: string
 *                   description: Name of the AGE graph
 *                 lastPopulatedAt:
 *                   type: string
 *                   nullable: true
 *                   format: date-time
 *                   description: Timestamp of most recent graph population event
 */
router.get('/stats', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const stats = await graphStats();

    if (!stats.available) {
      const result: GraphStatsResponse = {
        available: false,
        vertexCount: 0,
        edgeCount: 0,
        graphName: 'rorca',
        lastPopulatedAt: null,
      };
      return res.json(result);
    }

    // Fetch last populated timestamp from wal_events (graph_populated events)
    // or fall back to latest graph-related WAL event
    const lastEvent = await queryOne<{ ts: string }>(
      `SELECT ts FROM wal_events
       WHERE event_type IN ('graph_populated', 'graph_backfill_complete', 'graph_populate_finished', 'run_finished')
       ORDER BY ts DESC LIMIT 1`,
    );

    const result: GraphStatsResponse = {
      available: true,
      vertexCount: stats.vertexCount,
      edgeCount: stats.edgeCount,
      graphName: 'rorca',
      lastPopulatedAt: lastEvent?.ts ?? null,
    };

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ─── Helper: emit WAL event and broadcast to SSE subscribers ──────────────

async function emitWal(
  eventType: string,
  workspaceId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const row = await queryOne<{
    id: number;
    ts: string;
    event_type: string;
    workspace_id: string | null;
    spec_id: string | null;
    story_id: string | null;
    actor: string;
    payload: string | null;
  }>(
    `INSERT INTO wal_events (event_type, workspace_id, payload)
     VALUES ($1, $2, $3) RETURNING *`,
    [eventType, workspaceId, JSON.stringify(payload)],
  );
  if (row) broadcastAll(row);
}

// ─── POST /api/graph/populate ────────────────────────────────────────────

/**
 * @swagger
 * /api/graph/populate:
 *   post:
 *     tags: [Graph]
 *     summary: Populate the knowledge graph for a workspace
 *     operationId: populateGraph
 *     description: |
 *       Triggers a full graph population for a workspace by iterating all completed
 *       pipeline runs and approved specs. Returns 202 immediately; progress is reported
 *       via WAL events (graph_populate_started, graph_populate_progress, graph_populate_finished).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId:
 *                 type: string
 *                 description: The workspace to populate the graph for
 *     responses:
 *       202:
 *         description: Population started
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 totalItems:
 *                   type: integer
 *                   description: Total number of runs + specs to process
 *       400:
 *         description: Missing workspaceId or graph unavailable
 *       409:
 *         description: Population already in progress for this workspace
 */
router.post('/populate', requireAge(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { workspaceId } = req.body;

    if (!workspaceId || typeof workspaceId !== 'string') {
      return res.status(400).json({ error: 'workspaceId is required' });
    }

    if (activePopulations.has(workspaceId)) {
      return res.status(409).json({ error: 'Population already in progress for this workspace' });
    }

    // Count total items to process
    const completedRuns = await query<{ id: number; spec_path: string }>(
      `SELECT id, spec_path FROM pipeline_runs
       WHERE workspace_id = $1 AND status IN ('done', 'passed')`,
      [workspaceId],
    );

    // Get unique spec slugs from completed runs, then load latest version content
    const specSlugs = [...new Set(
      completedRuns
        .map(r => r.spec_path.replace(/^.*\//, '').replace(/\.json$/, ''))
        .filter(Boolean),
    )];

    const approvedSpecs: Array<{ spec_slug: string; content_json: unknown }> = [];
    for (const slug of specSlugs) {
      const sv = await queryOne<{ spec_slug: string; content_json: unknown }>(
        `SELECT spec_slug, content_json FROM spec_versions
         WHERE spec_slug = $1 ORDER BY version DESC LIMIT 1`,
        [slug],
      );
      if (sv) approvedSpecs.push(sv);
    }

    const totalItems = completedRuns.length + approvedSpecs.length;

    if (totalItems === 0) {
      return res.status(202).json({ totalItems: 0 });
    }

    // Mark population as active and respond immediately
    activePopulations.add(workspaceId);
    res.status(202).json({ totalItems });

    // Run population async (fire-and-forget after response)
    (async () => {
      let completed = 0;
      try {
        await emitWal('graph_populate_started', workspaceId, { totalItems });

        // Process completed runs
        for (const run of completedRuns) {
          try {
            const specId = run.spec_path
              .replace(/^.*\//, '')
              .replace(/\.json$/, '');
            await populateFromRun(run.id, specId, workspaceId);
          } catch (err) {
            logger.warn({ err, runId: run.id }, '[graph/populate] Failed to populate from run');
          }
          completed++;
          if (completed % 5 === 0 || completed === totalItems) {
            await emitWal('graph_populate_progress', workspaceId, { completed, total: totalItems });
          }
        }

        // Process approved specs
        for (const sv of approvedSpecs) {
          try {
            const content = typeof sv.content_json === 'string'
              ? JSON.parse(sv.content_json)
              : sv.content_json;
            const stories = (content.userStories || []).map((s: { id: string; title: string; dependsOn?: string[] }) => ({
              id: s.id,
              title: s.title,
              dependsOn: s.dependsOn,
            }));
            await populateFromSpec(sv.spec_slug, workspaceId, stories);
          } catch (err) {
            logger.warn({ err, specSlug: sv.spec_slug }, '[graph/populate] Failed to populate from spec');
          }
          completed++;
          if (completed % 5 === 0 || completed === totalItems) {
            await emitWal('graph_populate_progress', workspaceId, { completed, total: totalItems });
          }
        }

        await emitWal('graph_populate_finished', workspaceId, { totalItems, completed });
        logger.info({ workspaceId, totalItems, completed }, '[graph/populate] Population complete');
      } catch (err) {
        logger.error({ err, workspaceId }, '[graph/populate] Population failed');
        await emitWal('graph_populate_finished', workspaceId, { totalItems, completed, error: true }).catch(() => {});
      } finally {
        activePopulations.delete(workspaceId);
      }
    })();
  } catch (err) {
    next(err);
  }
});

export default router;
