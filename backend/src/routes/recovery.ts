/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Admin-only recovery routes. These are intentionally not MCP-generated. */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { handleRouteError } from '../lib/async-handler';
import {
  checkpointAttestationLookupSchema,
  checkpointReconciliationSchema,
  getCheckpointAttestationReference,
  reconcileCheckpoint,
} from '../lib/checkpoint-reconciliation';
import { AdminRequiredError, NotFoundError, ValidationError } from '../lib/errors';

const router = Router();

/** Defense in depth: server auth injects req.user, and this route verifies admin. */
function requireRecoveryAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') {
    next(new AdminRequiredError());
    return;
  }
  next();
}

/**
 * @swagger
 * /api/admin/recovery/checkpoints/attestation:
 *   get:
 *     tags: [Admin]
 *     summary: Resolve an existing trusted checkpoint attestation
 *     operationId: getAdminCheckpointAttestation
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Read-only lookup of opaque trusted evidence for an exact checkpoint; restricted to administrators and excluded from MCP."
 *     x-rorca-mcp: false
 *     parameters:
 *       - { in: query, name: workspaceId, required: true, schema: { type: string } }
 *       - { in: query, name: runId, required: true, schema: { type: integer } }
 *       - { in: query, name: storyId, required: true, schema: { type: string } }
 *       - { in: query, name: branch, required: true, schema: { type: string } }
 *       - { in: query, name: checkpointSha, required: true, schema: { type: string, pattern: '^[0-9a-fA-F]{40}$' } }
 *     responses:
 *       200: { description: Existing unexpired attestation reference }
 *       400: { description: Invalid bounded lookup }
 *       403: { description: Admin access required }
 *       404: { description: No trusted attestation exists for this exact checkpoint }
 */
router.get('/checkpoints/attestation', requireRecoveryAdmin, async (req: Request, res: Response) => {
  try {
    const parsed = checkpointAttestationLookupSchema.safeParse({
      workspaceId: req.query.workspaceId,
      runId: Number(req.query.runId),
      storyId: req.query.storyId,
      branch: req.query.branch,
      checkpointSha: req.query.checkpointSha,
    });
    if (!parsed.success) {
      throw new ValidationError('Invalid checkpoint attestation lookup', {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }
    const reference = await getCheckpointAttestationReference(parsed.data);
    if (!reference) {
      throw new NotFoundError('Trusted checkpoint attestation', parsed.data.checkpointSha);
    }
    res.status(200).json(reference);
  } catch (error: unknown) {
    handleRouteError(res, error, '[Recovery] Checkpoint attestation lookup');
  }
});

/**
 * @swagger
 * /api/admin/recovery/checkpoints/reconcile:
 *   post:
 *     tags: [Admin]
 *     summary: Reconcile a trusted validation attestation into story lifecycle
 *     operationId: reconcileAdminCheckpoint
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "This mutates canonical story state and is restricted to authenticated platform administrators; it is deliberately excluded from MCP."
 *     x-rorca-mcp: false
 *     description: >
 *       Admin-only REST recovery surface. The caller supplies an opaque trusted
 *       attestation reference, not validation commands or summaries. Rorca
 *       independently verifies immutable attestation binding, exact full branch
 *       head, approved spec, recoverable run, and provenance under a database
 *       advisory lock before using the canonical story completion service.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [workspaceId, specId, runId, storyId, branch, checkpointSha, attestationId, attestationDigest]
 *             properties:
 *               workspaceId: { type: string }
 *               specId: { type: string }
 *               runId: { type: integer, minimum: 1 }
 *               storyId: { type: string }
 *               branch: { type: string }
 *               checkpointSha: { type: string, pattern: '^[0-9a-fA-F]{40}$', description: Exact full current run-branch head }
 *               attestationId: { type: string, format: uuid }
 *               attestationDigest: { type: string, pattern: '^[0-9a-fA-F]{64}$' }
 *     responses:
 *       201:
 *         description: Checkpoint reconciled with immutable provenance
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [reconciled, idempotent, workspaceId, specId, runId, storyId, branch, checkpointSha, attestationId, validationGate]
 *               properties:
 *                 reconciled: { type: boolean, enum: [true] }
 *                 idempotent: { type: boolean, enum: [false] }
 *                 workspaceId: { type: string }
 *                 specId: { type: string }
 *                 runId: { type: integer }
 *                 storyId: { type: string }
 *                 branch: { type: string }
 *                 checkpointSha: { type: string, pattern: '^[0-9a-f]{40}$' }
 *                 attestationId: { type: string, format: uuid }
 *                 validationGate: { type: string, enum: [execution-engine, ci] }
 *                 walEventId: { type: integer }
 *       200: { description: Exact idempotent replay of existing provenance }
 *       400: { description: Invalid bounded request }
 *       403: { description: Admin access required }
 *       404: { description: Workspace, run, approved spec, story, or attestation not found }
 *       409: { description: Attestation, branch-head, provenance, lifecycle, or race conflict }
 *       422: { description: Revoked, expired, or invalid trusted attestation }
 */
router.post('/checkpoints/reconcile', requireRecoveryAdmin, async (req: Request, res: Response) => {
  try {
    const parsed = checkpointReconciliationSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid checkpoint reconciliation request', {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }
    const result = await reconcileCheckpoint(parsed.data);
    res.status(result.idempotent ? 200 : 201).json(result);
  } catch (error: unknown) {
    handleRouteError(res, error, '[Recovery] Checkpoint reconciliation');
  }
});

export default router;
