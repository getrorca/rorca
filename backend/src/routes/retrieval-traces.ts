/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * retrieval-traces.ts — US-018 retrieval trace API routes.
 *
 * Provides endpoints to persist and retrieve retrieval traces for debugging
 * and quality evaluation. Traces are redacted before storage — sensitive
 * values and large raw content are stripped.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { validateBody } from '../lib/validate';
import { handleRouteError } from '../lib/async-handler';
import { ValidationError } from '../lib/errors';
import {
  persistRetrievalTrace,
  getRetrievalTrace,
  listRetrievalTraces,
  linkTraceToSpecLog,
} from '../lib/retrieval-trace';
import { retrievalCandidate } from '../lib/retrieval-contracts';

const router = Router();

// ════════════════════════════════════════════════════════════════════════════
// Validation schemas
// ════════════════════════════════════════════════════════════════════════════

const persistTraceBody = z.object({
  traceId: z.string().min(1).max(200),
  workspaceId: z.string().min(1).max(200),
  briefHash: z.string().min(1).max(200),
  gitSha: z.string().max(64).optional(),
  policy: z.string().max(200).optional(),
  graphMode: z.enum(['full', 'lite', 'disabled']).optional(),
  degraded: z.boolean().optional(),
  candidates: z.array(retrievalCandidate),
  tokenEstimate: z.number().int().min(0).optional(),
  /** Optional spec generation log ID to link this trace to. */
  specLogId: z.number().int().positive().optional(),
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/retrieval-traces — persist a trace
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /api/retrieval-traces:
 *   post:
 *     summary: Persist a retrieval trace (idempotent)
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Trace persistence is a write path but safe for local automation — idempotent upsert, redacted payload, no operator-only side effects."
 *     x-rorca-public-api: true
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [traceId, workspaceId, briefHash, candidates]
 *             properties:
 *               traceId: { type: string }
 *               workspaceId: { type: string }
 *               briefHash: { type: string }
 *               gitSha: { type: string }
 *               policy: { type: string }
 *               graphMode: { type: string, enum: [full, lite, disabled] }
 *               degraded: { type: boolean }
 *               candidates: { type: array, items: { $ref: '#/components/schemas/RetrievalCandidate' } }
 *               tokenEstimate: { type: integer }
 *               specLogId: { type: integer }
 *     responses:
 *       201:
 *         description: Trace persisted (or already exists — idempotent)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 traceId: { type: string }
 *                 candidateCount: { type: integer }
 *                 redacted: { type: boolean, description: "Always true — traces are redacted before storage" }
 *       400:
 *         description: Validation error
 */
router.post('/', validateBody(persistTraceBody), async (req: Request, res: Response) => {
  try {
    const body = req.body as z.infer<typeof persistTraceBody>;
    const trace = await persistRetrievalTrace(body);

    // Optionally link to a spec generation log
    if (body.specLogId) {
      await linkTraceToSpecLog(trace.traceId, body.specLogId);
    }

    res.status(201).json({
      traceId: trace.traceId,
      candidateCount: trace.candidates.length,
      redacted: true,
    });
  } catch (err) {
    handleRouteError(res, err, 'POST /api/retrieval-traces');
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/retrieval-traces/:traceId — retrieve a trace by ID
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /api/retrieval-traces/{traceId}:
 *   get:
 *     summary: Retrieve a retrieval trace by ID
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only trace retrieval for UI/debugging — no write or operator-only side effects."
 *     x-rorca-public-api: true
 *     parameters:
 *       - in: path
 *         name: traceId
 *         required: true
 *         schema: { type: string }
 *         description: Trace ID
 *     responses:
 *       200:
 *         description: The retrieval trace
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RetrievalTrace'
 *       404:
 *         description: Trace not found
 */
router.get('/:traceId', async (req: Request, res: Response) => {
  try {
    const traceId = String(req.params.traceId);
    if (!traceId) throw new ValidationError('traceId is required');

    const trace = await getRetrievalTrace(traceId);
    res.json(trace);
  } catch (err) {
    handleRouteError(res, err, 'GET /api/retrieval-traces/:traceId');
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/retrieval-traces — list traces for a workspace
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /api/retrieval-traces:
 *   get:
 *     summary: List retrieval traces for a workspace
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only trace listing for operator dashboard — no write or operator-only side effects."
 *     x-rorca-public-api: true
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *         description: Workspace ID
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, minimum: 0, default: 0 }
 *     responses:
 *       200:
 *         description: Paginated list of retrieval traces
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 traces: { type: array, items: { $ref: '#/components/schemas/RetrievalTrace' } }
 *                 total: { type: integer }
 *       400:
 *         description: Missing workspaceId
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : '';
    if (!workspaceId) throw new ValidationError('workspaceId is required');

    const limit = typeof req.query.limit === 'string'
      ? Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20))
      : 20;
    const offset = typeof req.query.offset === 'string'
      ? Math.max(0, parseInt(req.query.offset, 10) || 0)
      : 0;

    const result = await listRetrievalTraces({ workspaceId, limit, offset });
    res.json(result);
  } catch (err) {
    handleRouteError(res, err, 'GET /api/retrieval-traces');
  }
});

export default router;
