import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { createBackup, listBackups, pruneOldBackups } from '../lib/backup';
import { backfillAll, isBackfillRunning, getQueueStats, getEmbeddingCounts, getProvider } from '../lib/embedding-pipeline';
import { isGraphAvailable, populateFromSpec, populateFromRun, addMemoryLink, graphStats } from '../lib/knowledge-graph';
import { query } from '../db/index';
import { logger } from '../lib/logger';

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
    logger.error('[Backup] Create error:', error);
    res.status(500).json({ error: error.message });
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
    logger.error('[Backup] List error:', error);
    res.status(500).json({ error: error.message });
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
    res.status(409).json({ error: 'Backfill already in progress' });
    return;
  }

  try {
    const { workspaceId, force } = req.body || {};
    const result = await backfillAll(workspaceId, !!force);
    res.json(result);
  } catch (error: any) {
    logger.error({ err: error }, '[Embeddings] Backfill error');
    res.status(500).json({ error: error.message });
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
 *     summary: Backfill the knowledge graph from existing specs, runs, and memories
 *     operationId: graphBackfill
 *     description: |
 *       Populates the Apache AGE knowledge graph from existing data:
 *       - Scans each workspace's forge/specs/approved/*.json and creates Spec/Story vertices + edges
 *       - Queries completed pipeline_runs and creates run-level graph relationships
 *       - Queries memories table and creates Memory vertices linked to their source stories
 *       Returns 400 if Apache AGE is not installed.
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
 *                 memoriesProcessed: { type: integer }
 *                 stats:
 *                   type: object
 *                   properties:
 *                     available: { type: boolean }
 *                     vertexCount: { type: integer }
 *                     edgeCount: { type: integer }
 *                     labels: { type: array, items: { type: string } }
 *       400:
 *         description: Apache AGE not installed or unavailable
 */
router.post('/graph-backfill', async (_req: Request, res: Response) => {
  try {
    if (!(await isGraphAvailable())) {
      res.status(400).json({ error: 'Apache AGE not installed or unavailable' });
      return;
    }

    let specsProcessed = 0;
    let runsProcessed = 0;
    let memoriesProcessed = 0;

    // 1. Scan workspace spec files
    const workspaces = await query<{ id: string; path: string }>('SELECT id, path FROM workspaces');

    for (const ws of workspaces) {
      const specsDir = path.join(ws.path, 'forge', 'specs', 'approved');
      let specFiles: string[] = [];
      try {
        specFiles = fs.readdirSync(specsDir).filter(f => f.endsWith('.json'));
      } catch {
        // Directory doesn't exist — skip
        continue;
      }

      for (const file of specFiles) {
        try {
          const raw = fs.readFileSync(path.join(specsDir, file), 'utf-8');
          const parsed = JSON.parse(raw);
          const specId = file.replace(/\.json$/, '');
          const stories: Array<{ id: string; title: string; dependsOn?: string[] }> =
            parsed.userStories || [];

          if (stories.length > 0) {
            await populateFromSpec(specId, ws.id, stories.map(s => ({
              id: s.id,
              title: s.title,
              dependsOn: s.dependsOn,
            })));
          }

          specsProcessed++;
          if (specsProcessed % 10 === 0) {
            logger.info(`[graph-backfill] Specs processed: ${specsProcessed}`);
          }
        } catch (err) {
          logger.warn({ err, file }, '[graph-backfill] Failed to process spec file');
        }
      }
    }

    // 2. Process completed pipeline runs
    const runs = await query<{ id: number; spec_path: string; workspace_id: string }>(
      `SELECT id, spec_path, workspace_id FROM pipeline_runs WHERE status IN ('done', 'passed')`,
    );

    for (const run of runs) {
      try {
        const specId = extractSpecIdFromPath(run.spec_path);
        if (specId) {
          await populateFromRun(run.id, specId, run.workspace_id);
        }
        runsProcessed++;
        if (runsProcessed % 10 === 0) {
          logger.info(`[graph-backfill] Runs processed: ${runsProcessed}`);
        }
      } catch (err) {
        logger.warn({ err, runId: run.id }, '[graph-backfill] Failed to process run');
      }
    }

    // 3. Process memories
    const memories = await query<{ id: number; source_story_id: string | null; category: string }>(
      `SELECT id, source_story_id, category FROM memories WHERE deleted_at IS NULL`,
    );

    for (const mem of memories) {
      try {
        if (mem.source_story_id) {
          await addMemoryLink(String(mem.id), mem.source_story_id, mem.category);
        }
        memoriesProcessed++;
        if (memoriesProcessed % 10 === 0) {
          logger.info(`[graph-backfill] Memories processed: ${memoriesProcessed}`);
        }
      } catch (err) {
        logger.warn({ err, memoryId: mem.id }, '[graph-backfill] Failed to process memory');
      }
    }

    const stats = await graphStats();

    logger.info(
      `[graph-backfill] Complete: ${specsProcessed} specs, ${runsProcessed} runs, ${memoriesProcessed} memories. ` +
      `Graph: ${stats.vertexCount} vertices, ${stats.edgeCount} edges`,
    );

    res.json({ specsProcessed, runsProcessed, memoriesProcessed, stats });
  } catch (error: any) {
    logger.error({ err: error }, '[graph-backfill] Backfill error');
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/admin/graph-stats:
 *   get:
 *     tags: [Admin]
 *     summary: Get knowledge graph statistics
 *     operationId: getGraphStats
 *     description: Returns Apache AGE knowledge graph stats including vertex count, edge count, and label list. Returns available=false if AGE is not installed.
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
 *                 labels: { type: array, items: { type: string } }
 */
router.get('/graph-stats', async (_req: Request, res: Response) => {
  try {
    const stats = await graphStats();
    res.json(stats);
  } catch (error: any) {
    logger.error({ err: error }, '[graph-stats] Error fetching graph stats');
    res.status(500).json({ error: error.message });
  }
});

function extractSpecIdFromPath(specPath: string): string {
  if (!specPath) return '';
  const basename = specPath.split('/').pop() || '';
  return basename.replace(/\.json$/, '');
}

export default router;
