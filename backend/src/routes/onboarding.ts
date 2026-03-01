import { Router, Request, Response } from 'express';
import { db } from '../db/index';

const router = Router();

interface OnboardingRow {
  id: number;
  current_step: number;
  workspace_id: string | null;
  direction_done: number;
  completed: number;
  updated_at: string;
}

function ensureRow(): OnboardingRow {
  let row = db.prepare('SELECT * FROM onboarding_state WHERE id = 1').get() as OnboardingRow | undefined;
  if (!row) {
    db.prepare(
      `INSERT OR IGNORE INTO onboarding_state (id, current_step, workspace_id, direction_done, completed)
       VALUES (1, 0, NULL, 0, 0)`
    ).run();
    row = db.prepare('SELECT * FROM onboarding_state WHERE id = 1').get() as OnboardingRow;
  }
  return row;
}

/**
 * @swagger
 * /api/onboarding:
 *   get:
 *     tags: [Onboarding]
 *     summary: Get current onboarding state
 *     operationId: getOnboardingState
 *     description: Returns the current onboarding wizard progress including step number, workspace association, direction completion, and overall completion status.
 *     responses:
 *       200:
 *         description: Onboarding state
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 currentStep: { type: integer }
 *                 workspaceId: { type: string, nullable: true }
 *                 directionDone: { type: boolean }
 *                 completed: { type: boolean }
 */
router.get('/', (_req: Request, res: Response) => {
  const row = ensureRow();
  res.json({
    currentStep: row.current_step,
    workspaceId: row.workspace_id,
    directionDone: !!row.direction_done,
    completed: !!row.completed,
  });
});

/**
 * @swagger
 * /api/onboarding:
 *   put:
 *     tags: [Onboarding]
 *     summary: Update onboarding state
 *     operationId: updateOnboardingState
 *     description: Updates one or more fields of the onboarding wizard state. Only provided fields are updated.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               currentStep: { type: integer }
 *               workspaceId: { type: string, nullable: true }
 *               directionDone: { type: boolean }
 *               completed: { type: boolean }
 *     responses:
 *       200:
 *         description: Updated onboarding state
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 currentStep: { type: integer }
 *                 workspaceId: { type: string, nullable: true }
 *                 directionDone: { type: boolean }
 *                 completed: { type: boolean }
 *       400:
 *         description: No fields to update
 */
router.put('/', (req: Request, res: Response) => {
  const { currentStep, workspaceId, directionDone, completed } = req.body;
  ensureRow();

  const updates: string[] = [];
  const params: (string | number | null)[] = [];

  if (currentStep !== undefined) {
    updates.push('current_step = ?');
    params.push(currentStep);
  }
  if (workspaceId !== undefined) {
    updates.push('workspace_id = ?');
    params.push(workspaceId);
  }
  if (directionDone !== undefined) {
    updates.push('direction_done = ?');
    params.push(directionDone ? 1 : 0);
  }
  if (completed !== undefined) {
    updates.push('completed = ?');
    params.push(completed ? 1 : 0);
  }

  if (updates.length === 0) {
    res.status(400).json({ error: 'No fields to update' });
    return;
  }

  updates.push("updated_at = datetime('now')");

  db.prepare(`UPDATE onboarding_state SET ${updates.join(', ')} WHERE id = 1`).run(...params);

  const row = db.prepare('SELECT * FROM onboarding_state WHERE id = 1').get() as OnboardingRow;
  res.json({
    currentStep: row.current_step,
    workspaceId: row.workspace_id,
    directionDone: !!row.direction_done,
    completed: !!row.completed,
  });
});

export default router;
