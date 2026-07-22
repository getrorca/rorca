/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { queryOne, transaction } from '../db/index';
import { ConflictError, ServiceUnavailableError } from './errors';
import { getBoss } from './pg-boss';
import { getPgBossSchemaSql } from './pg-boss-schema';
import { retryHash } from './retry-governance';

export type DispatchPublicationState = 'reserved' | 'preparing' | 'published' | 'claimed' | 'completed' | 'cancelled' | 'failed';

export interface DispatchPublicationClaim {
  outcome: 'acquired' | 'busy' | 'published' | 'claimed' | 'completed' | 'cancelled' | 'failed';
  runId: number;
  owner: string | null;
  bossJobId: string;
  requestHash: string | null;
}

export function pipelineTriggerRequestHash(body: Record<string, unknown>): string {
  const canonical = Object.fromEntries(
    Object.entries(body)
      .filter(([key, value]) => value !== undefined
        && !['queuedRunId', 'reservedRunId', 'dispatchPublicationOwner'].includes(key))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  return retryHash({ schemaVersion: 'rorca.pipeline-trigger-request.v1', request: canonical });
}

function owner(prefix: string): string {
  return `${prefix}:${process.pid}:${randomUUID()}`;
}

export async function claimDispatchPublication(input: {
  runId: number;
  workspaceId: string;
  expectedRequestHash?: string;
  owner?: string;
  allowPublishedRecovery?: boolean;
}): Promise<DispatchPublicationClaim> {
  const leaseOwner = input.owner ?? owner('pipeline-publisher');
  return transaction(async (client: PoolClient) => {
    const run = (await client.query<{ workspace_id: string; status: string; dispatch_request_hash: string | null }>(
      'SELECT workspace_id, status, dispatch_request_hash FROM pipeline_runs WHERE id = $1 FOR UPDATE', [input.runId],
    )).rows[0];
    if (!run || run.workspace_id !== input.workspaceId || run.status !== 'queued') {
      throw new ConflictError('Dispatch publication no longer owns a queued canonical run');
    }
    if (input.expectedRequestHash && run.dispatch_request_hash && run.dispatch_request_hash !== input.expectedRequestHash) {
      throw new ConflictError('Pipeline idempotency key was reused for different trigger options');
    }
    const cancellation = (await client.query<{ run_id: number }>(
      'SELECT run_id FROM pipeline_run_cancellation_requests WHERE run_id = $1 FOR UPDATE', [input.runId],
    )).rows[0];
    if (cancellation) throw new ConflictError('Dispatch publication is fenced by cancellation intent');

    const publication = (await client.query<{
      state: DispatchPublicationState; boss_job_id: string; request_hash: string | null;
      lease_owner: string | null; lease_expires_at: Date | string | null; updated_at: Date | string;
    }>(`SELECT state, boss_job_id::text, request_hash, lease_owner, lease_expires_at, updated_at
          FROM pipeline_dispatch_publications WHERE run_id = $1 FOR UPDATE`, [input.runId])).rows[0];
    if (!publication) throw new ConflictError('Run lacks application dispatch publication authority');
    if (input.expectedRequestHash && publication.request_hash && publication.request_hash !== input.expectedRequestHash) {
      throw new ConflictError('Pipeline idempotency key was reused for a different dispatch request');
    }
    if (['completed', 'cancelled', 'failed'].includes(publication.state)) {
      return { outcome: publication.state as 'completed' | 'cancelled' | 'failed', runId: input.runId, owner: null, bossJobId: publication.boss_job_id, requestHash: publication.request_hash };
    }
    if (publication.state === 'claimed') {
      return { outcome: 'claimed', runId: input.runId, owner: publication.lease_owner, bossJobId: publication.boss_job_id, requestHash: publication.request_hash };
    }
    const leaseActive = publication.lease_expires_at
      && new Date(publication.lease_expires_at).getTime() > Date.now();
    if (publication.state === 'preparing' && leaseActive && publication.lease_owner !== leaseOwner) {
      return { outcome: 'busy', runId: input.runId, owner: publication.lease_owner, bossJobId: publication.boss_job_id, requestHash: publication.request_hash };
    }
    const recentlyPublished = publication.state === 'published'
      && Date.now() - new Date(publication.updated_at).getTime() < 5 * 60_000;
    if (recentlyPublished && !input.allowPublishedRecovery) {
      return { outcome: 'published', runId: input.runId, owner: null, bossJobId: publication.boss_job_id, requestHash: publication.request_hash };
    }
    await client.query(
      `UPDATE pipeline_dispatch_publications
          SET state = 'preparing', lease_owner = $2,
              lease_expires_at = NOW() + INTERVAL '5 minutes', updated_at = NOW(), last_error = NULL,
              request_hash = COALESCE(request_hash, $3)
        WHERE run_id = $1`,
      [input.runId, leaseOwner, input.expectedRequestHash ?? publication.request_hash],
    );
    return { outcome: 'acquired', runId: input.runId, owner: leaseOwner, bossJobId: publication.boss_job_id, requestHash: input.expectedRequestHash ?? publication.request_hash };
  });
}

export async function prepareDispatchPublication(input: {
  runId: number;
  owner: string;
  requestHash: string;
  effectiveOptionsHash: string;
  payload: Record<string, unknown>;
}): Promise<{ bossJobId: string; payloadHash: string }> {
  const payloadHash = retryHash(input.payload);
  const row = await queryOne<{ boss_job_id: string }>(
    `UPDATE pipeline_dispatch_publications
        SET request_hash = COALESCE(request_hash, $3),
            effective_options_hash = COALESCE(effective_options_hash, $4),
            payload_hash = COALESCE(payload_hash, $5), payload = COALESCE(payload, $6::jsonb), updated_at = NOW()
      WHERE run_id = $1 AND state = 'preparing' AND lease_owner = $2
        AND (request_hash IS NULL OR request_hash = $3)
        AND (effective_options_hash IS NULL OR effective_options_hash = $4)
        AND (payload_hash IS NULL OR payload_hash = $5)
        AND (payload IS NULL OR payload = $6::jsonb)
      RETURNING boss_job_id::text`,
    [input.runId, input.owner, input.requestHash, input.effectiveOptionsHash, payloadHash, JSON.stringify(input.payload)],
  );
  if (!row) throw new ConflictError('Dispatch publication lease or immutable payload identity changed');
  return { bossJobId: row.boss_job_id, payloadHash };
}

export async function publishPreparedDispatch(input: {
  runId: number;
  owner: string;
  bossJobId: string;
  payloadHash: string;
  payload: Record<string, unknown>;
}): Promise<string> {
  const boss = getBoss();
  if (typeof boss.createQueue === 'function') await boss.createQueue('pipeline:run');
  const schema = getPgBossSchemaSql();
  const existing = await queryOne<{ id: string }>(
    `SELECT id::text FROM ${schema}.job WHERE id = $1
     UNION ALL SELECT id::text FROM ${schema}.archive WHERE id = $1 LIMIT 1`, [input.bossJobId],
  ).catch(() => undefined);
  const jobId = existing?.id ?? await boss.send('pipeline:run', input.payload, {
    id: input.bossJobId,
    retryLimit: 0,
    expireInSeconds: 300,
  });
  if (!jobId || jobId !== input.bossJobId) {
    throw new ServiceUnavailableError(
      `pg-boss did not preserve the application-owned deterministic dispatch identity (expected ${input.bossJobId}, observed ${String(jobId)})`,
    );
  }
  if (process.env.NODE_ENV === 'test' && process.env.RORCA_PIPELINE_DISPATCH_FAILPOINT === 'after_send_before_published') {
    throw new Error('pipeline_dispatch_failpoint:after_send_before_published');
  }
  const published = await queryOne<{ run_id: number }>(
    `UPDATE pipeline_dispatch_publications
        SET state = 'published', lease_owner = NULL, lease_expires_at = NULL,
            published_at = COALESCE(published_at, NOW()), publish_attempts = publish_attempts + 1, updated_at = NOW()
      WHERE run_id = $1 AND state = 'preparing' AND lease_owner = $2
        AND boss_job_id = $3::uuid AND payload_hash = $4
      RETURNING run_id`,
    [input.runId, input.owner, input.bossJobId, input.payloadHash],
  );
  if (!published) throw new ConflictError('Published transport job did not converge to application outbox authority');
  return jobId;
}

export async function claimDispatchForWorker(input: {
  runId: number; bossJobId: string; payload: Record<string, unknown>; workerId: string;
}): Promise<{ claimed: boolean; reason?: string; workspaceId?: string }> {
  const payloadHash = retryHash(input.payload);
  return transaction(async (client: PoolClient) => {
    const run = (await client.query<{ workspace_id: string; status: string }>(
      'SELECT workspace_id, status FROM pipeline_runs WHERE id = $1 FOR UPDATE', [input.runId],
    )).rows[0];
    if (!run) return { claimed: false, reason: 'run_missing' };
    const cancellation = (await client.query<{ run_id: number }>(
      'SELECT run_id FROM pipeline_run_cancellation_requests WHERE run_id = $1 FOR UPDATE', [input.runId],
    )).rows[0];
    if (cancellation) return { claimed: false, reason: 'cancellation_requested', workspaceId: run.workspace_id };
    const publication = (await client.query<{
      state: DispatchPublicationState; boss_job_id: string; payload_hash: string | null;
      lease_expires_at: Date | string | null;
    }>(`SELECT state, boss_job_id::text, payload_hash, lease_expires_at
          FROM pipeline_dispatch_publications WHERE run_id = $1 FOR UPDATE`, [input.runId])).rows[0];
    if (!publication || publication.boss_job_id !== input.bossJobId || publication.payload_hash !== payloadHash) {
      return { claimed: false, reason: 'publication_identity_mismatch', workspaceId: run.workspace_id };
    }
    if (publication.state === 'completed' || publication.state === 'cancelled' || publication.state === 'failed') {
      return { claimed: false, reason: 'publication_terminal', workspaceId: run.workspace_id };
    }
    if (publication.state === 'claimed') {
      return { claimed: false, reason: 'duplicate_delivery', workspaceId: run.workspace_id };
    }
    if (run.status !== 'queued' || !['preparing', 'published'].includes(publication.state)) {
      return { claimed: false, reason: 'run_not_dispatchable', workspaceId: run.workspace_id };
    }
    await client.query(
      `UPDATE pipeline_dispatch_publications
          SET state = 'claimed', lease_owner = $2, lease_expires_at = NOW() + INTERVAL '10 minutes',
              claimed_at = COALESCE(claimed_at, NOW()), updated_at = NOW()
        WHERE run_id = $1`, [input.runId, input.workerId],
    );
    return { claimed: true, workspaceId: run.workspace_id };
  });
}

export interface DispatchPublicationRecoveryResult {
  scanned: number;
  published: number;
  busy: number;
  failed: number;
}

/**
 * Re-publish only from application-owned immutable payloads after a publisher
 * lease expires or transport retention can no longer prove a published job.
 * The deterministic boss_job_id makes repeated scanners and send ambiguity
 * converge without making pg-boss the execution authority.
 */
export async function recoverPendingDispatchPublications(input: {
  limit?: number;
  stalePublishedAfterSeconds?: number;
} = {}): Promise<DispatchPublicationRecoveryResult> {
  const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)));
  const staleSeconds = Math.max(1, Math.min(86_400, Math.trunc(input.stalePublishedAfterSeconds ?? 300)));
  const candidates = await queryOne<{ run_ids: number[] | null }>(
    `SELECT ARRAY(
       SELECT publication.run_id
         FROM pipeline_dispatch_publications publication
         JOIN pipeline_runs run ON run.id = publication.run_id
        WHERE run.status = 'queued'
          AND publication.payload IS NOT NULL
          AND (
            (publication.state = 'preparing' AND (publication.lease_expires_at IS NULL OR publication.lease_expires_at <= NOW()))
            OR (publication.state = 'published' AND publication.updated_at <= NOW() - ($2 * INTERVAL '1 second'))
          )
        ORDER BY publication.updated_at, publication.run_id
        LIMIT $1
     ) AS run_ids`,
    [limit, staleSeconds],
  );
  const runIds = candidates?.run_ids ?? [];
  const result: DispatchPublicationRecoveryResult = { scanned: runIds.length, published: 0, busy: 0, failed: 0 };

  for (const runIdValue of runIds) {
    const runId = Number(runIdValue);
    const recoveryOwner = owner('pipeline-recovery');
    try {
      const identity = await queryOne<{ workspace_id: string; request_hash: string | null }>(
        `SELECT run.workspace_id, publication.request_hash
           FROM pipeline_runs run
           JOIN pipeline_dispatch_publications publication ON publication.run_id = run.id
          WHERE run.id = $1`,
        [runId],
      );
      if (!identity) {
        result.failed += 1;
        continue;
      }
      const claim = await claimDispatchPublication({
        runId,
        workspaceId: identity.workspace_id,
        expectedRequestHash: identity.request_hash ?? undefined,
        owner: recoveryOwner,
        allowPublishedRecovery: true,
      });
      if (claim.outcome !== 'acquired' || !claim.owner) {
        result.busy += 1;
        continue;
      }
      const prepared = await queryOne<{
        boss_job_id: string;
        payload_hash: string | null;
        payload: Record<string, unknown> | null;
      }>(
        `SELECT boss_job_id::text, payload_hash, payload
           FROM pipeline_dispatch_publications
          WHERE run_id = $1 AND state = 'preparing' AND lease_owner = $2`,
        [runId, claim.owner],
      );
      if (!prepared?.payload || !prepared.payload_hash || retryHash(prepared.payload) !== prepared.payload_hash) {
        throw new ConflictError('Recoverable dispatch publication has no valid immutable payload');
      }
      await publishPreparedDispatch({
        runId,
        owner: claim.owner,
        bossJobId: prepared.boss_job_id,
        payloadHash: prepared.payload_hash,
        payload: prepared.payload,
      });
      result.published += 1;
    } catch (error) {
      result.failed += 1;
      await releaseDispatchPublication(
        runId,
        recoveryOwner,
        error instanceof Error ? error.message : 'dispatch publication recovery failed',
      ).catch(() => undefined);
    }
  }
  return result;
}

export async function releaseDispatchPublication(runId: number, ownerId: string, reason: string): Promise<void> {
  await queryOne(
    `UPDATE pipeline_dispatch_publications
        SET state = CASE WHEN payload IS NULL THEN 'reserved' ELSE 'published' END,
            lease_owner = NULL, lease_expires_at = NULL, last_error = $3, updated_at = NOW()
      WHERE run_id = $1 AND state = 'preparing' AND lease_owner = $2 RETURNING run_id`,
    [runId, ownerId, reason.slice(0, 1000)],
  );
}
