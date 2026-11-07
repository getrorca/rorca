/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, type Request } from 'express';
import { z, type ZodType } from 'zod';
import { requireWorkspaceAdmin, requireWorkspaceMember } from '../lib/auth-utils';
import { AuthError, ValidationError } from '../lib/errors';
import {
  applyLifecycleReconciliation,
  listLifecycleReconciliationReceipts,
  previewLifecycleReconciliation,
} from '../lib/lifecycle-reconciliation';

const router = Router();
const WorkspaceId = z.string().trim().min(1).max(256);
const SpecId = z.string().trim().min(1).max(512).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const PreviewHash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const ReconcileBodySchema = z.object({
  workspaceId: WorkspaceId,
  previewHash: PreviewHash,
  operatorAttestation: z.object({
    deliveryOutcome: z.literal('completed'),
    rationale: z.string().trim().min(20).max(2000),
    evidenceReferences: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  }).strict().optional(),
}).strict();

function parse<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError('Invalid lifecycle reconciliation request', {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  return parsed.data;
}

function principal(req: Request): Express.UserShape {
  if (!req.user) throw new AuthError();
  return req.user;
}

function idempotencyKey(req: Request): string {
  const value = req.get('Idempotency-Key')?.trim() ?? '';
  if (value.length < 8 || value.length > 256) throw new ValidationError('Idempotency-Key must contain 8-256 characters');
  return value;
}

/**
 * @swagger
 * /api/lifecycle/specs/{specId}/reconciliation-preview:
 *   get:
 *     tags: [Lifecycle]
 *     summary: Preview exact-revision historical lifecycle reconciliation
 *     operationId: previewLifecycleReconciliation
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Read-only workspace history analysis exposes branch and run metadata only to members of the selected workspace."
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Deterministic exact-revision preview }
 *       401: { description: Authentication required }
 *       403: { description: Workspace membership required }
 *       404: { description: Workspace or approved spec not found }
 *       409: { description: Exact-spec authoritative history exceeds a deterministic read bound; details include remediation }
 *       422: { description: Approved spec is malformed or exceeds its safe read bound; details identify the spec and remediation }
 */
router.get('/specs/:specId/reconciliation-preview', requireWorkspaceMember(), async (req, res, next) => {
  try {
    principal(req);
    const workspaceId = parse(WorkspaceId, req.query.workspaceId);
    const specId = parse(SpecId, req.params.specId);
    res.json(await previewLifecycleReconciliation({ workspaceId, specId }));
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/lifecycle/specs/{specId}/reconcile:
 *   post:
 *     tags: [Lifecycle]
 *     summary: Persist an append-only exact-revision reconciliation receipt
 *     operationId: applyLifecycleReconciliation
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Writes a workspace-owned audit receipt and optional delivery attestation; workspace administration is required and the receipt grants no merge or deployment authority."
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *       - in: header
 *         name: Idempotency-Key
 *         required: true
 *         schema: { type: string, minLength: 8, maxLength: 256 }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [workspaceId, previewHash]
 *             properties:
 *               workspaceId: { type: string, minLength: 1, maxLength: 256 }
 *               previewHash: { type: string, pattern: '^sha256:[a-f0-9]{64}$' }
 *               operatorAttestation:
 *                 type: object
 *                 additionalProperties: false
 *                 required: [deliveryOutcome, rationale]
 *                 properties:
 *                   deliveryOutcome: { type: string, enum: [completed] }
 *                   rationale: { type: string, minLength: 20, maxLength: 2000 }
 *                   evidenceReferences:
 *                     type: array
 *                     maxItems: 20
 *                     items: { type: string, minLength: 1, maxLength: 500 }
 *     responses:
 *       200: { description: Persisted or idempotently replayed reconciliation receipt }
 *       400: { description: Invalid request }
 *       401: { description: Authentication required }
 *       403: { description: Workspace administration required }
 *       409: { description: Stale preview or idempotency conflict }
 */
router.post('/specs/:specId/reconcile', requireWorkspaceAdmin(), async (req, res, next) => {
  try {
    const actor = principal(req);
    const specId = parse(SpecId, req.params.specId);
    const body = parse(ReconcileBodySchema, req.body);
    res.json(await applyLifecycleReconciliation({
      workspaceId: body.workspaceId,
      specId,
      previewHash: body.previewHash,
      idempotencyKey: idempotencyKey(req),
      actorId: actor.id,
      actorLabel: actor.email,
      ...(body.operatorAttestation ? { operatorAttestation: body.operatorAttestation } : {}),
    }));
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/lifecycle/specs/{specId}/reconciliation-receipts:
 *   get:
 *     tags: [Lifecycle]
 *     summary: List append-only lifecycle reconciliation receipts
 *     operationId: listLifecycleReconciliationReceipts
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Receipts contain workspace-owned historical delivery evidence and authenticated operator attestations."
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *     responses:
 *       200: { description: Reconciliation receipts, newest first }
 *       401: { description: Authentication required }
 *       403: { description: Workspace membership required }
 */
router.get('/specs/:specId/reconciliation-receipts', requireWorkspaceMember(), async (req, res, next) => {
  try {
    principal(req);
    const specId = parse(SpecId, req.params.specId);
    const workspaceId = parse(WorkspaceId, req.query.workspaceId);
    const limit = req.query.limit === undefined ? undefined : Number(req.query.limit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
      throw new ValidationError('limit must be an integer from 1 through 100', { field: 'limit' });
    }
    res.json({ items: await listLifecycleReconciliationReceipts({ workspaceId, specId, limit }) });
  } catch (error) {
    next(error);
  }
});

export default router;
