import { Router, Request, Response } from 'express';
import { db } from '../db/index';
import { postCommitStatus, CHECK_NAME, type CheckState } from '../lib/github-checks';
import { broadcastAll, type WalEvent } from '../lib/sse-hub';
import { logger } from '../lib/logger';

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
      res.status(400).json({ error: 'Invalid SHA' });
      return;
    }

    if (!state || !['pending', 'success', 'failure', 'error'].includes(state)) {
      res.status(400).json({ error: 'Invalid state. Must be pending, success, failure, or error' });
      return;
    }

    if (!workspaceId || typeof workspaceId !== 'string') {
      res.status(400).json({ error: 'workspaceId is required' });
      return;
    }

    // Look up the GitHub repo for this workspace
    const webhookRow = db.prepare(
      'SELECT * FROM workspace_github_webhooks WHERE workspace_id = ?'
    ).get(workspaceId) as GithubWebhookRow | undefined;

    if (!webhookRow) {
      res.status(404).json({ error: 'No GitHub connection found for this workspace' });
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
    const walResult = db.prepare(
      `INSERT INTO wal_events (event_type, workspace_id, actor, payload) VALUES ('github_check_manual', ?, 'user', ?)`
    ).run(workspaceId, JSON.stringify({
      sha,
      state,
      description: desc,
      context: CHECK_NAME,
    }));

    const walEvent = db.prepare('SELECT * FROM wal_events WHERE id = ?').get(
      walResult.lastInsertRowid
    ) as WalEvent;

    broadcastAll(walEvent);

    res.json({
      ok: true,
      sha,
      state,
      context: CHECK_NAME,
      description: desc,
    });
  } catch (error: any) {
    logger.error('[Checks] Manual update error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
