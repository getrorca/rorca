/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Backend-owned pipeline run lifecycle.
 *
 * `pipeline_runs.status` remains a compatibility/result field. This module is
 * the only source for phase semantics exposed to API/UI: transports and the
 * frontend never infer lifecycle from output timing or process state.
 */
import { execute, queryOne } from '../db/index';

export const RUN_LIFECYCLE_STATES = [
  'queued',
  'waiting_for_authorization',
  'waiting_for_authentication',
  'waiting_for_change_window',
  'starting',
  'pty_attached',
  'running',
  'validating',
  'finished',
  'failed',
  'cancelled',
] as const;

export type RunLifecycleStatus = typeof RUN_LIFECYCLE_STATES[number];

type LifecycleRow = { lifecycle_status: RunLifecycleStatus };

const ALLOWED_NEXT: Record<RunLifecycleStatus, readonly RunLifecycleStatus[]> = {
  queued: ['waiting_for_authorization', 'waiting_for_authentication', 'waiting_for_change_window', 'starting', 'failed', 'cancelled'],
  waiting_for_authorization: ['queued', 'waiting_for_authentication', 'waiting_for_change_window', 'failed', 'cancelled'],
  waiting_for_authentication: ['queued', 'waiting_for_authorization', 'waiting_for_change_window', 'failed', 'cancelled'],
  waiting_for_change_window: ['queued', 'waiting_for_authorization', 'waiting_for_authentication', 'failed', 'cancelled'],
  starting: ['pty_attached', 'running', 'validating', 'failed', 'cancelled'],
  pty_attached: ['running', 'validating', 'failed', 'cancelled'],
  running: ['validating', 'failed', 'cancelled'],
  validating: ['finished', 'failed', 'cancelled'],
  finished: [],
  failed: [],
  cancelled: [],
};

export function isTerminalRunLifecycle(status: RunLifecycleStatus | null | undefined): boolean {
  return status === 'finished' || status === 'failed' || status === 'cancelled';
}

/** Derives a lifecycle for pre-v2 rows and test fixtures that lack the column. */
export function lifecycleFromLegacyStatus(status: string | null | undefined): RunLifecycleStatus {
  switch (status) {
    case 'queued': return 'queued';
    case 'WAITING_FOR_AUTHORIZATION': return 'waiting_for_authorization';
    case 'WAITING_FOR_AUTHENTICATION': return 'waiting_for_authentication';
    case 'WAITING_FOR_CHANGE_WINDOW': return 'waiting_for_change_window';
    case 'cancelled': return 'cancelled';
    case 'done': return 'finished';
    case 'partial_failure':
    case 'failed': return 'failed';
    default: return 'running';
  }
}

/**
 * Advance exactly one backend-owned lifecycle. Repeated writes are idempotent;
 * backward/terminal transitions fail closed rather than reviving a run.
 */
export async function transitionRunLifecycle(
  runId: number,
  next: RunLifecycleStatus,
  diagnostics: Record<string, unknown> = {},
): Promise<boolean> {
  const row = await queryOne<LifecycleRow>(
    'SELECT lifecycle_status FROM pipeline_runs WHERE id = $1',
    [runId],
  );
  if (!row) return false;
  const current = row.lifecycle_status;
  if (current === next) {
    if (Object.keys(diagnostics).length > 0) {
      await execute(
        `UPDATE pipeline_runs
         SET lifecycle_diagnostics = lifecycle_diagnostics || $2::jsonb,
             lifecycle_updated_at = NOW()
         WHERE id = $1`,
        [runId, JSON.stringify(diagnostics)],
      );
    }
    return true;
  }
  if (!ALLOWED_NEXT[current]?.includes(next)) return false;

  const result = await execute(
    `UPDATE pipeline_runs
     SET lifecycle_status = $2,
         lifecycle_diagnostics = lifecycle_diagnostics || $3::jsonb,
         lifecycle_updated_at = NOW()
     WHERE id = $1 AND lifecycle_status = $4`,
    [runId, next, JSON.stringify(diagnostics), current],
  );
  return result.rowCount === 1;
}

/**
 * Attach one sequential PTY story without moving a run-level lifecycle
 * backwards between stories. The first story advances starting → pty_attached;
 * later stories keep the already-authoritative running phase and only merge
 * fresh diagnostics.
 */
export async function attachRunPtyLifecycle(
  runId: number,
  diagnostics: Record<string, unknown> = {},
): Promise<boolean> {
  const row = await queryOne<LifecycleRow>(
    'SELECT lifecycle_status FROM pipeline_runs WHERE id = $1',
    [runId],
  );
  if (!row) return false;
  if (row.lifecycle_status === 'starting') {
    return transitionRunLifecycle(runId, 'pty_attached', diagnostics);
  }
  if (row.lifecycle_status === 'pty_attached' || row.lifecycle_status === 'running') {
    return transitionRunLifecycle(runId, row.lifecycle_status, diagnostics);
  }
  return false;
}
