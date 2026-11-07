/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type { AuthorityRequestStatus } from '../db/execution-authority';
import { EXECUTION_AUTHORITY_EVIDENCE_KINDS } from '../db/execution-authority-rollout';
import { AdminRequiredError, ForbiddenError, ValidationError } from '../lib/errors';
import { handleRouteError } from '../lib/async-handler';
import {
  AUTHORITY_APPROVAL_REASON_CODES,
  AUTHORITY_DENIAL_REASON_CODES,
  cancelPolicyAuthorityRequest,
  createPolicyAuthorityRequest,
  decidePolicyAuthorityRequest,
  getPolicyAuthorityRequest,
  getPolicyExecutionReceipt,
  listPolicyAuthorityRequests,
  listPolicyExecutionReceipts,
} from '../lib/execution-authority-policy';
import {
  assertExecutionAuthorityProgramCannotSelfApprove,
  getExecutionAuthorityProfileProjection,
  recordExecutionAuthorityRolloutEvidence,
  transitionExecutionAuthorityProfile,
} from '../lib/execution-authority-rollout';
import { requireLocalOperatorBoundary } from '../lib/local-operator-boundary';
import { parsePaginationParams } from '../lib/paginate';
import {
  assertAuthorityRedactedValue,
  redactAuthorityError,
} from '../lib/authority-redaction';

export const executionAuthorityRouter = Router({ strict: true, caseSensitive: true });

const WorkspaceParamsSchema = z.object({
  workspaceId: z.string().trim().min(1).max(160),
}).strict();
const RequestParamsSchema = WorkspaceParamsSchema.extend({
  requestId: z.string().uuid(),
}).strict();
const ReceiptParamsSchema = WorkspaceParamsSchema.extend({
  receiptId: z.string().uuid(),
}).strict();
const RequestDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const CreateRequestSchema = z.object({
  intentId: z.string().uuid(),
  maximumUses: z.number().int().min(1).max(1000),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();
const CancelRequestSchema = z.object({ requestDigest: RequestDigestSchema }).strict();
const ApproveRequestSchema = z.object({
  requestDigest: RequestDigestSchema,
  reasonCode: z.enum(AUTHORITY_APPROVAL_REASON_CODES),
}).strict();
const DenyRequestSchema = z.object({
  requestDigest: RequestDigestSchema,
  reasonCode: z.enum(AUTHORITY_DENIAL_REASON_CODES),
}).strict();
const RequestStatusSchema = z.enum(['pending', 'approved', 'denied', 'cancelled', 'expired']);
const IdempotencyKeySchema = z.string().min(1).max(512);
const RolloutEvidenceSchema = z.object({
  evidenceKind: z.enum(EXECUTION_AUTHORITY_EVIDENCE_KINDS),
  result: z.enum(['passed', 'failed']),
  artifactReference: z.string().trim().min(1).max(2048).regex(/^[a-z][a-z0-9+.-]*:\/\/\S+$/),
  evidenceDigest: RequestDigestSchema,
  observedAt: z.string().datetime({ offset: true }),
}).strict();
const ProfileTransitionSchema = z.object({
  enabled: z.boolean(),
  expectedGeneration: z.number().int().positive(),
}).strict();

function parseInput<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError(`Invalid Execution Authority ${label}`, {
      fields: parsed.error.issues.map((issue) => issue.path.join('.') || label),
    });
  }
  assertAuthorityRedactedValue(parsed.data);
  return parsed.data;
}

function requireAuthorityAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') {
    next(new AdminRequiredError('Execution Authority inspection requires a local administrator'));
    return;
  }
  if (req.authSource === 'internal'
    || req.user.id === 'system'
    || req.user.email?.toLowerCase().endsWith('@rorca.internal') === true) {
    next(new ForbiddenError('Execution principals cannot access the operator authority resource'));
    return;
  }
  next();
}

function idempotencyKey(req: Request): string {
  return parseInput(IdempotencyKeySchema, req.header('Idempotency-Key'), 'Idempotency-Key header');
}

function operatorPrincipal(req: Request): string {
  const id = req.user?.id;
  if (!id || id.length > 256) throw new ForbiddenError('A bounded local operator principal is required');
  return `${req.authSource === 'bearer' ? 'operator' : 'local-operator'}:${id}`;
}
function sendAuthorityJson(res: Response, value: unknown, status = 200): void {
  assertAuthorityRedactedValue(value);
  res.status(status).json(value);
}


function authorityRoute(
  label: string,
  handler: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      handleRouteError(res, redactAuthorityError(error), `[Execution Authority] ${label}`);
    }
  };
}

executionAuthorityRouter.use(requireAuthorityAdmin);

/**
 * @swagger
 * /api/admin/execution-authority/workspaces/{workspaceId}/profile:
 *   get:
 *     operationId: getExecutionAuthorityProfile
 *     summary: Inspect one workspace Execution Authority rollout profile
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Capability rollout state and validation evidence are operator-only security posture and never MCP-exposed."
 *     x-rorca-mcp: false
 *     parameters:
 *       - { in: path, name: workspaceId, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Typed profile, evidence readiness, and zero mutation-provider registration }
 *       404: { description: Workspace profile not found }
 *   put:
 *     operationId: transitionExecutionAuthorityProfile
 *     summary: Enable or disable one workspace Execution Authority profile
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Changing provider-effect authority is a local operator mutation, requires exact generation fencing, and is denied to MCP."
 *     x-rorca-mcp: false
 *     parameters:
 *       - { in: path, name: workspaceId, required: true, schema: { type: string } }
 *       - { in: header, name: X-Rorca-Operator-Capability, required: true, schema: { type: string, writeOnly: true } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [enabled, expectedGeneration]
 *             properties:
 *               enabled: { type: boolean }
 *               expectedGeneration: { type: integer, minimum: 1 }
 *     responses:
 *       200: { description: Transitioned profile and disable reconciliation counts }
 *       409: { description: Stale profile generation }
 *       422: { description: Enablement evidence is incomplete }
 */
executionAuthorityRouter.get('/workspaces/:workspaceId/profile', authorityRoute(
  'get rollout profile',
  async (req: Request, res: Response) => {
    const params = parseInput(WorkspaceParamsSchema, req.params, 'workspace path');
    sendAuthorityJson(res, await getExecutionAuthorityProfileProjection(params.workspaceId));
  },
));
executionAuthorityRouter.put(
  '/workspaces/:workspaceId/profile',
  requireLocalOperatorBoundary,
  authorityRoute('transition rollout profile', async (req: Request, res: Response) => {
    const params = parseInput(WorkspaceParamsSchema, req.params, 'workspace path');
    const body = parseInput(ProfileTransitionSchema, req.body, 'profile transition body');
    sendAuthorityJson(res, await transitionExecutionAuthorityProfile({
      workspaceId: params.workspaceId,
      enabled: body.enabled,
      expectedGeneration: body.expectedGeneration,
      operatorPrincipal: operatorPrincipal(req),
    }));
  }),
);

/**
 * @swagger
 * /api/admin/execution-authority/workspaces/{workspaceId}/profile/evidence:
 *   post:
 *     operationId: attachExecutionAuthorityRolloutEvidence
 *     summary: Attach append-only rollout evidence to one disabled workspace profile
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Release evidence controls activation of provider-effect authority, so only the explicit local operator capability may append it and MCP is denied."
 *     x-rorca-mcp: false
 *     parameters:
 *       - { in: path, name: workspaceId, required: true, schema: { type: string } }
 *       - { in: header, name: Idempotency-Key, required: true, schema: { type: string, minLength: 1, maxLength: 512 } }
 *       - { in: header, name: X-Rorca-Operator-Capability, required: true, schema: { type: string, writeOnly: true } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [evidenceKind, result, artifactReference, evidenceDigest, observedAt]
 *             properties:
 *               evidenceKind: { type: string, enum: [migration, api, ui, crash_recovery, redaction, disposable_fixture_smoke] }
 *               result: { type: string, enum: [passed, failed] }
 *               artifactReference: { type: string, maxLength: 2048 }
 *               evidenceDigest: { type: string, pattern: '^sha256:[0-9a-f]{64}$' }
 *               observedAt: { type: string, format: date-time }
 *     responses:
 *       201: { description: Updated profile with append-only evidence readiness }
 *       409: { description: Idempotency key reused for different evidence }
 */
executionAuthorityRouter.post(
  '/workspaces/:workspaceId/profile/evidence',
  requireLocalOperatorBoundary,
  authorityRoute('attach rollout evidence', async (req: Request, res: Response) => {
    const params = parseInput(WorkspaceParamsSchema, req.params, 'workspace path');
    const body = parseInput(RolloutEvidenceSchema, req.body, 'rollout evidence body');
    sendAuthorityJson(res, await recordExecutionAuthorityRolloutEvidence({
      workspaceId: params.workspaceId,
      evidenceKind: body.evidenceKind,
      result: body.result,
      artifactReference: body.artifactReference,
      evidenceDigest: body.evidenceDigest,
      observedAt: new Date(body.observedAt),
      operatorPrincipal: operatorPrincipal(req),
      idempotencyKey: idempotencyKey(req),
    }), 201);
  }),
);

/**
 * @swagger
 * /api/admin/execution-authority/workspaces/{workspaceId}/requests:
 *   post:
 *     operationId: createExecutionAuthorityRequest
 *     summary: Create an exact authority request for a proposed operation intent
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Creating a durable privileged-operation approval request is an operator-controlled mutation and must never be MCP-exposed."
 *     x-rorca-mcp: false
 *     parameters:
 *       - { in: path, name: workspaceId, required: true, schema: { type: string } }
 *       - { in: header, name: Idempotency-Key, required: true, schema: { type: string, minLength: 1, maxLength: 512 } }
 *       - { in: header, name: X-Rorca-Operator-Capability, required: true, schema: { type: string, writeOnly: true } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/AuthorityRequestCreateV1' }
 *     responses:
 *       201:
 *         description: Exact authority request created
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AuthorityRequestProjectionV1' }
 *       400: { description: Invalid request }
 *       403: { description: Local operator authority required }
 *       409:
 *         description: Conflicting or replayed request
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AuthorityFailureV1' }
 *   get:
 *     operationId: listExecutionAuthorityRequests
 *     summary: List authority requests in one workspace
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Authority request scope and decision state are operator-only audit data and are excluded from MCP."
 *     x-rorca-mcp: false
 *     parameters:
 *       - { in: path, name: workspaceId, required: true, schema: { type: string } }
 *       - { in: query, name: status, schema: { type: string, enum: [pending, approved, denied, cancelled, expired] } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 250 } }
 *       - { in: query, name: offset, schema: { type: integer, minimum: 0 } }
 *       - { in: query, name: cursor, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Paginated typed authority requests
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - { $ref: '#/components/schemas/PaginatedProjectionV1' }
 *                 - type: object
 *                   properties:
 *                     items: { type: array, items: { $ref: '#/components/schemas/AuthorityRequestProjectionV1' } }
 */
executionAuthorityRouter.post(
  '/workspaces/:workspaceId/requests',
  requireLocalOperatorBoundary,
  authorityRoute('create request', async (req: Request, res: Response) => {
    const params = parseInput(WorkspaceParamsSchema, req.params, 'workspace path');
    const body = parseInput(CreateRequestSchema, req.body, 'request body');
    const request = await createPolicyAuthorityRequest({
      workspaceId: params.workspaceId,
      intentId: body.intentId,
      maximumUses: body.maximumUses,
      expiresAt: new Date(body.expiresAt),
      idempotencyKey: idempotencyKey(req),
    });
    sendAuthorityJson(res, request, 201);
  }),
);
executionAuthorityRouter.get('/workspaces/:workspaceId/requests', authorityRoute(
  'list requests',
  async (req: Request, res: Response) => {
    const params = parseInput(WorkspaceParamsSchema, req.params, 'workspace path');
    const status = req.query.status === undefined
      ? undefined
      : parseInput(RequestStatusSchema, req.query.status, 'status query');
    const requests = await listPolicyAuthorityRequests({
      workspaceId: params.workspaceId,
      status: status as AuthorityRequestStatus | undefined,
      pagination: parsePaginationParams(req),
    });
    sendAuthorityJson(res, requests);
  },
));

/**
 * @swagger
 * /api/admin/execution-authority/workspaces/{workspaceId}/requests/{requestId}:
 *   get:
 *     operationId: getExecutionAuthorityRequest
 *     summary: Read an exact request with its typed decision and grant
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Exact request, decision, and grant scope is sensitive local operator audit state and is never MCP-exposed."
 *     x-rorca-mcp: false
 *     parameters:
 *       - { in: path, name: workspaceId, required: true, schema: { type: string } }
 *       - { in: path, name: requestId, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200:
 *         description: Typed authority request detail
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AuthorityRequestDetailProjectionV1' }
 *       404: { description: Request not found }
 */
executionAuthorityRouter.get('/workspaces/:workspaceId/requests/:requestId', authorityRoute(
  'get request',
  async (req: Request, res: Response) => {
    const params = parseInput(RequestParamsSchema, req.params, 'request path');
    sendAuthorityJson(res, await getPolicyAuthorityRequest(params.workspaceId, params.requestId));
  },
));

/**
 * @swagger
 * /api/admin/execution-authority/workspaces/{workspaceId}/requests/{requestId}/cancel:
 *   post:
 *     operationId: cancelExecutionAuthorityRequest
 *     summary: Cancel the current exact pending authority request
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Cancellation changes durable execution authority state and requires explicit local operator capability outside MCP."
 *     x-rorca-mcp: false
 *     parameters:
 *       - { in: path, name: workspaceId, required: true, schema: { type: string } }
 *       - { in: path, name: requestId, required: true, schema: { type: string, format: uuid } }
 *       - { in: header, name: X-Rorca-Operator-Capability, required: true, schema: { type: string, writeOnly: true } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/AuthorityDigestMutationV1' }
 *     responses:
 *       200:
 *         description: Cancelled typed request
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AuthorityRequestProjectionV1' }
 *       409:
 *         description: Altered or terminal request
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AuthorityFailureV1' }
 */
executionAuthorityRouter.post(
  '/workspaces/:workspaceId/requests/:requestId/cancel',
  requireLocalOperatorBoundary,
  authorityRoute('cancel request', async (req: Request, res: Response) => {
    const params = parseInput(RequestParamsSchema, req.params, 'request path');
    const body = parseInput(CancelRequestSchema, req.body, 'cancel body');
    sendAuthorityJson(res, await cancelPolicyAuthorityRequest({
      workspaceId: params.workspaceId,
      requestId: params.requestId,
      requestDigest: body.requestDigest,
    }));
  }),
);

/**
 * @swagger
 * /api/admin/execution-authority/workspaces/{workspaceId}/requests/{requestId}/approve:
 *   post:
 *     operationId: approveExecutionAuthorityRequest
 *     summary: Approve the current exact request digest and issue a scoped grant
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Approval mints bounded privileged-operation authority, so only the explicit local operator capability may invoke it and MCP is denied."
 *     x-rorca-mcp: false
 *     parameters:
 *       - { in: path, name: workspaceId, required: true, schema: { type: string } }
 *       - { in: path, name: requestId, required: true, schema: { type: string, format: uuid } }
 *       - { in: header, name: Idempotency-Key, required: true, schema: { type: string, minLength: 1, maxLength: 512 } }
 *       - { in: header, name: X-Rorca-Operator-Capability, required: true, schema: { type: string, writeOnly: true } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/AuthorityApproveMutationV1' }
 *     responses:
 *       200:
 *         description: Typed decision and exact bounded grant
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AuthorityDecisionResultProjectionV1' }
 *       409:
 *         description: Denied, cancelled, altered, replayed, or stale request
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AuthorityFailureV1' }
 *       410:
 *         description: Expired request
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AuthorityFailureV1' }
 */
executionAuthorityRouter.post(
  '/workspaces/:workspaceId/requests/:requestId/approve',
  requireLocalOperatorBoundary,
  authorityRoute('approve request', async (req: Request, res: Response) => {
    const params = parseInput(RequestParamsSchema, req.params, 'request path');
    const body = parseInput(ApproveRequestSchema, req.body, 'approve body');
    const current = await getPolicyAuthorityRequest(params.workspaceId, params.requestId);
    assertExecutionAuthorityProgramCannotSelfApprove(current.request.storyId);
    sendAuthorityJson(res, await decidePolicyAuthorityRequest({
      workspaceId: params.workspaceId,
      requestId: params.requestId,
      requestDigest: body.requestDigest,
      operatorPrincipal: operatorPrincipal(req),
      decision: 'approved',
      reasonCode: body.reasonCode,
      idempotencyKey: idempotencyKey(req),
    }));
  }),
);

/**
 * @swagger
 * /api/admin/execution-authority/workspaces/{workspaceId}/requests/{requestId}/deny:
 *   post:
 *     operationId: denyExecutionAuthorityRequest
 *     summary: Deny the current exact request digest
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Denial permanently resolves a privileged-operation request and is restricted to the explicit local operator capability outside MCP."
 *     x-rorca-mcp: false
 *     parameters:
 *       - { in: path, name: workspaceId, required: true, schema: { type: string } }
 *       - { in: path, name: requestId, required: true, schema: { type: string, format: uuid } }
 *       - { in: header, name: Idempotency-Key, required: true, schema: { type: string, minLength: 1, maxLength: 512 } }
 *       - { in: header, name: X-Rorca-Operator-Capability, required: true, schema: { type: string, writeOnly: true } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/AuthorityDenyMutationV1' }
 *     responses:
 *       200:
 *         description: Typed denial with no grant
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AuthorityDecisionResultProjectionV1' }
 *       409:
 *         description: Altered or terminal request
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AuthorityFailureV1' }
 */
executionAuthorityRouter.post(
  '/workspaces/:workspaceId/requests/:requestId/deny',
  requireLocalOperatorBoundary,
  authorityRoute('deny request', async (req: Request, res: Response) => {
    const params = parseInput(RequestParamsSchema, req.params, 'request path');
    const body = parseInput(DenyRequestSchema, req.body, 'deny body');
    sendAuthorityJson(res, await decidePolicyAuthorityRequest({
      workspaceId: params.workspaceId,
      requestId: params.requestId,
      requestDigest: body.requestDigest,
      operatorPrincipal: operatorPrincipal(req),
      decision: 'denied',
      reasonCode: body.reasonCode,
      idempotencyKey: idempotencyKey(req),
    }));
  }),
);

/**
 * @swagger
 * /api/admin/execution-authority/workspaces/{workspaceId}/receipts:
 *   get:
 *     operationId: listExecutionAuthorityReceipts
 *     summary: List redacted settled execution receipts
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Execution receipts are redacted but remain sensitive operator audit evidence and are excluded from MCP."
 *     x-rorca-mcp: false
 *     parameters:
 *       - { in: path, name: workspaceId, required: true, schema: { type: string } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 250 } }
 *       - { in: query, name: offset, schema: { type: integer, minimum: 0 } }
 *       - { in: query, name: cursor, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Paginated redacted receipt projections
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - { $ref: '#/components/schemas/PaginatedProjectionV1' }
 *                 - type: object
 *                   properties:
 *                     items: { type: array, items: { $ref: '#/components/schemas/ExecutionReceiptProjectionV1' } }
 */
executionAuthorityRouter.get('/workspaces/:workspaceId/receipts', authorityRoute(
  'list receipts',
  async (req: Request, res: Response) => {
    const params = parseInput(WorkspaceParamsSchema, req.params, 'workspace path');
    sendAuthorityJson(res, await listPolicyExecutionReceipts({
      workspaceId: params.workspaceId,
      pagination: parsePaginationParams(req),
    }));
  },
));

/**
 * @swagger
 * /api/admin/execution-authority/workspaces/{workspaceId}/receipts/{receiptId}:
 *   get:
 *     operationId: getExecutionAuthorityReceipt
 *     summary: Inspect one redacted settled execution receipt
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Exact redacted provider outcome evidence is restricted to the local operator and never exposed through MCP."
 *     x-rorca-mcp: false
 *     parameters:
 *       - { in: path, name: workspaceId, required: true, schema: { type: string } }
 *       - { in: path, name: receiptId, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200:
 *         description: Redacted typed execution receipt
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ExecutionReceiptProjectionV1' }
 *       404: { description: Receipt not found }
 */
executionAuthorityRouter.get('/workspaces/:workspaceId/receipts/:receiptId', authorityRoute(
  'get receipt',
  async (req: Request, res: Response) => {
    const params = parseInput(ReceiptParamsSchema, req.params, 'receipt path');
    sendAuthorityJson(res, await getPolicyExecutionReceipt(params.workspaceId, params.receiptId));
  },
));

export default executionAuthorityRouter;
