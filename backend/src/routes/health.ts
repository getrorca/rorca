import { Router, Request, Response } from 'express';
import { db } from '../db/index';
import { listBackups } from '../lib/backup';
import * as fs from 'fs';
import * as path from 'path';

const router = Router();

const startTime = Date.now();
const VERSION = '0.0.1';
const DB_PATH = process.env.DB_PATH || './rorcha.db';
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

// ─── GET /api/health — Basic health check ────────────────────────────────────

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

  res.status(statusCode).json({
    status,
    version: VERSION,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    db_connected: dbConnected,
    active_runs: activeRuns,
  });
});

// ─── GET /api/health/detailed — Extended metrics ─────────────────────────────

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
      const pendingDir = path.join(ws.path, 'scripts', 'ralph', 'specs', 'pending');
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
  });
});

export default router;
