/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { ValidationError } from '../lib/errors';
import { listGitReinsEvidence } from '../lib/gitreins-evidence-store';

const router = Router();

function optionalInteger(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new ValidationError(`${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ValidationError(`${name} must be between ${min} and ${max}`);
  }
  return parsed;
}

/**
 * @swagger
 * /api/gitreins/evidence:
 *   get:
 *     tags: [GitReins]
 *     summary: List append-only GitReins execution-gate evidence
 *     operationId: listGitReinsEvidence
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only, workspace-scoped, bounded and redacted quality-gate evidence is safe for stable local CLI and MCP inspection. Writes remain internal to the execution engine."
 *     x-rorca-public-api: true
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string, maxLength: 256 }
 *       - in: query
 *         name: runId
 *         required: false
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: storyId
 *         required: false
 *         schema: { type: string, maxLength: 128 }
 *       - in: query
 *         name: limit
 *         required: false
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *       - in: query
 *         name: offset
 *         required: false
 *         schema: { type: integer, minimum: 0, maximum: 100000, default: 0 }
 *     responses:
 *       200:
 *         description: Paginated GitReins evidence, newest first
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [items, total, limit, offset]
 *               properties:
 *                 items:
 *                   type: array
 *                   maxItems: 100
 *                   items:
 *                     type: object
 *                 total: { type: integer, minimum: 0 }
 *                 limit: { type: integer, minimum: 1, maximum: 100 }
 *                 offset: { type: integer, minimum: 0 }
 *       400:
 *         description: Invalid query parameters
 */
router.get('/evidence', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId.trim() : '';
    if (!workspaceId || workspaceId.length > 256) {
      throw new ValidationError('workspaceId is required and must be at most 256 characters');
    }
    const storyId = typeof req.query.storyId === 'string' ? req.query.storyId.trim() : undefined;
    if (storyId !== undefined && (!storyId || storyId.length > 128)) {
      throw new ValidationError('storyId must be between 1 and 128 characters');
    }
    const result = await listGitReinsEvidence({
      workspaceId,
      runId: optionalInteger(req.query.runId, 'runId', 1, Number.MAX_SAFE_INTEGER),
      storyId,
      limit: optionalInteger(req.query.limit, 'limit', 1, 100),
      offset: optionalInteger(req.query.offset, 'offset', 0, 100_000),
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
