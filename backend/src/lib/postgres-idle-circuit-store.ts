/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Pool, PoolClient } from 'pg';
import { EventDrivenCostCircuit, type DurableIdleCircuitStore, type IdleControllerState,
  type VersionedIdlePolicy, type VerifiedWakeSourceReceipt, type WakeAuthorityVerifier, type WakeRequest,
  type WakeRevalidation, type WakeResult } from './event-driven-cost-circuit';
import { governedOperationsHash, type Sha256 } from './governed-operations-primitives';

export interface IdleCircuitMutationCapability {
  capabilityId: string;
  requestHash: Sha256;
  subjectHash: Sha256;
}
export interface IdleCircuitCapabilityProvider {
  authorize(input: { workspaceId: string; controllerId: string; operation: 'idle.register'|'idle.observe'|'idle.wake';
    requestHash: Sha256; subjectHash: Sha256 }): Promise<IdleCircuitMutationCapability>;
}
interface StateRow { state_json: IdleControllerState; state_hash: Sha256 }

export class PostgresIdleCircuitStore implements DurableIdleCircuitStore {
  constructor(private readonly pool: Pool, private readonly capabilities: IdleCircuitCapabilityProvider) {}

  async load(workspaceId: string, controllerId: string): Promise<IdleControllerState | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('rorca.workspace_id',$1,TRUE)`, [workspaceId]);
      const result = await client.query<StateRow>(`SELECT state_json,state_hash FROM rorca.wave4_idle_controller_states
        WHERE workspace_id=$1 AND controller_id=$2`, [workspaceId, controllerId]);
      await client.query('COMMIT');
      return result.rows[0] ? structuredClone(result.rows[0].state_json) : null;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async register(state: IdleControllerState): Promise<IdleControllerState> {
    const nextHash = governedOperationsHash(state);
    const requestHash = governedOperationsHash({ operation: 'idle.register', expectedStateHash: 'state_absent', nextHash });
    const capability = await this.capabilities.authorize({ workspaceId: state.workspaceId, controllerId: state.controllerId,
      operation: 'idle.register', requestHash, subjectHash: governedOperationsHash([state.workspaceId, state.controllerId]) });
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('rorca.workspace_id',$1,TRUE)`, [state.workspaceId]);
      await this.apply(client, capability, 'idle.register', state.workspaceId, state.controllerId, 'state_absent', state, nextHash, null, null);
      await client.query('COMMIT'); return structuredClone(state);
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async atomicState<T>(workspaceId: string, controllerId: string,
    update: (state: IdleControllerState) => { state: IdleControllerState; result: T }): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN'); await client.query(`SELECT set_config('rorca.workspace_id',$1,TRUE)`, [workspaceId]);
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`wave4-idle:${workspaceId}:${controllerId}`]);
      const row = (await client.query<StateRow>(`SELECT state_json,state_hash FROM rorca.wave4_idle_controller_states
        WHERE workspace_id=$1 AND controller_id=$2`, [workspaceId, controllerId])).rows[0];
      if (!row) throw new Error('Unknown durable idle controller');
      const changed = update(structuredClone(row.state_json)); const nextHash = governedOperationsHash(changed.state);
      if (nextHash !== row.state_hash) {
        const requestHash = governedOperationsHash({ operation: 'idle.observe', expectedStateHash: row.state_hash, nextHash });
        const capability = await this.capabilities.authorize({ workspaceId, controllerId, operation: 'idle.observe', requestHash,
          subjectHash: governedOperationsHash([workspaceId, controllerId]) });
        await this.apply(client, capability, 'idle.observe', workspaceId, controllerId, row.state_hash, changed.state, nextHash, null, null);
      }
      await client.query('COMMIT'); return changed.result;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async atomicWake(workspaceId: string, controllerId: string, wakeId: string, requestHash: Sha256,
    update: (state: IdleControllerState) => Promise<WakeResult>): Promise<WakeResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN'); await client.query(`SELECT set_config('rorca.workspace_id',$1,TRUE)`, [workspaceId]);
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`wave4-idle:${workspaceId}:${controllerId}`]);
      const replay = (await client.query<{request_hash:Sha256;result_json:WakeResult}>(
        `SELECT request_hash,result_json FROM rorca.wave4_idle_wake_receipts
         WHERE workspace_id=$1 AND controller_id=$2 AND wake_id=$3`, [workspaceId,controllerId,wakeId])).rows[0];
      const row = (await client.query<StateRow>(`SELECT state_json,state_hash FROM rorca.wave4_idle_controller_states
        WHERE workspace_id=$1 AND controller_id=$2`, [workspaceId,controllerId])).rows[0];
      if (!row) throw new Error('Unknown durable idle controller');
      if (replay) {
        if (replay.request_hash!==requestHash) throw new Error('Changed wake replay permanently rejected');
        await client.query('COMMIT');
        return structuredClone(replay.result_json);
      }
      const result=await update(structuredClone(row.state_json)),nextHash=governedOperationsHash(result.state);
      const mutationHash=governedOperationsHash({operation:'idle.wake',expectedStateHash:row.state_hash,nextHash,wakeId,requestHash});
      const capability=await this.capabilities.authorize({workspaceId,controllerId,operation:'idle.wake',requestHash:mutationHash,
        subjectHash:governedOperationsHash([workspaceId,controllerId])});
      await this.apply(client,capability,'idle.wake',workspaceId,controllerId,row.state_hash,result.state,nextHash,wakeId,
        {requestHash,result});
      await client.query('COMMIT'); return result;
    } catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }

  private async apply(client:PoolClient,capability:IdleCircuitMutationCapability,operation:string,workspaceId:string,
    controllerId:string,expectedStateHash:string,state:IdleControllerState,nextHash:Sha256,wakeId:string|null,
    wake:{requestHash:Sha256;result:WakeResult}|null):Promise<void>{
    await client.query(`SELECT rorca.apply_wave4_idle_state_v1($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12)`,
      [workspaceId,capability.capabilityId,operation,capability.requestHash,capability.subjectHash,controllerId,
        expectedStateHash,JSON.stringify(state),nextHash,wakeId,wake?.requestHash??null,
        wake?JSON.stringify(wake.result):null]);
  }
}

export class PostgresIdleCircuitCapabilityProvider implements IdleCircuitCapabilityProvider {
  constructor(private readonly pool:Pool) {}
  async authorize(input:{workspaceId:string;controllerId:string;operation:'idle.register'|'idle.observe'|'idle.wake';
    requestHash:Sha256;subjectHash:Sha256}):Promise<IdleCircuitMutationCapability>{
    const client=await this.pool.connect();
    try{
      await client.query('BEGIN');await client.query(`SELECT set_config('rorca.workspace_id',$1,TRUE)`,[input.workspaceId]);
      const row=(await client.query<IdleCircuitMutationCapability>(`SELECT capability_id AS \"capabilityId\",
        request_hash AS \"requestHash\",subject_hash AS \"subjectHash\"
        FROM rorca.claim_wave4_idle_capability_v1($1,$2,$3,$4)`,
      [input.workspaceId,input.operation,input.requestHash,input.subjectHash])).rows[0];
      if(!row)throw new Error('No exact production idle capability');
      await client.query('COMMIT');return row;
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
}

const WAKE_REVALIDATION_KEYS: ReadonlyArray<keyof WakeRevalidation> = [
  'dependencyCapabilityHealthy','workspaceQuotaAvailable','runtimeQuotaAvailable','leaseFenceCurrent',
  'policyActive','sessionCursorCurrent','cooldownElapsed','singleWriter',
];
function exactWakeRevalidation(value:Record<string,boolean>):WakeRevalidation {
  if (Object.keys(value).length!==WAKE_REVALIDATION_KEYS.length
    || WAKE_REVALIDATION_KEYS.some(key=>typeof value[key]!=='boolean')) {
    throw new Error('Canonical wake receipt has incomplete revalidation state');
  }
  return value as unknown as WakeRevalidation;
}

export class PostgresWakeAuthorityVerifier implements WakeAuthorityVerifier {
  constructor(private readonly pool:Pool) {}
  async verifySourceAndLoadState(request:WakeRequest):
  Promise<{receipt:VerifiedWakeSourceReceipt;revalidation:WakeRevalidation}|null>{
    const client=await this.pool.connect();
    try{
      await client.query('BEGIN');await client.query(`SELECT set_config('rorca.workspace_id',$1,TRUE)`,[request.workspaceId]);
      const row=(await client.query<{source_receipt_id:string;receipt_hash:Sha256;workspace_id:string;controller_id:string;
        source:'canonical_event'|'webhook'|'lease_deadline'|'operator_request';subject_hash:Sha256;authenticated_by:string;
        relevant:true;observed_at:Date;expires_at:Date;revalidation_json:Record<string,boolean>}>(`SELECT * FROM rorca.wave4_idle_wake_source_receipts
        WHERE workspace_id=$1 AND controller_id=$2 AND source_receipt_id=$3`,
      [request.workspaceId,request.controllerId,request.sourceReceiptId])).rows[0];
      await client.query('COMMIT');
      if(!row)return null;
      return {receipt:{receiptId:row.source_receipt_id,receiptHash:row.receipt_hash,workspaceId:row.workspace_id,
        controllerId:row.controller_id,source:row.source,subjectHash:row.subject_hash,authenticatedBy:row.authenticated_by,
        relevant:row.relevant,observedAt:row.observed_at.getTime(),expiresAt:row.expires_at.getTime()},
      revalidation:exactWakeRevalidation(row.revalidation_json)};
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
}

export async function createProductionEventDrivenCostCircuit(input:{policy:VersionedIdlePolicy;pool:Pool;
  capabilities:IdleCircuitCapabilityProvider;wakeAuthority:WakeAuthorityVerifier;workspaceId:string;controllerId:string;
  now?:()=>number}):Promise<EventDrivenCostCircuit>{
  const store=new PostgresIdleCircuitStore(input.pool,input.capabilities);
  const persisted=await store.load(input.workspaceId,input.controllerId);
  if(!persisted) throw new Error('Production idle controller must be durably registered before startup');
  if(persisted.policyHash!==input.policy.policyHash) throw new Error('Production idle controller policy does not match durable state');
  return new EventDrivenCostCircuit(input.policy,store,input.wakeAuthority,input.now);
}
