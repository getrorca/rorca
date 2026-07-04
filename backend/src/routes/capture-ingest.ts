/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, Request, Response } from 'express';
import { queryOne } from '../db/index';
import { NotFoundError, UnprocessableError, ValidationError } from '../lib/errors';

const router = Router();

/**
 * @swagger
 * /api/workspaces/{workspaceId}/capture/last-rorca-run:
 *   get:
 *     tags: [Context Capture]
 *     summary: Resolve the last completed Rorca run pointer for git ingestion
 *     operationId: getCaptureLastRorcaRunPointer
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only sidecar pointer lookup exposes only the latest completed local run timestamp needed to choose a git range."
 *     x-rorca-public-api: true
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Last completed run pointer }
 *       400: { description: Invalid workspace id }
 *       404: { description: Workspace not found }
 *       422: { description: No completed run pointer exists yet }
 */
router.get('/:workspaceId/capture/last-rorca-run', async (req: Request, res: Response) => {
  const workspaceId = String(req.params.workspaceId ?? '').trim();
  if (!workspaceId) {
    throw new ValidationError('workspaceId is required');
  }

  const workspace = await queryOne<{ id: string }>('SELECT id FROM workspaces WHERE id = $1', [workspaceId]);
  if (!workspace) {
    throw new NotFoundError('Workspace', workspaceId);
  }

  const pointer = await queryOne<{ finishedAt: string | null }>(
    `SELECT MAX(finished_at)::text AS "finishedAt"
       FROM pipeline_runs
      WHERE workspace_id = $1
        AND status = 'completed'`,
    [workspaceId],
  );
  const finishedAt = pointer?.finishedAt ?? null;
  if (!finishedAt) {
    throw new UnprocessableError(
      `No completed Rorca pipeline run found for workspace '${workspaceId}'. Run a pipeline successfully first or pass --since <git-ref>.`,
      'CAPTURE_POINTER_NOT_FOUND',
      { workspaceId },
    );
  }

  res.json({
    workspaceId,
    finishedAt,
    lastCompletedRunFinishedAt: finishedAt,
  });
});

export default router;
