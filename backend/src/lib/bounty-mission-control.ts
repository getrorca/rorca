/** Copyright (c) 2026 Rorca Inc. SPDX-License-Identifier: Apache-2.0 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, transaction } from '../db';
import { hashBountyContract } from './bounty-contracts';
import { ConflictError, ForbiddenError, NotFoundError, UnprocessableError, ValidationError } from './errors';

export type BountyLifecycleAction = 'pause' | 'resume' | 'stop' | 'kill';
export type ControlledBountyMissionState = 'active' | 'paused' | 'held' | 'stopped' | 'killed';
export interface BountyLifecycleCommand {
  workspaceId: string; missionId: string; expectedEpoch: number; action: BountyLifecycleAction;
  actor: string; reason: string; idempotencyKey: string;
}
export interface BountyLifecycleReceipt {
  receiptId: string; operationId: string; missionId: string; action: BountyLifecycleAction;
  previousState: string; state: ControlledBountyMissionState; previousEpoch: number; epoch: number;
  cancelledPreparedEffects: number; uncertainEffects: number;
}
export interface MissionControlHooks {
  revokeCredentials?(missionId: string, replacementEpoch: number): Promise<void> | void;
  revokeCallbacks?(missionId: string, replacementEpoch: number): Promise<void> | void;
  closeBrowserPartitions?(missionId: string, replacementEpoch: number): Promise<void> | void;
}
export interface ProcessSignalDependencies {
  signalProcessGroup?: (processGroupId: number, signal: NodeJS.Signals | 0) => void;
  sleep?: (milliseconds: number) => Promise<void>;
}
export interface RestartReconciliationResult {
  missionEpoch: number; cancelledPreparedEffects: number; uncertainEffects: number;
  staleOutbox: number; staleLeases: number; staleProcesses: number;
}
export interface BountyWorkerProcessRegistration {
  workspaceId: string; missionId: string; attemptId: string; authorityEpoch: number; processGroupId: number;
}

const destination: Record<BountyLifecycleAction, ControlledBountyMissionState> = {
  pause: 'paused', resume: 'active', stop: 'stopped', kill: 'killed',
};
const legal: Record<BountyLifecycleAction, readonly string[]> = {
  pause: ['active'], resume: ['paused'], stop: ['active', 'paused', 'held'], kill: ['active', 'paused', 'held'],
};
const terminal = new Set(['completed', 'cancelled', 'stopped', 'killed']);
const required = (value: string, name: string): void => {
  if (!value.trim() || value.length > 256) throw new ValidationError(`${name} is required and must be at most 256 characters`);
};

/**
 * Durable Controller lifecycle boundary. Locking the mission row serializes this
 * command against commitEffectSendFence immediately before irreversible dispatch.
 */
export async function executeBountyLifecycleCommand(command: BountyLifecycleCommand, hooks: MissionControlHooks = {}): Promise<BountyLifecycleReceipt> {
  for (const [value, name] of [[command.workspaceId, 'workspaceId'], [command.missionId, 'missionId'], [command.actor, 'actor'], [command.reason, 'reason'], [command.idempotencyKey, 'idempotencyKey']] as const) required(value, name);
  if (!Number.isSafeInteger(command.expectedEpoch) || command.expectedEpoch < 1) throw new ValidationError('expectedEpoch must be a positive integer');
  const payload = { missionId: command.missionId, action: command.action, expectedEpoch: command.expectedEpoch, reason: command.reason };
  const payloadHash = hashBountyContract('mission-lifecycle-command', payload);

  const outcome = await transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`bounty-mission-control:${command.workspaceId}:${command.idempotencyKey}`]);
    const replay = await client.query<{ payload_hash: string; payload: BountyLifecycleReceipt }>(
      `SELECT o.payload_hash,r.payload FROM bounty_operations o
       JOIN bounty_operation_receipts r ON r.workspace_id=o.workspace_id AND r.operation_id=o.id
       WHERE o.workspace_id=$1 AND o.idempotency_key=$2 FOR UPDATE OF o`, [command.workspaceId, command.idempotencyKey],
    );
    if (replay.rows[0]) {
      if (replay.rows[0].payload_hash !== payloadHash) throw new ConflictError('Idempotency key was used with a different lifecycle command');
      const current = await client.query<{ epoch: string }>('SELECT epoch FROM bounty_missions WHERE workspace_id=$1 AND id=$2', [command.workspaceId, command.missionId]);
      return { receipt: replay.rows[0].payload, processGroups: [] as number[], replayed: true, runHooks: Number(current.rows[0]?.epoch) === replay.rows[0].payload.epoch };
    }

    const missionResult = await client.query<{ state: string; epoch: string }>(
      'SELECT state,epoch FROM bounty_missions WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [command.workspaceId, command.missionId],
    );
    const mission = missionResult.rows[0];
    if (!mission) throw new NotFoundError('Bounty mission');
    const previousEpoch = Number(mission.epoch);
    if (previousEpoch !== command.expectedEpoch) throw new ConflictError('Stale mission epoch', { expected: command.expectedEpoch, actual: previousEpoch });
    if (terminal.has(mission.state)) throw new UnprocessableError(`Mission ${mission.state} is terminal`, 'MISSION_TERMINAL');
    if (!legal[command.action].includes(mission.state)) throw new UnprocessableError(`Illegal mission ${command.action} from ${mission.state}`, 'ILLEGAL_MISSION_CONTROL');
    if (command.action === 'resume') {
      const hold = await client.query('SELECT 1 FROM bounty_holds WHERE workspace_id=$1 AND mission_id=$2 AND released_at IS NULL LIMIT 1', [command.workspaceId, command.missionId]);
      if (hold.rowCount) throw new ForbiddenError('Uncertain remote outcomes must be reconciled before resume');
    }

    const replacementEpoch = previousEpoch + 1;
    const nextState = destination[command.action];
    await client.query('UPDATE bounty_missions SET state=$1,epoch=$2,control_reason=$3,controlled_at=now() WHERE workspace_id=$4 AND id=$5', [nextState, replacementEpoch, command.reason, command.workspaceId, command.missionId]);
    await client.query(
      `INSERT INTO bounty_authority_revocations(workspace_id,mission_id,revoked_epoch,replacement_epoch,action,reason)
       VALUES($1,$2,$3,$4,$5,$6)`, [command.workspaceId, command.missionId, previousEpoch, replacementEpoch, command.action, command.reason],
    );

    const cancelled = await client.query(
      `UPDATE bounty_operations SET state='cancelled-before-send'
       WHERE workspace_id=$1 AND mission_id=$2 AND kind='target.effect' AND state='prepared'`, [command.workspaceId, command.missionId],
    );
    await client.query(
      `UPDATE bounty_effect_reservations r SET released_at=now() FROM bounty_operations o
       WHERE r.operation_id=o.id AND o.workspace_id=$1 AND o.mission_id=$2
         AND o.state='cancelled-before-send' AND r.released_at IS NULL`, [command.workspaceId, command.missionId],
    );
    const uncertain = await holdUncertainEffects(client, command.workspaceId, command.missionId);

    await client.query(
      `UPDATE bounty_application_outbox SET cancelled_at=now(),cancellation_reason=$3
       WHERE workspace_id=$1 AND mission_id=$2 AND published_at IS NULL AND cancelled_at IS NULL`,
      [command.workspaceId, command.missionId, `${command.action} epoch ${replacementEpoch}`],
    );
    await client.query(
      `UPDATE bounty_leases SET expires_at=LEAST(expires_at,now()) WHERE workspace_id=$1
       AND work_package_id IN (SELECT id FROM bounty_work_packages WHERE workspace_id=$1 AND mission_id=$2) AND expires_at>now()`,
      [command.workspaceId, command.missionId],
    );
    if (command.action === 'pause') {
      await client.query(`UPDATE bounty_work_packages SET status='pending' WHERE workspace_id=$1 AND mission_id=$2 AND status='running'`, [command.workspaceId, command.missionId]);
    } else if (command.action !== 'resume') {
      await client.query(`UPDATE bounty_work_packages SET status='cancelled' WHERE workspace_id=$1 AND mission_id=$2 AND status IN ('pending','running')`, [command.workspaceId, command.missionId]);
    }
    if (command.action !== 'resume') {
      await client.query(
        `UPDATE bounty_attempts SET status='terminated' WHERE workspace_id=$1 AND status IN ('pending','running')
         AND work_package_id IN (SELECT id FROM bounty_work_packages WHERE workspace_id=$1 AND mission_id=$2)`,
        [command.workspaceId, command.missionId],
      );
    }
    const processes = command.action === 'resume' ? { rows: [] as Array<{ process_group_id: number }> } : await client.query<{ process_group_id: number }>(
      `UPDATE bounty_worker_processes SET state='term-requested'
       WHERE workspace_id=$1 AND mission_id=$2 AND exited_at IS NULL RETURNING process_group_id`, [command.workspaceId, command.missionId],
    );

    const operationId = randomUUID(); const receiptId = randomUUID();
    const receipt: BountyLifecycleReceipt = {
      receiptId, operationId, missionId: command.missionId, action: command.action, previousState: mission.state, state: nextState,
      previousEpoch, epoch: replacementEpoch, cancelledPreparedEffects: cancelled.rowCount ?? 0, uncertainEffects: uncertain,
    };
    await client.query(
      `INSERT INTO bounty_operations(id,workspace_id,mission_id,idempotency_key,kind,payload,payload_hash,actor,purpose,state,decision,repeatable,authority_epoch)
       VALUES($1,$2,$3,$4,'mission.lifecycle',$5,$6,$7,$8,'observed','ALLOW',false,$9)`,
      [operationId, command.workspaceId, command.missionId, command.idempotencyKey, payload, payloadHash, command.actor, command.reason, replacementEpoch],
    );
    await client.query(`INSERT INTO bounty_operation_receipts(id,workspace_id,operation_id,receipt_identity,payload) VALUES($1,$2,$3,$4,$5)`, [receiptId, command.workspaceId, operationId, `${command.workspaceId}:${command.idempotencyKey}`, receipt]);
    await client.query(`INSERT INTO bounty_events(workspace_id,mission_id,event_identity,event_type,payload) VALUES($1,$2,$3,$4,$5)`, [command.workspaceId, command.missionId, `mission-control:${operationId}`, `mission.${command.action}`, receipt]);
    return { receipt, processGroups: processes.rows.map((row) => row.process_group_id), replayed: false, runHooks: true };
  });

  // Cleanup is idempotent and intentionally retried on command replay. The epoch
  // boundary is already durable, but the operator must see any revocation failure.
  if (outcome.runHooks) {
    await Promise.all([
      hooks.revokeCredentials?.(command.missionId, outcome.receipt.epoch),
      hooks.revokeCallbacks?.(command.missionId, outcome.receipt.epoch),
      hooks.closeBrowserPartitions?.(command.missionId, outcome.receipt.epoch),
    ]);
  }
  if (!outcome.replayed && command.action !== 'resume') await terminateProcessGroups(outcome.processGroups, command.action === 'kill' ? 2_000 : 5_000);
  return outcome.receipt;
}

async function holdUncertainEffects(client: PoolClient, workspaceId: string, missionId: string): Promise<number> {
  const uncertain = await client.query<{ id: string }>(
    `SELECT id FROM bounty_operations WHERE workspace_id=$1 AND mission_id=$2
      AND kind='target.effect' AND state IN ('sent','unknown') FOR UPDATE`, [workspaceId, missionId],
  );
  for (const operation of uncertain.rows) {
    await client.query(
      `INSERT INTO bounty_holds(workspace_id,mission_id,reason)
       SELECT $1,$2,$3 WHERE NOT EXISTS (SELECT 1 FROM bounty_holds WHERE workspace_id=$1 AND mission_id=$2 AND released_at IS NULL)`,
      [workspaceId, missionId, `Uncertain sent operation ${operation.id}`],
    );
  }
  return uncertain.rowCount ?? 0;
}

/** Register a trusted worker process only while its exact mission epoch is current. */
export async function registerBountyWorkerProcess(input: BountyWorkerProcessRegistration): Promise<string> {
  required(input.workspaceId, 'workspaceId'); required(input.missionId, 'missionId'); required(input.attemptId, 'attemptId');
  if (!Number.isSafeInteger(input.authorityEpoch) || input.authorityEpoch < 1 || !Number.isSafeInteger(input.processGroupId) || input.processGroupId < 2) throw new ValidationError('Worker process authority or process group is invalid');
  return transaction(async (client) => {
    const authority = await client.query<{ state: string; epoch: string }>(
      `SELECT m.state,m.epoch FROM bounty_missions m JOIN bounty_attempts a ON a.workspace_id=m.workspace_id
       JOIN bounty_work_packages w ON w.workspace_id=a.workspace_id AND w.id=a.work_package_id AND w.mission_id=m.id
       WHERE m.workspace_id=$1 AND m.id=$2 AND a.id=$3 FOR UPDATE OF m,a`, [input.workspaceId, input.missionId, input.attemptId],
    );
    if (!authority.rows[0] || authority.rows[0].state !== 'active' || Number(authority.rows[0].epoch) !== input.authorityEpoch) throw new ForbiddenError('Worker process authority is stale');
    const id = randomUUID();
    await client.query(
      `INSERT INTO bounty_worker_processes(id,workspace_id,mission_id,attempt_id,authority_epoch,process_group_id)
       VALUES($1,$2,$3,$4,$5,$6)`, [id, input.workspaceId, input.missionId, input.attemptId, input.authorityEpoch, input.processGroupId],
    );
    return id;
  });
}

/** SIGTERM every process group, then SIGKILL survivors after a bounded grace. */
export async function terminateProcessGroups(processGroupIds: readonly number[], graceMs: number, dependencies: ProcessSignalDependencies = {}): Promise<void> {
  if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 30_000) throw new ValidationError('Process termination grace must be between 0 and 30000ms');
  const groups = [...new Set(processGroupIds)].filter((id) => Number.isSafeInteger(id) && id > 1);
  const signal = dependencies.signalProcessGroup ?? ((id, value) => process.kill(-id, value));
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  for (const group of groups) { try { signal(group, 'SIGTERM'); } catch { /* exited before signal */ } }
  if (groups.length && graceMs) await sleep(graceMs);
  for (const group of groups) {
    let alive = true;
    try { signal(group, 0); } catch { alive = false; }
    if (alive) { try { signal(group, 'SIGKILL'); } catch { /* raced exit */ } }
  }
}

/**
 * Complete work exactly once under the current epoch. Old worker/browser callback
 * completion messages are quarantined without mutating work, attempts, or leases.
 */
export async function commitBountyWorkCompletion(input: {
  workspaceId: string; missionId: string; workPackageId: string; attemptId: string;
  authorityEpoch: number; completionIdentity: string;
}): Promise<{ committed: boolean; replayed: boolean }> {
  for (const [value, name] of [[input.workspaceId, 'workspaceId'], [input.missionId, 'missionId'], [input.workPackageId, 'workPackageId'], [input.attemptId, 'attemptId'], [input.completionIdentity, 'completionIdentity']] as const) required(value, name);
  if (!Number.isSafeInteger(input.authorityEpoch) || input.authorityEpoch < 1) throw new ValidationError('Completion authority epoch is invalid');
  return transaction(async (client) => {
    const replay = await client.query(
      `SELECT 1 FROM bounty_mission_crash_cuts WHERE workspace_id=$1 AND mission_id=$2
       AND boundary='completion' AND boundary_identity=$3`, [input.workspaceId, input.missionId, input.completionIdentity],
    );
    if (replay.rowCount) return { committed: true, replayed: true };
    const authority = await client.query<{ state: string; epoch: string; package_status: string; attempt_status: string }>(
      `SELECT m.state,m.epoch,w.status AS package_status,a.status AS attempt_status
       FROM bounty_missions m JOIN bounty_work_packages w ON w.workspace_id=m.workspace_id AND w.mission_id=m.id
       JOIN bounty_attempts a ON a.workspace_id=w.workspace_id AND a.work_package_id=w.id
       WHERE m.workspace_id=$1 AND m.id=$2 AND w.id=$3 AND a.id=$4 FOR UPDATE OF m,w,a`,
      [input.workspaceId, input.missionId, input.workPackageId, input.attemptId],
    );
    const row = authority.rows[0];
    if (!row) throw new NotFoundError('Bounty work completion authority');
    const currentEpoch = Number(row.epoch);
    if (currentEpoch !== input.authorityEpoch || row.state !== 'active') {
      if (currentEpoch <= input.authorityEpoch) throw new ConflictError('Completion presented an invalid future or inactive authority epoch');
      await client.query(
        `INSERT INTO bounty_stale_authority_inputs(workspace_id,mission_id,source,source_identity,presented_epoch,current_epoch)
         VALUES($1,$2,'completion',$3,$4,$5) ON CONFLICT DO NOTHING`,
        [input.workspaceId, input.missionId, input.completionIdentity, input.authorityEpoch, currentEpoch],
      );
      return { committed: false, replayed: false };
    }
    if (row.package_status !== 'running' || row.attempt_status !== 'running') throw new ConflictError('Bounty work is not running');
    await client.query(`UPDATE bounty_attempts SET status='succeeded' WHERE workspace_id=$1 AND id=$2`, [input.workspaceId, input.attemptId]);
    await client.query(`UPDATE bounty_work_packages SET status='completed' WHERE workspace_id=$1 AND id=$2`, [input.workspaceId, input.workPackageId]);
    await client.query(`UPDATE bounty_leases SET expires_at=LEAST(expires_at,now()) WHERE workspace_id=$1 AND work_package_id=$2 AND expires_at>now()`, [input.workspaceId, input.workPackageId]);
    await client.query(
      `INSERT INTO bounty_mission_crash_cuts(workspace_id,mission_id,boundary,boundary_identity,authority_epoch,resolution)
       VALUES($1,$2,'completion',$3,$4,'complete-once')`, [input.workspaceId, input.missionId, input.completionIdentity, input.authorityEpoch],
    );
    return { committed: true, replayed: false };
  });
}

/** Restart recovery converges stale durable records without re-sending any uncertain effect. */
export async function reconcileBountyMissionOnRestart(workspaceId: string, missionId: string): Promise<RestartReconciliationResult> {
  required(workspaceId, 'workspaceId'); required(missionId, 'missionId');
  const outcome = await transaction(async (client) => {
    const mission = await client.query<{ epoch: string; state: string }>('SELECT epoch,state FROM bounty_missions WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [workspaceId, missionId]);
    if (!mission.rows[0]) throw new NotFoundError('Bounty mission');
    const epoch = Number(mission.rows[0].epoch);
    const dispatchable = mission.rows[0].state === 'active';
    const prepared = await client.query(
      `UPDATE bounty_operations SET state='cancelled-before-send' WHERE workspace_id=$1 AND mission_id=$2
       AND kind='target.effect' AND state='prepared' AND (authority_epoch<>$3 OR NOT $4)`, [workspaceId, missionId, epoch, dispatchable],
    );
    await client.query(
      `UPDATE bounty_effect_reservations r SET released_at=now() FROM bounty_operations o
       WHERE r.operation_id=o.id AND o.workspace_id=$1 AND o.mission_id=$2 AND o.state='cancelled-before-send' AND r.released_at IS NULL`, [workspaceId, missionId],
    );
    const uncertain = await holdUncertainEffects(client, workspaceId, missionId);
    const outbox = await client.query(
      `UPDATE bounty_application_outbox SET cancelled_at=now(),cancellation_reason='restart stale epoch'
       WHERE workspace_id=$1 AND mission_id=$2 AND published_at IS NULL AND cancelled_at IS NULL
         AND (mission_epoch IS DISTINCT FROM $3 OR NOT $4)`, [workspaceId, missionId, epoch, dispatchable],
    );
    const leases = await client.query(
      `UPDATE bounty_leases SET expires_at=now() WHERE workspace_id=$1 AND expires_at>now()
       AND work_package_id IN (SELECT id FROM bounty_work_packages WHERE workspace_id=$1 AND mission_id=$2)
       AND (epoch<>$3 OR NOT $4)`, [workspaceId, missionId, epoch, dispatchable],
    );
    const processes = await client.query<{ process_group_id: number }>(
      `UPDATE bounty_worker_processes SET state='term-requested' WHERE workspace_id=$1 AND mission_id=$2
       AND exited_at IS NULL AND (authority_epoch<>$3 OR NOT $4) RETURNING process_group_id`, [workspaceId, missionId, epoch, dispatchable],
    );
    return { epoch, prepared: prepared.rowCount ?? 0, uncertain, outbox: outbox.rowCount ?? 0, leases: leases.rowCount ?? 0, processGroups: processes.rows.map((row) => row.process_group_id) };
  });
  await terminateProcessGroups(outcome.processGroups, 2_000);
  return { missionEpoch: outcome.epoch, cancelledPreparedEffects: outcome.prepared, uncertainEffects: outcome.uncertain, staleOutbox: outcome.outbox, staleLeases: outcome.leases, staleProcesses: outcome.processGroups.length };
}

/** Reconcile every durable bounty mission during backend restart. */
export async function reconcileAllBountyMissionsOnRestart(): Promise<RestartReconciliationResult[]> {
  const missions = await query<{ workspace_id: string; id: string }>('SELECT workspace_id,id FROM bounty_missions ORDER BY created_at,id');
  const results: RestartReconciliationResult[] = [];
  for (const mission of missions) results.push(await reconcileBountyMissionOnRestart(mission.workspace_id, mission.id));
  return results;
}

export type CrashCutBoundary = 'command' | 'outbox' | 'queue' | 'lease' | 'prepare' | 'send' | 'observation' | 'evidence' | 'completion';
export type CrashCutResolution = 'resume' | 'discard-stale' | 'cancel-prepared' | 'hold-uncertain' | 'quarantine' | 'complete-once';
/** Executable restart policy used by crash-cut tests and the reconciler. */
export function resolveBountyCrashCut(boundary: CrashCutBoundary, staleEpoch: boolean): CrashCutResolution {
  if (staleEpoch) return boundary === 'send' || boundary === 'observation' ? 'hold-uncertain' : boundary === 'prepare' ? 'cancel-prepared' : boundary === 'evidence' || boundary === 'completion' ? 'quarantine' : 'discard-stale';
  if (boundary === 'send' || boundary === 'observation') return 'hold-uncertain';
  if (boundary === 'prepare') return 'cancel-prepared';
  if (boundary === 'completion') return 'complete-once';
  return 'resume';
}
