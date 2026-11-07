/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { Pool } from 'pg';
import { buildSslConfig } from '../db';
import { EventDrivenCostCircuit, type IdleControllerState, type VersionedIdlePolicy } from './event-driven-cost-circuit';
import { governedOperationsHash } from './governed-operations-primitives';
import {
  PostgresIdleCircuitCapabilityProvider,
  PostgresIdleCircuitStore,
  PostgresWakeAuthorityVerifier,
} from './postgres-idle-circuit-store';

export interface WorkerIdleCostController {
  beforeIteration(elapsedMs: number): Promise<boolean>;
  snapshot(): IdleControllerState;
  close(): Promise<void>;
}

interface WakeSourceRow { source_receipt_id: string }

export async function initializeWorkerIdleCostController(): Promise<WorkerIdleCostController | null> {
  const policyJson = process.env.RORCA_WAVE4_IDLE_POLICY_JSON;
  if (!policyJson) return null;
  const workspaceId = process.env.RORCA_WAVE4_IDLE_WORKSPACE_ID;
  const controllerId = process.env.RORCA_WAVE4_IDLE_CONTROLLER_ID;
  const databaseUrl = process.env.RORCA_CANONICAL_WRITER_DATABASE_URL;
  if (!workspaceId || !controllerId || !databaseUrl) {
    throw new Error('Wave 4 idle controller requires exact workspace, controller, and canonical-writer database configuration');
  }
  const policy = JSON.parse(policyJson) as VersionedIdlePolicy;
  const { policyHash, ...policyMaterial } = policy;
  if (governedOperationsHash(policyMaterial) !== policyHash) throw new Error('Wave 4 idle controller policy hash mismatch');
  const pool = new Pool({ connectionString: databaseUrl, ssl: buildSslConfig(databaseUrl),
    options: '-c search_path=rorca,public', application_name: 'rorca-wave4-idle-controller' });
  const capabilities = new PostgresIdleCircuitCapabilityProvider(pool);
  const store = new PostgresIdleCircuitStore(pool, capabilities);
  const authority = new PostgresWakeAuthorityVerifier(pool);
  const circuit = new EventDrivenCostCircuit(policy, store, authority);
  const persisted = await store.load(workspaceId, controllerId);
  let state: IdleControllerState = persisted ?? await circuit.register(workspaceId, controllerId, 0);
  if (state.policyHash !== policy.policyHash) throw new Error('Wave 4 durable idle state uses a different policy');

  const wakeFromCanonicalReceipts = async (): Promise<void> => {
    const durable = await store.load(workspaceId, controllerId);
    if (!durable) throw new Error('Wave 4 durable idle controller disappeared');
    state = durable;
    if (state.status !== 'suspended') return;
    const client = await pool.connect();
    let rows: WakeSourceRow[];
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('rorca.workspace_id',$1,TRUE)`, [workspaceId]);
      rows = (await client.query<WakeSourceRow>(`SELECT source.source_receipt_id
        FROM rorca.wave4_idle_wake_source_receipts source
        WHERE source.workspace_id=$1 AND source.controller_id=$2 AND source.expires_at>=clock_timestamp()
          AND NOT EXISTS(SELECT 1 FROM rorca.wave4_idle_wake_receipts wake
            WHERE wake.workspace_id=source.workspace_id AND wake.controller_id=source.controller_id
              AND wake.wake_id='source:'||source.source_receipt_id)
        ORDER BY source.observed_at,source.source_receipt_id LIMIT 100`, [workspaceId, controllerId])).rows;
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    for (const row of rows) {
      const result = await circuit.requestWake({ wakeId: `source:${row.source_receipt_id}`, workspaceId, controllerId,
        sourceReceiptId: row.source_receipt_id, requestedAt: Date.now() });
      state = result.state;
      if (result.accepted || state.status !== 'suspended') break;
    }
  };

  return {
    async beforeIteration(elapsedMs: number): Promise<boolean> {
      await wakeFromCanonicalReceipts();
      if (state.status !== 'running') return false;
      state = await circuit.observeIteration(workspaceId, controllerId, { noChangeTicks: 1, elapsedMs });
      return state.status === 'running';
    },
    snapshot(): IdleControllerState { return structuredClone(state); },
    async close(): Promise<void> { await pool.end(); },
  };
}
