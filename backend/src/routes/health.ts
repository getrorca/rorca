import { Router, Request, Response } from 'express';
import { db } from '../db/index';
import { listBackups } from '../lib/backup';
import { agentType } from '../lib/config';
import { detectOpenCode } from '../lib/opencode-detector';
import { detectCodex } from '../lib/codex-detector';
import { isTelemetryEnabled } from '../lib/telemetry-config';
import * as fs from 'fs';
import * as path from 'path';

const router = Router();

const startTime = Date.now();
const VERSION = '0.0.1';
const DB_PATH = process.env.DB_PATH || './rorca.db';
const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-cache, no-store, must-revalidate',
  'Pragma': 'no-cache',
  'Expires': '0',
};

/**
 * Check DB connectivity by running a simple query.
 * Returns true if query completes within 1 second.
 */
function checkDbConnected(): boolean {
  try {
    const start = Date.now();
    const result = db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
    const elapsed = Date.now() - start;
    return elapsed < 1000 && result?.ok === 1;
  } catch {
    return false;
  }
}

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
 *                 opencodeInstalled: { type: boolean }
 *                 opencodeVersion: { type: string }
 *                 codexInstalled: { type: boolean }
 *                 codexVersion: { type: string }
 *       503:
 *         description: Server is degraded (database not connected)
 */
router.get('/', (_req: Request, res: Response) => {
  res.set(NO_CACHE_HEADERS);

  const dbConnected = checkDbConnected();

  let activeRuns = 0;
  try {
    const row = db.prepare(
      `SELECT COUNT(*) AS cnt FROM pipeline_runs WHERE status = 'running'`
    ).get() as { cnt: number } | undefined;
    activeRuns = row?.cnt ?? 0;
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
    // CA-021: Report MCP transport mode
    mcpTransport: 'http',
    // PR-005: Report telemetry status
    telemetryEnabled: isTelemetryEnabled(),
    ...(agentType === 'opencode' && opencode ? {
      opencodeInstalled: opencode.opencodeInstalled,
      opencodeVersion: opencode.opencodeVersion,
    } : {}),
    ...(agentType === 'codex' && codex ? {
      codexInstalled: codex.codexInstalled,
      codexVersion: codex.codexVersion,
    } : {}),
  });
});

/**
 * @swagger
 * /api/health/detailed:
 *   get:
 *     tags: [Health]
 *     summary: Detailed health check with extended metrics
 *     operationId: getHealthDetailed
 *     description: Returns extended health metrics including database file size, pending spec count, memory usage, last backup timestamp, and execution engine status.
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
 *                 db_size: { type: integer, description: "Database file size in bytes" }
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
router.get('/detailed', (_req: Request, res: Response) => {
  res.set(NO_CACHE_HEADERS);

  const dbConnected = checkDbConnected();

  // DB file size
  let dbSize = 0;
  try {
    const resolvedPath = path.resolve(path.dirname(require.resolve('../../package.json')), DB_PATH);
    const stat = fs.statSync(resolvedPath);
    dbSize = stat.size;
  } catch {
    // DB file not found or inaccessible
  }

  // Pending specs count — count spec files across all workspaces
  let pendingSpecsCount = 0;
  try {
    const workspaces = db.prepare('SELECT path FROM workspaces').all() as { path: string }[];
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
    const row = db.prepare(
      `SELECT COUNT(*) AS cnt FROM pipeline_runs WHERE status = 'running'`
    ).get() as { cnt: number } | undefined;
    activeRuns = row?.cnt ?? 0;
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
    db_size: dbSize,
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
});

export default router;
