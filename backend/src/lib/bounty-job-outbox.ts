/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Application outbox relay and worker authority fence for bounty jobs. */
import type PgBoss from 'pg-boss';
import type { PoolClient } from 'pg';
import { query, queryOne, transaction } from '../db';
import { getBoss } from './pg-boss';
import { getPgBossSchemaSql } from './pg-boss-schema';

export const BOUNTY_QUEUES = ['bounty:control', 'bounty:work', 'bounty:reconcile', 'bounty:isolated-proposal'] as const;
export type BountyQueue = typeof BOUNTY_QUEUES[number];
export interface BountyJobPayload {
  outboxId: string; workspaceId: string; missionId: string; workPackageId?: string;
  contractRevision?: number; missionEpoch?: number; packageHash?: string;
}
interface OutboxRow {
  id: string; workspace_id: string; mission_id: string; work_package_id: string | null;
  queue_name: BountyQueue; job_id: string; contract_revision: string | null;
  mission_epoch: string | null; package_hash: string | null;
}
const payload = (row: OutboxRow): BountyJobPayload => ({
  outboxId: row.id, workspaceId: row.workspace_id, missionId: row.mission_id,
  ...(row.work_package_id ? { workPackageId: row.work_package_id } : {}),
  ...(row.contract_revision ? { contractRevision: Number(row.contract_revision) } : {}),
  ...(row.mission_epoch ? { missionEpoch: Number(row.mission_epoch) } : {}),
  ...(row.package_hash ? { packageHash: row.package_hash } : {}),
});

/** Claims unpublished intents with SKIP LOCKED; the lease permits restart recovery. */
export async function claimBountyOutbox(owner: string, limit = 50): Promise<OutboxRow[]> {
  return transaction(async (client: PoolClient) => {
    const result = await client.query<OutboxRow>(
      `UPDATE bounty_application_outbox outbox SET publish_owner=$1,
          publish_lease_expires_at=NOW()+INTERVAL '2 minutes', publish_attempts=publish_attempts+1
       FROM (SELECT id FROM bounty_application_outbox WHERE published_at IS NULL AND cancelled_at IS NULL
             AND (publish_lease_expires_at IS NULL OR publish_lease_expires_at<=NOW())
             ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $2) claim
       WHERE outbox.id=claim.id RETURNING outbox.*`, [owner, Math.max(1, Math.min(500, limit))],
    );
    return result.rows;
  });
}

/** Publish using the pre-recorded UUID, reconciling success, null, and ambiguous send outcomes. */
export async function publishBountyOutbox(owner: string, boss: PgBoss = getBoss()): Promise<number> {
  const rows = await claimBountyOutbox(owner);
  let published = 0;
  for (const row of rows) {
    try {
      const schema = getPgBossSchemaSql();
      const exists = async () => Boolean(await queryOne(
        `SELECT id FROM ${schema}.job WHERE id=$1::uuid UNION ALL SELECT id FROM ${schema}.archive WHERE id=$1::uuid LIMIT 1`, [row.job_id],
      ));
      let found = await exists();
      if (!found) {
        const observed = await boss.send(row.queue_name, payload(row), { id: row.job_id, retryLimit: 5 });
        found = observed === row.job_id || await exists();
      }
      if (!found) throw new Error('pg-boss send did not converge to the recorded job UUID');
      const marked = await queryOne<{ id: string }>(
        `UPDATE bounty_application_outbox SET published_at=COALESCE(published_at,NOW()),
           publish_owner=NULL,publish_lease_expires_at=NULL,last_error=NULL
         WHERE id=$1 AND job_id=$2::uuid AND publish_owner=$3 AND cancelled_at IS NULL RETURNING id`, [row.id, row.job_id, owner],
      );
      if (marked) published += 1;
    } catch (error) {
      await query(`UPDATE bounty_application_outbox SET publish_owner=NULL,publish_lease_expires_at=NULL,last_error=$3
        WHERE id=$1 AND publish_owner=$2`, [row.id, owner, error instanceof Error ? error.message.slice(0, 1000) : 'publish failed']);
    }
  }
  return published;
}

/** A delivery is only a hint: lock and recheck every application authority fence. */
export async function claimBountyWorkJob(job: BountyJobPayload, workerId: string): Promise<{ claimed: boolean; reason?: string }> {
  if (!job.workPackageId || !job.contractRevision || !job.missionEpoch || !job.packageHash) return { claimed: false, reason: 'incomplete_identity' };
  return transaction(async (client: PoolClient) => {
    const result = await client.query<{ state: string; epoch: string; revision: string; status: string; package_hash: string; stopped: boolean; leased: boolean }>(
      `SELECT m.state,m.epoch,c.revision,w.status,w.package_hash,
          EXISTS(SELECT 1 FROM bounty_holds h WHERE h.workspace_id=m.workspace_id AND h.mission_id=m.id AND h.released_at IS NULL) AS stopped,
          EXISTS(SELECT 1 FROM bounty_leases l WHERE l.workspace_id=w.workspace_id AND l.work_package_id=w.id AND l.expires_at>NOW()) AS leased
       FROM bounty_missions m JOIN bounty_work_packages w ON w.mission_id=m.id AND w.workspace_id=m.workspace_id
       JOIN LATERAL (SELECT revision FROM bounty_contracts WHERE mission_id=m.id ORDER BY revision DESC LIMIT 1) c ON TRUE
       WHERE m.id=$1 AND m.workspace_id=$2 AND w.id=$3 FOR UPDATE OF m,w`, [job.missionId, job.workspaceId, job.workPackageId],
    );
    const row = result.rows[0];
    if (!row || row.state !== 'active' || row.stopped || row.status !== 'pending') return { claimed: false, reason: 'stopped_or_not_dispatchable' };
    if (Number(row.revision) !== job.contractRevision || Number(row.epoch) !== job.missionEpoch || row.package_hash !== job.packageHash) return { claimed: false, reason: 'stale_authority' };
    if (row.leased) return { claimed: false, reason: 'lease_active' };
    await client.query(`INSERT INTO bounty_leases(workspace_id,work_package_id,epoch,holder,expires_at)
      VALUES($1,$2,COALESCE((SELECT max(epoch)+1 FROM bounty_leases WHERE work_package_id=$2),1),$3,NOW()+INTERVAL '10 minutes')`, [job.workspaceId, job.workPackageId, workerId]);
    await client.query(`UPDATE bounty_work_packages SET status='running' WHERE id=$1 AND workspace_id=$2`, [job.workPackageId, job.workspaceId]);
    return { claimed: true };
  });
}
