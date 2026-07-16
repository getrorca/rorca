/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Bounded recovery telemetry for external recovery supervisors.
 *
 * This is deliberately a projection of Rorca's worker heartbeat and canonical
 * pipeline queue. It never returns pg-boss jobs, job payloads, command lines,
 * paths, logs, or environment values.
 */
import { query } from '../db/index';
import { getWorkspaceRecoveryQueueSummary } from './run-queue';
import { getLatestWorkerHeartbeat, isWorkerHeartbeatStale, WORKER_HEARTBEAT_STALE_MS } from './worker-heartbeat';

const MAX_RUNS = 20;

interface RecoveryRunRow {
  id: number | string;
  status: string;
  queued_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  last_heartbeat: string | null;
}

export interface RecoveryTelemetry {
  contractVersion: 'v1';
  available: true;
  redacted: true;
  /** Timestamp at which this bounded projection was observed. */
  observedAt: string;
  workspaceId: string;
  worker: {
    active: boolean;
    heartbeatAgeSeconds: number | null;
    staleAfterSeconds: number;
    activeChildProcesses: number;
  };
  queue: {
    health: 'healthy' | 'degraded' | 'critical';
    queued: number;
    active: number;
    oldestQueuedAgeSeconds: number | null;
    staleActive: number;
  };
  runs: Array<{
    /** Bounded canonical run attribution; no job payload or path is exposed. */
    runId: number;
    status: string;
    ageSeconds: number;
    heartbeatAgeSeconds: number | null;
  }>;
  limits: { maxRuns: number; returnedRuns: number };
}

function ageSeconds(value: string | null, now: number): number {
  if (!value) return 0;
  return Math.max(0, Math.floor((now - new Date(value).getTime()) / 1000));
}

function queueHealth(summary: Awaited<ReturnType<typeof getWorkspaceRecoveryQueueSummary>>, workerActive: boolean): 'healthy' | 'degraded' | 'critical' {
  if (summary.staleActive > 0 || (summary.queued > 0 && !workerActive)) return 'critical';
  if ((summary.oldestQueuedAgeSeconds ?? 0) > 300 || summary.queued > 0) return 'degraded';
  return 'healthy';
}

/** Read-only, bounded recovery projection backed by existing Rorca services. */
export async function getRecoveryTelemetry(workspaceId: string): Promise<RecoveryTelemetry> {
  const [heartbeat, queue, runRows] = await Promise.all([
    getLatestWorkerHeartbeat(),
    getWorkspaceRecoveryQueueSummary(workspaceId),
    query<RecoveryRunRow>(
      `SELECT id, status, queued_at, started_at, finished_at, last_heartbeat
       FROM pipeline_runs
       WHERE workspace_id = $1
         AND status IN ('queued', 'running', 'paused', 'failed', 'cancelled')
       ORDER BY COALESCE(last_heartbeat, started_at, queued_at, finished_at) DESC NULLS LAST
       LIMIT $2`,
      [workspaceId, MAX_RUNS],
    ),
  ]);

  const now = Date.now();
  const workerActive = heartbeat ? !isWorkerHeartbeatStale(heartbeat.last_seen, now) : false;
  const workerHeartbeatAge = heartbeat ? ageSeconds(heartbeat.last_seen, now) : null;
  const runs = runRows.map((run) => ({
    runId: Number(run.id),
    status: run.status,
    ageSeconds: ageSeconds(run.started_at ?? run.queued_at ?? run.finished_at, now),
    heartbeatAgeSeconds: run.last_heartbeat ? ageSeconds(run.last_heartbeat, now) : null,
  }));

  return {
    contractVersion: 'v1',
    available: true,
    redacted: true,
    observedAt: new Date(now).toISOString(),
    workspaceId,
    worker: {
      active: workerActive,
      heartbeatAgeSeconds: workerHeartbeatAge,
      staleAfterSeconds: Math.floor(WORKER_HEARTBEAT_STALE_MS / 1000),
      activeChildProcesses: Math.max(0, heartbeat?.active_jobs ?? 0),
    },
    queue: {
      health: queueHealth(queue, workerActive),
      queued: queue.queued,
      active: queue.active,
      oldestQueuedAgeSeconds: queue.oldestQueuedAgeSeconds,
      staleActive: queue.staleActive,
    },
    runs,
    limits: { maxRuns: MAX_RUNS, returnedRuns: runs.length },
  };
}
