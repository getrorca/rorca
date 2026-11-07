/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { PoolClient } from 'pg';
import { query, transaction } from '../db/index';
import { ConflictError } from './errors';
import { linkEcoManagedCloseout } from './eco-managed-runtime';
import type { RetryRunCloseoutEvidence } from './governed-story-retry';
import { assertNotProtectedWave1Run } from './wave-1-stabilization';
import { inspectRunHostAuthority } from './run-host-authority';
import { assertTaskManifestHostFileScope } from './task-manifest-run-lineage';
import {
  assertExactTrustedWalRow,
  insertTrustedWalEvent,
  stableWalJson,
  trustedWalReference,
  type TrustedWalReference,
  type TrustedWalRow,
} from './trusted-wal';

export const HOST_RUN_CLOSEOUT_VERSION = 'rorca.host-run-closeout.v1' as const;
export type HostRunCloseoutStatus = 'done' | 'failed' | 'partial_failure' | 'cancelled';

export interface HostRunCloseoutPayload {
  schemaVersion: typeof HOST_RUN_CLOSEOUT_VERSION;
  run_id: number;
  status: HostRunCloseoutStatus;
  integrated_revision: string;
  integration_ancestry: string[];
  accepted_story_ids: string[];
  governed_retry_dispatch_identity: string | null;
  semantic_closeout: true;
}

export interface PreparedHostRunCloseout {
  runId: number;
  workspaceId: string;
  specId: string;
  status: HostRunCloseoutStatus;
  payload: HostRunCloseoutPayload;
}

function parsePayload(value: unknown): HostRunCloseoutPayload {
  const payload = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') {
    throw new ConflictError('Host run closeout payload is not an object');
  }
  const candidate = payload as Partial<HostRunCloseoutPayload>;
  if (candidate.schemaVersion !== HOST_RUN_CLOSEOUT_VERSION
    || !Number.isSafeInteger(candidate.run_id) || Number(candidate.run_id) <= 0
    || !['done', 'failed', 'partial_failure', 'cancelled'].includes(String(candidate.status))
    || !/^[a-f0-9]{40}$/.test(String(candidate.integrated_revision ?? ''))
    || !Array.isArray(candidate.integration_ancestry)
    || candidate.integration_ancestry.some((sha) => !/^[a-f0-9]{40}$/.test(String(sha)))
    || !Array.isArray(candidate.accepted_story_ids)
    || candidate.accepted_story_ids.some((storyId) => typeof storyId !== 'string' || !storyId)
    || new Set(candidate.accepted_story_ids).size !== candidate.accepted_story_ids.length
    || candidate.semantic_closeout !== true
    || !(candidate.governed_retry_dispatch_identity === null
      || /^sha256:[a-f0-9]{64}$/.test(String(candidate.governed_retry_dispatch_identity)))) {
    throw new ConflictError('Host run closeout payload is incomplete or invalid');
  }
  if (candidate.integration_ancestry.at(-1) !== candidate.integrated_revision) {
    throw new ConflictError('Host run closeout ancestry does not terminate at its integrated revision');
  }
  if ([...candidate.accepted_story_ids].sort((a, b) => a.localeCompare(b))
    .some((storyId, index) => storyId !== candidate.accepted_story_ids![index])) {
    throw new ConflictError('Host run closeout accepted stories must be sorted');
  }
  return candidate as HostRunCloseoutPayload;
}

export async function prepareHostRunCloseout(input: {
  runId: number;
  status: HostRunCloseoutStatus;
  governedRetryDispatchIdentity?: string | null;
}): Promise<PreparedHostRunCloseout> {
  assertNotProtectedWave1Run(input.runId);
  const authority = await inspectRunHostAuthority(
    input.runId,
    undefined,
    { allowPostCancellationRecoveryConflicts: input.status === 'cancelled' },
  );
  if (!authority || !authority.closeoutEligible || !authority.terminalRevision) {
    // A present but incomplete run can legitimately have invalidReason=null:
    // absence of terminal story results is not a contradictory authority row.
    // Do not misreport that ordinary denial as a failed run lookup.
    const missingStories = authority?.expectedStoryIds.filter(
      (storyId) => !authority.stories.some((story) => story.storyId === storyId),
    ) ?? [];
    const reason = !authority ? 'run not found'
      : authority.invalidReason ?? (missingStories.length > 0
        ? `frozen story scope is incomplete: ${missingStories.join(', ')}`
        : !authority.terminalRevision ? 'canonical terminal revision is unavailable'
          : 'host closeout eligibility is unavailable');
    throw new ConflictError(`Run lacks exact host closeout authority: ${reason}`);
  }
  if (input.status === 'done' && !authority.releaseEligible) {
    throw new ConflictError('Successful closeout requires complete release-eligible host authority');
  }
  const taskManifestRun = (await query<{ task_manifest_id: string | null }>(
    'SELECT task_manifest_id FROM pipeline_runs WHERE id = $1', [input.runId],
  ))[0];
  if (taskManifestRun?.task_manifest_id) {
    await assertTaskManifestHostFileScope({
      runId: input.runId,
      workspacePath: authority.repositoryTopLevel,
      repositoryPath: authority.checkoutPath,
      terminalRevision: authority.terminalRevision,
    });
  }
  const dispatchIdentity = input.governedRetryDispatchIdentity ?? null;
  if (dispatchIdentity !== null && !/^sha256:[a-f0-9]{64}$/.test(dispatchIdentity)) {
    throw new ConflictError('Governed retry dispatch identity is invalid');
  }
  const payload: HostRunCloseoutPayload = {
    schemaVersion: HOST_RUN_CLOSEOUT_VERSION,
    run_id: authority.runId,
    status: input.status,
    integrated_revision: authority.terminalRevision,
    integration_ancestry: [...authority.integrationAncestry],
    accepted_story_ids: [...authority.acceptedStoryIds],
    governed_retry_dispatch_identity: dispatchIdentity,
    semantic_closeout: true,
  };
  parsePayload(payload);
  return {
    runId: authority.runId,
    workspaceId: authority.workspaceId,
    specId: authority.specId,
    status: input.status,
    payload,
  };
}

export async function insertPreparedHostRunCloseout(
  client: PoolClient,
  prepared: PreparedHostRunCloseout,
): Promise<TrustedWalReference> {
  assertNotProtectedWave1Run(prepared.runId);
  const run = (await client.query<{
    id: number | string; workspace_id: string; spec_path: string; host_closeout_event_id: number | null; trigger_options?: Record<string,unknown>;
  }>(
    `SELECT id, workspace_id, spec_path, host_closeout_event_id, trigger_options
     FROM pipeline_runs WHERE id = $1 FOR UPDATE`,
    [prepared.runId],
  )).rows[0];
  if (!run || run.workspace_id !== prepared.workspaceId) {
    throw new ConflictError('Prepared host closeout no longer owns the canonical run');
  }

  // The canonical run row is the transaction-scoped serialization boundary;
  // callers must not compose a second advisory namespace around this insert.
  // The caller's snapshot is proposal-only. Re-derive DB/Git authority while
  // the canonical run row is locked, compare every authority field, and bind
  // the observed HEAD as an immutable checkout fence before writing closeout.
  const canonical = await prepareHostRunCloseout({
    runId: prepared.runId,
    status: prepared.status,
    governedRetryDispatchIdentity: prepared.payload.governed_retry_dispatch_identity,
  });
  if (!samePreparedHostCloseout(prepared, canonical)) {
    throw new ConflictError('Host closeout authority changed before immutable publication');
  }
  const fenced = await client.query(
    `UPDATE pipeline_runs
     SET terminal_checkout_sha = COALESCE(terminal_checkout_sha, $2),
         terminal_checkout_attested_at = COALESCE(terminal_checkout_attested_at, NOW())
     WHERE id = $1 AND workspace_id = $3
       AND (terminal_checkout_sha IS NULL OR terminal_checkout_sha = $2)
     RETURNING id`,
    [canonical.runId, canonical.payload.integrated_revision, canonical.workspaceId],
  );
  if (fenced.rowCount !== 1) throw new ConflictError('Canonical Git checkout fence changed before closeout');

  const inserted = await insertTrustedWalEvent(client, {
    eventType: 'run_closeout',
    workspaceId: prepared.workspaceId,
    runId: prepared.runId,
    specId: prepared.specId,
    source: 'worker',
    payload: prepared.payload as unknown as Record<string, unknown>,
  });
  const reference = trustedWalReference(inserted.row);
  const finalCanonical = await prepareHostRunCloseout({
    runId: canonical.runId,
    status: canonical.status,
    governedRetryDispatchIdentity: canonical.payload.governed_retry_dispatch_identity,
  });
  if (!samePreparedHostCloseout(canonical, finalCanonical)) {
    throw new ConflictError('Host closeout DB/Git authority changed during immutable publication');
  }
  if (run.host_closeout_event_id != null && Number(run.host_closeout_event_id) !== reference.id) {
    throw new ConflictError('Run already points to a different immutable host closeout');
  }
  const bound = await client.query(
    `UPDATE pipeline_runs
     SET host_closeout_event_id = COALESCE(host_closeout_event_id, $2)
     WHERE id = $1 AND workspace_id = $3
       AND (host_closeout_event_id IS NULL OR host_closeout_event_id = $2)
     RETURNING id`,
    [prepared.runId, reference.id, prepared.workspaceId],
  );
  if (bound.rowCount !== 1) throw new ConflictError('Host closeout pointer did not bind canonical run');
  if (run.trigger_options?.ecoManagedAdmission) await linkEcoManagedCloseout(client, prepared.runId);
  return reference;
}

export async function terminalizePreparedHostRunCloseout(
  client: PoolClient,
  prepared: PreparedHostRunCloseout,
): Promise<TrustedWalReference> {
  if (prepared.status === 'done') {
    throw new ConflictError('Successful release closeout cannot use failure terminalization');
  }
  const closeout = await insertPreparedHostRunCloseout(client, prepared);
  const publicStatus = prepared.status === 'cancelled'
    ? 'cancelled'
    : prepared.status === 'partial_failure' ? 'partial_failure' : 'failed';
  const lifecycleStatus = prepared.status === 'cancelled' ? 'cancelled' : 'failed';
  const terminalized = await client.query(
    `UPDATE pipeline_runs
     SET status = $2, lifecycle_status = $3, lifecycle_updated_at = NOW(),
         finished_at = COALESCE(finished_at, NOW()), pid = NULL, worker_id = NULL,
         queue_position = NULL
     WHERE id = $1 AND workspace_id = $4
       AND status NOT IN ('done','failed','partial_failure','cancelled')
     RETURNING id`,
    [prepared.runId, publicStatus, lifecycleStatus, prepared.workspaceId],
  );
  if (terminalized.rowCount !== 1) throw new ConflictError('Host closeout could not terminalize canonical run');

  const terminal = await insertTrustedWalEvent(client, {
    eventType: 'run_finished',
    workspaceId: prepared.workspaceId,
    runId: prepared.runId,
    specId: prepared.specId,
    source: 'worker',
    payload: {
      run_id: prepared.runId,
      status: prepared.status,
      host_closeout_event_id: closeout.id,
      host_closeout_identity_hash: closeout.identityHash,
      semantic_closeout: true,
    },
  });
  const ready = await client.query(
    `UPDATE wal_events SET outbox_ready_at = COALESCE(outbox_ready_at, NOW())
     WHERE id = ANY($1::int[]) AND trust_provenance = 'host'
     RETURNING id`,
    [[closeout.id, terminal.row.id]],
  );
  if (ready.rowCount !== 2) throw new ConflictError('Failure closeout and terminal outbox were not released atomically');
  return closeout;
}

export async function persistHostRunCloseout(input: {
  runId: number;
  status: HostRunCloseoutStatus;
  governedRetryDispatchIdentity?: string | null;
  terminalizeRun: boolean;
  /** Exact worker/retry generation which observed the process outcome. */
  expectedDispatchFence?: string | null;
}): Promise<TrustedWalReference> {
  assertNotProtectedWave1Run(input.runId);
  return transaction(async (client) => {
    // Canonical lock order is advisory run fence -> run row -> cancellation and
    // retry rows -> closeout/evidence. Cancellation, retry publication, worker
    // closeout, and reconciliation all share this first fence.
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`pipeline-run-authority:${input.runId}`],
    );
    const locked = (await client.query<{
      id: number | string; status: string; dispatch_fence: string | null;
      cancellation_requested: boolean;
    }>(`
      SELECT run.id, run.status, run.dispatch_fence,
             EXISTS (
               SELECT 1 FROM pipeline_run_cancellation_requests cancellation
                WHERE cancellation.run_id = run.id
             ) OR EXISTS (
               SELECT 1 FROM governed_retry_dispatches retry
                WHERE retry.retry_run_id = run.id
                  AND retry.cancellation_requested_at IS NOT NULL
             ) AS cancellation_requested
        FROM pipeline_runs run WHERE run.id = $1 FOR UPDATE
    `, [input.runId])).rows[0];
    if (!locked) throw new ConflictError('Run not found for host closeout');
    if (input.expectedDispatchFence !== undefined
      && locked.dispatch_fence !== input.expectedDispatchFence) {
      throw new ConflictError('Worker host closeout lost its exact dispatch fence');
    }
    if (locked.cancellation_requested && input.status !== 'cancelled') {
      throw new ConflictError('Durable cancellation authority supersedes late worker closeout');
    }
    if (locked.status === 'cancelled' && input.status !== 'cancelled') {
      throw new ConflictError('Cancelled run cannot be replaced by worker closeout');
    }
    if (['done', 'failed', 'partial_failure'].includes(locked.status)
      && locked.status !== input.status) {
      throw new ConflictError(`Terminal run status ${locked.status} rejects contradictory worker closeout ${input.status}`);
    }
    const prepared = await prepareHostRunCloseout(input);
    if (input.terminalizeRun && prepared.status !== 'done') {
      return terminalizePreparedHostRunCloseout(client, prepared);
    }
    const closeout = await insertPreparedHostRunCloseout(client, prepared);
    if (input.terminalizeRun) {
      const terminalized = await client.query(
        `UPDATE pipeline_runs
         SET status = 'done', lifecycle_status = 'finished', lifecycle_updated_at = NOW(),
             finished_at = COALESCE(finished_at, NOW()), pid = NULL, worker_id = NULL,
             queue_position = NULL
         WHERE id = $1 AND workspace_id = $2
           AND status NOT IN ('done','failed','partial_failure','cancelled')
         RETURNING id`,
        [prepared.runId, prepared.workspaceId],
      );
      if (terminalized.rowCount !== 1) throw new ConflictError('Host closeout could not terminalize canonical run');
    }
    return closeout;
  });
}

export async function loadHostRunCloseoutReference(runId: number): Promise<{
  reference: TrustedWalReference;
  payload: HostRunCloseoutPayload;
  ready: boolean;
}> {
  assertNotProtectedWave1Run(runId);
  const rows = await query<TrustedWalRow & { pointer_run_id: number | string }>(
    `SELECT wal.*, run.id AS pointer_run_id
     FROM pipeline_runs run
     JOIN wal_events wal ON wal.id = run.host_closeout_event_id
     WHERE run.id = $1
       AND wal.event_type = 'run_closeout'
       AND wal.trust_provenance = 'host'
       AND wal.trusted_source = 'worker'
       AND wal.canonical_run_id = run.id
       AND wal.workspace_id = run.workspace_id`,
    [runId],
  );
  const row = rows[0];
  if (!row) throw new ConflictError('Canonical host closeout reference is unavailable');
  assertExactTrustedWalRow(row);
  const payload = parsePayload(row.payload);
  if (payload.run_id !== Number(row.pointer_run_id)) {
    throw new ConflictError('Canonical host closeout does not bind its pointer run');
  }
  return { reference: trustedWalReference(row), payload, ready: row.outbox_ready_at !== null };
}

export async function loadHostRunCloseoutEvidence(runIds: number[]): Promise<RetryRunCloseoutEvidence[]> {
  for (const runId of runIds) assertNotProtectedWave1Run(runId);
  const unique = [...new Set(runIds)];
  if (unique.length === 0) return [];
  const rows = await query<TrustedWalRow & { pointer_run_id: number | string }>(
    `SELECT wal.*, run.id AS pointer_run_id
     FROM pipeline_runs run
     JOIN wal_events wal ON wal.id = run.host_closeout_event_id
     WHERE run.id = ANY($1::bigint[])
       AND wal.event_type = 'run_closeout'
       AND wal.trust_provenance = 'host'
       AND wal.trusted_source = 'worker'
       AND wal.canonical_run_id = run.id
       AND wal.workspace_id = run.workspace_id
       AND wal.outbox_ready_at IS NOT NULL
     ORDER BY array_position($1::bigint[], run.id)`,
    [unique],
  );
  return rows.map((row) => {
    assertExactTrustedWalRow(row);
    const payload = parsePayload(row.payload);
    if (payload.run_id !== Number(row.pointer_run_id)
      || payload.run_id !== Number(row.canonical_run_id)) {
      throw new ConflictError('Host closeout payload does not bind its pointer run');
    }
    return {
      runId: payload.run_id,
      status: payload.status === 'done' ? 'done'
        : payload.status === 'partial_failure' ? 'partial_failure' : 'failed',
      integratedRevision: payload.integrated_revision,
      integrationAncestry: [...payload.integration_ancestry],
      acceptedStoryIds: [...payload.accepted_story_ids],
      evidenceIdentity: `trusted-wal:${row.id}:${row.event_identity_hash}`,
    };
  });
}

export function samePreparedHostCloseout(left: PreparedHostRunCloseout, right: PreparedHostRunCloseout): boolean {
  return stableWalJson(left) === stableWalJson(right);
}
