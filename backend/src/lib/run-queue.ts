import { query, queryOne, transaction } from '../db/index';
import { broadcastAll, type WalEvent } from './sse-hub';
import { logger } from './logger';

interface QueuedRunRow {
  id: number;
  spec_path: string;
  workspace_id: string;
  queued_at: string;
  queue_position: number;
}

/**
 * Advance the run queue for a workspace: find the next queued run,
 * promote it to 'running' by triggering the pipeline internally.
 *
 * Called after a run transitions to 'done' or 'failed'.
 */
export async function advanceQueue(workspaceId: string): Promise<void> {
  try {
    // Check if there's still an active run — don't double-start
    const activeRun = await queryOne<{ id: number }>(
      `SELECT id FROM pipeline_runs WHERE workspace_id = $1 AND status IN ('running', 'paused') LIMIT 1`,
      [workspaceId],
    );
    if (activeRun) {
      logger.info(`[RunQueue] Workspace ${workspaceId} still has active run, skipping queue advance`);
      return;
    }

    // Find the next queued run (oldest first)
    const nextQueued = await queryOne<QueuedRunRow>(
      `SELECT id, spec_path, workspace_id, queued_at, queue_position FROM pipeline_runs
       WHERE workspace_id = $1 AND status = 'queued'
       ORDER BY queued_at ASC LIMIT 1`,
      [workspaceId],
    );

    if (!nextQueued) {
      logger.info(`[RunQueue] No queued runs for workspace ${workspaceId}`);
      return;
    }

    logger.info(`[RunQueue] Promoting queued run ${nextQueued.id} for workspace ${workspaceId}`);

    // Emit WAL event for promotion
    const walEvent = await queryOne<WalEvent>(
      `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('run_queued_promoted', $1, $2) RETURNING *`,
      [workspaceId, JSON.stringify({
        runId: nextQueued.id,
        workspaceId: nextQueued.workspace_id,
        specPath: nextQueued.spec_path,
      })],
    );
    if (walEvent) {
      broadcastAll(walEvent);
    }

    // Trigger the run via internal HTTP call to reuse all spawn logic
    const port = process.env.PORT || '3030';
    fetch(`http://localhost:${port}/api/pipeline/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        specPath: nextQueued.spec_path,
        workspaceId: nextQueued.workspace_id,
        queuedRunId: nextQueued.id,
      }),
    }).then(async (resp) => {
      if (!resp.ok) {
        const body = await resp.text();
        logger.error(`[RunQueue] Failed to trigger queued run ${nextQueued.id}: ${resp.status} ${body}`);
      } else {
        logger.info(`[RunQueue] Successfully triggered queued run ${nextQueued.id}`);
      }
    }).catch((err) => {
      logger.error(`[RunQueue] HTTP trigger failed for run ${nextQueued.id}:`, err);
    });
  } catch (err) {
    logger.error(`[RunQueue] advanceQueue error: ${err}`);
  }
}

/**
 * Recalculate queue_position for all queued runs in a workspace
 * after a cancellation or reorder.
 */
export async function recalculateQueuePositions(workspaceId: string): Promise<void> {
  const queuedRuns = await query<{ id: number }>(
    `SELECT id FROM pipeline_runs WHERE workspace_id = $1 AND status = 'queued' ORDER BY queued_at ASC`,
    [workspaceId],
  );

  await transaction(async (client) => {
    for (let i = 0; i < queuedRuns.length; i++) {
      await client.query('UPDATE pipeline_runs SET queue_position = $1 WHERE id = $2', [i + 1, queuedRuns[i].id]);
    }
  });
}
