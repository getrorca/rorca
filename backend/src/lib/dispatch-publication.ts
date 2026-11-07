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
import { pipelineExecutionJobSendOptions } from './pipeline-job-lifecycle';
import { retryHash } from './retry-governance';
import { assertEcoDispatch, requireEcoBoundedExecutor } from './eco-managed-runtime';
import {
  assertLifecycleDispatchClaim,
  parseLifecycleDispatchClaim,
  withLifecycleDispatchClaimLock,
} from './lifecycle-dispatch-claim';

export type DispatchPublicationState = 'reserved' | 'preparing' | 'published' | 'claimed' | 'completed' | 'cancelled' | 'failed';

export const PIPELINE_RUN_QUEUE = 'pipeline:run' as const;
export const PIPELINE_DIRECT_RUN_QUEUE = 'pipeline:run:direct' as const;

export function pipelineRunQueueForPayload(payload: Record<string, unknown>):
  typeof PIPELINE_RUN_QUEUE | typeof PIPELINE_DIRECT_RUN_QUEUE {
  return typeof payload.worktreePath === 'string' && payload.worktreePath.length > 0
    ? PIPELINE_RUN_QUEUE
    : PIPELINE_DIRECT_RUN_QUEUE;
}

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
    const run = (await client.query<{
      workspace_id: string; status: string; dispatch_request_hash: string | null;
      campaign_dispatch_authorization_hash: string | null;
    }>(
      `SELECT workspace_id, status, dispatch_request_hash, campaign_dispatch_authorization_hash
         FROM pipeline_runs WHERE id = $1 FOR UPDATE`, [input.runId],
    )).rows[0];
    if (!run || run.workspace_id !== input.workspaceId || run.status !== 'queued') {
      throw new ConflictError('Dispatch publication no longer owns a queued canonical run');
    }
    if (input.expectedRequestHash && run.dispatch_request_hash && run.dispatch_request_hash !== input.expectedRequestHash) {
      throw new ConflictError('Pipeline idempotency key was reused for different trigger options');
    }
    if (run.campaign_dispatch_authorization_hash) {
      const consumed = (await client.query<{ run_id: number; request_hash: string }>(
        `SELECT run_id, request_hash FROM campaign_dispatch_authorizations
          WHERE authorization_hash = $1 FOR SHARE`,
        [run.campaign_dispatch_authorization_hash],
      )).rows[0];
      if (!consumed || Number(consumed.run_id) !== input.runId
        || consumed.request_hash !== run.dispatch_request_hash) {
        throw new ConflictError('Campaign run lacks exact consumed dispatch authorization authority');
      }
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
}, transactionClient?: Pick<PoolClient, 'query'>): Promise<{ bossJobId: string; payloadHash: string; queueName: typeof PIPELINE_RUN_QUEUE | typeof PIPELINE_DIRECT_RUN_QUEUE }> {
  const payloadHash = retryHash(input.payload);
  const queueName = pipelineRunQueueForPayload(input.payload);
  const managed = Boolean((input.payload.triggerOptions as Record<string, unknown> | undefined)?.ecoManagedAdmission);
  const update = async (client?: Pick<PoolClient, 'query'>) => {
    if (client) await assertEcoDispatch(client, input.runId, input.payload);
    const sql = `UPDATE pipeline_dispatch_publications
        SET request_hash = COALESCE(request_hash, $3),
            effective_options_hash = COALESCE(effective_options_hash, $4),
            payload_hash = COALESCE(payload_hash, $5), payload = COALESCE(payload, $6::jsonb),
            queue_name = CASE WHEN payload IS NULL THEN $7 ELSE queue_name END,
            updated_at = NOW()
      WHERE run_id = $1 AND state = 'preparing' AND lease_owner = $2
        AND (request_hash IS NULL OR request_hash = $3)
        AND (effective_options_hash IS NULL OR effective_options_hash = $4)
        AND (payload_hash IS NULL OR payload_hash = $5)
        AND (payload IS NULL OR (payload = $6::jsonb AND queue_name = $7))
        AND ($8::boolean OR NOT EXISTS(SELECT 1 FROM pipeline_runs run WHERE run.id=$1 AND run.trigger_options ? 'ecoManagedAdmission'))
      RETURNING boss_job_id::text, queue_name`;
    const params = [input.runId, input.owner, input.requestHash, input.effectiveOptionsHash, payloadHash, JSON.stringify(input.payload), queueName, managed];
    type Row = {boss_job_id:string;queue_name:typeof PIPELINE_RUN_QUEUE | typeof PIPELINE_DIRECT_RUN_QUEUE};
    const row = client ? (await client.query<Row>(sql,params)).rows[0] : await queryOne<Row>(sql,params);
    if (!row) throw new ConflictError('Dispatch publication lease, queue lane, or immutable payload identity changed');
    return { bossJobId: row.boss_job_id, payloadHash, queueName: row.queue_name };
  };
  // Reuse the explicit lifecycle-lock transaction; never open a nested one.
  return transactionClient ? update(transactionClient) : managed ? transaction(update) : update();
}

export async function publishPreparedDispatch(input: {
  runId: number;
  owner: string;
  bossJobId: string;
  payloadHash: string;
  payload: Record<string, unknown>;
}): Promise<string> {
  const triggerOptions = input.payload.triggerOptions;
  const lifecycleDispatchClaim = parseLifecycleDispatchClaim(
    triggerOptions && typeof triggerOptions === 'object' && !Array.isArray(triggerOptions)
      ? (triggerOptions as Record<string, unknown>).lifecycleDispatchClaim
      : undefined,
  );
  if (!lifecycleDispatchClaim) {
    throw new ConflictError('Prepared dispatch lacks an immutable lifecycle dispatch claim');
  }
  return withLifecycleDispatchClaimLock(lifecycleDispatchClaim, async (client) => {
    const linkedRun = await queryOne<{
      trigger_options: unknown;
      queue_name: typeof PIPELINE_RUN_QUEUE | typeof PIPELINE_DIRECT_RUN_QUEUE;
    }>(
      `SELECT run.trigger_options, publication.queue_name
         FROM pipeline_runs run
         JOIN pipeline_dispatch_publications publication ON publication.run_id = run.id
        WHERE run.id = $1`,
      [input.runId],
    );
    const linkedTriggerOptions = linkedRun?.trigger_options
      && typeof linkedRun.trigger_options === 'object'
      && !Array.isArray(linkedRun.trigger_options)
      ? linkedRun.trigger_options as Record<string, unknown>
      : undefined;
    const linkedClaim = parseLifecycleDispatchClaim(linkedTriggerOptions?.lifecycleDispatchClaim);
    if (linkedTriggerOptions?.ecoManagedAdmission || (input.payload.triggerOptions as Record<string, unknown> | undefined)?.ecoManagedAdmission) {
      const managedScope = await assertEcoDispatch(client, input.runId, input.payload);
      if (managedScope) requireEcoBoundedExecutor(managedScope);
    }
    if (!linkedClaim || retryHash(linkedClaim) !== retryHash(lifecycleDispatchClaim)) {
      throw new ConflictError('Prepared dispatch lifecycle claim does not match its pipeline run');
    }
    const queueName = linkedRun?.queue_name;
    if (queueName !== PIPELINE_RUN_QUEUE && queueName !== PIPELINE_DIRECT_RUN_QUEUE) {
      throw new ConflictError('Prepared dispatch has no canonical transport queue lane');
    }
    const boss = getBoss();
    if (typeof boss.createQueue === 'function') await boss.createQueue(queueName);
    const schema = getPgBossSchemaSql();
    const existing = await queryOne<{ id: string }>(
      `SELECT id::text FROM ${schema}.job WHERE id = $1
       UNION ALL SELECT id::text FROM ${schema}.archive WHERE id = $1 LIMIT 1`, [input.bossJobId],
    ).catch(() => undefined);
    const jobId = existing?.id ?? await boss.send(queueName, input.payload, {
      id: input.bossJobId,
      retryLimit: 0,
      ...pipelineExecutionJobSendOptions(input.payload),
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
  });
}

export async function claimDispatchForWorker(input: {
  runId: number;
  bossJobId: string;
  payload: Record<string, unknown>;
  workerId: string;
  queueName?: typeof PIPELINE_RUN_QUEUE | typeof PIPELINE_DIRECT_RUN_QUEUE;
}) {
  const triggerOptions = input.payload.triggerOptions;
  const lifecycleDispatchClaim = parseLifecycleDispatchClaim(
    triggerOptions && typeof triggerOptions === 'object' && !Array.isArray(triggerOptions)
      ? (triggerOptions as Record<string, unknown>).lifecycleDispatchClaim
      : undefined,
  );
  const payloadHash = retryHash(input.payload);
  return transaction(async (client: PoolClient) => {
    if (lifecycleDispatchClaim) {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        [lifecycleDispatchClaim.workspaceId, lifecycleDispatchClaim.specId],
      );
    }
    const run = (await client.query<{
      workspace_id: string; status: string; dispatch_request_hash: string | null;
      campaign_dispatch_authorization_hash: string | null; trigger_options: unknown;
    }>(
      `SELECT workspace_id, status, dispatch_request_hash, campaign_dispatch_authorization_hash,
              trigger_options
         FROM pipeline_runs WHERE id = $1 FOR UPDATE`, [input.runId],
    )).rows[0];
    if (!run) return { claimed: false, reason: 'run_missing' };
    if (run.campaign_dispatch_authorization_hash) {
      const consumed = (await client.query<{ run_id: number; request_hash: string }>(
        `SELECT run_id, request_hash FROM campaign_dispatch_authorizations
          WHERE authorization_hash = $1 FOR SHARE`,
        [run.campaign_dispatch_authorization_hash],
      )).rows[0];
      if (!consumed || Number(consumed.run_id) !== input.runId
        || consumed.request_hash !== run.dispatch_request_hash) {
        return { claimed: false, reason: 'campaign_authorization_mismatch', workspaceId: run.workspace_id };
      }
    }
    const cancellation = (await client.query<{ run_id: number }>(
      'SELECT run_id FROM pipeline_run_cancellation_requests WHERE run_id = $1 FOR UPDATE', [input.runId],
    )).rows[0];
    if (cancellation) return { claimed: false, reason: 'cancellation_requested', workspaceId: run.workspace_id };
    const publication = (await client.query<{
      state: DispatchPublicationState;
      boss_job_id: string;
      payload_hash: string | null;
      lease_expires_at: Date | string | null;
      queue_name: string;
    }>(`SELECT state, boss_job_id::text, payload_hash, lease_expires_at, queue_name
          FROM pipeline_dispatch_publications WHERE run_id = $1 FOR UPDATE`, [input.runId])).rows[0];
    if (!publication || publication.boss_job_id !== input.bossJobId || publication.payload_hash !== payloadHash) {
      return { claimed: false, reason: 'publication_identity_mismatch', workspaceId: run.workspace_id };
    }
    if (input.queueName && publication.queue_name !== input.queueName) {
      return { claimed: false, reason: 'publication_queue_mismatch', workspaceId: run.workspace_id };
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
    if (!lifecycleDispatchClaim) {
      return { claimed: false, reason: 'lifecycle_dispatch_claim_missing', workspaceId: run.workspace_id };
    }
    const storedTriggerOptions = run.trigger_options
      && typeof run.trigger_options === 'object'
      && !Array.isArray(run.trigger_options)
      ? run.trigger_options as Record<string, unknown>
      : undefined;
    const linkedClaim = parseLifecycleDispatchClaim(storedTriggerOptions?.lifecycleDispatchClaim);
    if (!linkedClaim || retryHash(linkedClaim) !== retryHash(lifecycleDispatchClaim)) {
      return { claimed: false, reason: 'lifecycle_dispatch_claim_linkage_mismatch', workspaceId: run.workspace_id };
    }
    try {
      await assertLifecycleDispatchClaim(lifecycleDispatchClaim, client);
      if (storedTriggerOptions?.ecoManagedAdmission || (triggerOptions as Record<string, unknown> | undefined)?.ecoManagedAdmission) {
        await assertEcoDispatch(client, input.runId, input.payload);
      }
    } catch (error) {
      if (error instanceof ConflictError) {
        return { claimed: false, reason: 'lifecycle_dispatch_claim_stale', workspaceId: run.workspace_id };
      }
      throw error;
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

/** Return a never-started callback claim to its exact published transport. */
export async function releaseDispatchWorkerClaim(input: {
  runId: number;
  bossJobId: string;
  workerId: string;
  reason: string;
}): Promise<void> {
  const released = await queryOne<{ run_id: number }>(
    `UPDATE pipeline_dispatch_publications
        SET state = 'published', lease_owner = NULL, lease_expires_at = NULL,
            last_error = $4, updated_at = NOW()
      WHERE run_id = $1 AND boss_job_id = $2::uuid
        AND state = 'claimed' AND lease_owner = $3
      RETURNING run_id`,
    [input.runId, input.bossJobId, input.workerId, input.reason.slice(0, 1000)],
  );
  if (!released) {
    throw new ConflictError('Never-started dispatch worker claim could not be released');
  }
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
  workspaceId?: string;
} = {}): Promise<DispatchPublicationRecoveryResult> {
  const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)));
  const staleSeconds = Math.max(1, Math.min(86_400, Math.trunc(input.stalePublishedAfterSeconds ?? 300)));
  const workspaceId = input.workspaceId?.trim() || null;
  const candidates = await queryOne<{ run_ids: number[] | null }>(
    `SELECT ARRAY(
       SELECT publication.run_id
         FROM pipeline_dispatch_publications publication
         JOIN pipeline_runs run ON run.id = publication.run_id
        WHERE run.status = 'queued'
          AND ($3::text IS NULL OR run.workspace_id = $3)
          AND publication.payload IS NOT NULL
          AND (
            (publication.state = 'preparing' AND (publication.lease_expires_at IS NULL OR publication.lease_expires_at <= NOW()))
            OR (publication.state = 'published' AND publication.updated_at <= NOW() - ($2 * INTERVAL '1 second'))
          )
        ORDER BY publication.updated_at, publication.run_id
        LIMIT $1
     ) AS run_ids`,
    [limit, staleSeconds, workspaceId],
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

export async function releaseDispatchPublication(runId: number | string, ownerId: string, reason: string): Promise<void> {
  await queryOne(
    `UPDATE pipeline_dispatch_publications
        SET state = CASE WHEN payload IS NULL THEN 'reserved' ELSE 'published' END,
            lease_owner = NULL, lease_expires_at = NULL, last_error = $3, updated_at = NOW()
      WHERE run_id = $1 AND state = 'preparing' AND lease_owner = $2 RETURNING run_id`,
    [runId, ownerId, reason.slice(0, 1000)],
  );
}
