/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { AdminRequiredError, AuthError, ValidationError } from '../lib/errors';
import { handleRouteError } from '../lib/async-handler';
import { BOUNTY_QUALIFICATION_STATUS } from '../lib/bounty-qualification';
import { BountyReleasePromotionEnvelopeSchema } from '../lib/bounty-release-promotion';
import { admitBountyReleasePromotion } from '../lib/bounty-promotion-store';
import {
  BountyAdminPolicyMutationSchema,
  persistBountyAdminPolicy,
  resolveBountyFeaturePolicy,
} from '../lib/bounty-feature-policy';

const router = Router();

export function requireBountyAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') {
    next(new AdminRequiredError());
    return;
  }
  next();
}

/** Enabling target effects requires a credential-authenticated human admin. */
function requireAuthenticatedAdminMutation(req: Request, _res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') {
    next(new AdminRequiredError());
    return;
  }
  if (req.authSource !== 'bearer') {
    next(new AuthError('Credential-authenticated admin required for bounty policy mutation'));
    return;
  }
  next();
}

/**
 * @swagger
 * /api/admin/bounty/policy:
 *   get:
 *     tags: [Admin]
 *     summary: Read the effective operator-owned bounty feature policy
 *     operationId: getAdminBountyPolicy
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Bounty target-effect policy is operator-only state and is deliberately excluded from MCP and repository configuration."
 *     x-rorca-mcp: false
 *     responses:
 *       200: { description: Effective policy, defaulting to disabled }
 *       403: { description: Admin access required }
 */
router.get('/policy', requireBountyAdmin, async (_req: Request, res: Response) => {
  try {
    res.status(200).json(await resolveBountyFeaturePolicy());
  } catch (error: unknown) {
    handleRouteError(res, error, '[Bounty policy] Read');
  }
});

/**
 * @swagger
 * /api/admin/bounty/qualification:
 *   get:
 *     tags: [Admin]
 *     summary: Read the non-enabling bounty qualification posture
 *     operationId: getAdminBountyQualification
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Qualification state exposes release-safety metadata to the local operator, but exact receipts and feature enablement remain outside MCP and worker authority."
 *     x-rorca-mcp: false
 *     responses:
 *       200: { description: Disabled release posture and required exact requalification counts }
 *       403: { description: Admin access required }
 */
export function readBountyQualification(_req: Request, res: Response): void {
  res.status(200).json(BOUNTY_QUALIFICATION_STATUS);
}
router.get('/qualification', requireBountyAdmin, readBountyQualification);

/**
 * @swagger
 * /api/admin/bounty/promotions:
 *   post:
 *     tags: [Admin]
 *     summary: Admit an exact trusted post-commit bounty release promotion
 *     operationId: admitAdminBountyPromotion
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Release promotion verifies a configured external trust root and exact deployed qualification identities; it is credential-authenticated human-admin-only."
 *     x-rorca-mcp: false
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       201: { description: Trusted immutable promotion admitted }
 *       400: { description: Malformed receipt }
 *       401: { description: Credential-authenticated admin required }
 *       403: { description: Signature or trust root rejected }
 *       409: { description: Checkout or receipt identity mismatch }
 */
router.post('/promotions', requireAuthenticatedAdminMutation, async (req: Request, res: Response) => {
  try {
    const parsed = BountyReleasePromotionEnvelopeSchema.safeParse(req.body?.envelope);
    if (!parsed.success || !req.body?.qualificationReceipt || Object.keys(req.body).some((key) => !['envelope', 'qualificationReceipt'].includes(key))) {
      throw new ValidationError('Invalid bounty release promotion request');
    }
    res.status(201).json(await admitBountyReleasePromotion({
      envelope: parsed.data,
      qualificationReceipt: req.body.qualificationReceipt,
      actor: `${req.user!.id}:${req.user!.email}`,
    }));
  } catch (error: unknown) { handleRouteError(res, error, '[Bounty promotion] Admission'); }
});

/**
 * @swagger
 * /api/admin/bounty/policy:
 *   put:
 *     tags: [Admin]
 *     summary: Replace the persisted bounty feature policy
 *     operationId: putAdminBountyPolicy
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Enabling or disabling bounty target effects is restricted to a credential-authenticated administrator, revisioned, audited, and excluded from MCP."
 *     x-rorca-mcp: false
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [state, missionMode, revision]
 *             properties:
 *               state: { type: string, enum: [disabled, enabled] }
 *               missionMode: { type: string, enum: [bounty] }
 *               revision: { type: integer, minimum: 1 }
 *               promotionReceiptId: { type: string, format: uuid, description: Required only when enabling }
 *     responses:
 *       200: { description: Persisted revision and server-derived audit identity }
 *       400: { description: Invalid or unknown policy field }
 *       401: { description: Credential-authenticated admin required }
 *       403: { description: Admin access required }
 *       409: { description: Revision conflict or deployment-owned policy }
 */
router.put('/policy', requireAuthenticatedAdminMutation, async (req: Request, res: Response) => {
  try {
    const parsed = BountyAdminPolicyMutationSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid bounty feature policy mutation', {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }
    res.status(200).json(await persistBountyAdminPolicy(parsed.data, {
      id: req.user!.id,
      email: req.user!.email,
      role: req.user!.role,
      authSource: req.authSource,
    }));
  } catch (error: unknown) {
    handleRouteError(res, error, '[Bounty policy] Mutation');
  }
});

export default router;
