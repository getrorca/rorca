import { Router, Request, Response, NextFunction } from 'express';
import { graphStats } from '../lib/knowledge-graph';
import { queryOne } from '../db/index';

const router = Router();

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
       WHERE event_type IN ('graph_populated', 'graph_backfill_complete', 'run_finished')
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

export default router;
