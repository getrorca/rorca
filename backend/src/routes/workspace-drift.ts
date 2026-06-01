/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * PG-017: Workspace drift routes — graph-powered convention drift detection.
 *
 * GET  /api/workspaces/:id/drift       — latest drift report (optional ?specId= filter)
 * POST /api/workspaces/:id/drift/check — manually trigger drift detection for most recent completed spec
 */

import { Router, Request, Response } from 'express';
import { queryOne, execute } from '../db/index';
import { detectDrift } from '../lib/graph-drift-detector';
import type { GraphDriftReport } from '../lib/graph-drift-detector';
import { broadcastAll, type WalEvent } from '../lib/sse-hub';
import { logger } from '../lib/logger';
import { NotFoundError } from '../lib/errors';
import { handleRouteError } from '../lib/async-handler';
import { requireAge } from '../lib/age-guard';

const router = Router({ mergeParams: true });

async function emitWalEvent(
  eventType: string,
  workspaceId: string,
  specId: string | null,
  payload: Record<string, unknown>,
): Promise<void> {
  const result = await queryOne<{ id: number }>(
    'INSERT INTO wal_events (event_type, workspace_id, spec_id, payload) VALUES ($1, $2, $3, $4) RETURNING id',
    [eventType, workspaceId, specId, JSON.stringify(payload)],
  );
  const walEvent: WalEvent = {
    id: result?.id ?? 0,
    ts: new Date().toISOString(),
    event_type: eventType,
    workspace_id: workspaceId,
    spec_id: specId,
    story_id: null,
    actor: '',
    payload: JSON.stringify(payload),
  };
  broadcastAll(walEvent);
}

/**
 * @swagger
 * /api/workspaces/{id}/drift:
 *   get:
 *     tags: [Workspaces, Drift]
 *     summary: Get the most recent graph-powered drift report for a workspace
 *     operationId: getWorkspaceDrift
 *     description: Returns the most recent GraphDriftReport. Optional specId query param filters to a specific spec run.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Workspace ID
 *       - in: query
 *         name: specId
 *         required: false
 *         schema: { type: string }
 *         description: Filter to drift report for a specific spec
 *     responses:
 *       200:
 *         description: Drift report or null
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: integer, nullable: true }
 *                 specId: { type: string, nullable: true }
 *                 triggerType: { type: string, nullable: true }
 *                 report:
 *                   nullable: true
 *                   type: object
 *                   properties:
 *                     violations: { type: array, items: { type: object } }
 *                     impactAnalysis: { type: array, items: { type: object } }
 *                     score: { type: number }
 *       404: { description: Workspace not found }
 */
router.get('/:id/drift', async (req: Request, res: Response) => {
  const workspaceId = String(req.params.id);
  const specId = req.query.specId ? String(req.query.specId) : undefined;

  // Verify workspace exists
  const workspace = await queryOne<{ id: string }>(
    'SELECT id FROM workspaces WHERE id = $1',
    [workspaceId],
  );
  if (!workspace) {
    throw new NotFoundError('Workspace not found');
    return;
  }

  let row: {
    id: number;
    spec_id: string | null;
    violations_json: string;
    impact_json: string;
    score: number;
    trigger_type: string;
    created_at: string;
  } | undefined;

  if (specId) {
    row = await queryOne<typeof row>(
      `SELECT id, spec_id, violations_json, impact_json, score, trigger_type, created_at
       FROM drift_reports
       WHERE workspace_id = $1 AND spec_id = $2
       ORDER BY created_at DESC LIMIT 1`,
      [workspaceId, specId],
    );
  } else {
    row = await queryOne<typeof row>(
      `SELECT id, spec_id, violations_json, impact_json, score, trigger_type, created_at
       FROM drift_reports
       WHERE workspace_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [workspaceId],
    );
  }

  if (!row) {
    res.json({ report: null });
    return;
  }

  const report: GraphDriftReport = {
    violations: JSON.parse(row.violations_json || '[]'),
    impactAnalysis: JSON.parse(row.impact_json || '[]'),
    score: row.score,
  };

  res.json({
    id: row.id,
    specId: row.spec_id,
    triggerType: row.trigger_type,
    checkedAt: row.created_at,
    report,
  });
});

/**
 * @swagger
 * /api/workspaces/{id}/drift/check:
 *   post:
 *     tags: [Workspaces, Drift]
 *     summary: Manually trigger graph-powered drift detection
 *     operationId: checkWorkspaceDrift
 *     description: Runs drift detection against the most recent completed spec for this workspace. Stores the report and emits a WAL event.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Workspace ID
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               specId:
 *                 type: string
 *                 description: Optional spec ID to check. If omitted, uses the most recent completed spec.
 *     responses:
 *       200:
 *         description: Drift report generated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 specId: { type: string }
 *                 report:
 *                   type: object
 *                   properties:
 *                     violations: { type: array, items: { type: object } }
 *                     impactAnalysis: { type: array, items: { type: object } }
 *                     score: { type: number }
 *       404: { description: Workspace not found or no completed specs }
 *       500: { description: Drift detection failed }
 */
router.post('/:id/drift/check', requireAge(), async (req: Request, res: Response) => {
  const workspaceId = String(req.params.id);
  const requestSpecId = req.body?.specId ? String(req.body.specId) : undefined;

  // Verify workspace exists
  const workspace = await queryOne<{ id: string }>(
    'SELECT id FROM workspaces WHERE id = $1',
    [workspaceId],
  );
  if (!workspace) {
    throw new NotFoundError('Workspace not found');
    return;
  }

  // Resolve spec ID
  let specId = requestSpecId;

  if (!specId) {
    // Find most recent completed run for this workspace
    const latestRun = await queryOne<{ spec_path: string }>(
      `SELECT spec_path FROM pipeline_runs
       WHERE workspace_id = $1 AND status = 'done'
       ORDER BY finished_at DESC LIMIT 1`,
      [workspaceId],
    );

    if (!latestRun?.spec_path) {
      throw new NotFoundError('No completed spec runs found for this workspace');
      return;
    }

    // Extract spec ID from path: "forge/specs/approved/my-spec.json" → "my-spec"
    const basename = latestRun.spec_path.split('/').pop() || '';
    specId = basename.replace(/\.json$/, '');
  }

  if (!specId) {
    throw new NotFoundError('Could not determine spec ID');
    return;
  }

  try {
    const report = await detectDrift(specId, Number(workspaceId) || 0);

    // Store in drift_reports
    await execute(
      `INSERT INTO drift_reports (workspace_id, spec_id, violations_json, impact_json, score, conventions_checked, files_sampled, trigger_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        workspaceId,
        specId,
        JSON.stringify(report.violations),
        JSON.stringify(report.impactAnalysis),
        report.score,
        report.violations.length,
        report.impactAnalysis.length,
        'manual',
      ],
    );

    // Emit WAL event
    await emitWalEvent('graph_drift_detected', workspaceId, specId, {
      score: report.score,
      violationCount: report.violations.length,
      impactFileCount: report.impactAnalysis.length,
      errorCount: report.violations.filter(v => v.severity === 'error').length,
      warningCount: report.violations.filter(v => v.severity === 'warning').length,
    });

    res.json({ ok: true, specId, report });
  } catch (err: any) {
    handleRouteError(res, err, '[workspace-drift] Drift detection');
  }
});

export default router;
