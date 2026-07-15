/** Governed recovery routes for external local supervisors such as Hermes. */
import { Router, type Request, type Response } from 'express';
import { handleRouteError } from '../lib/async-handler';
import {
  checkpointReconciliationSchema,
  reconcileCheckpoint,
} from '../lib/checkpoint-reconciliation';
import { ValidationError } from '../lib/errors';

const router = Router();

/**
 * @swagger
 * /api/repair/checkpoints/reconcile:
 *   post:
 *     tags: [Pipeline]
 *     summary: Reconcile a validated checkpoint into canonical story lifecycle
 *     operationId: reconcileCheckpoint
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "A checkpoint changes a workspace-owned canonical story lifecycle, so only authenticated local automation may submit it after Rorca independently validates workspace, run, branch, commit, and fresh validation evidence."
 *     description: >
 *       Governed checkpoint ingestion for local recovery supervisors. Rorca does
 *       not accept database mutations, raw worker payloads, logs, paths, or
 *       secrets. It verifies the run ownership and failed/cancelled lifecycle,
 *       exact approved spec, run branch, commit ancestry, story dependencies,
 *       and fresh successful validation evidence before using the same canonical
 *       execution-engine story completion service used by normal execution.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, specId, runId, storyId, branch, commitSha, validation]
 *             properties:
 *               workspaceId: { type: string }
 *               specId: { type: string }
 *               runId: { type: integer, minimum: 1 }
 *               storyId: { type: string }
 *               branch: { type: string }
 *               commitSha: { type: string, description: "Checkpoint commit SHA on the run branch" }
 *               validation:
 *                 type: object
 *                 required: [passed, completedAt, commitSha, command, summary]
 *                 properties:
 *                   passed: { type: boolean, enum: [true] }
 *                   completedAt: { type: string, format: date-time, description: "Must be no older than 24 hours" }
 *                   commitSha: { type: string, description: "Must equal commitSha" }
 *                   command: { type: string, description: "Validation command; hashed before WAL persistence" }
 *                   summary: { type: string, description: "Validation summary; hashed before WAL persistence" }
 *     responses:
 *       201: { description: Checkpoint reconciled and WAL evidence emitted }
 *       200: { description: Idempotent replay; story was already reconciled }
 *       400: { description: Invalid bounded request }
 *       404: { description: Workspace, run, approved spec, or story not found }
 *       409: { description: Workspace/spec/run/branch/dependency lifecycle conflict }
 *       422: { description: Missing commit or stale/invalid validation evidence }
 */
router.post('/checkpoints/reconcile', async (req: Request, res: Response) => {
  try {
    const parsed = checkpointReconciliationSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid checkpoint reconciliation request', {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }
    const result = await reconcileCheckpoint(parsed.data);
    res.status(result.idempotent ? 200 : 201).json(result);
  } catch (error: unknown) {
    handleRouteError(res, error, '[Recovery] Checkpoint reconciliation');
  }
});

export default router;
