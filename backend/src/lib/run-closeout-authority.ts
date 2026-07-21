/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { PoolClient } from 'pg';
import { query, transaction } from '../db/index';
import { ConflictError } from './errors';
import type { RetryRunCloseoutEvidence } from './governed-story-retry';
import { inspectRunHostAuthority } from './run-host-authority';
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
  const authority = await inspectRunHostAuthority(input.runId);
  if (!authority || !authority.closeoutEligible || !authority.terminalRevision) {
    throw new ConflictError(`Run lacks exact host closeout authority: ${authority?.invalidReason ?? 'run not found'}`);
  }
  if (input.status === 'done' && !authority.releaseEligible) {
    throw new ConflictError('Successful closeout requires complete release-eligible host authority');
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
  const run = (await client.query<{
    id: number | string; workspace_id: string; spec_path: string; host_closeout_event_id: number | null;
  }>(
    `SELECT id, workspace_id, spec_path, host_closeout_event_id
     FROM pipeline_runs WHERE id = $1 FOR UPDATE`,
    [prepared.runId],
  )).rows[0];
  if (!run || run.workspace_id !== prepared.workspaceId) {
    throw new ConflictError('Prepared host closeout no longer owns the canonical run');
  }
  const inserted = await insertTrustedWalEvent(client, {
    eventType: 'run_closeout',
    workspaceId: prepared.workspaceId,
    runId: prepared.runId,
    specId: prepared.specId,
    source: 'worker',
    payload: prepared.payload as unknown as Record<string, unknown>,
  });
  const reference = trustedWalReference(inserted.row);
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
}): Promise<TrustedWalReference> {
  const prepared = await prepareHostRunCloseout(input);
  return transaction(async (client) => {
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
