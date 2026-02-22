import { Router } from 'express';
import { db } from '../db/index';

const router = Router();

interface WalEventRow {
  id: number;
  ts: string;
  event_type: string;
  workspace_id: string | null;
  spec_id: string | null;
  story_id: string | null;
  actor: string;
  payload: string | null;
}

// GET /api/wal
router.get('/', (req, res) => {
  const limit = Math.min(Math.max(parseInt(String(req.query.limit), 10) || 50, 1), 200);
  const offset = Math.max(parseInt(String(req.query.offset), 10) || 0, 0);

  const events = db.prepare(
    'SELECT * FROM wal_events ORDER BY id DESC LIMIT ? OFFSET ?'
  ).all(limit, offset) as WalEventRow[];

  const countRow = db.prepare(
    'SELECT COUNT(*) as total FROM wal_events'
  ).get() as { total: number };

  res.json({
    events,
    total: countRow.total,
    limit,
    offset,
  });
});

export default router;
