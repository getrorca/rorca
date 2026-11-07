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
import { NotFoundError, UnprocessableError } from '../lib/errors';
import { queryOne } from '../db';
import { contextEventSchema, type ContextEvent, memoryCandidateSchema } from '../lib/capture-contracts';

const router = Router();

// ════════════════════════════════════════════════════════════════════════════
// Validation schemas for the flush (batch) endpoint
// ════════════════════════════════════════════════════════════════════════════

const reviewStatusInput = z.enum(['pending', 'approved', 'rejected', 'duplicate', 'superseded', 'revisit']);
const trustTierInput = z.enum(['authoritative', 'trusted', 'community', 'unverified']);
const confidenceInput = z.union([z.number().min(0).max(1), z.enum(['low', 'medium', 'high'])]).optional();

const ingestionMemoryCandidateSchema = memoryCandidateSchema
  .omit({ status: true, trust: true, confidence: true, createdAt: true })
  .extend({
    // Ingestion always stores candidates as pending, but accepting an omitted
    // status keeps older sidecars/tests compatible while still validating at
    // the route boundary.
    status: reviewStatusInput.optional().default('pending'),
    trust: trustTierInput.optional().default('unverified'),
    confidence: confidenceInput,
    createdAt: z.string().optional().default(() => new Date().toISOString()),
  });

type IngestibleMemoryCandidate = z.infer<typeof ingestionMemoryCandidateSchema>;

const flushEventEntry = z.object({
  type: z.literal('event'),
  payload: contextEventSchema,
});

const flushCandidateEntry = z.object({
  type: z.literal('candidate'),
  payload: ingestionMemoryCandidateSchema,
});

const flushEntry = z.discriminatedUnion('type', [flushEventEntry, flushCandidateEntry]);

const flushBody = z.object({
  entries: z.array(flushEntry).min(1).max(100),
});

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

function schemaVersionNumber(version: string | undefined): number {
  return version ? Number(version.replace(/^v/i, '')) : 1;
}

function toNumericId(id: number | string): number {
  const parsed = typeof id === 'number' ? id : Number(id);
  if (!Number.isSafeInteger(parsed)) {
    throw new UnprocessableError('Persisted id is outside the safe JSON number range');
  }
  return parsed;
}

function confidenceLabel(score: IngestibleMemoryCandidate['confidence']): 'low' | 'medium' | 'high' {
  if (score === undefined) return 'medium';
  if (typeof score === 'string') return score;
  if (score >= 0.75) return 'high';
  if (score >= 0.4) return 'medium';
  return 'low';
}

function legacyTrustTier(tier: IngestibleMemoryCandidate['trust']): string {
  switch (tier) {
    case 'authoritative':
      return 'approved_policy';
    case 'trusted':
      return 'verified_fact';
    case 'community':
      return 'working_note';
    case 'unverified':
    default:
      return 'agent_observation';
  }
}

function legacyCandidateCategory(category?: string): string {
  const allowed = new Set(['Architecture', 'Convention', 'Bug Fix', 'Decision', 'Pattern', 'Gotcha']);
  return category && allowed.has(category) ? category : 'Decision';
}

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

  const result = await queryOne<{ id: number | string; created: boolean }>(
    `WITH inserted AS (
       INSERT INTO context_events
         (workspace_id, source_system, source_ref, event_type, actor,
          occurred_at, summary, payload, idempotency_key, schema_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
       RETURNING id
     )
     SELECT id, TRUE AS created FROM inserted
     UNION ALL
     SELECT id, FALSE AS created
       FROM context_events
      WHERE workspace_id = $1
        AND idempotency_key = $9
        AND NOT EXISTS (SELECT 1 FROM inserted)
     LIMIT 1`,
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
      schemaVersionNumber(event.schemaVersion),
    ],
  );

  if (!result) {
    throw new UnprocessableError('Failed to upsert context event');
  }

  return { id: toNumericId(result.id), created: result.created };
}

/**
 * Upsert a memory candidate with idempotency-gated INSERT … ON CONFLICT.
 * Returns the row (existing or newly inserted).
 */
async function upsertMemoryCandidate(
  candidate: IngestibleMemoryCandidate,
): Promise<{ id: number; created: boolean }> {
  const ws = await queryOne<{ id: string }>(
    'SELECT id FROM workspaces WHERE id = $1',
    [candidate.workspaceId],
  );
  if (!ws) {
    throw new NotFoundError(`Workspace '${candidate.workspaceId}' not found`);
  }

  const relatedFiles = candidate.relatedFiles ?? [];
  const category = legacyCandidateCategory(candidate.category);
  const result = await queryOne<{ id: number | string; created: boolean }>(
    `WITH inserted AS (
       INSERT INTO memory_candidates
         (workspace_id, source_system, source_ref, category, suggested_category, title, rule, context,
          related_files, confidence, trust_tier, review_status,
          idempotency_key, schema_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', $12, $13)
       ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
       RETURNING id
     )
     SELECT id, TRUE AS created FROM inserted
     UNION ALL
     SELECT id, FALSE AS created
       FROM memory_candidates
      WHERE workspace_id = $1
        AND idempotency_key = $12
        AND NOT EXISTS (SELECT 1 FROM inserted)
     LIMIT 1`,
    [
      candidate.workspaceId,
      candidate.sourceEventKey ? 'rorca-capture' : 'manual',
      candidate.sourceEventKey ?? null,
      category,
      category,
      candidate.title,
      candidate.body,
      null, // context — optional review rationale can be added by governance actions later
      JSON.stringify(relatedFiles),
      confidenceLabel(candidate.confidence),
      legacyTrustTier(candidate.trust),
      candidate.idempotencyKey,
      schemaVersionNumber(candidate.schemaVersion),
    ],
  );

  if (!result) {
    throw new UnprocessableError('Failed to upsert memory candidate');
  }

  return { id: toNumericId(result.id), created: result.created };
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
  candidate: ingestionMemoryCandidateSchema,
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
    const { candidate } = req.body as { candidate: IngestibleMemoryCandidate };
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
          const result = await upsertMemoryCandidate(entry.payload);
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
