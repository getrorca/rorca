/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, type Request, type Response } from 'express';
import { isSuperUser } from '../lib/auth-utils';
import { ForbiddenError, ValidationError } from '../lib/errors';
import {
  getPtyOperationsHealth,
  runPtyRetention,
  simulatePtyLegacyRollback,
} from '../lib/pty-operations';
import {
  PTY_OPERATIONS_HEALTH_TOPIC,
  publishPtyOperationsHealthEvent,
} from '../lib/pty-operational-telemetry';
import { attachTopicSSE } from '../lib/sse-hub';

const router = Router();

function assertOperator(req: Request): void {
  if (!isSuperUser(req.user)) throw new ForbiddenError('PTY operations require local operator admin access');
}

/**
 * @swagger
 * /api/pty-operations/health:
 *   get:
 *     tags: [Health]
 *     summary: Inspect bounded PTY recovery health and storage telemetry
 *     operationId: getPtyOperationsHealth
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Operational PTY integrity, retention, and rollout diagnostics are local operator-only and never MCP-callable."
 *     responses:
 *       200: { description: Content-free bounded PTY operational health }
 */
router.get('/health', async (req: Request, res: Response) => {
  assertOperator(req);
  res.json(await getPtyOperationsHealth());
});

/**
 * @swagger
 * /api/pty-operations/health/stream:
 *   get:
 *     tags: [Health]
 *     summary: Stream bounded PTY recovery health events through the SSE hub
 *     operationId: streamPtyOperationsHealth
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Live PTY retention and integrity diagnostics are operator-only and exclude terminal content, paths, prompts, and generation credentials."
 *     responses:
 *       200: { description: SSE health and byte-accounting events }
 */
router.get('/health/stream', async (req: Request, res: Response) => {
  assertOperator(req);
  const health = await getPtyOperationsHealth();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const detach = attachTopicSSE(PTY_OPERATIONS_HEALTH_TOPIC, res, 'pty_operations_health');
  req.once('close', detach);
  publishPtyOperationsHealthEvent({ event: 'health', ...health });
});

/**
 * @swagger
 * /api/pty-operations/retention:
 *   post:
 *     tags: [Health]
 *     summary: Dry-run or execute independent PTY artifact retention
 *     operationId: runPtyOperationsRetention
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Retention mutates restricted execution evidence and is available only to the local operator."
 *     responses:
 *       200: { description: Per-artifact retention counts and effective policy }
 *       422: { description: PTY recovery schema is unsupported or mutation-blocked }
 */
router.post('/retention', async (req: Request, res: Response) => {
  assertOperator(req);
  const dryRun = req.body?.dryRun ?? true;
  if (typeof dryRun !== 'boolean') throw new ValidationError('dryRun must be a boolean');
  res.json(await runPtyRetention(dryRun));
});

/**
 * @swagger
 * /api/pty-operations/rollback/simulate:
 *   post:
 *     tags: [Health]
 *     summary: Simulate non-destructive rollback to legacy terminal replay
 *     operationId: simulatePtyLegacyRollback
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Rollback evidence and temporary presentation degradation are operator-only diagnostics."
 *     responses:
 *       200: { description: Preserved evidence counts and expected legacy presentation }
 */
router.post('/rollback/simulate', async (req: Request, res: Response) => {
  assertOperator(req);
  res.json(await simulatePtyLegacyRollback());
});

export default router;
