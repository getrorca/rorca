/**
 * cross-workspace-memory.ts — API routes for cross-workspace memory sharing (PR-021)
 *
 * Surfaces memory entries from other workspaces in the same domain as
 * suggestions with Accept/Dismiss buttons in the Memory panel.
 */

import { Router, Request, Response } from 'express';
import { NotFoundError, ValidationError } from '../lib/errors';
import {
  synthesizeCrossWorkspace,
  getPendingSuggestions,
  acceptCrossWorkspaceEntry,
  dismissCrossWorkspaceEntry,
} from '../lib/cross-workspace-memory';

const router = Router();

/**
 * @swagger
 * /api/memory/cross-workspace/{workspaceId}:
 *   get:
 *     tags: [Memory]
 *     summary: Get cross-workspace memory suggestions
 *     operationId: getCrossWorkspaceMemory
 *     x-rorca-tier: paid
 *     x-rorca-rationale: "Cross-workspace memory is a federated collaboration feature and belongs behind the paid plan boundary."
 *     description: |
 *       Returns suggested memory entries from other workspaces sharing the same
 *       domain (L2). When pgvector is available, entries are filtered by cosine
 *       similarity > 0.85. Otherwise, all same-domain entries are suggested.
 *       Set refresh=true to re-synthesize (scans other workspaces for new entries).
 *     parameters:
 *       - name: workspaceId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *         description: Target workspace ID
 *       - name: refresh
 *         in: query
 *         schema: { type: boolean }
 *         description: If true, re-runs synthesis to find new suggestions
 *     responses:
 *       200:
 *         description: Cross-workspace memory suggestions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: integer }
 *                       sourceWorkspaceId: { type: string }
 *                       sourceWorkspaceLabel: { type: string }
 *                       date: { type: string }
 *                       category: { type: string }
 *                       title: { type: string }
 *                       rule: { type: string }
 *                       context: { type: string }
 *                       source: { type: string }
 *                       status: { type: string }
 *                       similarity: { type: number, nullable: true }
 *                       createdAt: { type: string }
 *                 total: { type: integer }
 *       400: { description: "Missing workspaceId" }
 */
router.get('/:workspaceId', async (req: Request<{ workspaceId: string }>, res: Response) => {
  const workspaceId = req.params.workspaceId as string;
  if (!workspaceId) throw new ValidationError('workspaceId required');

  const refresh = req.query.refresh === 'true';

  if (refresh) {
    const newSuggestions = await synthesizeCrossWorkspace(workspaceId);
    const allPending = await getPendingSuggestions(workspaceId);
    return res.json({ items: allPending, total: allPending.length, newCount: newSuggestions.length });
  }

  const suggestions = await getPendingSuggestions(workspaceId);
  res.json({ items: suggestions, total: suggestions.length });
});

/**
 * @swagger
 * /api/memory/cross-workspace/{workspaceId}/accept/{entryId}:
 *   post:
 *     tags: [Memory]
 *     summary: Accept a cross-workspace memory suggestion
 *     operationId: acceptCrossWorkspaceMemory
 *     x-rorca-tier: paid
 *     x-rorca-rationale: "Accepting federated memory suggestions mutates a paid cross-workspace collaboration feature."
 *     description: |
 *       Copies the suggested entry into the target workspace's MEMORY.md with
 *       source attribution (From: {workspace label}). The entry is marked as
 *       accepted and won't resurface.
 *     parameters:
 *       - name: workspaceId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *       - name: entryId
 *         in: path
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Entry accepted and copied to MEMORY.md
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 accepted: { type: boolean }
 *                 entry:
 *                   type: object
 *                   properties:
 *                     date: { type: string }
 *                     category: { type: string }
 *                     title: { type: string }
 *                     rule: { type: string }
 *                     context: { type: string }
 *                     source: { type: string }
 *       400: { description: "Invalid parameters" }
 *       404: { description: "Entry not found or already resolved" }
 */
router.post('/:workspaceId/accept/:entryId', async (req: Request<{ workspaceId: string; entryId: string }>, res: Response) => {
  const workspaceId = req.params.workspaceId as string;
  const entryIdNum = parseInt(req.params.entryId as string, 10);
  if (!workspaceId || isNaN(entryIdNum)) {
    throw new ValidationError('workspaceId and valid entryId required');
  }

  const result = await acceptCrossWorkspaceEntry(workspaceId, entryIdNum);
  if (!result.accepted) {
    throw new NotFoundError('Entry not found or already resolved');
  }

  res.json(result);
});

/**
 * @swagger
 * /api/memory/cross-workspace/{workspaceId}/dismiss/{entryId}:
 *   post:
 *     tags: [Memory]
 *     summary: Dismiss a cross-workspace memory suggestion
 *     operationId: dismissCrossWorkspaceMemory
 *     x-rorca-tier: paid
 *     x-rorca-rationale: "Dismissing federated memory suggestions is part of the paid cross-workspace collaboration surface."
 *     description: |
 *       Marks the suggestion as dismissed so it does not resurface.
 *       The entry is NOT copied to the target workspace.
 *     parameters:
 *       - name: workspaceId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *       - name: entryId
 *         in: path
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Entry dismissed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 dismissed: { type: boolean }
 *       400: { description: "Invalid parameters" }
 *       404: { description: "Entry not found or already resolved" }
 */
router.post('/:workspaceId/dismiss/:entryId', async (req: Request<{ workspaceId: string; entryId: string }>, res: Response) => {
  const workspaceId = req.params.workspaceId as string;
  const entryIdNum = parseInt(req.params.entryId as string, 10);
  if (!workspaceId || isNaN(entryIdNum)) {
    throw new ValidationError('workspaceId and valid entryId required');
  }

  const dismissed = await dismissCrossWorkspaceEntry(workspaceId, entryIdNum);
  if (!dismissed) {
    throw new NotFoundError('Entry not found or already resolved');
  }

  res.json({ dismissed: true });
});

export default router;
