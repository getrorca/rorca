import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { createBackup, listBackups, pruneOldBackups } from '../lib/backup';
import { backfillAll, isBackfillRunning, getQueueStats, getEmbeddingCounts, getProvider } from '../lib/embedding-pipeline';
import { isGraphAvailable, graphStats, populateFromSpec, populateFromRun } from '../lib/knowledge-graph';
import { query } from '../db/index';
import { logger } from '../lib/logger';
import { ConflictError, ValidationError } from '../lib/errors';
import { handleRouteError } from '../lib/async-handler';

const router = Router();

/**
 * @swagger
 * /api/admin/backup:
 *   post:
 *     tags: [Admin]
 *     summary: Trigger an immediate database backup
 *     operationId: createBackup
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
router.post('/graph-backfill', async (_req: Request, res: Response) => {
  try {
    const available = await isGraphAvailable();
    if (!available) {
      throw new ValidationError('Apache AGE is not installed — graph features unavailable');
      return;
    }

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
router.get('/graph-stats', async (_req: Request, res: Response) => {
  try {
    const stats = await graphStats();
    res.json(stats);
  } catch (error: any) {
    handleRouteError(res, error, '[graph-stats]');
  }
});

export default router;
