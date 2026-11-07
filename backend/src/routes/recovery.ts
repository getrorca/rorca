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
import { AdminRequiredError, ConflictError, NotFoundError, ValidationError } from '../lib/errors';
import { isLocalHumanApprovalPrincipal } from '../lib/auth-utils';
import { z } from 'zod';
import {
  closeoutReconciliationPreviewQuerySchema,
  closeoutReconciliationRequestSchema,
  previewRunCloseoutReconciliation,
  requestRunCloseoutReconciliation,
  requireCloseoutReconciliationIdempotencyKey,
} from '../lib/run-closeout-reconciliation';
import {
  inspectExactPostSaveWorkflow,
  reconcilePostSaveWorkflowStage,
} from '../lib/spec-post-save-reconciliation';

const router = Router();

/** Defense in depth: server auth injects req.user, and this route verifies admin. */
function requireRecoveryAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') {
    next(new AdminRequiredError());
    return;
  }
  next();
}

/** Closeout correction is a local human repair request, never service authority. */
function requireCloseoutLocalAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!isLocalHumanApprovalPrincipal(req.user)) {
    next(new AdminRequiredError('Local human administrator authority required'));
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

/**
 * @swagger
 * /api/admin/recovery/runs/{runId}/closeout-reconciliation/preview:
 *   get:
 *     tags: [Admin]
 *     summary: Preview one exact false-failed host closeout correction
 *     operationId: previewAdminRunCloseoutReconciliation
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Read-only exact-run recovery evidence contains host paths and security authority and is restricted to a local human administrator; owner authorization is still separately required for mutation."
 *     x-rorca-mcp: false
 *     parameters:
 *       - { in: path, name: runId, required: true, schema: { type: integer, minimum: 1 } }
 *       - { in: query, name: workspaceId, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Deterministic expiring exact-run reconciliation target }
 *       400: { description: Invalid bounded request }
 *       403: { description: Local human administrator required }
 *       404: { description: Exact run/workspace pair not found }
 *       409: { description: Run, evidence, Git, posture, or ownership is not eligible }
 *       422: { description: Immutable host evidence expired }
 */
router.get('/runs/:runId/closeout-reconciliation/preview', requireCloseoutLocalAdmin, async (req: Request, res: Response) => {
  try {
    const parsed = closeoutReconciliationPreviewQuerySchema.safeParse({ workspaceId: req.query.workspaceId });
    const runId = Number(req.params.runId);
    if (!parsed.success || !Number.isSafeInteger(runId) || runId <= 0) {
      throw new ValidationError('Invalid closeout reconciliation preview request', {
        issues: parsed.success
          ? [{ path: 'runId', message: 'Expected a positive safe integer' }]
          : parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }
    const preview = await previewRunCloseoutReconciliation({ runId, workspaceId: parsed.data.workspaceId });
    res.status(200).json(preview);
  } catch (error: unknown) {
    handleRouteError(res, error, '[Recovery] Run closeout reconciliation preview');
  }
});

/**
 * @swagger
 * /api/admin/recovery/runs/{runId}/closeout-reconciliation:
 *   post:
 *     tags: [Admin]
 *     summary: Queue one owner-authorized closeout-only reconciliation
 *     operationId: reconcileAdminRunCloseout
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "This corrects terminal host/lifecycle authority for one exact historical run and therefore requires local-admin authentication, strict CSRF, idempotency, and a separate signed workspace-owner event; it is never MCP-callable."
 *     x-rorca-mcp: false
 *     parameters:
 *       - { in: path, name: runId, required: true, schema: { type: integer, minimum: 1 } }
 *       - { in: header, name: Idempotency-Key, required: true, schema: { type: string, minLength: 8, maxLength: 200 } }
 *       - { in: header, name: X-CSRF-Token, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [workspaceId, acceptedPreviewHash, rationale, ownerAuthorization]
 *             properties:
 *               workspaceId: { type: string }
 *               acceptedPreviewHash: { type: string, pattern: '^sha256:[0-9a-f]{64}$' }
 *               rationale: { type: string, minLength: 12, maxLength: 2000 }
 *               ownerAuthorization: { type: object, description: Exact provider-human-event.v1 signed by a configured workspace owner }
 *     responses:
 *       202: { description: Exact application-owned request durably queued }
 *       200: { description: Exact idempotent replay; no duplicate authority or work }
 *       400: { description: Invalid bounded request or Idempotency-Key }
 *       403: { description: Local admin, CSRF, distinct owner, signature, tenant, or principal denied }
 *       409: { description: Preview, idempotency, authority, or immutable evidence conflict }
 *       422: { description: Preview or host evidence expired }
 *       503: { description: Application request is durable but transport publication is unavailable }
 */
router.post('/runs/:runId/closeout-reconciliation', requireCloseoutLocalAdmin, async (req: Request, res: Response) => {
  try {
    const parsed = closeoutReconciliationRequestSchema.safeParse(req.body);
    const runId = Number(req.params.runId);
    if (!parsed.success || !Number.isSafeInteger(runId) || runId <= 0) {
      throw new ValidationError('Invalid closeout reconciliation request', {
        issues: parsed.success
          ? [{ path: 'runId', message: 'Expected a positive safe integer' }]
          : parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }
    const idempotencyKey = requireCloseoutReconciliationIdempotencyKey(req.get('Idempotency-Key'));
    const result = await requestRunCloseoutReconciliation({
      runId,
      workspaceId: parsed.data.workspaceId,
      acceptedPreviewHash: parsed.data.acceptedPreviewHash,
      rationale: parsed.data.rationale,
      ownerAuthorization: parsed.data.ownerAuthorization,
      requesterActorId: req.user!.id,
      idempotencyKey,
    });
    res.status(result.replayed ? 200 : 202).json(result);
  } catch (error: unknown) {
    handleRouteError(res, error, '[Recovery] Run closeout reconciliation request');
  }
});

const exactWorkflowQuerySchema = z.object({
  workspaceId: z.string().trim().min(1).max(160),
  specId: z.string().trim().min(1).max(256),
}).strict();
const exactWorkflowReconcileSchema = z.object({
  workspaceId: z.string().trim().min(1).max(160),
  specId: z.string().trim().min(1).max(256),
  applicationJobId: z.string().uuid(),
}).strict();
const queueBackedStageSchema = z.enum(['enrich', 'matchSkills', 'memorySynthesis']);
const exactWorkflowReconciliationResultSchema=z.object({
  schemaVersion:z.literal('rorca.spec-post-save-reconciliation.v1'),outcome:z.enum(['accepted','rejected','no_op']),
  reasonCode:z.string().min(1).max(96),workspaceId:z.string().min(1).max(160),specId:z.string().min(1).max(256),
  workflowRunId:z.number().int().positive(),stageKey:queueBackedStageSchema,applicationJobId:z.string().uuid(),bossJobId:z.string().uuid().nullable(),
  beforeStatus:z.enum(['pending','queued','running','completed','failed','skipped']).nullable(),afterStatus:z.enum(['pending','queued','running','completed','failed','skipped']).nullable(),
  applicationJobStatus:z.enum(['pending','running','completed','failed','cancelled','superseded']).nullable(),
  transport:z.object({location:z.enum(['live','archive','missing']),state:z.string().max(32).nullable()}).strict(),auditId:z.number().int().positive().nullable(),
}).strict();

function requireWorkflowReconciliationOperationId(value: unknown): string {
  const raw = typeof value === 'string' ? value : '';
  const operationId = raw.trim();
  if (raw !== operationId || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{7,199}$/.test(operationId)) {
    throw new ValidationError('Idempotency-Key must be 8-200 bounded ASCII characters');
  }
  return operationId;
}

/**
 * @swagger
 * /api/admin/recovery/spec-workflows/v1/{workflowRunId}:
 *   get:
 *     tags: [Admin]
 *     summary: Inspect one exact durable post-save workflow run
 *     operationId: inspectAdminExactSpecPostSaveWorkflowV1
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Exact historical workflow/job identities are operator recovery metadata; the bounded read is local-human-admin only and excluded from MCP."
 *     x-rorca-mcp: false
 *     parameters:
 *       - { in: path, name: workflowRunId, required: true, schema: { type: integer, minimum: 1 } }
 *       - { in: query, name: workspaceId, required: true, schema: { type: string, minLength: 1, maxLength: 160 } }
 *       - { in: query, name: specId, required: true, schema: { type: string, minLength: 1, maxLength: 256 } }
 *     responses:
 *       200:
 *         description: Exact v1 workflow inspection without job payloads or raw errors
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ExactPostSaveWorkflowInspectionV1' } } }
 *       400:
 *         description: Invalid bounded request
 *         content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } }
 *       403:
 *         description: Local human administrator required
 *         content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } }
 *       404:
 *         description: Exact workspace/spec/run tuple not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } }
 */
router.get('/spec-workflows/v1/:workflowRunId', requireCloseoutLocalAdmin, async (req: Request, res: Response) => {
  try {
    const parsed = exactWorkflowQuerySchema.safeParse(req.query);
    const workflowRunId = Number(req.params.workflowRunId);
    if (!parsed.success || !Number.isSafeInteger(workflowRunId) || workflowRunId <= 0) {
      throw new ValidationError('Invalid exact workflow inspection request');
    }
    const result = await inspectExactPostSaveWorkflow({ ...parsed.data, workflowRunId });
    if (!result) throw new NotFoundError('Post-save workflow run', String(workflowRunId));
    res.status(200).json(result);
  } catch (error: unknown) {
    handleRouteError(res, error, '[Recovery] Exact post-save workflow inspection');
  }
});

/**
 * @swagger
 * /api/admin/recovery/spec-workflows/v1/{workflowRunId}/stages/{stageKey}/reconcile:
 *   post:
 *     tags: [Admin]
 *     summary: Reconcile one exact post-save stage from terminal application-job evidence
 *     operationId: reconcileAdminExactSpecPostSaveWorkflowStageV1
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "This is a bounded derived-state correction for one exact application job and workflow stage; local-human-admin, CSRF, and idempotency controls apply and the operation is never MCP-callable."
 *     x-rorca-mcp: false
 *     parameters:
 *       - { in: path, name: workflowRunId, required: true, schema: { type: integer, minimum: 1 } }
 *       - { in: path, name: stageKey, required: true, schema: { type: string, enum: [enrich, matchSkills, memorySynthesis] } }
 *       - { in: header, name: Idempotency-Key, required: true, schema: { type: string, minLength: 8, maxLength: 200 } }
 *       - { in: header, name: X-CSRF-Token, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/ExactPostSaveWorkflowReconciliationRequestV1' }
 *     responses:
 *       200:
 *         description: Accepted terminal settlement or exact idempotent replay
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ExactPostSaveWorkflowReconciliationResultV1' } } }
 *       400:
 *         description: Invalid bounded request
 *         content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } }
 *       403:
 *         description: Local human administrator or CSRF required
 *         content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } }
 *       409:
 *         description: "Exact binding, live work, terminal state, idempotency, or compare-and-set conflict"
 *         content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } }
 */
router.post('/spec-workflows/v1/:workflowRunId/stages/:stageKey/reconcile', requireCloseoutLocalAdmin, async (req: Request, res: Response) => {
  try {
    const parsed = exactWorkflowReconcileSchema.safeParse(req.body);
    const parsedStage = queueBackedStageSchema.safeParse(req.params.stageKey);
    const workflowRunId = Number(req.params.workflowRunId);
    if (!parsed.success || !parsedStage.success || !Number.isSafeInteger(workflowRunId) || workflowRunId <= 0) {
      throw new ValidationError('Invalid exact workflow reconciliation request');
    }
    const operationId = requireWorkflowReconciliationOperationId(req.get('Idempotency-Key'));
    const result = await reconcilePostSaveWorkflowStage({
      ...parsed.data,
      workflowRunId,
      stageKey: parsedStage.data,
      operationId,
      source: 'operator',
      actorId: req.user!.id,
      authorityClass: 'local_human_admin',
    });
    const validatedResult=exactWorkflowReconciliationResultSchema.parse(result);
    if (validatedResult.outcome === 'rejected') {
      throw new ConflictError('Exact post-save workflow reconciliation rejected', {
        reasonCode: validatedResult.reasonCode,
        workflowRunId: validatedResult.workflowRunId,
        stageKey: validatedResult.stageKey,
        auditId: validatedResult.auditId,
      });
    }
    res.status(200).json(validatedResult);
  } catch (error: unknown) {
    handleRouteError(res, error, '[Recovery] Exact post-save workflow reconciliation');
  }
});

export default router;
