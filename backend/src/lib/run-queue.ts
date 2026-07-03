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
  auto_worktree: boolean;
  auto_merge: boolean | null;
  include_graph: boolean | null;
  parallelism: number | null;
  agent_type: string | null;
  agent_model: string | null;
  merge_strategy: 'direct' | 'pr' | 'draft-pr' | 'branch-only' | null;
  terminal_mode: string | null;
  execution_environment: string | null;
  trigger_options: Record<string, unknown> | string | null;
}

function parseTriggerOptions(raw: QueuedRunRow['trigger_options']): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function isKnownAgent(agent: string | null): agent is 'claude' | 'opencode' | 'codex' | 'pi' {
  return agent === 'claude' || agent === 'opencode' || agent === 'codex' || agent === 'pi';
}

const DEFAULT_QUEUE_MAX_CONCURRENT = 1;

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

    // Find the next queued run (oldest first), including the stored trigger contract.
    const nextQueued = await queryOne<QueuedRunRow>(
      `SELECT id, spec_path, workspace_id, queued_at, queue_position,
              auto_worktree, auto_merge, include_graph, parallelism,
              agent_type, agent_model, merge_strategy, terminal_mode,
              execution_environment,
              COALESCE(trigger_options, '{}'::jsonb) AS trigger_options
       FROM pipeline_runs
       WHERE workspace_id = $1 AND status = 'queued'
       ORDER BY queued_at ASC LIMIT 1`,
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
    // Replay the full queued trigger contract so queue promotion preserves
    // agent/model, reasoning effort, merge strategy, terminal mode, graph mode,
    // story scope, readiness override, and sequential execution intent.
    // triggered_via='queue' is derived by pipeline.ts from the presence of queuedRunId.
    const triggerOptions = parseTriggerOptions(nextQueued.trigger_options);
    const fallbackAgentOverride = isKnownAgent(nextQueued.agent_type) ? nextQueued.agent_type : undefined;
    const replayBody = {
      ...triggerOptions,
      specPath: nextQueued.spec_path,
      workspaceId: nextQueued.workspace_id,
      queuedRunId: Number(nextQueued.id),
      autoWorktree: Boolean(nextQueued.auto_worktree),
      ...(nextQueued.auto_merge !== null ? { autoMerge: nextQueued.auto_merge } : {}),
      ...(nextQueued.include_graph !== null ? { includeGraph: nextQueued.include_graph } : {}),
      ...(nextQueued.merge_strategy ? { mergeStrategy: nextQueued.merge_strategy } : {}),
      ...(nextQueued.terminal_mode ? { terminal_mode: nextQueued.terminal_mode } : {}),
      ...(nextQueued.execution_environment ? { executionEnvironment: nextQueued.execution_environment } : {}),
      ...(fallbackAgentOverride ? { agentOverride: fallbackAgentOverride } : {}),
      ...(nextQueued.agent_model ? { modelOverride: nextQueued.agent_model } : {}),
      ...(nextQueued.parallelism === 1 ? { forceSequential: true } : {}),
    };

    const port = process.env.PORT || '3030';
    fetch(`http://localhost:${port}/api/pipeline/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(replayBody),
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
