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
 * @swagger
 * /api/wal:
 *   get:
 *     tags: [WAL]
 *     summary: Query WAL event log
 *     operationId: queryWalEvents
 *     description: Returns a paginated, filterable list of WAL (Write-Ahead Log) events with full-text search support. Also returns distinct event types for filter dropdowns.
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50, minimum: 1, maximum: 200 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *       - in: query
 *         name: event_type
 *         schema: { type: string }
 *         description: Filter by event type (exact match)
 *       - in: query
 *         name: workspace_id
 *         schema: { type: string }
 *       - in: query
 *         name: actor
 *         schema: { type: string }
 *         description: Filter by actor (substring match, case-insensitive)
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *         description: Events after this ISO-8601 timestamp
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *         description: Events before this ISO-8601 timestamp
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *         description: Full-text search across event_type, spec_id, story_id, actor, payload
 *       - in: query
 *         name: sort
 *         schema: { type: string, enum: [newest, oldest], default: newest }
 *     responses:
 *       200:
 *         description: Paginated WAL events with event type list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: integer }
 *                       ts: { type: string }
 *                       event_type: { type: string }
 *                       workspace_id: { type: string, nullable: true }
 *                       spec_id: { type: string, nullable: true }
 *                       story_id: { type: string, nullable: true }
 *                       actor: { type: string }
 *                       payload: { type: string, nullable: true }
 *                 total: { type: integer }
 *                 hasMore: { type: boolean }
 *                 eventTypes: { type: array, items: { type: string } }
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
 * @swagger
 * /api/wal:
 *   post:
 *     tags: [WAL]
 *     summary: Insert a WAL event
 *     operationId: insertWalEvent
 *     description: Inserts a new WAL event and broadcasts it to all SSE subscribers. Used by run-loop.ts to report story progress.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [event_type]
 *             properties:
 *               event_type: { type: string }
 *               workspace_id: { type: string }
 *               spec_id: { type: string }
 *               story_id: { type: string }
 *               payload: { type: object }
 *     responses:
 *       201:
 *         description: WAL event created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 id: { type: integer }
 *       400:
 *         description: Missing event_type
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
