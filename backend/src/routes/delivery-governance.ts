/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, type Request } from 'express';
import { requireWorkspaceAdmin } from '../lib/auth-utils';
import { AuthError, ValidationError } from '../lib/errors';
import { requireLifecycleIdempotencyKey } from '../lib/lifecycle-mutations';
import {
  activateAutonomousDeliveryPolicy,
  AUTONOMOUS_DELIVERY_ACTIVATION_CONFIRMATION,
  createAutonomousDeliveryPolicy,
  listAutonomousDeliveryPolicies,
  revokeAutonomousDeliveryPolicy,
  type AutonomousDeliveryPolicyDraft,
  type DeliveryPolicyPrincipal,
} from '../lib/autonomous-delivery-policy';
import {
  listGithubPrDeliveryEvidence,
  observeGithubPrDeliveryEvidence,
  type DeliveryEvidencePrincipal,
} from '../lib/github-pr-delivery-evidence';
import { parsePaginationParams } from '../lib/paginate';
import {
  listAutonomousPrDeliveries,
  queueAutonomousPrDeliveryForRun,
} from '../lib/autonomous-pr-delivery';

const router = Router();

const FORBIDDEN_AUTHORITY_FIELDS = [
  'actor', 'actorId', 'principal', 'principalId', 'authority', 'role',
  'deploy', 'deploymentAllowed', 'deploymentsAllowed', 'productionApproval',
] as const;

function bodyObject(req: Request): Record<string, unknown> {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    throw new ValidationError('Request body must be an object');
  }
  return req.body as Record<string, unknown>;
}

function rejectAuthorityClaims(body: Record<string, unknown>): void {
  const field = FORBIDDEN_AUTHORITY_FIELDS.find((name) => body[name] !== undefined);
  if (field) throw new ValidationError(`Request-body authority field '${field}' is not accepted`, { field });
}

function principal(req: Request): DeliveryPolicyPrincipal & DeliveryEvidencePrincipal {
  if (!req.user) throw new AuthError();
  return { principalId: req.user.id, displayLabel: req.user.email };
}

function requestId(req: Request): string {
  return requireLifecycleIdempotencyKey(req.get('Idempotency-Key'));
}

/**
 * @swagger
 * /api/workspaces/{id}/github/delivery-policies:
 *   get:
 *     tags: [GitHub]
 *     summary: List standing autonomous PR delivery policies
 *     operationId: listAutonomousDeliveryPolicies
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Autonomous delivery policy exposes operator-owned release authority and is intentionally excluded from MCP and public automation."
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *       - in: query
 *         name: cursor
 *         schema: { type: string }
 *     responses:
 *       200: { description: Active policy and paginated immutable policy history }
 */
router.get('/:id/github/delivery-policies', requireWorkspaceAdmin(), async (req, res, next) => {
  try {
    principal(req);
    const pagination = parsePaginationParams(req, { limit: 50, maxLimit: 100 });
    res.json(await listAutonomousDeliveryPolicies(String(req.params.id), pagination));
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/workspaces/{id}/github/delivery-policies:
 *   post:
 *     tags: [GitHub]
 *     summary: Draft a disabled standing autonomous PR delivery policy
 *     operationId: createAutonomousDeliveryPolicy
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Creating release policy is an operator-only mutation; drafts are disabled and cannot grant deployment authority."
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: header
 *         name: Idempotency-Key
 *         required: true
 *         schema: { type: string, minLength: 8, maxLength: 200 }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [baseBranch, allowedRiskLevels, requiredChecks, reviewRules, mergeMethod, retryBudget, expiresAt]
 *     responses:
 *       201: { description: Disabled immutable policy draft created }
 *       200: { description: Exact idempotent replay returned }
 *       400: { description: Invalid or unsafe policy }
 *       409: { description: Idempotency or immutable policy conflict }
 */
router.post('/:id/github/delivery-policies', requireWorkspaceAdmin(), async (req, res, next) => {
  try {
    const body = bodyObject(req);
    rejectAuthorityClaims(body);
    const result = await createAutonomousDeliveryPolicy({
      workspaceId: String(req.params.id),
      draft: body as unknown as AutonomousDeliveryPolicyDraft,
      principal: principal(req),
      sourceRequestId: requestId(req),
    });
    res.status(result.replayed ? 200 : 201).json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/workspaces/{id}/github/delivery-policies/{policyId}/activate:
 *   post:
 *     tags: [GitHub]
 *     summary: Activate an exact reviewed autonomous PR delivery policy
 *     operationId: activateAutonomousDeliveryPolicy
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Activation is the explicit operator-owned autonomy switch and is excluded from MCP/public surfaces."
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: policyId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: header
 *         name: Idempotency-Key
 *         required: true
 *         schema: { type: string, minLength: 8, maxLength: 200 }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [expectedPolicyDigest, confirmation]
 *             properties:
 *               expectedPolicyDigest: { type: string }
 *               confirmation: { type: string, enum: [ENABLE_AUTONOMOUS_PR_DELIVERY] }
 *     responses:
 *       200: { description: Exact policy activated or activation replayed }
 *       400: { description: Missing explicit confirmation }
 *       409: { description: Policy digest/state conflict }
 *       422: { description: Policy expired }
 */
router.post('/:id/github/delivery-policies/:policyId/activate', requireWorkspaceAdmin(), async (req, res, next) => {
  try {
    const body = bodyObject(req);
    rejectAuthorityClaims(body);
    const expectedPolicyDigest = typeof body.expectedPolicyDigest === 'string' ? body.expectedPolicyDigest : '';
    const confirmation = typeof body.confirmation === 'string' ? body.confirmation : '';
    if (!expectedPolicyDigest) throw new ValidationError('expectedPolicyDigest is required');
    if (confirmation !== AUTONOMOUS_DELIVERY_ACTIVATION_CONFIRMATION) {
      throw new ValidationError(`confirmation must equal ${AUTONOMOUS_DELIVERY_ACTIVATION_CONFIRMATION}`);
    }
    res.json(await activateAutonomousDeliveryPolicy({
      workspaceId: String(req.params.id),
      policyId: String(req.params.policyId),
      expectedPolicyDigest,
      confirmation,
      principal: principal(req),
      sourceRequestId: requestId(req),
    }));
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/workspaces/{id}/github/delivery-policies/{policyId}/revoke:
 *   post:
 *     tags: [GitHub]
 *     summary: Revoke a standing autonomous PR delivery policy
 *     operationId: revokeAutonomousDeliveryPolicy
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Revocation is an operator-only fail-safe that permanently removes standing merge authority."
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: policyId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: header
 *         name: Idempotency-Key
 *         required: true
 *         schema: { type: string, minLength: 8, maxLength: 200 }
 *     responses:
 *       200: { description: Policy revoked or exact revocation replayed }
 *       400: { description: Invalid revocation rationale }
 *       409: { description: Policy already revoked by another request }
 */
router.post('/:id/github/delivery-policies/:policyId/revoke', requireWorkspaceAdmin(), async (req, res, next) => {
  try {
    const body = bodyObject(req);
    rejectAuthorityClaims(body);
    res.json(await revokeAutonomousDeliveryPolicy({
      workspaceId: String(req.params.id),
      policyId: String(req.params.policyId),
      reason: typeof body.reason === 'string' ? body.reason : '',
      principal: principal(req),
      sourceRequestId: requestId(req),
    }));
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/workspaces/{id}/github/delivery-evidence:
 *   post:
 *     tags: [GitHub]
 *     summary: Observe exact-SHA GitHub PR checks, reviews, mergeability, and freshness
 *     operationId: observeGithubPrDeliveryEvidence
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Provider observation writes immutable release evidence and must remain an operator-only, non-MCP action."
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [runId, expectedHeadSha]
 *             properties:
 *               runId: { type: integer }
 *               expectedHeadSha: { type: string, minLength: 40, maxLength: 64 }
 *     responses:
 *       201: { description: New immutable provider evidence observed }
 *       200: { description: Exact provider snapshot replayed }
 *       409: { description: Repository, branch, PR, or head SHA changed }
 *       422: { description: Canonical PR binding or workspace GitHub credential unavailable }
 */
router.post('/:id/github/delivery-evidence', requireWorkspaceAdmin(), async (req, res, next) => {
  try {
    const body = bodyObject(req);
    rejectAuthorityClaims(body);
    const result = await observeGithubPrDeliveryEvidence({
      workspaceId: String(req.params.id),
      runId: Number(body.runId),
      expectedHeadSha: typeof body.expectedHeadSha === 'string' ? body.expectedHeadSha : '',
      principal: principal(req),
    });
    res.status(result.replayed ? 200 : 201).json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/workspaces/{id}/github/delivery-evidence:
 *   get:
 *     tags: [GitHub]
 *     summary: List immutable exact-SHA GitHub PR delivery evidence
 *     operationId: listGithubPrDeliveryEvidence
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "PR review/check evidence is release-governance metadata and intentionally remains operator-only."
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: runId
 *         schema: { type: integer }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *       - in: query
 *         name: cursor
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *     responses:
 *       200: { description: Bounded immutable provider evidence list }
 */
router.get('/:id/github/delivery-evidence', requireWorkspaceAdmin(), async (req, res, next) => {
  try {
    principal(req);
    const runId = typeof req.query.runId === 'string' ? Number(req.query.runId) : undefined;
    const pagination = parsePaginationParams(req, { limit: 50, maxLimit: 100 });
    res.json(await listGithubPrDeliveryEvidence({
      workspaceId: String(req.params.id),
      runId,
      pagination,
    }));
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/workspaces/{id}/github/autonomous-deliveries:
 *   post:
 *     tags: [GitHub]
 *     summary: Queue the existing worker to steward one policy-governed reviewed PR
 *     operationId: queueAutonomousPrDelivery
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Reviewed PR delivery may ultimately merge code and is restricted to workspace administrators outside MCP/public automation."
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: header
 *         name: Idempotency-Key
 *         required: true
 *         schema: { type: string, minLength: 8, maxLength: 200 }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [runId]
 *             properties:
 *               runId: { type: integer }
 *     responses:
 *       202: { description: Existing worker queue accepted the reviewed delivery }
 *       200: { description: Run is ineligible or an exact delivery already exists }
 *       409: { description: Existing immutable delivery policy or run binding conflicts }
 */
router.post('/:id/github/autonomous-deliveries', requireWorkspaceAdmin(), async (req, res, next) => {
  try {
    const body = bodyObject(req);
    rejectAuthorityClaims(body);
    principal(req);
    const result = await queueAutonomousPrDeliveryForRun({
      workspaceId: String(req.params.id),
      runId: Number(body.runId),
      sourceRequestId: requestId(req),
    });
    res.status(result.queued ? 202 : 200).json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/workspaces/{id}/github/autonomous-deliveries:
 *   get:
 *     tags: [GitHub]
 *     summary: List bounded autonomous reviewed-PR delivery state
 *     operationId: listAutonomousPrDeliveries
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Delivery authority, recovery, review, and merged-SHA state is operator-only release metadata."
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *       - in: query
 *         name: cursor
 *         schema: { type: string }
 *     responses:
 *       200: { description: Paginated reviewed-delivery state }
 */
router.get('/:id/github/autonomous-deliveries', requireWorkspaceAdmin(), async (req, res, next) => {
  try {
    principal(req);
    const pagination = parsePaginationParams(req, { limit: 50, maxLimit: 100 });
    res.json(await listAutonomousPrDeliveries(String(req.params.id), pagination));
  } catch (error) {
    next(error);
  }
});

export default router;
