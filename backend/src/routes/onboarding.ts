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

// GET /api/onboarding — get current onboarding state
router.get('/', (_req: Request, res: Response) => {
  const row = ensureRow();
  res.json({
    currentStep: row.current_step,
    workspaceId: row.workspace_id,
    directionDone: !!row.direction_done,
    completed: !!row.completed,
  });
});

// PUT /api/onboarding — update onboarding state
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
