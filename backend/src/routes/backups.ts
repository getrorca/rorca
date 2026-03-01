import { Router, Request, Response } from 'express';
import { createBackup, listBackups, pruneOldBackups } from '../lib/backup';

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

    console.log(`[Backup] Created ${result.filename} (${result.size} bytes), pruned ${pruned} old backups`);
    res.status(201).json({
      backup: {
        filename: result.filename,
        size: result.size,
      },
      pruned,
    });
  } catch (error: any) {
    console.error('[Backup] Create error:', error);
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
    console.error('[Backup] List error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
