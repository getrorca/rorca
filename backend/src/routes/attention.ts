/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { getWorkspaceAttention } from '../lib/mission-read-models';

const router = Router({ mergeParams: true });

/**
 * @swagger
 * /api/workspaces/{workspaceId}/attention:
 *   get:
 *     operationId: getWorkspaceAttention
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Authenticated users may inspect a bounded, workspace-scoped server projection; it exposes no mutation or delegated authority."
 *     x-rorca-mcp: false
 *     summary: List authoritative workspace attention items
 *     parameters:
 *       - { in: path, name: workspaceId, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Deterministically ranked strict ActionEnvelopeV1 items
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [items, generatedAt]
 *               properties:
 *                 items: { type: array, maxItems: 100, items: { type: object } }
 *                 generatedAt: { type: string, format: date-time }
 *       400: { description: Invalid workspace identifier }
 *       404: { description: Workspace not found }
 */
router.get('/:workspaceId/attention', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await getWorkspaceAttention(req.params.workspaceId));
  } catch (error) {
    next(error);
  }
});

export default router;
