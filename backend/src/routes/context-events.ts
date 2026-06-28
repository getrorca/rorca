/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * US-026: Context Intelligence Platform ingestion routes.
 *
 * These are the API endpoints the capture sidecar (`rorca-capture`) talks to
 * over HTTP. They accept context events and memory candidates that have already
 * been redacted by the sidecar (US-005), validate them against the shared
 * contracts (US-002), and persist them to the Rorca DB (US-004).
 *
 * Every endpoint is idempotency-keyed so the sidecar's offline JSONL queue
 * (also US-026) can be safely replayed without double-ingestion.
 *
 * Design doc: docs/context-intelligence-platform.md §2.4 (Capture Sidecar),
 * §3 (Source-of-Truth Boundaries), §6 (Shared Contracts).
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { validateBody } from '../lib/validate';
import { handleRouteError } from '../lib/async-handler';
import { NotFoundError } from '../lib/errors';
import { queryOne } from '../db';
import { contextEventSchema, type ContextEvent, memoryCandidateSchema, type MemoryCandidate } from '../lib/capture-contracts';

const router = Router();

// ════════════════════════════════════════════════════════════════════════════
// Validation schemas for the flush (batch) endpoint
// ════════════════════════════════════════════════════════════════════════════

const flushEventEntry = z.object({
  type: z.literal('event'),
  payload: contextEventSchema,
});

const flushCandidateEntry = z.object({
  type: z.literal('candidate'),
  payload: memoryCandidateSchema,
});

const flushEntry = z.discriminatedUnion('type', [flushEventEntry, flushCandidateEntry]);

const flushBody = z.object({
  entries: z.array(flushEntry).min(1).max(100),
});

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

/**
 * Upsert a context event with idempotency-gated INSERT … ON CONFLICT.
 * Returns the row (existing or newly inserted).
 */
async function upsertContextEvent(event: ContextEvent): Promise<{ id: number; created: boolean }> {
  // Verify workspace exists.
  const ws = await queryOne<{ id: string }>(
    'SELECT id FROM workspaces WHERE id = $1',
    [event.workspaceId],
  );
  if (!ws) {
    throw new NotFoundError(`Workspace '${event.workspaceId}' not found`);
  }

  const result = await queryOne<{ id: number; created_at: string }>(
    `INSERT INTO context_events
       (workspace_id, source_system, source_ref, event_type, actor,
        occurred_at, summary, payload, idempotency_key, schema_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (workspace_id, idempotency_key) DO UPDATE
       SET updated_at = NOW()
     RETURNING id, created_at`,
    [
      event.workspaceId,
      event.source,
      event.gitSha ?? null,
      event.kind,
      null, // actor — extracted from payload/auth in a later story
      event.occurredAt,
      null, // summary — derived downstream
      JSON.stringify(event.payload),
      event.idempotencyKey,
      event.schemaVersion ? Number((event.schemaVersion as string).replace('v', '')) : 1,
    ],
  );

  if (!result) {
    throw new Error('Failed to upsert context event');
  }

  // Determine if it was newly created: if created_at is within 1 second of now, it's new.
  // This is a heuristic; the ON CONFLICT DO UPDATE path still returns a row.
  const created = Date.now() - new Date(result.created_at).getTime() < 2000;
  return { id: result.id, created };
}

/**
 * Upsert a memory candidate with idempotency-gated INSERT … ON CONFLICT.
 * Returns the row (existing or newly inserted).
 */
async function upsertMemoryCandidate(
  candidate: MemoryCandidate,
): Promise<{ id: number; created: boolean }> {
  const ws = await queryOne<{ id: string }>(
    'SELECT id FROM workspaces WHERE id = $1',
    [candidate.workspaceId],
  );
  if (!ws) {
    throw new NotFoundError(`Workspace '${candidate.workspaceId}' not found`);
  }

  const relatedFiles = candidate.relatedFiles ?? [];
  const result = await queryOne<{ id: number; created_at: string }>(
    `INSERT INTO memory_candidates
       (workspace_id, source_system, source_ref, category, title, rule, context,
        related_files, confidence, trust_tier, review_status,
        idempotency_key, schema_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11, $12)
     ON CONFLICT (workspace_id, idempotency_key) DO UPDATE
       SET updated_at = NOW()
     RETURNING id, created_at`,
    [
      candidate.workspaceId,
      candidate.sourceEventKey ? 'rorca-capture' : 'manual',
      candidate.sourceEventKey ?? null,
      (candidate as any).category ?? 'Uncategorised',
      candidate.title,
      candidate.body,
      (candidate as any).context ?? null,
      JSON.stringify(relatedFiles),
      (candidate as any).confidence ?? 'medium',
      (candidate as any).trust ?? 'unverified',
      candidate.idempotencyKey,
      candidate.schemaVersion ? Number((candidate.schemaVersion as string).replace('v', '')) : 1,
    ],
  );

  if (!result) {
    throw new Error('Failed to upsert memory candidate');
  }

  const created = Date.now() - new Date(result.created_at).getTime() < 2000;
  return { id: result.id, created };
}

// ════════════════════════════════════════════════════════════════════════════
// Routes
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /api/context-events/health:
 *   get:
 *     summary: Capture sidecar health check
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only reachability check — safe for CLI/MCP automation, no write or data exposure."
 *     x-rorca-public-api: true
 *     responses:
 *       200:
 *         description: Service is reachable and DB is connected
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: ok
 *                 db:
 *                   type: string
 *                   example: connected
 */
router.get('/health', async (_req: Request, res: Response) => {
  try {
    const row = await queryOne<{ one: number }>('SELECT 1 AS one');
    res.json({ status: 'ok', db: row ? 'connected' : 'degraded' });
  } catch (err) {
    handleRouteError(res, err, 'GET /health');
  }
});

const submitEventBodySchema = z.object({
  event: contextEventSchema,
});

/**
 * @swagger
 * /api/context-events/events:
 *   post:
 *     summary: Submit a context event (idempotent)
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Sidecar-facing ingestion endpoint — idempotency-gated, no operator-only side effects, safe for local/MCP automation."
 *     x-rorca-public-api: true
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               event:
 *                 $ref: '#/components/schemas/ContextEvent'
 *     responses:
 *       200:
 *         description: Event accepted (or already exists — idempotent)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: number
 *                 created:
 *                   type: boolean
 *                   description: Whether this was a new insert (false = idempotent deduplication)
 *       404:
 *         description: Workspace not found
 */
router.post('/events', validateBody(submitEventBodySchema), async (req: Request, res: Response) => {
  try {
    const { event } = req.body as { event: ContextEvent };
    const result = await upsertContextEvent(event);
    res.json(result);
  } catch (err) {
    handleRouteError(res, err, 'POST /events');
  }
});

const submitCandidateBodySchema = z.object({
  candidate: memoryCandidateSchema,
});

/**
 * @swagger
 * /api/context-events/candidates:
 *   post:
 *     summary: Submit a memory candidate (idempotent)
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Sidecar-facing candidate ingestion — idempotency-gated review entry point, safe for local/MCP automation."
 *     x-rorca-public-api: true
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               candidate:
 *                 $ref: '#/components/schemas/MemoryCandidate'
 *     responses:
 *       200:
 *         description: Candidate accepted (or already exists — idempotent)
 *       404:
 *         description: Workspace not found
 */
router.post('/candidates', validateBody(submitCandidateBodySchema), async (req: Request, res: Response) => {
  try {
    const { candidate } = req.body as { candidate: MemoryCandidate };
    const result = await upsertMemoryCandidate(candidate);
    res.json(result);
  } catch (err) {
    handleRouteError(res, err, 'POST /candidates');
  }
});

/**
 * @swagger
 * /api/context-events/flush:
 *   post:
 *     summary: Batch flush queued events and candidates (idempotent)
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Sidecar offline-queue flush — idempotent batch ingestion, no operator-only side effects, safe for local/MCP automation."
 *     x-rorca-public-api: true
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               entries:
 *                 type: array
 *                 items:
 *                   oneOf:
 *                     - type: object
 *                       properties:
 *                         type: { enum: ["event"] }
 *                         payload: { $ref: '#/components/schemas/ContextEvent' }
 *                     - type: object
 *                       properties:
 *                         type: { enum: ["candidate"] }
 *                         payload: { $ref: '#/components/schemas/MemoryCandidate' }
 *     responses:
 *       200:
 *         description: Flush result (per-entry success/failure)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 succeeded:
 *                   type: number
 *                 failed:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       index: { type: number }
 *                       idempotencyKey: { type: string }
 *                       error: { type: string }
 */
router.post('/flush', validateBody(flushBody), async (req: Request, res: Response) => {
  try {
    const { entries } = req.body as z.infer<typeof flushBody>;
    const succeeded: number[] = [];
    const failed: Array<{ index: number; idempotencyKey: string; error: string }> = [];

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      try {
        if (entry.type === 'event') {
          const result = await upsertContextEvent(entry.payload as ContextEvent);
          succeeded.push(result.id);
        } else {
          const candidate = entry.payload as MemoryCandidate;
          // Normalise memory candidate from flush format
          const normalised: MemoryCandidate = {
            ...candidate,
            // If candidate lacks sourceEventKey from flush, use manual
            sourceEventKey: (candidate as any).sourceEventKey ?? undefined,
          };
          const result = await upsertMemoryCandidate(normalised);
          succeeded.push(result.id);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        const payload = entry.payload as any;
        failed.push({
          index: i,
          idempotencyKey: payload?.idempotencyKey ?? 'unknown',
          error: message,
        });
      }
    }

    res.json({ succeeded: succeeded.length, failed });
  } catch (err) {
    handleRouteError(res, err, 'POST /flush');
  }
});

export default router;
