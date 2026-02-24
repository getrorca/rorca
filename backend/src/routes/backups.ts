import { Router, Request, Response } from 'express';
import { createBackup, listBackups, pruneOldBackups } from '../lib/backup';

const router = Router();

// ─── POST /api/admin/backup — Trigger an immediate backup ───────────────────

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

// ─── GET /api/admin/backups — List available backups ────────────────────────

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
