/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Bounded read-only closeout reconciliation contract for UI/CLI/MCP. */
import { Router, type Request, type Response } from 'express';
import { handleRouteError } from '../lib/async-handler';
import { ValidationError } from '../lib/errors';
import {
  closeoutReconciliationPreviewQuerySchema,
  getSafeRunCloseoutReconciliation,
  previewRunCloseoutReconciliation,
} from '../lib/run-closeout-reconciliation';

const router = Router();

function requestIdentity(req: Request): { runId: number; workspaceId: string } {
  const runId = Number(req.params.runId);
  const parsed = closeoutReconciliationPreviewQuerySchema.safeParse({ workspaceId: req.query.workspaceId });
  if (!Number.isSafeInteger(runId) || runId <= 0 || !parsed.success) {
    throw new ValidationError('Invalid closeout reconciliation read request');
  }
  return { runId, workspaceId: parsed.data.workspaceId };
}

/**
 * @swagger
 * /api/recovery/runs/{runId}/closeout-reconciliation/preview:
 *   get:
 *     tags: [Recovery]
 *     summary: Preview the safe identity of one exact closeout reconciliation
 *     operationId: previewRunCloseoutReconciliation
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only, fixed-run projection omits host paths, owner receipts, actors, and raw evidence while allowing reviewed UI/CLI/MCP clients to bind the exact preview hash."
 *     x-rorca-public-api: true
 *     parameters:
 *       - { in: path, name: runId, required: true, schema: { type: integer, minimum: 1 } }
 *       - { in: query, name: workspaceId, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Safe deterministic preview identity
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties: false
 *               required: [schemaVersion, eligible, canonicalTargetHash, target]
 *               properties:
 *                 schemaVersion: { type: string, enum: [rorca.run-closeout-reconciliation-preview.v1] }
 *                 eligible: { type: boolean, enum: [true] }
 *                 canonicalTargetHash: { type: string, pattern: '^sha256:[0-9a-f]{64}$' }
 *                 target:
 *                   type: object
 *                   additionalProperties: false
 *                   required: [runId, workspaceId, specId, expiresAt, immutableAuthorityHash]
 *                   properties:
 *                     runId: { type: integer }
 *                     workspaceId: { type: string }
 *                     specId: { type: string }
 *                     expiresAt: { type: string, format: date-time }
 *                     immutableAuthorityHash: { type: string, pattern: '^sha256:[0-9a-f]{64}$' }
 *       409: { description: Exact target is not eligible }
 *       422: { description: Evidence expired }
 */
router.get('/runs/:runId/closeout-reconciliation/preview', async (req: Request, res: Response) => {
  try {
    const input = requestIdentity(req);
    const preview = await previewRunCloseoutReconciliation(input);
    res.status(200).json({
      schemaVersion: preview.schemaVersion,
      eligible: true,
      canonicalTargetHash: preview.canonicalTargetHash,
      target: {
        runId: preview.target.runId,
        workspaceId: preview.target.workspaceId,
        specId: preview.target.specId,
        expiresAt: preview.target.expiresAt,
        immutableAuthorityHash: preview.target.immutableAuthorityHash,
      },
    });
  } catch (error) {
    handleRouteError(res, error, '[Recovery] Public closeout reconciliation preview');
  }
});

/**
 * @swagger
 * /api/recovery/runs/{runId}/closeout-reconciliation:
 *   get:
 *     tags: [Recovery]
 *     summary: Read safe closeout reconciliation state
 *     operationId: getRunCloseoutReconciliation
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only state exposes opaque hashes and lifecycle state only; apply, owner receipts, paths, actors, and raw evidence remain administrator-only."
 *     x-rorca-public-api: true
 *     parameters:
 *       - { in: path, name: runId, required: true, schema: { type: integer, minimum: 1 } }
 *       - { in: query, name: workspaceId, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Safe reconciliation state projection
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties: false
 *               required: [schemaVersion, runId, workspaceId, state]
 *               properties:
 *                 schemaVersion: { type: string, enum: [rorca.run-closeout-reconciliation-public.v1] }
 *                 runId: { type: integer }
 *                 workspaceId: { type: string }
 *                 state: { type: string, enum: [eligible, prepared, queued, processing, completed, blocked] }
 *                 previewHash: { type: string, nullable: true, pattern: '^sha256:[0-9a-f]{64}$' }
 *                 immutableAuthorityHash: { type: string, nullable: true, pattern: '^sha256:[0-9a-f]{64}$' }
 *                 expiresAt: { type: string, format: date-time, nullable: true }
 *                 reconciliationEventId: { type: string, format: uuid, nullable: true }
 *                 reconciledAt: { type: string, format: date-time, nullable: true }
 *                 resultReceiptHash: { type: string, nullable: true, pattern: '^sha256:[0-9a-f]{64}$' }
 */
router.get('/runs/:runId/closeout-reconciliation', async (req: Request, res: Response) => {
  try {
    res.status(200).json(await getSafeRunCloseoutReconciliation(requestIdentity(req)));
  } catch (error) {
    handleRouteError(res, error, '[Recovery] Public closeout reconciliation read');
  }
});

export default router;
