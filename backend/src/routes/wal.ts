/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../db/index';
import { validateBody } from '../lib/validate';
import { broadcastAll, type WalEvent } from '../lib/sse-hub';
import { parsePaginationParams, paginateQuery } from '../lib/paginate';
import { handleRouteError } from '../lib/async-handler';

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
 *     description: |
 *       Returns a paginated, filterable list of WAL (Write-Ahead Log) events with full-text search support.
 *       Also returns distinct event types for filter dropdowns.
 *       Common event types include generate, spec_approved, spec_rejected, run_started,
 *       story_started, story_passed, story_failed, story_skipped, run_finished,
 *       worktree_created, worktree_merged, run_blocked, context_file_changed,
 *       story_escalated, skill_installed, skill_removed, skill_matched,
 *       terminal_session_started, and terminal_session_ended.
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
router.get('/', async (req, res, next) => {
  try {
    const pagination = parsePaginationParams(req, { limit: 50, maxLimit: 200 });
    const eventType = req.query.event_type ? String(req.query.event_type) : null;
    const workspaceId = req.query.workspace_id ? String(req.query.workspace_id) : null;
    const actor = req.query.actor ? String(req.query.actor) : null;
    const from = req.query.from ? String(req.query.from) : null;
    const to = req.query.to ? String(req.query.to) : null;
    const q = req.query.q ? String(req.query.q) : null;
    const sort = req.query.sort === 'oldest' ? 'ASC' : 'DESC';

    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 0;

    if (eventType) {
      paramIdx++;
      conditions.push(`event_type = $${paramIdx}`);
      params.push(eventType);
    }
    if (workspaceId) {
      paramIdx++;
      conditions.push(`workspace_id = $${paramIdx}`);
      params.push(workspaceId);
    }
    if (actor) {
      paramIdx++;
      conditions.push(`actor ILIKE $${paramIdx}`);
      params.push(`%${actor}%`);
    }
    if (from) {
      paramIdx++;
      conditions.push(`ts >= $${paramIdx}`);
      params.push(from);
    }
    if (to) {
      paramIdx++;
      conditions.push(`ts <= $${paramIdx}`);
      params.push(to);
    }
    if (q) {
      const pattern = `%${q}%`;
      paramIdx++;
      const p1 = paramIdx;
      paramIdx++;
      const p2 = paramIdx;
      paramIdx++;
      const p3 = paramIdx;
      paramIdx++;
      const p4 = paramIdx;
      paramIdx++;
      const p5 = paramIdx;
      conditions.push(
        `(event_type ILIKE $${p1} OR spec_id ILIKE $${p2} OR story_id ILIKE $${p3} OR actor ILIKE $${p4} OR payload::text ILIKE $${p5})`
      );
      params.push(pattern, pattern, pattern, pattern, pattern);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await paginateQuery<WalEventRow>({
      query: `SELECT * FROM wal_events ${whereClause}`,
      countQuery: `SELECT COUNT(*)::int as total FROM wal_events ${whereClause}`,
      params,
      pagination,
      orderBy: `id ${sort}`,
      cursorColumn: 'id',
      cursorDirection: sort === 'DESC' ? 'desc' : 'asc',
    });

    // Return distinct event types for filter dropdown
    const eventTypes = await query<{ event_type: string }>(
      'SELECT DISTINCT event_type FROM wal_events ORDER BY event_type'
    );

    res.json({
      ...result,
      eventTypes: eventTypes.map(r => r.event_type),
    });
  } catch (err) { next(err); }
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
const WalEventSchema = z.object({
  event_type: z.string().min(1),
  workspace_id: z.string().nullish(),
  spec_id: z.string().nullish(),
  story_id: z.string().nullish(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

router.post('/', validateBody(WalEventSchema), async (req: Request, res: Response, _next: NextFunction) => {
  try {
    const { event_type, workspace_id, story_id, spec_id, payload } = req.body;

    const walEvent = await queryOne<WalEvent>(
      `INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, payload)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        event_type,
        workspace_id ?? null,
        spec_id ?? null,
        story_id ?? null,
        payload ? JSON.stringify(payload) : null,
      ],
    );

    broadcastAll(walEvent!);

    res.status(201).json({ ok: true, id: walEvent!.id });
  } catch (error: any) {
    handleRouteError(res, error, '[WAL] POST');
  }
});

export default router;
