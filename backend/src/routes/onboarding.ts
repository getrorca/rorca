/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { queryOne, execute } from '../db/index';
import { ValidationError } from '../lib/errors';

const router = Router();

interface OnboardingRow {
  id: number;
  current_step: number;
  workspace_id: string | null;
  direction_done: number | boolean;
  completed: number | boolean;
  updated_at: string;
}

async function ensureRow(): Promise<OnboardingRow> {
  let row = await queryOne<OnboardingRow>('SELECT * FROM onboarding_state WHERE id = 1');
  if (!row) {
    await execute(
      `INSERT INTO onboarding_state (id, current_step, workspace_id, direction_done, completed)
       VALUES (1, 0, NULL, false, false)
       ON CONFLICT (id) DO NOTHING`
    );
    row = await queryOne<OnboardingRow>('SELECT * FROM onboarding_state WHERE id = 1');
  }
  return row!;
}

/**
 * @swagger
 * /api/onboarding:
 *   get:
 *     tags: [Onboarding]
 *     summary: Get current onboarding state
 *     operationId: getOnboardingState
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Onboarding progress is user-specific state and should only be exposed to authenticated callers."
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
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const row = await ensureRow();
    res.json({
      currentStep: row.current_step,
      workspaceId: row.workspace_id,
      directionDone: !!row.direction_done,
      completed: !!row.completed,
    });
  } catch (err) { next(err); }
});

/**
 * @swagger
 * /api/onboarding:
 *   put:
 *     tags: [Onboarding]
 *     summary: Update onboarding state
 *     operationId: updateOnboardingState
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Updating onboarding progress mutates user-specific state and should require authenticated access."
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
router.put('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { currentStep, workspaceId, directionDone, completed } = req.body;
    await ensureRow();

    const updates: string[] = [];
    const params: (string | number | boolean | null)[] = [];
    let paramIdx = 0;

    if (currentStep !== undefined) {
      paramIdx++;
      updates.push(`current_step = $${paramIdx}`);
      params.push(currentStep);
    }
    if (workspaceId !== undefined) {
      paramIdx++;
      updates.push(`workspace_id = $${paramIdx}`);
      params.push(workspaceId);
    }
    if (directionDone !== undefined) {
      paramIdx++;
      updates.push(`direction_done = $${paramIdx}`);
      params.push(directionDone ? true : false);
    }
    if (completed !== undefined) {
      paramIdx++;
      updates.push(`completed = $${paramIdx}`);
      params.push(completed ? true : false);
    }

    if (updates.length === 0) {
      throw new ValidationError('No fields to update');
      return;
    }

    updates.push('updated_at = NOW()');

    await execute(`UPDATE onboarding_state SET ${updates.join(', ')} WHERE id = 1`, params);

    const row = await queryOne<OnboardingRow>('SELECT * FROM onboarding_state WHERE id = 1');
    res.json({
      currentStep: row!.current_step,
      workspaceId: row!.workspace_id,
      directionDone: !!row!.direction_done,
      completed: !!row!.completed,
    });
  } catch (err) { next(err); }
});

export default router;
