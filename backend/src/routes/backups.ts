import { Router, Request, Response } from 'express';
import { createBackup, listBackups, pruneOldBackups } from '../lib/backup';
import { backfillAll, isBackfillRunning, getQueueStats } from '../lib/embedding-pipeline';
import { logger } from '../lib/logger';

const router = Router();

/**
 * @swagger
 * /api/admin/backup:
 *   post:
 *     tags: [Admin]
 *     summary: Trigger an immediate database backup
 *     operationId: createBackup
 *     description: Creates a new SQLite database backup and prunes old backups beyond the retention limit.
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
    const { workspaceId } = req.body || {};
    const result = await backfillAll(workspaceId);
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
 *     description: Returns current embedding queue depth, processed count, failed count, and whether a backfill is in progress.
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
 */
router.get('/embed-all/status', (_req: Request, res: Response) => {
  const stats = getQueueStats();
  res.json({
    running: isBackfillRunning(),
    ...stats,
  });
});

export default router;
