/** Copyright (c) 2026 Rorca Inc. SPDX-License-Identifier: Apache-2.0 */
import { randomUUID } from 'node:crypto';
import { transaction } from '../db';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from './errors';
import { decideEffect, type EffectAdmission, type EffectRequest } from './bounty-effect-policy';

export type EffectOperationState = 'prepared' | 'sent' | 'observed' | 'failed-before-send' | 'cancelled-before-send' | 'unknown';
export interface PreparedEffect { operationId: string; requestHash: string; decision: 'ALLOW'; state: 'prepared'; expiresAt: string; authorityEpoch: number }
export interface EffectSendFence { operationId: string; missionId: string; workspaceId: string; authorityEpoch: number; payload: Record<string, unknown> }

/** Append intent and reserve both accounting dimensions in the same row-lock transaction. */
export async function prepareEffect(request: EffectRequest, admission: EffectAdmission): Promise<PreparedEffect> {
  const decision = decideEffect(request, admission);
  if (!decision.allowed) throw new ForbiddenError(`Effect denied: ${decision.code}`);
  const operationId = randomUUID();
  return transaction(async (client) => {
    const mission = await client.query<{ state: string; epoch: string }>('SELECT state,epoch FROM bounty_missions WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [request.workspaceId, request.missionId]);
    if (!mission.rows[0]) throw new NotFoundError('Bounty mission');
    if (mission.rows[0].state !== 'active') throw new ConflictError('Mission is no longer active');
    const authorityEpoch = Number(mission.rows[0].epoch);
    const stoppedTarget = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM bounty_affected_target_stop_fences
       WHERE workspace_id=$1 AND mission_id=$2 AND affected_target_id=$3) AS exists`,
      [request.workspaceId, request.missionId, request.target],
    );
    if (stoppedTarget.rows[0]?.exists) throw new ForbiddenError('Affected target is stopped by an admitted finding');
    const hold = await client.query('SELECT 1 FROM bounty_holds WHERE workspace_id=$1 AND mission_id=$2 AND released_at IS NULL LIMIT 1', [request.workspaceId, request.missionId]);
    if (hold.rowCount) throw new ForbiddenError('Mission is held');
    const budget = await client.query<{ limit_cents: string }>('SELECT limit_cents FROM bounty_budgets WHERE workspace_id=$1 AND mission_id=$2 ORDER BY revision DESC LIMIT 1 FOR UPDATE', [request.workspaceId, request.missionId]);
    if (!budget.rows[0]) throw new ForbiddenError('No mission budget');
    const usage = await client.query<{ cents: string; slots: string }>(`SELECT COALESCE(sum(cost_cents),0)::text cents, COALESCE(sum(concurrency),0)::text slots FROM bounty_effect_reservations WHERE workspace_id=$1 AND mission_id=$2 AND released_at IS NULL`, [request.workspaceId, request.missionId]);
    if (Number(usage.rows[0]?.cents ?? 0) + request.costCents > Number(budget.rows[0].limit_cents) || Number(usage.rows[0]?.slots ?? 0) + request.concurrency > admission.availableConcurrency) throw new ForbiddenError('Effect budget or concurrency exhausted');
    const repeats = await client.query<{ count: string }>(`SELECT count(*)::text count FROM bounty_operations WHERE workspace_id=$1 AND mission_id=$2 AND work_package_id=$3 AND payload_hash=$4`, [request.workspaceId, request.missionId, request.workPackageId, decision.requestHash]);
    if (Number(repeats.rows[0]?.count ?? 0) >= 2) throw new ForbiddenError('Work package fenced after three identical effect requests');
    await client.query(`INSERT INTO bounty_operations (id,workspace_id,mission_id,idempotency_key,kind,payload,payload_hash,actor,purpose,expires_at,work_package_id,state,decision,repeatable,authority_epoch) VALUES ($1,$2,$3,$4,'target.effect',$5,$6,$7,$8,$9,$10,'prepared','ALLOW',$11,$12)`, [operationId, request.workspaceId, request.missionId, operationId, request.input, decision.requestHash, request.credentialRole, request.action, request.expiresAt, request.workPackageId, request.repeatable, authorityEpoch]);
    await client.query(`INSERT INTO bounty_effect_reservations (operation_id,workspace_id,mission_id,cost_cents,concurrency) VALUES ($1,$2,$3,$4,$5)`, [operationId, request.workspaceId, request.missionId, request.costCents, request.concurrency]);
    return { operationId, requestHash: decision.requestHash, decision: 'ALLOW', state: 'prepared', expiresAt: request.expiresAt, authorityEpoch };
  });
}

/**
 * Linearization point for an irreversible effect. The mission and operation rows
 * are locked together, so a lifecycle command and this transition cannot both
 * win the same epoch. Once this commits, a crash is sent-unobserved, never retryable.
 */
export async function commitEffectSendFence(operationId: string, authorityEpoch: number): Promise<EffectSendFence> {
  if (!operationId || !Number.isSafeInteger(authorityEpoch) || authorityEpoch < 1) throw new ValidationError('Invalid effect send fence');
  return transaction(async (client) => {
    const result = await client.query<{ workspace_id: string; mission_id: string; mission_state: string; mission_epoch: string; state: EffectOperationState; authority_epoch: string; payload: Record<string, unknown>; expired: boolean; held: boolean }>(
      `SELECT o.workspace_id,o.mission_id,m.state AS mission_state,m.epoch AS mission_epoch,
              o.state,o.authority_epoch,o.payload,clock_timestamp()>=o.expires_at AS expired,
              EXISTS(SELECT 1 FROM bounty_holds h WHERE h.workspace_id=o.workspace_id AND h.mission_id=o.mission_id AND h.released_at IS NULL) AS held
         FROM bounty_operations o JOIN bounty_missions m ON m.workspace_id=o.workspace_id AND m.id=o.mission_id
        WHERE o.id=$1 AND o.kind='target.effect' FOR UPDATE OF m,o`, [operationId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundError('Bounty operation');
    if (row.state !== 'prepared') throw new ConflictError(`Effect is not prepared: ${row.state}`);
    if (row.mission_state !== 'active' || row.held || row.expired || Number(row.mission_epoch) !== authorityEpoch || Number(row.authority_epoch) !== authorityEpoch) {
      throw new ForbiddenError('Effect send lost the Controller epoch fence');
    }
    await client.query(`UPDATE bounty_operations SET state='sent' WHERE id=$1 AND state='prepared'`, [operationId]);
    return { operationId, missionId: row.mission_id, workspaceId: row.workspace_id, authorityEpoch, payload: row.payload };
  });
}

/** Fence, dispatch exactly once, then record observation; ambiguous transport failure becomes a hold. */
export async function dispatchPreparedEffect<T>(operationId: string, authorityEpoch: number, dispatch: (fence: EffectSendFence) => Promise<T>): Promise<T> {
  const fence = await commitEffectSendFence(operationId, authorityEpoch);
  try {
    const response = await dispatch(fence);
    const admitted = await observeEffect(operationId, authorityEpoch);
    if (!admitted) throw new ConflictError('Stale adapter response was quarantined');
    return response;
  } catch (error) {
    await reconcileEffect(operationId, 'unknown');
    throw error;
  }
}

/** An old-epoch adapter response is quarantined and cannot release budget or admit evidence. */
export async function observeEffect(operationId: string, authorityEpoch: number): Promise<boolean> {
  return transaction(async (client) => {
    const result = await client.query<{ workspace_id: string; mission_id: string; mission_epoch: string; state: EffectOperationState; authority_epoch: string }>(
      `SELECT o.workspace_id,o.mission_id,m.epoch AS mission_epoch,o.state,o.authority_epoch
         FROM bounty_operations o JOIN bounty_missions m ON m.workspace_id=o.workspace_id AND m.id=o.mission_id
        WHERE o.id=$1 AND o.kind='target.effect' FOR UPDATE OF m,o`, [operationId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundError('Bounty operation');
    if (Number(row.authority_epoch) !== authorityEpoch || Number(row.mission_epoch) !== authorityEpoch) {
      if (Number(row.mission_epoch) <= authorityEpoch) throw new ConflictError('Adapter response presented an invalid future or mismatched epoch');
      await client.query(
        `INSERT INTO bounty_stale_authority_inputs(workspace_id,mission_id,source,source_identity,presented_epoch,current_epoch)
         VALUES($1,$2,'adapter-response',$3,$4,$5) ON CONFLICT DO NOTHING`,
        [row.workspace_id, row.mission_id, operationId, authorityEpoch, Number(row.mission_epoch)],
      );
      await ensureUncertainHold(client, row.workspace_id, row.mission_id, operationId);
      return false;
    }
    if (row.state === 'observed') return true;
    if (row.state !== 'sent') throw new ConflictError(`Effect response cannot be observed from ${row.state}`);
    await client.query(`UPDATE bounty_operations SET state='observed' WHERE id=$1`, [operationId]);
    await client.query('UPDATE bounty_effect_reservations SET released_at=now() WHERE operation_id=$1 AND released_at IS NULL', [operationId]);
    return true;
  });
}

async function ensureUncertainHold(client: { query: (sql: string, values?: unknown[]) => Promise<unknown> }, workspaceId: string, missionId: string, operationId: string): Promise<void> {
  await client.query(`INSERT INTO bounty_holds (workspace_id,mission_id,reason)
    SELECT $1,$2,$3 WHERE NOT EXISTS (SELECT 1 FROM bounty_holds WHERE workspace_id=$1 AND mission_id=$2 AND released_at IS NULL)`,
  [workspaceId, missionId, `Uncertain sent operation ${operationId}`]);
}

/** Reconciliation never turns sent/unknown into retryable; every uncertain outcome holds. */
export async function reconcileEffect(operationId: string, state: EffectOperationState): Promise<void> {
  if (!operationId || !['prepared', 'sent', 'observed', 'failed-before-send', 'cancelled-before-send', 'unknown'].includes(state)) throw new ValidationError('Invalid effect reconciliation');
  await transaction(async (client) => {
    const result = await client.query<{ workspace_id: string; mission_id: string; state: EffectOperationState }>('SELECT workspace_id,mission_id,state FROM bounty_operations WHERE id=$1 FOR UPDATE', [operationId]);
    const operation = result.rows[0];
    if (!operation) throw new NotFoundError('Bounty operation');
    const allowed: Record<EffectOperationState, readonly EffectOperationState[]> = {
      prepared: ['sent', 'failed-before-send', 'cancelled-before-send', 'unknown'], sent: ['observed', 'unknown'], observed: [],
      'failed-before-send': [], 'cancelled-before-send': [], unknown: [],
    };
    if (state !== operation.state && !allowed[operation.state].includes(state)) throw new ConflictError(`Illegal effect transition: ${operation.state} -> ${state}`);
    await client.query('UPDATE bounty_operations SET state=$1 WHERE id=$2', [state, operationId]);
    if (state === 'observed' || state === 'failed-before-send' || state === 'cancelled-before-send') await client.query('UPDATE bounty_effect_reservations SET released_at=now() WHERE operation_id=$1 AND released_at IS NULL', [operationId]);
    if (state === 'sent' || state === 'unknown') await ensureUncertainHold(client, operation.workspace_id, operation.mission_id, operationId);
  });
}
