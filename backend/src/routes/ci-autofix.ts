/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, Request, Response } from 'express';
import { query, queryOne, execute } from '../db/index';
import { NotFoundError, ValidationError } from '../lib/errors';

const router = Router({ mergeParams: true });

interface CiAutofixRunRow {
  id: number;
  workspace_id: string;
  head_sha: string;
  branch_name: string;
  check_run_id: string;
  check_run_name: string;
  spec_path: string;
  run_id: number | null;
  annotation_count: number;
  agent_type: string;
  status: string;
  error_summary: string | null;
  created_at: string;
  finished_at: string | null;
}

interface WorkspaceCiConfig {
  ci_autofix_enabled: boolean;
  ci_autofix_check_patterns: string[] | null;
  ci_autofix_max_retries: number;
}

/**
 * @swagger
 * /api/workspaces/{workspaceId}/ci-autofix:
 *   get:
 *     tags: [CI Autofix]
 *     summary: Get CI autofix config and recent runs
 *     operationId: getCiAutofixConfig
 *     description: Returns the CI autofix configuration for a workspace and its 10 most recent autofix runs.
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: CI autofix configuration and recent runs
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 enabled: { type: boolean }
 *                 checkPatterns: { type: array, items: { type: string }, nullable: true }
 *                 maxRetries: { type: integer }
 *                 recentRuns:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: integer }
 *                       headSha: { type: string }
 *                       branchName: { type: string }
 *                       checkRunName: { type: string }
 *                       annotationCount: { type: integer }
 *                       agentType: { type: string }
 *                       status: { type: string }
 *                       errorSummary: { type: string, nullable: true }
 *                       createdAt: { type: string, format: date-time }
 *                       finishedAt: { type: string, format: date-time, nullable: true }
 *                       runId: { type: integer, nullable: true }
 *       404:
 *         description: Workspace not found
 */
router.get('/', async (req: Request, res: Response) => {
  const workspaceId = req.params.id;

  const workspace = await queryOne<WorkspaceCiConfig>(
    `SELECT ci_autofix_enabled, ci_autofix_check_patterns, ci_autofix_max_retries
     FROM workspaces WHERE id = $1`,
    [workspaceId]
  );

  if (!workspace) {
    throw new NotFoundError('Workspace not found');
  }

  const recentRuns = await query<CiAutofixRunRow>(
    `SELECT id, head_sha, branch_name, check_run_name, annotation_count,
            agent_type, status, error_summary, created_at, finished_at, run_id
     FROM ci_autofix_runs
     WHERE workspace_id = $1
     ORDER BY created_at DESC
     LIMIT 10`,
    [workspaceId]
  );

  res.json({
    enabled: workspace.ci_autofix_enabled,
    checkPatterns: workspace.ci_autofix_check_patterns,
    maxRetries: workspace.ci_autofix_max_retries,
    recentRuns: recentRuns.map(r => ({
      id: r.id,
      headSha: r.head_sha,
      branchName: r.branch_name,
      checkRunName: r.check_run_name,
      annotationCount: r.annotation_count,
      agentType: r.agent_type,
      status: r.status,
      errorSummary: r.error_summary,
      createdAt: r.created_at,
      finishedAt: r.finished_at,
      runId: r.run_id,
    })),
  });
});

/**
 * @swagger
 * /api/workspaces/{workspaceId}/ci-autofix:
 *   patch:
 *     tags: [CI Autofix]
 *     summary: Update CI autofix configuration
 *     operationId: updateCiAutofixConfig
 *     description: Updates the CI autofix settings for a workspace. Only provided fields are updated.
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               enabled: { type: boolean }
 *               checkPatterns:
 *                 type: array
 *                 items: { type: string }
 *                 nullable: true
 *               maxRetries: { type: integer, minimum: 1, maximum: 5 }
 *     responses:
 *       200:
 *         description: Updated CI autofix configuration
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 enabled: { type: boolean }
 *                 checkPatterns: { type: array, items: { type: string }, nullable: true }
 *                 maxRetries: { type: integer }
 *       400:
 *         description: Invalid input
 *       404:
 *         description: Workspace not found
 */
router.patch('/', async (req: Request, res: Response) => {
  const workspaceId = req.params.id;
  const { enabled, checkPatterns, maxRetries } = req.body;

  // Validate inputs
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw new ValidationError('enabled must be a boolean', { field: 'enabled' });
  }

  if (checkPatterns !== undefined) {
    if (checkPatterns !== null) {
      if (!Array.isArray(checkPatterns) || checkPatterns.length === 0) {
        throw new ValidationError('checkPatterns must be a non-empty array of strings or null', { field: 'checkPatterns' });
      }
      if (!checkPatterns.every((p: unknown) => typeof p === 'string')) {
        throw new ValidationError('checkPatterns must contain only strings', { field: 'checkPatterns' });
      }
    }
  }

  if (maxRetries !== undefined) {
    if (!Number.isInteger(maxRetries) || maxRetries < 1 || maxRetries > 5) {
      throw new ValidationError('maxRetries must be an integer between 1 and 5', { field: 'maxRetries' });
    }
  }

  // Verify workspace exists
  const workspace = await queryOne<{ id: string }>(
    'SELECT id FROM workspaces WHERE id = $1',
    [workspaceId]
  );

  if (!workspace) {
    throw new NotFoundError('Workspace not found');
  }

  // Build dynamic UPDATE
  const setClauses: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (enabled !== undefined) {
    setClauses.push(`ci_autofix_enabled = $${paramIdx++}`);
    params.push(enabled);
  }
  if (checkPatterns !== undefined) {
    setClauses.push(`ci_autofix_check_patterns = $${paramIdx++}`);
    params.push(checkPatterns === null ? null : JSON.stringify(checkPatterns));
  }
  if (maxRetries !== undefined) {
    setClauses.push(`ci_autofix_max_retries = $${paramIdx++}`);
    params.push(maxRetries);
  }

  if (setClauses.length > 0) {
    params.push(workspaceId);
    await execute(
      `UPDATE workspaces SET ${setClauses.join(', ')} WHERE id = $${paramIdx}`,
      params
    );
  }

  // Return updated config
  const updated = await queryOne<WorkspaceCiConfig>(
    `SELECT ci_autofix_enabled, ci_autofix_check_patterns, ci_autofix_max_retries
     FROM workspaces WHERE id = $1`,
    [workspaceId]
  );

  res.json({
    enabled: updated!.ci_autofix_enabled,
    checkPatterns: updated!.ci_autofix_check_patterns,
    maxRetries: updated!.ci_autofix_max_retries,
  });
});

export default router;
