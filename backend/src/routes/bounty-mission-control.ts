/** Copyright (c) 2026 Rorca Inc. SPDX-License-Identifier: Apache-2.0 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { handleRouteError } from '../lib/async-handler';
import { bountyCallbackBroker } from '../lib/bounty-callback-broker';
import { executeBountyLifecycleCommand } from '../lib/bounty-mission-control';
import { AdminRequiredError, AuthError, ValidationError } from '../lib/errors';
import { bountyCredentialBroker } from './bounty-credentials';

const router = Router();
const ControlRequestSchema = z.object({
  workspaceId: z.string().trim().min(1).max(128),
  expectedEpoch: z.number().int().positive(),
  action: z.enum(['pause', 'resume', 'stop', 'kill']),
  reason: z.string().trim().min(1).max(256),
  idempotencyKey: z.string().trim().min(1).max(256),
}).strict();

function requireOperator(req: Request, _res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') return next(new AdminRequiredError());
  if (req.authSource !== 'bearer') return next(new AuthError('Credential-authenticated admin required for mission control'));
  next();
}

/**
 * @swagger
 * /api/admin/bounty/missions/{missionId}/control:
 *   post:
 *     tags: [Admin]
 *     summary: Pause, resume, stop, or emergency-kill a bounty mission at a durable epoch boundary
 *     operationId: controlAdminBountyMission
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Mission lifecycle control revokes target-effect authority and credentials and can terminate process groups; it is operator-only and never MCP-exposed."
 *     x-rorca-mcp: false
 *     parameters:
 *       - in: path
 *         name: missionId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [workspaceId, expectedEpoch, action, reason, idempotencyKey]
 *     responses:
 *       200: { description: Durable mission-control receipt, including replacement epoch and uncertain effect count }
 *       400: { description: Strict lifecycle input validation failed }
 *       401: { description: Credential-authenticated operator required }
 *       403: { description: Admin authority or safe resume reconciliation requirement failed }
 *       404: { description: Mission not found }
 *       409: { description: Stale mission epoch or conflicting idempotency replay }
 *       422: { description: Illegal or terminal lifecycle transition }
 */
router.post('/:missionId/control', requireOperator, async (req: Request, res: Response) => {
  try {
    const missionId = z.string().uuid().safeParse(req.params.missionId);
    const body = ControlRequestSchema.safeParse(req.body);
    if (!missionId.success || !body.success) throw new ValidationError('Invalid bounty mission control request');
    const receipt = await executeBountyLifecycleCommand({
      ...body.data,
      missionId: missionId.data,
      actor: `${req.user!.id}:${req.user!.email}`,
    }, {
      revokeCredentials: (id, epoch) => bountyCredentialBroker.revokeMission(id, epoch).then(() => undefined),
      revokeCallbacks: (id, epoch) => { bountyCallbackBroker.revokeMission(id, epoch); },
      // Credential revocation closes every browser partition through its broker lifecycle.
      closeBrowserPartitions: async () => undefined,
    });
    res.json(receipt);
  } catch (error: unknown) {
    handleRouteError(res, error, '[Bounty mission control] Control');
  }
});

export default router;
