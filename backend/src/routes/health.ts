/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { CronExpressionParser } from 'cron-parser';
import { execSync } from 'child_process';
import { query, queryOne, dbHealthCheck } from '../db/index';
import { listBackups } from '../lib/backup';
import { activeAgent, activeModel, agentType } from '../lib/config';
import { detectOpenCode } from '../lib/opencode-detector';
import { detectCodex } from '../lib/codex-detector';
import { detectPi } from '../lib/pi-detector';
import { isTelemetryEnabled } from '../lib/telemetry-config';
import { getQueueStats } from '../lib/embedding-pipeline';
import { cacheStats } from '../lib/context-cache';
import { getMcpTransportCount } from '../lib/mcp-http';
import { buildDatabaseCapability, buildDatabaseSetupGuidance, type DatabaseProvider } from '../lib/db-strategy';
import * as fs from 'fs';
import * as path from 'path';

const router = Router();

const startTime = Date.now();

// ── Engine detection cache (30s TTL) ─────────────────────────────────────────

interface EnginesStatus {
  claude: { installed: boolean };
  opencode: { installed: boolean; version?: string };
  codex: { installed: boolean; version?: string };
  pi: { installed: boolean; version?: string };
}

let enginesCache: EnginesStatus | null = null;
let enginesCacheAt = 0;
const ENGINES_CACHE_TTL_MS = 30_000;

function detectClaudeBinary(): boolean {
  // Check CLAUDE_BIN env var first, then PATH
  const claudeBin = process.env.CLAUDE_BIN?.trim();
  if (claudeBin) {
    return fs.existsSync(claudeBin);
  }
  try {
    execSync('which claude', { encoding: 'utf-8', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function detectEngines(): EnginesStatus {
  const now = Date.now();
  if (enginesCache && now - enginesCacheAt < ENGINES_CACHE_TTL_MS) {
    return enginesCache;
  }

  const claudeInstalled = agentType === 'claude' || detectClaudeBinary();

  const opencode = (() => {
    try {
      return detectOpenCode();
    } catch {
      return { opencodeInstalled: false, opencodeVersion: undefined };
    }
  })();
  const codex = (() => {
    try {
      return detectCodex();
    } catch {
      return { codexInstalled: false, codexVersion: undefined };
    }
  })();
  const pi = (() => {
    try {
      return detectPi();
    } catch {
      return { piInstalled: false, piVersion: undefined };
    }
  })();

  const result: EnginesStatus = {
    claude: { installed: claudeInstalled },
    opencode: {
      installed: opencode.opencodeInstalled,
      ...(opencode.opencodeVersion ? { version: opencode.opencodeVersion } : {}),
    },
    codex: {
      installed: codex.codexInstalled,
      ...(codex.codexVersion ? { version: codex.codexVersion } : {}),
    },
    pi: {
      installed: pi.piInstalled,
      ...(pi.piVersion ? { version: pi.piVersion } : {}),
    },
  };

  enginesCache = result;
  enginesCacheAt = now;
  return result;
}

// Cache package.json version at module load — avoids fs.readFileSync on every request
let VERSION = '0.0.1';
try {
  VERSION = (require('../../package.json') as { version: string }).version;
} catch {
  // Fall back to default if package.json is unavailable (e.g. compiled build)
}
const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-cache, no-store, must-revalidate',
  'Pragma': 'no-cache',
  'Expires': '0',
};

type McpBridgeStatus = 'healthy' | 'disabled';

function getMcpBridgeHealth(): {
  enabled: boolean;
  status: McpBridgeStatus;
  url: string;
  sessions: number;
} {
  const enabled = process.env.RORCA_SERVE_MCP !== 'false';
  return {
    enabled,
    status: enabled ? 'healthy' : 'disabled',
    url: `${process.env.RORCA_PUBLIC_URL || 'http://localhost:3030'}/mcp`,
    sessions: enabled ? getMcpTransportCount() : 0,
  };
}

/**
 * @swagger
 * /api/health:
 *   get:
 *     tags: [Health]
 *     summary: Basic health check
 *     operationId: getHealth
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Health checks are safe read-only diagnostics that external CLI clients depend on before invoking higher-level workflows."
 *     x-rorca-public-api: true
 *     description: Returns basic server health status including database connectivity, uptime, active pipeline runs, MCP transport mode, and telemetry status. When agent type is opencode or codex, includes installation status. Also returns unconditional Pi CLI detection status and component-level health for database, worker, github, postgres, and migrations.
 *     responses:
 *       200:
 *         description: Server is healthy
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, enum: [ok, degraded, down] }
 *                 version: { type: string }
 *                 uptime: { type: integer, description: "Uptime in seconds" }
 *                 db_connected: { type: boolean }
 *                 active_runs: { type: integer }
 *                 dbMode: { type: string, enum: [native, docker, byop] }
 *                 graphMode: { type: string, enum: [full, lite, disabled] }
 *                 pgvectorReady: { type: boolean, description: "Whether the pgvector extension is installed for the active database mode" }
 *                 graphWarnings:
 *                   type: array
 *                   items: { type: string }
 *                 agentType: { type: string }
 *                 agentModel: { type: string, nullable: true }
 *                 mcpTransport: { type: string }
 *                 mcp:
 *                   type: object
 *                   properties:
 *                     enabled: { type: boolean }
 *                     status: { type: string, enum: [healthy, disabled] }
 *                     url: { type: string }
 *                     sessions: { type: integer }
 *                 telemetryEnabled: { type: boolean }
 *                 authRequired: { type: boolean, description: "Whether AUTH_REQUIRED=true is set" }
 *                 opencodeInstalled: { type: boolean }
 *                 opencodeVersion: { type: string }
 *                 codexInstalled: { type: boolean }
 *                 codexVersion: { type: string }
 *                 piInstalled: { type: boolean }
 *                 piVersion:
 *                   type: string
 *                   nullable: true
 *                 piBinPath:
 *                   type: string
 *                   nullable: true
 *                 engines:
 *                   type: object
 *                   description: "Availability status for each execution engine (cached 30s)"
 *                   properties:
 *                     claude:
 *                       type: object
 *                       properties:
 *                         installed: { type: boolean }
 *                     opencode:
 *                       type: object
 *                       properties:
 *                         installed: { type: boolean }
 *                         version: { type: string }
 *                     codex:
 *                       type: object
 *                       properties:
 *                         installed: { type: boolean }
 *                         version: { type: string }
 *                 databaseCapability:
 *                   type: object
 *                   description: Canonical redacted database capability contract for DB mode, connection metadata, graph mode, and extension availability.
 *                 components:
 *                   type: object
 *                   properties:
 *                     database: { type: object }
 *                     worker: { type: object }
 *                     github: { type: object }
 *                     postgres: { type: object }
 *                     migrations: { type: object }
 *       503:
 *         description: Server is down (database unreachable)
 */
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.set(NO_CACHE_HEADERS);

    // Run all component checks in parallel for <500ms SLA
    const [
      dbResult,
      workerResult,
      githubResult,
      migrationsResult,
      activeJobsResult,
      scheduledJobsResult,
    ] = await Promise.allSettled([
      checkDatabaseComponent(),
      checkWorkerComponent(),
      checkGithubComponent(),
      checkMigrationsComponent(),
      getActiveJobs(),
      getScheduledJobs(),
    ]);

    const dbHealth = dbResult.status === 'fulfilled' ? dbResult.value : { status: 'down' as const, error: 'check failed' };
    const workerHealth = workerResult.status === 'fulfilled' ? workerResult.value : { status: 'unknown' as const };
    const githubHealth = githubResult.status === 'fulfilled' ? githubResult.value : { status: 'unknown' as const };
    const migrationsHealth = migrationsResult.status === 'fulfilled' ? migrationsResult.value : { status: 'unknown' as const };

    const dbConnected = dbHealth.status !== 'down';
    const workerDown = workerHealth.status === 'down' || workerHealth.status === 'not_running';
    const rawDbHealth = dbHealth as ComponentDatabaseHealth;
    const databaseCapability = buildDatabaseCapability({
      connected: dbConnected,
      provider: rawDbHealth.provider,
      extensionStatus: rawDbHealth.extensionStatus,
    });

    // Overall status: 'down' if DB or worker is down, 'degraded' if any component is amber, 'ok' if all green
    let overallStatus: 'ok' | 'degraded' | 'down';
    if (!dbConnected) {
      overallStatus = 'down';
    } else if (workerDown || githubHealth.status === 'degraded' || migrationsHealth.status === 'degraded') {
      overallStatus = 'degraded';
    } else {
      overallStatus = 'ok';
    }

    if (!dbConnected) {
      return res.status(503).json({
        status: 'down',
        error: 'Database unreachable',
        version: VERSION,
        uptime: Math.floor((Date.now() - startTime) / 1000),
        dbMode: databaseCapability.dbMode,
        graphMode: databaseCapability.graphMode,
        pgvectorReady: databaseCapability.extensions.vector,
        graphWarnings: databaseCapability.warnings,
        databaseCapability,
        databaseSetup: buildDatabaseSetupGuidance(databaseCapability.dbMode),
      });
    }

    let activeRuns = 0;
    try {
      const row = await queryOne<{ cnt: string }>(
        `SELECT COUNT(*)::int AS cnt FROM pipeline_runs WHERE status = 'running'`
      );
      activeRuns = parseInt(row?.cnt ?? '0', 10);
    } catch {
      // DB query failed — already captured by dbConnected
    }

    // OC-002: Include opencode status when agentType=opencode
    const opencode = agentType === 'opencode' ? detectOpenCode() : undefined;
    // OC-024: Include codex status when agentType=codex
    const codex = agentType === 'codex' ? detectCodex() : undefined;
    const pi = (() => {
      try {
        return detectPi();
      } catch {
        return {
          piInstalled: false,
          piVersion: null,
          piBinPath: null,
        };
      }
    })();

    // MP-009: Detect all engines (cached 30s) for EngineSelector availability dots
    const engines = detectEngines();
    const mcp = getMcpBridgeHealth();
    const databaseSetup = buildDatabaseSetupGuidance(databaseCapability.dbMode);

    res.status(200).json({
      status: overallStatus,
      version: VERSION,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      database: 'postgresql',
      db_connected: dbConnected,
      active_runs: activeRuns,
      dbMode: databaseCapability.dbMode,
      graphMode: databaseCapability.graphMode,
      // LHM-009: Explicit pgvector readiness so clients see (and can surface the
      // fix path in graphWarnings) when the active DB mode lacks pgvector.
      pgvectorReady: databaseCapability.extensions.vector,
      graphWarnings: databaseCapability.warnings,
      agentType: activeAgent,
      agentModel: activeModel,
      db: rawDbHealth.poolStats,
      ...(rawDbHealth.pgVersion ? { pgVersion: rawDbHealth.pgVersion } : {}),
      ...(rawDbHealth.extensions ? { extensions: rawDbHealth.extensions } : {}),
      poolStats: rawDbHealth.poolStats,
      cloud: rawDbHealth.cloud,
      provider: rawDbHealth.provider,
      ...(rawDbHealth.extensionStatus ? { extensionStatus: rawDbHealth.extensionStatus } : {}),
      ...(rawDbHealth.connectionLimit ? { connectionLimit: rawDbHealth.connectionLimit } : {}),
      databaseCapability,
      databaseSetup,
      // CA-021: Report MCP transport mode + bridge health
      mcpTransport: mcp.enabled ? 'http' : 'disabled',
      mcp,
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
      piInstalled: pi.piInstalled,
      piVersion: pi.piVersion,
      piBinPath: pi.piBinPath,
      // MP-009: Engine availability for EngineSelector (all three engines, cached 30s)
      engines,
      embeddings: getQueueStats(),
      cache: cacheStats(),
      activeJobs: activeJobsResult.status === 'fulfilled' ? activeJobsResult.value : [],
      scheduledJobs: scheduledJobsResult.status === 'fulfilled' ? scheduledJobsResult.value : [],
      // US-047: Component-level health status
      components: {
        database: dbHealth,
        worker: workerHealth,
        github: githubHealth,
        postgres: buildPostgresComponent(rawDbHealth),
        migrations: migrationsHealth,
      },
    });
  } catch (err) { next(err); }
});

// ── Component health check types ─────────────────────────────────────────

interface ComponentDatabaseHealth {
  status: 'ok' | 'degraded' | 'down';
  latencyMs?: number;
  connectionPoolSize?: number;
  activeConnections?: number;
  error?: string;
  // Forwarded from dbHealthCheck
  poolStats?: { total: number; idle: number; waiting: number; maxSize: number };
  pgVersion?: string;
  extensions?: string[];
  cloud?: boolean;
  provider?: DatabaseProvider;
  extensionStatus?: { vector: boolean; age: boolean };
  connectionLimit?: number;
}

interface ComponentWorkerHealth {
  status: 'ok' | 'stale' | 'not_running' | 'down' | 'unknown';
  lastHeartbeat?: string;
  activePid?: number | null;
  message?: string;
}

interface ComponentGithubHealth {
  status: 'ok' | 'degraded' | 'unknown';
  rateRemaining?: number | null;
  lastCheck?: string | null;
}

interface ComponentPostgresHealth {
  status: 'ok' | 'unknown';
  version?: string;
  uptime?: number | null;
}

interface ComponentMigrationsHealth {
  status: 'ok' | 'degraded' | 'unknown';
  applied?: number;
  pending?: number;
}

// ── Component check functions ─────────────────────────────────────────────

async function checkDatabaseComponent(): Promise<ComponentDatabaseHealth> {
  try {
    const result = await dbHealthCheck();
    if (!result.ok) {
      return {
        status: 'down',
        latencyMs: result.latencyMs,
        connectionPoolSize: result.poolStats.maxSize,
        activeConnections: result.poolStats.total - result.poolStats.idle,
        error: 'SELECT 1 failed',
        poolStats: result.poolStats,
        cloud: result.cloud,
        provider: result.provider,
        extensionStatus: result.extensionStatus,
        connectionLimit: result.connectionLimit,
      };
    }
    return {
      status: result.latencyMs > 200 ? 'degraded' : 'ok',
      latencyMs: result.latencyMs,
      connectionPoolSize: result.poolStats.maxSize,
      activeConnections: result.poolStats.total - result.poolStats.idle,
      poolStats: result.poolStats,
      pgVersion: result.pgVersion,
      extensions: result.extensions,
      cloud: result.cloud,
      provider: result.provider,
      extensionStatus: result.extensionStatus,
      connectionLimit: result.connectionLimit,
    };
  } catch {
    return {
      status: 'down',
      error: 'Database unreachable',
    };
  }
}

async function checkWorkerComponent(): Promise<ComponentWorkerHealth> {
  try {
    const row = await queryOne<{ pid: number | null; last_seen: string; worker_id: string }>(
      `SELECT pid, last_seen, worker_id FROM worker_heartbeat ORDER BY last_seen DESC LIMIT 1`
    );

    if (!row) {
      return {
        status: 'not_running',
        message: 'Start worker with npm run worker',
      };
    }

    const lastSeenMs = new Date(row.last_seen).getTime();
    const ageSeconds = (Date.now() - lastSeenMs) / 1000;

    if (ageSeconds > 90) {
      return {
        status: 'stale',
        lastHeartbeat: row.last_seen,
        activePid: row.pid,
        message: `Last heartbeat ${Math.round(ageSeconds)}s ago (stale after 90s)`,
      };
    }

    return {
      status: 'ok',
      lastHeartbeat: row.last_seen,
      activePid: row.pid,
    };
  } catch {
    return { status: 'unknown' };
  }
}

async function checkGithubComponent(): Promise<ComponentGithubHealth> {
  try {
    // Check integration_health table if it exists (written by GitHub webhook handler)
    const row = await queryOne<{ rate_remaining: number | null; checked_at: string }>(
      `SELECT rate_remaining, checked_at FROM integration_health WHERE provider = 'github' ORDER BY checked_at DESC LIMIT 1`
    );

    if (!row) {
      return { status: 'unknown', rateRemaining: null, lastCheck: null };
    }

    const rateOk = row.rate_remaining === null || row.rate_remaining > 100;
    return {
      status: rateOk ? 'ok' : 'degraded',
      rateRemaining: row.rate_remaining,
      lastCheck: row.checked_at,
    };
  } catch {
    // Table may not exist yet — not an error
    return { status: 'unknown', rateRemaining: null, lastCheck: null };
  }
}

async function checkMigrationsComponent(): Promise<ComponentMigrationsHealth> {
  try {
    // Count applied migrations from schema_migrations
    const appliedRow = await queryOne<{ cnt: string }>(
      `SELECT COUNT(*)::int AS cnt FROM schema_migrations`
    );
    const applied = parseInt(appliedRow?.cnt ?? '0', 10);

    // Count migration files on disk
    let totalOnDisk = 0;
    try {
      const migrationsDir = path.join(__dirname, '..', 'db', 'pg-migrations');
      if (fs.existsSync(migrationsDir)) {
        totalOnDisk = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).length;
      }
    } catch {
      // File system read failed — report what we know
    }

    const pending = Math.max(0, totalOnDisk - applied);
    return {
      status: pending > 0 ? 'degraded' : 'ok',
      applied,
      pending,
    };
  } catch {
    return { status: 'unknown' };
  }
}

function buildPostgresComponent(dbHealth: ComponentDatabaseHealth): ComponentPostgresHealth {
  if (!dbHealth.pgVersion) {
    return { status: 'unknown' };
  }
  return {
    status: 'ok',
    version: dbHealth.pgVersion,
    // pg doesn't expose server uptime directly without a superuser query
    uptime: null,
  };
}

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
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Detailed health diagnostics remain read-only and are safe for local tooling that needs richer readiness and environment context before invoking workflows."
 *     x-rorca-public-api: true
 *     description: Returns extended health metrics including pending spec count, memory usage, last backup timestamp, database mode, graph mode, and execution engine status.
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
 *                 dbMode: { type: string, enum: [native, docker, byop] }
 *                 graphMode: { type: string, enum: [full, lite, disabled] }
 *                 pgvectorReady: { type: boolean, description: "Whether the pgvector extension is installed for the active database mode" }
 *                 graphWarnings:
 *                   type: array
 *                   items: { type: string }
 *                 pending_specs_count: { type: integer }
 *                 memory_usage:
 *                   type: object
 *                   properties:
 *                     rss: { type: integer }
 *                     heapTotal: { type: integer }
 *                     heapUsed: { type: integer }
 *                     external: { type: integer }
 *                 last_backup_at: { type: string, nullable: true }
 *                 databaseCapability:
 *                   type: object
 *                   description: Canonical redacted database capability contract for DB mode, connection metadata, graph mode, and extension availability.
 *       503:
 *         description: Server is degraded
 */
router.get('/detailed', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.set(NO_CACHE_HEADERS);

    const healthResult = await dbHealthCheck();
    const dbConnected = healthResult.ok;
    const databaseCapability = buildDatabaseCapability({
      connected: healthResult.ok,
      provider: healthResult.provider,
      extensionStatus: healthResult.extensionStatus,
    });
    const databaseSetup = buildDatabaseSetupGuidance(databaseCapability.dbMode);

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
        `SELECT COUNT(*)::int AS cnt FROM pipeline_runs WHERE status = 'running'`
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
      dbMode: databaseCapability.dbMode,
      graphMode: databaseCapability.graphMode,
      pgvectorReady: databaseCapability.extensions.vector,
      graphWarnings: databaseCapability.warnings,
      pending_specs_count: pendingSpecsCount,
      memory_usage: memoryUsage,
      last_backup_at: lastBackupAt,
      databaseCapability,
      databaseSetup,
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
