/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { createBackup, listBackups, pruneOldBackups } from '../lib/backup';
import { backfillAll, isBackfillRunning, getQueueStats, getEmbeddingCounts, getProvider } from '../lib/embedding-pipeline';
import { isGraphAvailable, graphStats, populateFromSpec, populateFromRun } from '../lib/knowledge-graph';
import { query, queryOne } from '../db/index';
import { logger } from '../lib/logger';
import { ConflictError, ValidationError } from '../lib/errors';
import { handleRouteError } from '../lib/async-handler';
import { checkAge, invalidateAgeCache, requireAge } from '../lib/age-guard';
import { resetGraphAvailability } from '../lib/knowledge-graph';
import { parsePaginationParams, paginateQuery } from '../lib/paginate';
import { createSignedLicense } from '../lib/license-verifier';

const router = Router();

interface McpAuditLogRow {
  id: number;
  ts: string;
  tool_name: string;
  token_tier: 'public' | 'admin';
  remote_addr: string | null;
  session_id: string | null;
  params_hash: string | null;
  success: boolean;
  error_code: string | null;
  duration_ms: number | null;
}

interface McpAuditSummaryRow {
  tool_name: string;
  token_tier: 'public' | 'admin';
  total_calls: string;
  success_count: string;
  failure_count: string;
}

function parseBooleanFilter(value: unknown): boolean | null {
  if (value === undefined) return null;
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return null;
}

/**
 * @swagger
 * /api/admin/backup:
 *   post:
 *     tags: [Admin]
 *     summary: Trigger an immediate database backup
 *     operationId: createBackup
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Database backup is an operator-only maintenance action and must never be exposed through CLI or MCP."
 *     description: Creates a new PostgreSQL database backup via pg_dump and prunes old backups beyond the retention limit.
 *     responses:
 *       201:
 *         description: Backup created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 backup:
 *                   type: object
 *                   properties:
 *                     filename: { type: string }
 *                     size: { type: integer }
 *                 pruned: { type: integer }
 *       500:
 *         description: Backup creation failed
 */
router.post('/backup', async (_req: Request, res: Response) => {
  try {
    const result = await createBackup();
    const pruned = pruneOldBackups();

    logger.info(`[Backup] Created ${result.filename} (${result.size} bytes), pruned ${pruned} old backups`);
    res.status(201).json({
      backup: {
        filename: result.filename,
        size: result.size,
      },
      pruned,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Backup] Create');
  }
});

/**
 * @swagger
 * /api/admin/backups:
 *   get:
 *     tags: [Admin]
 *     summary: List available database backups
 *     operationId: listBackups
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Backup inventory is operator-only maintenance metadata and should remain outside CLI and MCP exposure."
 *     description: Returns a list of all available database backup files with their metadata.
 *     responses:
 *       200:
 *         description: List of backups
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 backups:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       filename: { type: string }
 *                       size: { type: integer }
 *                       createdAt: { type: string }
 *       500:
 *         description: Failed to list backups
 */
router.get('/backups', (_req: Request, res: Response) => {
  try {
    const backups = listBackups();
    res.json({ backups });
  } catch (error: any) {
    handleRouteError(res, error, '[Backup] List');
  }
});

/**
 * @swagger
 * /api/admin/embed-all:
 *   post:
 *     tags: [Admin]
 *     summary: Backfill embeddings for all content
 *     operationId: backfillEmbeddings
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Embedding backfill is an operator-controlled maintenance workflow and must not be exposed to MCP or the public CLI."
 *     description: Queues embedding jobs for all existing specs, stories, memory entries, and archived specs. Skips content whose hash matches existing embeddings (staleness check).
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               workspaceId: { type: string, description: "Optional workspace ID to limit backfill scope" }
 *               force: { type: boolean, description: "When true, skip content_hash staleness check and re-embed everything (use when switching providers)" }
 *     responses:
 *       200:
 *         description: Backfill queued
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 queued: { type: integer }
 *                 skippedStale: { type: integer }
 *       409:
 *         description: Backfill already in progress
 */
router.post('/embed-all', async (req: Request, res: Response) => {
  if (isBackfillRunning()) {
    throw new ConflictError('Backfill already in progress');
    return;
  }

  try {
    const { workspaceId, force } = req.body || {};
    const result = await backfillAll(workspaceId, !!force);
    res.json(result);
  } catch (error: any) {
    handleRouteError(res, error, '[Embeddings] Backfill');
  }
});

/**
 * @swagger
 * /api/admin/embed-all/status:
 *   get:
 *     tags: [Admin]
 *     summary: Get embedding backfill status
 *     operationId: getBackfillStatus
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Embedding backfill status is operator-focused maintenance telemetry and should remain admin-only."
 *     description: Returns current embedding queue depth, processed count, failed count, whether a backfill is in progress, and total embedding counts by source type.
 *     responses:
 *       200:
 *         description: Backfill status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 running: { type: boolean }
 *                 queueDepth: { type: integer }
 *                 processed: { type: integer }
 *                 failed: { type: integer }
 *                 embeddingCount: { type: integer }
 *                 specCount: { type: integer }
 *                 storyCount: { type: integer }
 *                 memoryCount: { type: integer }
 */
router.get('/embed-all/status', async (_req: Request, res: Response) => {
  const stats = getQueueStats();
  const counts = await getEmbeddingCounts();
  res.json({
    running: isBackfillRunning(),
    ...stats,
    ...counts,
  });
});

/**
 * @swagger
 * /api/admin/embedding-provider:
 *   get:
 *     tags: [Admin]
 *     summary: Get current embedding provider configuration
 *     operationId: getEmbeddingProvider
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Embedding provider configuration is operator-level infrastructure data and should remain admin-only."
 *     description: Returns the active embedding provider name, model identifier, and vector dimensions.
 *     responses:
 *       200:
 *         description: Current embedding provider info
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 provider: { type: string, enum: [openai, openai-large, voyage, local] }
 *                 model: { type: string }
 *                 dimensions: { type: integer }
 */
router.get('/embedding-provider', (_req: Request, res: Response) => {
  const provider = getProvider();
  res.json({
    provider: provider.name,
    model: provider.model,
    dimensions: provider.dimension,
  });
});

/**
 * @swagger
 * /api/admin/graph-backfill:
 *   post:
 *     tags: [Admin]
 *     summary: Backfill the knowledge graph from existing specs and runs
 *     operationId: graphBackfill
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Graph backfill is an operator-run maintenance job and must remain outside MCP and public CLI exposure."
 *     description: |
 *       Populates the Apache AGE knowledge graph from all approved spec JSONs
 *       found on disk and all completed pipeline runs in the database.
 *       Requires Apache AGE to be installed — returns 400 if unavailable.
 *     responses:
 *       200:
 *         description: Backfill completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 specsProcessed: { type: integer }
 *                 runsProcessed: { type: integer }
 *                 stats:
 *                   type: object
 *                   properties:
 *                     available: { type: boolean }
 *                     vertexCount: { type: integer }
 *                     edgeCount: { type: integer }
 *                     labels: { type: array, items: { type: string } }
 *       400:
 *         description: Apache AGE is not installed
 */
router.post('/graph-backfill', requireAge(), async (_req: Request, res: Response) => {
  try {
    let specsProcessed = 0;
    let runsProcessed = 0;

    // 1. Process all approved specs from all workspace filesystem paths
    const workspaces = await query<{ id: number; path: string }>(
      'SELECT id, path FROM workspaces'
    );

    for (const ws of workspaces) {
      const approvedDir = path.join(ws.path, 'forge', 'specs', 'approved');
      let files: string[] = [];
      try {
        files = fs.readdirSync(approvedDir).filter(f => f.endsWith('.json'));
      } catch {
        // Directory doesn't exist for this workspace — skip
        continue;
      }

      for (const file of files) {
        try {
          const specPath = path.join(approvedDir, file);
          const raw = fs.readFileSync(specPath, 'utf-8');
          const spec = JSON.parse(raw);
          const specId = file.replace(/\.json$/, '');
          const stories: Array<{ id: string; title: string; dependsOn?: string[] }> =
            (spec.userStories || []).map((s: { id: string; title?: string; dependsOn?: string[] }) => ({
              id: s.id,
              title: s.title || s.id,
              dependsOn: s.dependsOn,
            }));

          if (stories.length > 0) {
            await populateFromSpec(specId, String(ws.id), stories);
            specsProcessed++;
          }
        } catch (err) {
          logger.warn({ err, file, workspace: ws.path }, '[graph-backfill] Failed to process spec');
        }
      }
    }

    // 2. Process all completed pipeline runs
    const completedRuns = await query<{ id: number; spec_path: string; workspace_id: number }>(
      "SELECT id, spec_path, workspace_id FROM pipeline_runs WHERE status IN ('done', 'passed')"
    );

    for (const run of completedRuns) {
      try {
        // Extract spec ID from spec_path (e.g. "forge/specs/approved/my-spec.json" → "my-spec")
        const specId = path.basename(run.spec_path, '.json');
        await populateFromRun(run.id, specId, String(run.workspace_id));
        runsProcessed++;
      } catch (err) {
        logger.warn({ err, runId: run.id }, '[graph-backfill] Failed to process run');
      }
    }

    const stats = await graphStats();

    logger.info(
      { specsProcessed, runsProcessed, stats },
      '[graph-backfill] Backfill completed'
    );

    res.json({ specsProcessed, runsProcessed, stats });
  } catch (error: any) {
    handleRouteError(res, error, '[graph-backfill] Backfill');
  }
});

/**
 * @swagger
 * /api/admin/graph-stats:
 *   get:
 *     tags: [Admin]
 *     summary: Get knowledge graph statistics
 *     operationId: getGraphStats
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Admin graph stats are operator maintenance telemetry and should not be exposed to non-admin callers."
 *     description: Returns current vertex count, edge count, and label list from the Apache AGE knowledge graph. Returns available=false if AGE is not installed.
 *     responses:
 *       200:
 *         description: Graph statistics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 available: { type: boolean }
 *                 vertexCount: { type: integer }
 *                 edgeCount: { type: integer }
 *                 labels:
 *                   type: array
 *                   items: { type: string }
 */
router.get('/graph-stats', requireAge(), async (_req: Request, res: Response) => {
  try {
    const stats = await graphStats();
    res.json(stats);
  } catch (error: any) {
    handleRouteError(res, error, '[graph-stats]');
  }
});

/**
 * @swagger
 * /api/admin/age-recheck:
 *   post:
 *     tags: [Admin]
 *     summary: Re-check Apache AGE availability
 *     operationId: recheckAge
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "AGE rechecks are operator-only diagnostics and must remain admin-only."
 *     description: Clears the cached AGE availability flag and probes the current database again. No auth gate is applied because Rorca runs as a local single-user tool.
 *     responses:
 *       200:
 *         description: Re-check complete
 */
router.post('/age-recheck', async (_req: Request, res: Response) => {
  try {
    invalidateAgeCache();
    resetGraphAvailability();
    const age = await checkAge();
    res.json({ ok: true, age });
  } catch (error: any) {
    handleRouteError(res, error, '[age-recheck]');
  }
});

/**
 * @swagger
 * /api/admin/mcp-audit:
 *   get:
 *     tags: [Admin]
 *     summary: List MCP audit log entries
 *     operationId: listMcpAuditLog
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "MCP audit history contains operator forensics and must remain restricted to admin callers."
 *     x-mcp-tier: admin
 *     description: Returns paginated MCP audit rows with optional filters for tool, token tier, success state, and time window.
 *     parameters:
 *       - in: query
 *         name: tool
 *         schema: { type: string }
 *         description: Filter by MCP tool name
 *       - in: query
 *         name: tier
 *         schema: { type: string, enum: [public, admin] }
 *         description: Filter by MCP token tier
 *       - in: query
 *         name: success
 *         schema: { type: boolean }
 *         description: Filter by success state
 *       - in: query
 *         name: since
 *         schema: { type: string, format: date-time }
 *         description: Inclusive lower bound for ts
 *       - in: query
 *         name: until
 *         schema: { type: string, format: date-time }
 *         description: Inclusive upper bound for ts
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *       - in: query
 *         name: page
 *         schema: { type: integer }
 *       - in: query
 *         name: offset
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Paginated audit log rows
 */
router.get('/mcp-audit', async (req: Request, res: Response) => {
  const tool = req.query.tool ? String(req.query.tool) : null;
  const tier = req.query.tier ? String(req.query.tier) : null;
  const success = parseBooleanFilter(req.query.success);
  const since = req.query.since ? String(req.query.since) : null;
  const until = req.query.until ? String(req.query.until) : null;

  if (tier && tier !== 'public' && tier !== 'admin') {
    throw new ValidationError('tier must be public or admin');
  }
  if (req.query.success !== undefined && success === null) {
    throw new ValidationError('success must be true or false');
  }
  if (since && Number.isNaN(Date.parse(since))) {
    throw new ValidationError('since must be a valid ISO timestamp');
  }
  if (until && Number.isNaN(Date.parse(until))) {
    throw new ValidationError('until must be a valid ISO timestamp');
  }

  const pagination = parsePaginationParams(req, { limit: 50, maxLimit: 250 });
  const where: string[] = ['1=1'];
  const params: unknown[] = [];

  if (tool) {
    params.push(tool);
    where.push(`tool_name = $${params.length}`);
  }
  if (tier) {
    params.push(tier);
    where.push(`token_tier = $${params.length}`);
  }
  if (success !== null) {
    params.push(success);
    where.push(`success = $${params.length}`);
  }
  if (since) {
    params.push(since);
    where.push(`ts >= $${params.length}::timestamptz`);
  }
  if (until) {
    params.push(until);
    where.push(`ts <= $${params.length}::timestamptz`);
  }

  const baseQuery = `SELECT id, ts, tool_name, token_tier, remote_addr, session_id, params_hash, success, error_code, duration_ms
    FROM mcp_audit_log
    WHERE ${where.join(' AND ')}`;
  const countQuery = `SELECT COUNT(*)::int AS total
    FROM mcp_audit_log
    WHERE ${where.join(' AND ')}`;

  const page = await paginateQuery<McpAuditLogRow>({
    query: baseQuery,
    countQuery,
    params,
    pagination,
    orderBy: 'ts DESC, id DESC',
    cursorColumn: 'id',
  });

  res.json(page);
});

/**
 * @swagger
 * /api/admin/mcp-audit/summary:
 *   get:
 *     tags: [Admin]
 *     summary: Summarize MCP audit activity
 *     operationId: summarizeMcpAuditLog
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "MCP usage summaries are operator telemetry and should remain admin-only."
 *     x-mcp-tier: admin
 *     description: Returns grouped counts by tool and token tier for a time window.
 *     parameters:
 *       - in: query
 *         name: since
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: until
 *         schema: { type: string, format: date-time }
 *     responses:
 *       200:
 *         description: Grouped summary rows
 */
router.get('/mcp-audit/summary', async (req: Request, res: Response) => {
  const since = req.query.since ? String(req.query.since) : null;
  const until = req.query.until ? String(req.query.until) : null;

  if (since && Number.isNaN(Date.parse(since))) {
    throw new ValidationError('since must be a valid ISO timestamp');
  }
  if (until && Number.isNaN(Date.parse(until))) {
    throw new ValidationError('until must be a valid ISO timestamp');
  }

  const params: unknown[] = [];
  const where: string[] = ['1=1'];
  if (since) {
    params.push(since);
    where.push(`ts >= $${params.length}::timestamptz`);
  }
  if (until) {
    params.push(until);
    where.push(`ts <= $${params.length}::timestamptz`);
  }

  const rows = await query<McpAuditSummaryRow>(
    `SELECT
       tool_name,
       token_tier,
       COUNT(*)::text AS total_calls,
       COUNT(*) FILTER (WHERE success = true)::text AS success_count,
       COUNT(*) FILTER (WHERE success = false)::text AS failure_count
     FROM mcp_audit_log
     WHERE ${where.join(' AND ')}
     GROUP BY tool_name, token_tier
     ORDER BY COUNT(*) DESC, tool_name ASC, token_tier ASC`,
    params,
  );

  const total = await queryOne<{ total: number }>(
    `SELECT COUNT(*)::int AS total
     FROM mcp_audit_log
     WHERE ${where.join(' AND ')}`,
    params,
  );

  res.json({
    totalCalls: total?.total ?? 0,
    items: rows.map((row) => ({
      toolName: row.tool_name,
      tokenTier: row.token_tier,
      totalCalls: Number(row.total_calls),
      successCount: Number(row.success_count),
      failureCount: Number(row.failure_count),
    })),
  });
});

// ─── BL-013: Generate offline RS256 license key for self-hosted distribution ──

/**
 * @swagger
 * /api/admin/generate-license:
 *   post:
 *     tags: [Admin]
 *     summary: Generate an offline RSA-signed license key for self-hosted distribution
 *     operationId: generateLicense
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "License generation is a sensitive commercial operator action and must never be exposed through MCP or the open-source CLI."
 *     description: |
 *       Signs a detached RSA license key with the RORCA_LICENSE_PRIVATE_KEY. Requires RORCA_ADMIN_KEY header for authentication.
 *       Used by Rorca admins to generate trial or paid licenses for self-hosted users.
 *     parameters:
 *       - in: header
 *         name: X-Rorca-Admin-Key
 *         required: true
 *         schema:
 *           type: string
 *         description: Admin API key (must match RORCA_ADMIN_KEY env var)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [plan, email]
 *             properties:
 *               plan: { type: string, enum: [solo, pro, team, enterprise], description: "License plan tier" }
 *               email: { type: string, description: "Licensee email address" }
 *               expiresInDays: { type: integer, description: "License validity in days (omit for perpetual)" }
 *     responses:
 *       200:
 *         description: License key generated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 licenseKey: { type: string, description: "RSA-signed detached license key" }
 *                 plan: { type: string }
 *                 email: { type: string }
 *                 expiresAt: { type: string, nullable: true }
 *       400:
 *         description: Missing or invalid parameters
 *       401:
 *         description: Missing or invalid RORCA_ADMIN_KEY
 *       503:
 *         description: RORCA_LICENSE_PRIVATE_KEY not configured
 */
router.post('/generate-license', async (req: Request, res: Response) => {
  try {
    // Validate admin key
    const adminKey = process.env.RORCA_ADMIN_KEY;
    if (!adminKey) {
      res.status(401).json({ error: 'RORCA_ADMIN_KEY env var not configured' });
      return;
    }

    const providedKey = req.headers['x-rorca-admin-key'] as string;
    if (!providedKey || providedKey !== adminKey) {
      res.status(401).json({ error: 'Invalid or missing X-Rorca-Admin-Key header' });
      return;
    }

    // Validate private key availability
    const privateKey = process.env.RORCA_LICENSE_PRIVATE_KEY;
    if (!privateKey) {
      res.status(503).json({ error: 'RORCA_LICENSE_PRIVATE_KEY env var not configured' });
      return;
    }

    const { plan, email, expiresInDays } = req.body as {
      plan?: 'solo' | 'pro' | 'team' | 'enterprise';
      email?: string;
      expiresInDays?: number;
    };

    if (!plan || !['solo', 'pro', 'team', 'enterprise'].includes(plan)) {
      res.status(400).json({ error: 'plan must be one of: solo, pro, team, enterprise' });
      return;
    }
    if (!email || typeof email !== 'string') {
      res.status(400).json({ error: 'email is required' });
      return;
    }

    const payload = {
      sub: email,
      plan,
      iss: 'rorca',
      issuedAt: new Date().toISOString(),
      expiresAt: null as string | null,
    };

    if (expiresInDays && expiresInDays > 0) {
      payload.expiresAt = new Date(Date.now() + expiresInDays * 86400 * 1000).toISOString();
    }

    const licenseKey = createSignedLicense(payload, privateKey);
    const expiresAt = payload.expiresAt;

    logger.info({ plan, email, expiresInDays: expiresInDays || 'perpetual' }, '[Admin] License generated');

    res.json({
      licenseKey,
      plan,
      email,
      expiresAt,
    });
  } catch (err) {
    handleRouteError(res, err, '[Admin] Generate license');
  }
});

export default router;
