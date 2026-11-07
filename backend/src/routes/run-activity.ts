/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import { json, Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { queryOne } from '../db/index';
import { INTERNAL_SERVICE_USER_ID } from '../lib/auth-utils';
import { AuthError, ForbiddenError, PayloadTooLargeError, ValidationError } from '../lib/errors';
import { createEmptyRunActivityProjection, deriveRunViewState, reduceRunActivity } from '../lib/run-activity-reducers';
import { runActivityStore, type RunActivityPage } from '../lib/run-activity-store';

const router = Router();
router.use(json({ limit: '256kb' }));

const PageQuerySchema = z.object({
  workspaceId: z.string().min(2).max(128),
  runtimeGeneration: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(40).max(4096).optional(),
  tail: z.preprocess((value) => value === 'true' ? true : value === 'false' ? false : value, z.boolean()).optional(),
}).strict();
const StateQuerySchema = PageQuerySchema.omit({ cursor: true, limit: true, tail: true });
const LiveQuerySchema = PageQuerySchema.transform(({ tail: _tail, ...query }) => query);
const RunIdSchema = z.coerce.number().int().positive();

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => { handler(req, res).catch(next); };
}

function correlationId(req: Request): string {
  return String((req as Request & { requestId?: string }).requestId ?? 'run-activity:request');
}

function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ValidationError('Run activity request validation failed', { issues: result.error.issues });
  return result.data;
}

async function requireExactWorkspaceMember(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AuthError();
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : null;
    if (!workspaceId) throw new ValidationError('Workspace ID is required');
    const membership = await queryOne(`SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_auth_id=$2`,
      [workspaceId, req.user.supabaseId]);
    if (!membership) throw new ForbiddenError('Exact workspace membership is required');
    next();
  } catch (error) {
    next(error);
  }
}

function requireRuntimeTelemetryPrincipal(req: Request): void {
  if (!req.user || ![INTERNAL_SERVICE_USER_ID, 'rorca-hermes-service'].includes(req.user.id)) {
    throw new AuthError('Bounded internal telemetry relay credential required');
  }
  const body = req.body as Record<string, unknown>;
  const runtimeId = typeof body?.runtimeId === 'string' ? body.runtimeId : null;
  if (!runtimeId || req.headers['x-rorca-runtime-id'] !== runtimeId) {
    throw new AuthError('Runtime telemetry principal does not match the exact leased subject');
  }
}

/**
 * @swagger
 * /api/mission-control/v1/run-activity/telemetry/batches:
 *   post:
 *     summary: Ingest a bounded runtime-neutral telemetry batch
 *     x-rorca-native-api: true
 *     x-rorca-native-authority: local-admin
 *     x-rorca-rationale: "Exact runtime lease/fence binding and pre-persistence redaction make this a bounded observability seam, never authority."
 *     responses:
 *       200: { description: Idempotent telemetry receipt }
 */
router.post('/telemetry/batches', asyncRoute(async (req, res) => {
  requireRuntimeTelemetryPrincipal(req);
  const bytes = Buffer.byteLength(JSON.stringify(req.body ?? null), 'utf8');
  if (bytes > 256 * 1024) throw new PayloadTooLargeError('Runtime telemetry batch exceeds 256 KiB');
  const result = await runActivityStore.ingestTelemetryBatch(req.body);
  res.json({ schemaVersion: 'rorca.runtime-telemetry-receipt.v1', ...result, projectionOnly: true, authorityEffect: 'none' });
}));

/**
 * @swagger
 * /api/mission-control/v1/run-activity/runs/{runId}/events:
 *   get:
 *     summary: Read a bounded durable run activity page
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Exact workspace membership, generation-bound signed cursors, and redacted projections prevent cross-workspace replay."
 *     parameters:
 *       - { in: path, name: runId, required: true, schema: { type: integer, minimum: 1 } }
 *     responses:
 *       200: { description: Durable activity page or explicit reset/gap }
 */
router.get('/runs/:runId/events', requireExactWorkspaceMember, asyncRoute(async (req, res) => {
  const query = parseInput(PageQuerySchema, req.query);
  const runId = parseInput(RunIdSchema, req.params.runId);
  const page = await runActivityStore.page({ ...query, runId, correlationId: correlationId(req) });
  res.setHeader('Cache-Control', 'no-store');
  res.json(page);
}));

/**
 * @swagger
 * /api/mission-control/v1/run-activity/runs/{runId}/state:
 *   get:
 *     summary: Read Run View activity and seven independent operational status planes
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "This is a redacted observability projection; no aggregate badge or terminal/runtime assertion can establish completion."
 *     parameters:
 *       - { in: path, name: runId, required: true, schema: { type: integer, minimum: 1 } }
 *     responses:
 *       200: { description: Bounded Run View state }
 */
router.get('/runs/:runId/state', requireExactWorkspaceMember, asyncRoute(async (req, res) => {
  const query = parseInput(StateQuerySchema, req.query);
  const runId = parseInput(RunIdSchema, req.params.runId);
  let page = await runActivityStore.page({ ...query, runId, limit: 100, correlationId: correlationId(req) });
  let projection = createEmptyRunActivityProjection();
  let pagesRead = 0;
  while (page.status === 'ok' && pagesRead < 100) {
    projection = reduceRunActivity(page.events, projection);
    pagesRead += 1;
    if (!page.hasMore || !page.nextCursor) break;
    page = await runActivityStore.page({ ...query, runId, limit: 100, cursor: page.nextCursor, correlationId: correlationId(req) });
  }
  if (page.status !== 'ok' || page.hasMore) {
    projection = {
      ...projection,
      incomplete: true,
      gap: projection.gap ?? { expectedSequence: projection.lastSequence + 1, observedSequence: projection.lastSequence + 1,
        reasonCode: page.status === 'ok' ? 'projection_page_budget' : String(page.resetReason) },
    };
  }
  const operationalPlanes = await runActivityStore.listStatusPlanes({ ...query, runId });
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    schemaVersion: 'rorca.run-view-state.v1',
    state: deriveRunViewState(projection, page.status === 'ok' ? 'live' : undefined),
    projection,
    operationalPlanes,
    planeCount: 7,
    notices: [
      'Terminal and runtime activity are observability. Completion is shown only from host closeout records.',
      'Operational planes are independent and have no aggregate readiness authority.',
    ],
    authorityLabels: {
      terminalOutput: 'observability_only',
      runtimeAssertion: 'observability_only',
      completionCandidate: 'proposal_only',
      storyCompletion: 'verified_StoryCloseoutDecision.accepted_only',
      runLifecycle: 'separate_host_authority',
      mergeDeploymentProduction: 'not_authorized',
    },
    authoritative: false,
    authorityEffect: 'none',
  });
}));

function writeSse(res: Response, event: string, data: unknown, id?: string): boolean {
  const frame = `${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return res.write(frame);
}

/**
 * @swagger
 * /api/mission-control/v1/run-activity/runs/{runId}/live:
 *   get:
 *     summary: Replay durable run activity then tail committed events
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Database replay is correctness authority; notifications are wake hints and slow clients are disconnected without blocking ingestion."
 *     parameters:
 *       - { in: path, name: runId, required: true, schema: { type: integer, minimum: 1 } }
 *     responses:
 *       200: { description: Bounded SSE activity stream }
 */
router.get('/runs/:runId/live', requireExactWorkspaceMember, asyncRoute(async (req, res) => {
  const query = parseInput(LiveQuerySchema, req.query);
  const runId = parseInput(RunIdSchema, req.params.runId);
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  let closed = false;
  let busy = false;
  let cursor = query.cursor;
  let disconnectSent = false;
  const close = (): void => { closed = true; };
  req.on('close', close);

  const deliver = async (): Promise<void> => {
    if (closed || busy) return;
    busy = true;
    try {
      let page: RunActivityPage;
      do {
        page = await runActivityStore.page({ ...query, runId, cursor, limit: 100, correlationId: correlationId(req) });
        if (page.status !== 'ok') {
          writeSse(res, page.status, page);
          res.end();
          closed = true;
          return;
        }
        for (const event of page.events) {
          if (!writeSse(res, 'activity', event, `${event.streamId}:${event.runtimeGeneration}:${event.streamSequence}`)) {
            if (!disconnectSent) {
              disconnectSent = true;
              writeSse(res, 'stream_disconnect', { reasonCode: 'slow_client', retryAfterMs: 1000, cursor: page.nextCursor });
            }
            res.end();
            closed = true;
            return;
          }
        }
        cursor = page.nextCursor ?? cursor;
      } while (!closed && page.hasMore);
    } catch {
      if (!closed) {
        writeSse(res, 'error', { code: 'RUN_ACTIVITY_STREAM_ERROR', retryable: true });
        res.end();
        closed = true;
      }
    } finally {
      busy = false;
    }
  };

  await deliver();
  if (closed) return;
  const poll = setInterval(() => { void deliver(); }, 1000);
  const heartbeat = setInterval(() => {
    if (!closed && !res.write(`: heartbeat ${Date.now()}\n\n`)) {
      res.end();
      closed = true;
    }
  }, 15_000);
  const maximumConnection = setTimeout(() => {
    if (!closed) {
      writeSse(res, 'stream_disconnect', { reasonCode: 'bounded_connection_window', retryAfterMs: 1000, cursor });
      res.end();
      closed = true;
    }
  }, 5 * 60_000);
  req.on('close', () => {
    clearInterval(poll);
    clearInterval(heartbeat);
    clearTimeout(maximumConnection);
  });
}));

export default router;
