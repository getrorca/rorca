import { Router, Request, Response } from 'express';
import { db } from '../db/index';
import { broadcastAll, type WalEvent } from '../lib/sse-hub';
import { parsePaginationParams, paginateQuery } from '../lib/paginate';

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

/**
 * GET /api/wal
 * Query paginated WAL event log with filtering and search.
 *
 * Query params:
 *   limit       - max rows (1–200, default 50)
 *   offset      - pagination offset (default 0)
 *   event_type  - filter by event type (exact match)
 *   workspace_id - filter by workspace
 *   actor       - filter by actor (substring match, case-insensitive)
 *   from        - ISO-8601 date, events after this timestamp
 *   to          - ISO-8601 date, events before this timestamp
 *   q           - full-text search across event_type, spec_id, story_id, actor, payload
 *   sort        - 'newest' (default) or 'oldest'
 */
router.get('/', (req, res) => {
  const pagination = parsePaginationParams(req, { limit: 50, maxLimit: 200 });
  const eventType = req.query.event_type ? String(req.query.event_type) : null;
  const workspaceId = req.query.workspace_id ? String(req.query.workspace_id) : null;
  const actor = req.query.actor ? String(req.query.actor) : null;
  const from = req.query.from ? String(req.query.from) : null;
  const to = req.query.to ? String(req.query.to) : null;
  const q = req.query.q ? String(req.query.q) : null;
  const sort = req.query.sort === 'oldest' ? 'ASC' : 'DESC';

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (eventType) {
    conditions.push('event_type = ?');
    params.push(eventType);
  }
  if (workspaceId) {
    conditions.push('workspace_id = ?');
    params.push(workspaceId);
  }
  if (actor) {
    conditions.push('actor LIKE ?');
    params.push(`%${actor}%`);
  }
  if (from) {
    conditions.push('ts >= ?');
    params.push(from);
  }
  if (to) {
    conditions.push('ts <= ?');
    params.push(to);
  }
  if (q) {
    conditions.push(
      `(event_type LIKE ? OR spec_id LIKE ? OR story_id LIKE ? OR actor LIKE ? OR payload LIKE ?)`
    );
    const pattern = `%${q}%`;
    params.push(pattern, pattern, pattern, pattern, pattern);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = paginateQuery<WalEventRow>(db, {
    query: `SELECT * FROM wal_events ${whereClause}`,
    countQuery: `SELECT COUNT(*) as total FROM wal_events ${whereClause}`,
    params,
    pagination,
    orderBy: `id ${sort}`,
    cursorColumn: 'id',
    cursorDirection: sort === 'DESC' ? 'desc' : 'asc',
  });

  // Return distinct event types for filter dropdown
  const eventTypes = db.prepare(
    'SELECT DISTINCT event_type FROM wal_events ORDER BY event_type'
  ).all() as { event_type: string }[];

  res.json({
    ...result,
    eventTypes: eventTypes.map(r => r.event_type),
  });
});

/**
 * POST /api/wal
 * Insert a WAL event (used by run-loop.ts to report story progress).
 * Broadcasts to all SSE subscribers.
 */
router.post('/', (req: Request, res: Response) => {
  try {
    const { event_type, workspace_id, story_id, spec_id, payload } = req.body;
    if (!event_type) {
      res.status(400).json({ error: 'event_type is required' });
      return;
    }

    const result = db.prepare(
      `INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, payload)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      event_type,
      workspace_id ?? null,
      spec_id ?? null,
      story_id ?? null,
      payload ? JSON.stringify(payload) : null,
    );

    const walEvent = db.prepare('SELECT * FROM wal_events WHERE id = ?').get(
      result.lastInsertRowid
    ) as WalEvent;
    broadcastAll(walEvent);

    res.status(201).json({ ok: true, id: result.lastInsertRowid });
  } catch (error: any) {
    console.error('[WAL] POST error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
