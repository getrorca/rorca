/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * PG-017: Drift Detection WAL Subscriber
 *
 * Listens for run_finished WAL events and triggers graph-powered
 * convention drift detection. Stores results in drift_reports and
 * emits graph_drift_detected WAL event.
 */

import { subscribe, broadcastAll, type WalEvent } from './sse-hub';
import { detectDrift } from './graph-drift-detector';
import { queryOne, execute } from '../db/index';
import { logger } from './logger';

/**
 * Start the drift detection subscriber.
 * Call once at server startup.
 */
export function startDriftSubscriber(): void {
  subscribe((event: WalEvent) => {
    if (event.event_type !== 'run_finished') return;
    handleRunFinished(event).catch((err) => {
      logger.error({ err, eventType: event.event_type }, '[drift-subscriber] Error handling WAL event');
    });
  });
  logger.info('[drift-subscriber] Subscribed to WAL events');
}

async function handleRunFinished(event: WalEvent): Promise<void> {
  let payload: { run_id?: number; status?: string };
  try {
    payload = JSON.parse(event.payload || '{}');
  } catch {
    return;
  }

  // Only run drift detection for completed runs (done or failed)
  if (!payload.run_id) return;
  if (payload.status !== 'done' && payload.status !== 'failed') return;

  // Look up the run
  const run = await queryOne<{ id: number; spec_path: string; workspace_id: string }>(
    'SELECT id, spec_path, workspace_id FROM pipeline_runs WHERE id = $1',
    [payload.run_id],
  );
  if (!run) return;

  // Extract spec ID from spec_path
  const specId = event.spec_id || extractSpecId(run.spec_path);
  if (!specId) return;

  const workspaceId = event.workspace_id || run.workspace_id;
  if (!workspaceId) return;

  logger.info({ runId: payload.run_id, specId, workspaceId }, '[drift-subscriber] Running post-run drift detection');

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
        'post-run',
      ],
    );

    // Emit WAL event for the drift result
    const walResult = await queryOne<{ id: number }>(
      'INSERT INTO wal_events (event_type, workspace_id, spec_id, payload) VALUES ($1, $2, $3, $4) RETURNING id',
      [
        'graph_drift_detected',
        workspaceId,
        specId,
        JSON.stringify({
          run_id: payload.run_id,
          score: report.score,
          violationCount: report.violations.length,
          impactFileCount: report.impactAnalysis.length,
          errorCount: report.violations.filter(v => v.severity === 'error').length,
          warningCount: report.violations.filter(v => v.severity === 'warning').length,
          infoCount: report.violations.filter(v => v.severity === 'info').length,
        }),
      ],
    );

    const walEvent: WalEvent = {
      id: walResult?.id ?? 0,
      ts: new Date().toISOString(),
      event_type: 'graph_drift_detected',
      workspace_id: workspaceId,
      spec_id: specId,
      story_id: null,
      actor: '',
      payload: JSON.stringify({ run_id: payload.run_id, score: report.score }),
    };
    broadcastAll(walEvent);

    logger.info(
      { runId: payload.run_id, specId, score: report.score, violations: report.violations.length },
      '[drift-subscriber] Post-run drift detection complete',
    );
  } catch (err) {
    // Non-fatal — drift detection failure must not affect the run result
    logger.warn({ err, runId: payload.run_id, specId }, '[drift-subscriber] Post-run drift detection failed');
  }
}

function extractSpecId(specPath: string): string {
  if (!specPath) return '';
  const basename = specPath.split('/').pop() || '';
  return basename.replace(/\.json$/, '');
}
