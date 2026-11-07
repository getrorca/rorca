/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { randomUUID } from 'node:crypto';
import { query, queryOne, transaction } from '../db/index';
import { releaseDispatchPublication } from './dispatch-publication';
import { broadcastAll, type WalEvent } from './sse-hub';
import { logger } from './logger';
import { getWorkerConcurrencySettings } from './worker-concurrency';

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
  terminal_mode: 'ansi-html' | 'pty' | 'native-pty' | null;
  execution_environment: 'remote-rorca' | 'local-user' | null;
  agent_type: 'claude' | 'opencode' | 'codex' | 'pi' | 'omp';
  agent_model: string | null;
  effective_options: { effort?: string | null } | null;
  trigger_options: Record<string, unknown> | null;
  task_manifest_id: string | null;
  idempotency_key: string;
}


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
       COUNT(*) FILTER (WHERE status IN ('starting', 'running', 'paused', 'pi_native'))::text AS active,
       EXTRACT(EPOCH FROM (NOW() - MIN(queued_at)))::integer
         FILTER (WHERE status = 'queued') AS oldest_queued_age_seconds,
       COUNT(*) FILTER (
         WHERE (
           status IN ('running', 'pi_native')
           AND COALESCE(last_heartbeat, started_at, queued_at) < NOW() - INTERVAL '5 minutes'
         ) OR (
           status = 'starting'
           AND dispatch_lease_expires_at <= NOW()
         )
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


async function failQueuedDispatch(runId: number | string, publicationOwner: string, reason: string): Promise<void> {
  await releaseDispatchPublication(runId, publicationOwner, reason);
  logger.error(`[RunQueue] Deferred queued run ${runId} after dispatch failure: ${reason}`);
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
    const { queueMaxConcurrent } = await getWorkerConcurrencySettings();

    const publicationOwner = `queue-promoter:${process.pid}:${randomUUID()}`;
    const nextQueued = await transaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('rorca:queue-promotion:' || $1))`, [workspaceId]);
      const active = (await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM pipeline_runs
          WHERE workspace_id = $1 AND triggered_via = 'queue'
            AND (
              status IN ('running', 'paused', 'pi_native')
              OR (status = 'starting' AND dispatch_lease_expires_at > NOW())
            )`,
        [workspaceId],
      )).rows[0];
      if (Number(active?.count ?? 0) >= queueMaxConcurrent) return null;
      const selected = (await client.query<QueuedRunRow>(
        `SELECT run.id, run.spec_path, run.workspace_id, run.queued_at, run.queue_position,
                run.parallelism, run.auto_worktree, run.auto_merge, run.merge_strategy,
                run.include_graph, run.terminal_mode, run.execution_environment,
                run.agent_type, run.agent_model, run.effective_options, run.trigger_options,
                run.task_manifest_id, run.idempotency_key
           FROM pipeline_runs run
           JOIN pipeline_dispatch_publications publication ON publication.run_id = run.id
          WHERE run.workspace_id = $1 AND run.status = 'queued'
            AND publication.state = 'reserved'
            AND run.idempotency_key IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM pipeline_run_cancellation_requests cancellation WHERE cancellation.run_id = run.id)
          ORDER BY run.queued_at ASC NULLS LAST, run.id ASC
          FOR UPDATE OF run, publication SKIP LOCKED LIMIT 1`,
        [workspaceId],
      )).rows[0];
      if (!selected) return null;
      const claimed = await client.query(
        `UPDATE pipeline_dispatch_publications
            SET state = 'preparing', lease_owner = $2,
                lease_expires_at = NOW() + INTERVAL '5 minutes', updated_at = NOW()
          WHERE run_id = $1 AND state = 'reserved'`,
        [selected.id, publicationOwner],
      );
      return claimed.rowCount === 1 ? selected : null;
    });

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
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': nextQueued.idempotency_key,
      },
      body: JSON.stringify({
        specPath: nextQueued.spec_path,
        workspaceId: nextQueued.workspace_id,
        queuedRunId: nextQueued.id,
        idempotencyKey: nextQueued.idempotency_key,
        dispatchPublicationOwner: publicationOwner,
        orchestrationMode: nextQueued.parallelism > 1 ? 'wave-parallel' : 'sequential',
        parallelism: nextQueued.parallelism,
        forceSequential: nextQueued.parallelism <= 1,
        ...(nextQueued.task_manifest_id ? {
          // Promotion carries only the reserved TaskManifest lineage marker.
          // Readiness authority is never synthesized by the queue on Darwin or
          // Linux; the trigger route verifies the preparing publication lease.
          taskManifestPromotion: true,
          manifestId: nextQueued.task_manifest_id,
        } : {}),
        qualificationReceiptId: nextQueued.trigger_options?.qualificationReceiptId,
        rolloutCohort: nextQueued.trigger_options?.rolloutCohort,
        triggerOptions: nextQueued.trigger_options ?? undefined,
        autoWorktree: nextQueued.auto_worktree,
        autoMerge: nextQueued.auto_merge,
        mergeStrategy: nextQueued.merge_strategy ?? 'branch-only',
        includeGraph: nextQueued.include_graph,
        terminalMode: nextQueued.terminal_mode ?? 'ansi-html',
        executionEnvironment: nextQueued.execution_environment ?? 'remote-rorca',
        executionEnvironmentId: nextQueued.trigger_options?.executionEnvironmentId,
        agentOverride: nextQueued.agent_type,
        modelOverride: nextQueued.agent_model ?? undefined,
        thinkingEnabled: nextQueued.trigger_options?.thinkingEnabled,
        thinkingBudget: nextQueued.trigger_options?.thinkingBudget,
        effortLevel: nextQueued.effective_options?.effort ?? nextQueued.trigger_options?.effortLevel,
        reasoningEffort: nextQueued.trigger_options?.reasoningEffort,
      }),
    }).then(async (resp) => {
      if (!resp.ok) {
        const body = await resp.text();
        await failQueuedDispatch(nextQueued.id, publicationOwner, `HTTP ${resp.status}: ${body.slice(0, 500)}`);
      } else {
        logger.info(`[RunQueue] Successfully triggered queued run ${nextQueued.id}`);
      }
    }).catch(async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      await failQueuedDispatch(nextQueued.id, publicationOwner, `HTTP trigger failed: ${message}`);
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
