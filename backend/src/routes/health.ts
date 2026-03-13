import { Router, Request, Response, NextFunction } from 'express';
import { CronExpressionParser } from 'cron-parser';
import { query, queryOne, dbHealthCheck } from '../db/index';
import { listBackups } from '../lib/backup';
import { agentType } from '../lib/config';
import { detectOpenCode } from '../lib/opencode-detector';
import { detectCodex } from '../lib/codex-detector';
import { isTelemetryEnabled } from '../lib/telemetry-config';
import { getQueueStats } from '../lib/embedding-pipeline';
import { cacheStats } from '../lib/context-cache';
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
      database: 'postgresql',
      db_connected: dbConnected,
      active_runs: activeRuns,
      db: healthResult.poolStats,
      ...(healthResult.pgVersion ? { pgVersion: healthResult.pgVersion } : {}),
      ...(healthResult.extensions ? { extensions: healthResult.extensions } : {}),
      poolStats: healthResult.poolStats,
      // PG-019: Cloud managed service compatibility
      cloud: healthResult.cloud,
      provider: healthResult.provider,
      ...(healthResult.extensionStatus ? { extensionStatus: healthResult.extensionStatus } : {}),
      ...(healthResult.connectionLimit ? { connectionLimit: healthResult.connectionLimit } : {}),
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
      cache: cacheStats(),
      activeJobs: await getActiveJobs(),
      scheduledJobs: await getScheduledJobs(),
    });
  } catch (err) { next(err); }
});

/**
 * getActiveJobs — query pgboss.job for active and created pipeline jobs.
 * Returns a summary list visible in the health endpoint.
 */
async function getActiveJobs(): Promise<Array<{ id: string; name: string; state: string; runId: number | null; createdOn: string }>> {
  try {
    const rows = await query<{ id: string; name: string; state: string; data: Record<string, unknown>; createdon: string }>(
      `SELECT id, name, state, data, createdon
       FROM pgboss.job
       WHERE name IN ('pipeline:run', 'pipeline:retry', 'pipeline:cancel')
         AND state IN ('created', 'active')
       ORDER BY createdon ASC
       LIMIT 50`,
      [],
    );
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      state: r.state,
      runId: typeof r.data?.runId === 'number' ? r.data.runId : null,
      createdOn: String(r.createdon),
    }));
  } catch {
    // pgboss schema may not be initialised yet (e.g. fresh DB, tests)
    return [];
  }
}

// ── Scheduled jobs cache (30s TTL) ───────────────────────────────────────

interface ScheduledJobInfo {
  name: string;
  nextFireAt: string | null;
}

let scheduledJobsCache: ScheduledJobInfo[] | null = null;
let scheduledJobsCacheAt = 0;
const SCHEDULED_JOBS_CACHE_TTL_MS = 30_000;

function computeNextFireAt(cron: string): string | null {
  try {
    return CronExpressionParser.parse(cron).next().toISOString();
  } catch {
    return null;
  }
}

/**
 * getScheduledJobs — return the list of pg-boss registered schedules with
 * computed nextFireAt. Uses a 30s in-memory cache to avoid re-parsing on
 * every health poll.
 */
async function getScheduledJobs(): Promise<ScheduledJobInfo[]> {
  const now = Date.now();
  if (scheduledJobsCache && now - scheduledJobsCacheAt < SCHEDULED_JOBS_CACHE_TTL_MS) {
    return scheduledJobsCache;
  }

  try {
    // pgboss.schedule table: columns name, cron, data, timezone
    const rows = await query<{ name: string; cron: string }>(
      `SELECT name, cron FROM pgboss.schedule WHERE name LIKE 'pipeline:cron:%' ORDER BY name ASC`,
      [],
    );

    const result: ScheduledJobInfo[] = rows.map(r => ({
      name: r.name,
      nextFireAt: computeNextFireAt(r.cron),
    }));

    scheduledJobsCache = result;
    scheduledJobsCacheAt = now;
    return result;
  } catch {
    // pgboss schema may not be initialised yet (e.g. fresh DB, no worker running)
    return [];
  }
}

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
