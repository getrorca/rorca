import { Router, Request, Response, NextFunction } from 'express';
import { query, queryOne, dbHealthCheck } from '../db/index';
import { listBackups } from '../lib/backup';
import { agentType } from '../lib/config';
import { detectOpenCode } from '../lib/opencode-detector';
import { detectCodex } from '../lib/codex-detector';
import { isTelemetryEnabled } from '../lib/telemetry-config';
import { getQueueStats } from '../lib/embedding-pipeline';
import * as fs from 'fs';
import * as path from 'path';

const router = Router();

const startTime = Date.now();
const VERSION = '0.0.1';
const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-cache, no-store, must-revalidate',
  'Pragma': 'no-cache',
  'Expires': '0',
};

/**
 * @swagger
 * /api/health:
 *   get:
 *     tags: [Health]
 *     summary: Basic health check
 *     operationId: getHealth
 *     description: Returns basic server health status including database connectivity, uptime, active pipeline runs, MCP transport mode, and telemetry status. When agent type is opencode or codex, includes installation status.
 *     responses:
 *       200:
 *         description: Server is healthy
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, enum: [healthy, degraded] }
 *                 version: { type: string }
 *                 uptime: { type: integer, description: "Uptime in seconds" }
 *                 db_connected: { type: boolean }
 *                 active_runs: { type: integer }
 *                 mcpTransport: { type: string }
 *                 telemetryEnabled: { type: boolean }
 *                 authRequired: { type: boolean, description: "Whether AUTH_REQUIRED=true is set" }
 *                 opencodeInstalled: { type: boolean }
 *                 opencodeVersion: { type: string }
 *                 codexInstalled: { type: boolean }
 *                 codexVersion: { type: string }
 *       503:
 *         description: Server is degraded (database not connected)
 */
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.set(NO_CACHE_HEADERS);

    const healthResult = await dbHealthCheck();
    const dbConnected = healthResult.ok;

    let activeRuns = 0;
    try {
      const row = await queryOne<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM pipeline_runs WHERE status = 'running'`
      );
      activeRuns = parseInt(row?.cnt ?? '0', 10);
    } catch {
      // DB query failed — already captured by dbConnected
    }

    const status = dbConnected ? 'healthy' : 'degraded';
    const statusCode = dbConnected ? 200 : 503;

    // OC-002: Include opencode status when agentType=opencode
    const opencode = agentType === 'opencode' ? detectOpenCode() : undefined;
    // OC-024: Include codex status when agentType=codex
    const codex = agentType === 'codex' ? detectCodex() : undefined;

    res.status(statusCode).json({
      status,
      version: VERSION,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      db_connected: dbConnected,
      active_runs: activeRuns,
      db: healthResult.poolStats,
      // CA-021: Report MCP transport mode
      mcpTransport: 'http',
      // PR-005: Report telemetry status
      telemetryEnabled: isTelemetryEnabled(),
      // PR-009: Report auth enforcement status
      authRequired: process.env.AUTH_REQUIRED === 'true',
      ...(agentType === 'opencode' && opencode ? {
        opencodeInstalled: opencode.opencodeInstalled,
        opencodeVersion: opencode.opencodeVersion,
      } : {}),
      ...(agentType === 'codex' && codex ? {
        codexInstalled: codex.codexInstalled,
        codexVersion: codex.codexVersion,
      } : {}),
      embeddings: getQueueStats(),
    });
  } catch (err) { next(err); }
});

/**
 * @swagger
 * /api/health/detailed:
 *   get:
 *     tags: [Health]
 *     summary: Detailed health check with extended metrics
 *     operationId: getHealthDetailed
 *     description: Returns extended health metrics including pending spec count, memory usage, last backup timestamp, and execution engine status.
 *     responses:
 *       200:
 *         description: Detailed health metrics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, enum: [healthy, degraded] }
 *                 version: { type: string }
 *                 uptime: { type: integer }
 *                 db_connected: { type: boolean }
 *                 active_runs: { type: integer }
 *                 pending_specs_count: { type: integer }
 *                 memory_usage:
 *                   type: object
 *                   properties:
 *                     rss: { type: integer }
 *                     heapTotal: { type: integer }
 *                     heapUsed: { type: integer }
 *                     external: { type: integer }
 *                 last_backup_at: { type: string, nullable: true }
 *       503:
 *         description: Server is degraded
 */
router.get('/detailed', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.set(NO_CACHE_HEADERS);

    const healthResult = await dbHealthCheck();
    const dbConnected = healthResult.ok;

    // Pending specs count — count spec files across all workspaces
    let pendingSpecsCount = 0;
    try {
      const workspaces = await query<{ path: string }>('SELECT path FROM workspaces');
      for (const ws of workspaces) {
        const pendingDir = path.join(ws.path, 'forge', 'specs', 'pending');
        if (fs.existsSync(pendingDir)) {
          const files = fs.readdirSync(pendingDir).filter(f => f.endsWith('.json'));
          pendingSpecsCount += files.length;
        }
      }
    } catch {
      // Workspace/spec read failed
    }

    // Memory usage
    const mem = process.memoryUsage();
    const memoryUsage = {
      rss: mem.rss,
      heapTotal: mem.heapTotal,
      heapUsed: mem.heapUsed,
      external: mem.external,
    };

    // Last backup timestamp
    let lastBackupAt: string | null = null;
    try {
      const backups = listBackups();
      if (backups.length > 0) {
        lastBackupAt = backups[0].createdAt;
      }
    } catch {
      // Backup dir not found or unreadable
    }

    // Active runs (same as basic health)
    let activeRuns = 0;
    try {
      const row = await queryOne<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM pipeline_runs WHERE status = 'running'`
      );
      activeRuns = parseInt(row?.cnt ?? '0', 10);
    } catch {
      // DB query failed
    }

    const status = dbConnected ? 'healthy' : 'degraded';
    const statusCode = dbConnected ? 200 : 503;

    // OC-002: Include opencode status when agentType=opencode
    const opencode = agentType === 'opencode' ? detectOpenCode() : undefined;
    // OC-024: Include codex status when agentType=codex
    const codex = agentType === 'codex' ? detectCodex() : undefined;

    res.status(statusCode).json({
      status,
      version: VERSION,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      db_connected: dbConnected,
      active_runs: activeRuns,
      pending_specs_count: pendingSpecsCount,
      memory_usage: memoryUsage,
      last_backup_at: lastBackupAt,
      ...(agentType === 'opencode' && opencode ? {
        opencodeInstalled: opencode.opencodeInstalled,
        opencodeVersion: opencode.opencodeVersion,
      } : {}),
      ...(agentType === 'codex' && codex ? {
        codexInstalled: codex.codexInstalled,
        codexVersion: codex.codexVersion,
      } : {}),
    });
  } catch (err) { next(err); }
});

export default router;
