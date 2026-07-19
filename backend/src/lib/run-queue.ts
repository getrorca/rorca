/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { query, queryOne, transaction } from '../db/index';
import { broadcastAll, type WalEvent } from './sse-hub';
import { logger } from './logger';

interface QueuedRunRow {
  id: number | string;
  spec_path: string;
  workspace_id: string;
  queued_at: string;
  queue_position: number;
  parallelism: number;
  auto_worktree: boolean;
  auto_merge: boolean;
  merge_strategy: 'direct' | 'pr' | 'draft-pr' | 'branch-only' | null;
  include_graph: boolean;
  terminal_mode: 'ansi-html' | 'pty' | null;
  agent_type: 'claude' | 'opencode' | 'codex' | 'pi';
  agent_model: string | null;
  effective_options: { effort?: string | null } | null;
  trigger_options: Record<string, unknown> | null;
}

const DEFAULT_QUEUE_MAX_CONCURRENT = 1;

/**
 * Bounded, canonical queue view for recovery clients. This intentionally reads
 * pipeline_runs rather than exposing pg-boss jobs or their data payloads.
 */
export interface WorkspaceRecoveryQueueSummary {
  queued: number;
  active: number;
  oldestQueuedAgeSeconds: number | null;
  staleActive: number;
}

export async function getWorkspaceRecoveryQueueSummary(workspaceId: string): Promise<WorkspaceRecoveryQueueSummary> {
  const row = await queryOne<{
    queued: string;
    active: string;
    oldest_queued_age_seconds: number | null;
    stale_active: string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'queued')::text AS queued,
       COUNT(*) FILTER (WHERE status IN ('running', 'paused'))::text AS active,
       EXTRACT(EPOCH FROM (NOW() - MIN(queued_at)))::integer
         FILTER (WHERE status = 'queued') AS oldest_queued_age_seconds,
       COUNT(*) FILTER (
         WHERE status = 'running'
           AND COALESCE(last_heartbeat, started_at, queued_at) < NOW() - INTERVAL '5 minutes'
       )::text AS stale_active
     FROM pipeline_runs
     WHERE workspace_id = $1`,
    [workspaceId],
  );

  return {
    queued: Number(row?.queued ?? 0),
    active: Number(row?.active ?? 0),
    oldestQueuedAgeSeconds: row?.oldest_queued_age_seconds ?? null,
    staleActive: Number(row?.stale_active ?? 0),
  };
}

/**
 * Read queue_max_concurrent from worker_settings.
 * Returns the configured limit or DEFAULT_QUEUE_MAX_CONCURRENT.
 */
async function getQueueMaxConcurrent(): Promise<number> {
  const row = await queryOne<{ value: string }>(
    `SELECT value FROM worker_settings WHERE key = 'queue_max_concurrent'`,
  );
  if (row) {
    const parsed = parseInt(row.value, 10);
    if (parsed > 0) return parsed;
  }
  return DEFAULT_QUEUE_MAX_CONCURRENT;
}

/**
 * Advance the run queue for a workspace: find the next queued run,
 * promote it to 'running' by triggering the pipeline internally.
 *
 * US-005: Checks queue_max_concurrent before promoting. Only promotes if
 * currently active queue-triggered runs for this workspace are below the limit.
 * Passes auto_worktree from the queued run row so worktree isolation is preserved.
 *
 * Called after a run transitions to 'done' or 'failed'.
 */
export async function advanceQueue(workspaceId: string): Promise<void> {
  try {
    // US-005: Read queue_max_concurrent from worker_settings
    const queueMaxConcurrent = await getQueueMaxConcurrent();

    // Count active runs triggered via 'queue' for this workspace
    const activeQueueCount = Number(
      (await queryOne<{ count: string }>(
        `SELECT COUNT(*) as count FROM pipeline_runs
         WHERE workspace_id = $1 AND status IN ('running', 'paused') AND triggered_via = 'queue'`,
        [workspaceId],
      ))?.count ?? '0',
    );

    if (activeQueueCount >= queueMaxConcurrent) {
      logger.info(
        `[RunQueue] Workspace ${workspaceId} has ${activeQueueCount}/${queueMaxConcurrent} active queue runs, skipping advance`,
      );
      return;
    }

    // Find the next queued run (oldest first), including auto_worktree
    const nextQueued = await queryOne<QueuedRunRow>(
      `SELECT id, spec_path, workspace_id, queued_at, queue_position, parallelism, auto_worktree,
              auto_merge, merge_strategy, include_graph, terminal_mode, agent_type,
              agent_model, effective_options, trigger_options
         FROM pipeline_runs
       WHERE workspace_id = $1 AND status = 'queued'
       ORDER BY queued_at ASC NULLS LAST, id ASC LIMIT 1`,
      [workspaceId],
    );

    if (!nextQueued) {
      logger.info(`[RunQueue] No queued runs for workspace ${workspaceId}`);
      return;
    }

    logger.info(
      `[RunQueue] Promoting queued run ${nextQueued.id} for workspace ${workspaceId} (autoWorktree=${nextQueued.auto_worktree})`,
    );

    // Emit WAL event for promotion
    const walEvent = await queryOne<WalEvent>(
      `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('run_queued_promoted', $1, $2) RETURNING *`,
      [workspaceId, JSON.stringify({
        runId: nextQueued.id,
        workspaceId: nextQueued.workspace_id,
        specPath: nextQueued.spec_path,
        autoWorktree: nextQueued.auto_worktree,
      })],
    );
    if (walEvent) {
      broadcastAll(walEvent);
    }

    // Trigger the run via internal HTTP call to reuse all spawn logic.
    // US-005: Pass autoWorktree from the queued run row so worktree isolation is preserved.
    // triggered_via='queue' is derived by pipeline.ts from the presence of queuedRunId.
    const port = process.env.PORT || '3030';
    fetch(`http://localhost:${port}/api/pipeline/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        specPath: nextQueued.spec_path,
        workspaceId: nextQueued.workspace_id,
        queuedRunId: nextQueued.id,
        orchestrationMode: nextQueued.parallelism > 1 ? 'wave-parallel' : 'sequential',
        parallelism: nextQueued.parallelism,
        forceSequential: nextQueued.parallelism <= 1,
        triggerOptions: nextQueued.trigger_options ?? undefined,
        autoWorktree: nextQueued.auto_worktree,
        autoMerge: nextQueued.auto_merge,
        mergeStrategy: nextQueued.merge_strategy ?? 'branch-only',
        includeGraph: nextQueued.include_graph,
        terminalMode: nextQueued.terminal_mode ?? 'ansi-html',
        agentOverride: nextQueued.agent_type,
        modelOverride: nextQueued.agent_model ?? undefined,
        effortLevel: nextQueued.effective_options?.effort ?? undefined,
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
