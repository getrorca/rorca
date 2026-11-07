/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { handleRouteError } from '../lib/async-handler';
import { persistBountyPackageRoute } from '../lib/bounty-controller';
import { BountyRouteInputSchema } from '../lib/bounty-work-package-router';
import { AdminRequiredError, AuthError, ValidationError } from '../lib/errors';

const router = Router();
const RouteRequestSchema = z.object({
  workspaceId: z.string().trim().min(1).max(128),
  missionId: z.string().uuid(),
  expectedEpoch: z.number().int().positive(),
  routeInput: BountyRouteInputSchema,
}).strict();

function requireAuthenticatedBountyAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') {
    next(new AdminRequiredError());
    return;
  }
  if (req.authSource !== 'bearer') {
    next(new AuthError('Credential-authenticated admin required for bounty work package creation'));
    return;
  }
  next();
}

/**
 * @swagger
 * /api/admin/bounty/work-packages:
 *   post:
 *     tags: [Admin]
 *     summary: Deterministically route and persist immutable bounty work packages
 *     operationId: createAdminBountyWorkPackages
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Work-package creation binds mission authority, target effects, model policy, and immutable execution context; it is operator-only and excluded from MCP."
 *     x-rorca-mcp: false
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [workspaceId, missionId, expectedEpoch, routeInput]
 *     responses:
 *       201: { description: Deterministic route and persisted package identities }
 *       200: { description: Idempotent replay of an existing input hash }
 *       400: { description: Strict route input validation failed }
 *       401: { description: Credential-authenticated admin required }
 *       403: { description: Admin access, mission hold, or authority denied }
 *       409: { description: Stale mission epoch }
 *       422: { description: Unsupported phase, evidence, skill, capability, context, or mission state; the immutable blocked decision includes separate reports and telemetry }
 */
router.post('/', requireAuthenticatedBountyAdmin, async (req: Request, res: Response) => {
  try {
    const parsed = RouteRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid bounty work package route request', {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }
    const result = await persistBountyPackageRoute({
      ...parsed.data,
      actor: `${req.user!.id}:${req.user!.email}`,
      purpose: 'route immutable bounty work packages',
    });
    res.status(result.replayed ? 200 : 201).json(result);
  } catch (error: unknown) {
    handleRouteError(res, error, '[Bounty work packages] Route');
  }
});

export default router;
