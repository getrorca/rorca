/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, Request, Response } from 'express';
import { queryOne } from '../db/index';
import { postCommitStatus, CHECK_NAME, type CheckState } from '../lib/github-checks';
import { broadcastAll, type WalEvent } from '../lib/sse-hub';
import { handleRouteError } from '../lib/async-handler';
import { NotFoundError, ValidationError } from '../lib/errors';

const router = Router();

interface GithubWebhookRow {
  workspace_id: string;
  repo_owner: string;
  repo_name: string;
}

/**
 * @swagger
 * /api/github/checks/{sha}:
 *   post:
 *     tags: [GitHub]
 *     summary: Manually update a GitHub commit check status
 *     operationId: updateGithubCheckStatus
 *     description: Posts a commit status to GitHub for the given SHA. Used for manual verification overrides or edge cases outside the normal pipeline flow.
 *     parameters:
 *       - in: path
 *         name: sha
 *         required: true
 *         schema: { type: string, minLength: 7 }
 *         description: Git commit SHA
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [state, workspaceId]
 *             properties:
 *               state: { type: string, enum: [pending, success, failure, error] }
 *               description: { type: string }
 *               workspaceId: { type: string }
 *     responses:
 *       200:
 *         description: Check status posted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 sha: { type: string }
 *                 state: { type: string }
 *                 context: { type: string }
 *                 description: { type: string }
 *       400:
 *         description: Invalid SHA, state, or missing workspaceId
 *       404:
 *         description: No GitHub connection found for this workspace
 *       502:
 *         description: Failed to post status to GitHub
 */
router.post('/:sha', async (req: Request, res: Response) => {
  try {
    const sha = req.params.sha as string;
    const { state, description, workspaceId } = req.body;

    if (!sha || sha.length < 7) {
      throw new ValidationError('Invalid SHA');
      return;
    }

    if (!state || !['pending', 'success', 'failure', 'error'].includes(state)) {
      throw new ValidationError('Invalid state. Must be pending, success, failure, or error');
      return;
    }

    if (!workspaceId || typeof workspaceId !== 'string') {
      throw new ValidationError('workspaceId is required');
      return;
    }

    // Look up the GitHub repo for this workspace
    const webhookRow = await queryOne<GithubWebhookRow>(
      'SELECT * FROM workspace_github_webhooks WHERE workspace_id = $1',
      [workspaceId]
    );

    if (!webhookRow) {
      throw new NotFoundError('No GitHub connection found for this workspace');
      return;
    }

    const desc = (description as string) || `Manual ${state} via Rorca`;

    const posted = await postCommitStatus(
      webhookRow.repo_owner,
      webhookRow.repo_name,
      sha,
      state as CheckState,
      desc,
    );

    if (!posted) {
      res.status(502).json({ error: 'Failed to post status to GitHub' });
      return;
    }

    // Emit WAL event
    const walEvent = await queryOne<WalEvent>(
      `INSERT INTO wal_events (event_type, workspace_id, actor, payload) VALUES ('github_check_manual', $1, 'user', $2) RETURNING *`,
      [workspaceId, JSON.stringify({
        sha,
        state,
        description: desc,
        context: CHECK_NAME,
      })]
    );

    if (walEvent) {
      broadcastAll(walEvent);
    }

    res.json({
      ok: true,
      sha,
      state,
      context: CHECK_NAME,
      description: desc,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Checks] Manual update');
  }
});

export default router;
