/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { AdminRequiredError, AuthError, ValidationError } from '../lib/errors';
import { handleRouteError } from '../lib/async-handler';
import { bountyCredentialBroker } from '../lib/bounty-production-services';

const router = Router();
export { bountyCredentialBroker } from '../lib/bounty-production-services';

const issueSchema = z.object({
  workspaceId: z.string().min(1), programId: z.string().uuid(), missionId: z.string().uuid(),
  accountId: z.string().min(1), role: z.string().min(1), origin: z.string().min(1),
  actions: z.array(z.string()).min(1), adapter: z.string().min(1), epoch: z.number().int().positive(),
  expiresAt: z.string().datetime(), material: z.object({
    username: z.string().min(1).optional(), password: z.string().min(1).optional(),
    token: z.string().min(1).optional(), cookies: z.string().min(1).optional(),
  }).strict(),
}).strict();
const handleSchema = z.object({ handle: z.string().startsWith('bch_') }).strict();
const failureSchema = handleSchema.extend({ reason: z.enum(['login', 'captcha', 'refresh-invalidated']) }).strict();

function requireOperator(req: Request, _res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') return next(new AdminRequiredError());
  if (req.authSource !== 'bearer') return next(new AuthError('Credential-authenticated admin required'));
  next();
}

function parsed<T>(result: { success: true; data: T } | { success: false }): T {
  if (!result.success) throw new ValidationError('Invalid credential broker request');
  return result.data;
}

/**
 * @swagger
 * /api/admin/bounty/credentials/handles:
 *   post:
 *     summary: Store operator test-account material and issue an opaque adapter handle
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Credential ingestion is operator-only and handles are never MCP-exposed."
 *     x-rorca-mcp: false
 *     responses:
 *       201: { description: Opaque scope-bound handle; credential material is never returned }
 */
router.post('/handles', requireOperator, async (req, res) => {
  try {
    const input = parsed(issueSchema.safeParse(req.body));
    const { material, ...binding } = input;
    res.status(201).json(await bountyCredentialBroker.issue(binding, material));
  } catch (error) { handleRouteError(res, error, '[Bounty credentials] Issue'); }
});

/**
 * @swagger
 * /api/admin/bounty/credentials/revoke:
 *   post:
 *     summary: Revoke a credential handle, close its partition, and advance its epoch
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Credential revocation is an operator-only emergency control."
 *     x-rorca-mcp: false
 *     responses:
 *       200: { description: New epoch only }
 */
router.post('/revoke', requireOperator, async (req, res) => {
  try { res.json(await bountyCredentialBroker.revoke(parsed(handleSchema.safeParse(req.body)).handle)); }
  catch (error) { handleRouteError(res, error, '[Bounty credentials] Revoke'); }
});

/**
 * @swagger
 * /api/admin/bounty/credentials/failures:
 *   post:
 *     summary: Report authentication failure to the bounded credential circuit breaker
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Circuit-breaker state is operator-only and excludes credential material."
 *     x-rorca-mcp: false
 *     responses:
 *       200: { description: Whether the mission was held }
 */
router.post('/failures', requireOperator, async (req, res) => {
  try {
    const input = parsed(failureSchema.safeParse(req.body));
    res.json(await bountyCredentialBroker.reportFailure(input.handle, input.reason));
  } catch (error) { handleRouteError(res, error, '[Bounty credentials] Failure'); }
});

export default router;
