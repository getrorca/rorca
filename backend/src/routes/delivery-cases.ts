/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { getDeliveryCaseSummary, getRunControlProjection } from '../lib/mission-read-models';

const router = Router({ mergeParams: true });

/**
 * @swagger
 * /api/workspaces/{workspaceId}/delivery-cases/{specId}:
 *   get:
 *     operationId: getDeliveryCaseSummary
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Authenticated users may inspect an exact-revision delivery projection; server-authored links grant no lifecycle or execution mutation authority."
 *     x-rorca-mcp: false
 *     summary: Get an exact delivery case projection with live frozen-source drift state
 *     parameters:
 *       - { in: path, name: workspaceId, required: true, schema: { type: string } }
 *       - { in: path, name: specId, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Strict DeliveryCaseSummaryV1 }
 *       400: { description: Invalid identifier }
 *       404: { description: Workspace or spec not found }
 */
router.get('/:workspaceId/delivery-cases/:specId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await getDeliveryCaseSummary(req.params.workspaceId, req.params.specId));
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/workspaces/{workspaceId}/delivery-cases/{specId}/runs/{runId}/control:
 *   get:
 *     operationId: getDeliveryCaseRunControl
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Authenticated users may inspect bounded semantic run state and server-permitted links; raw terminal logs and client-derived control authority are excluded."
 *     x-rorca-mcp: false
 *     summary: Get a semantic run-control projection
 *     parameters:
 *       - { in: path, name: workspaceId, required: true, schema: { type: string } }
 *       - { in: path, name: specId, required: true, schema: { type: string } }
 *       - { in: path, name: runId, required: true, schema: { type: integer, minimum: 1 } }
 *     responses:
 *       200: { description: Strict RunControlProjectionV1 without raw terminal output }
 *       400: { description: Invalid identifier }
 *       404: { description: Workspace, spec, or run not found }
 */
router.get('/:workspaceId/delivery-cases/:specId/runs/:runId/control', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await getRunControlProjection(req.params.workspaceId, req.params.specId, req.params.runId));
  } catch (error) {
    next(error);
  }
});

export default router;
