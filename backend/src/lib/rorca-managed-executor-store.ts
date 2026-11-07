/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */
import { canonicalTransaction } from '../db';
import {
  ManagedAdmissionError,
  type ManagedAttemptState,
  type ManagedEngineRequest,
  type ManagedCapabilitySnapshot,
  type ManagedExecutorStore,
  type ManagedPreparation,
  type ManagedRecoveryRecord,
  type ManagedResultProposal,
} from './rorca-managed-executor';

interface QuotaAdmissionRow { admitted: boolean; duplicate: boolean; reason_code: string }
interface PreparationRow { launch_token: string; released: boolean; replayed: boolean; reason_code: string }
interface BooleanRow { allowed: boolean }
interface JsonRow { value: unknown }

function admissionReason(reason: string): ManagedAdmissionError {
  if (reason.startsWith('quota_exhausted')) return new ManagedAdmissionError('quota_exhausted', reason);
  if (reason === 'reservation_replay_conflict') return new ManagedAdmissionError('reservation_replay_conflict', reason);
  if (reason === 'capability_snapshot_stale') return new ManagedAdmissionError('capability_snapshot_stale', reason);
  if (reason === 'cancelled') return new ManagedAdmissionError('cancelled', reason);
  if (reason === 'duplicate_launch') return new ManagedAdmissionError('duplicate_launch', reason);
  return new ManagedAdmissionError('fence_lost', reason);
}

function recoveryRecord(value: unknown): ManagedRecoveryRecord {
  if (!value || typeof value !== 'object') throw new Error('Managed generation read returned an invalid record');
  const record = value as Record<string, unknown>;
  if (!record.request || typeof record.request !== 'object' || typeof record.state !== 'string' || typeof record.launchToken !== 'string') {
    throw new Error('Managed generation read omitted canonical fields');
  }
  return Object.freeze({
    request: Object.freeze(record.request as ManagedEngineRequest),
    state: record.state as ManagedAttemptState,
    launchToken: record.launchToken,
    processIdentity: typeof record.processIdentity === 'string' ? record.processIdentity : null,
    resultProposal: (record.resultProposal ?? null) as ManagedResultProposal | null,
    quarantined: record.quarantined === true,
  });
}

/** Canonical-writer-backed store. Every mutation is performed by a fenced SECURITY DEFINER API. */
export async function persistManagedCapabilitySnapshot(snapshot: ManagedCapabilitySnapshot): Promise<{ duplicate: boolean }> {
  const duplicate = await canonicalTransaction(async (client) => {
    const result = await client.query<BooleanRow>(
      'SELECT rorca.persist_managed_capability_snapshot_v1($1::jsonb) allowed',
      [JSON.stringify(snapshot)],
    );
    return result.rows[0]?.allowed === true;
  });
  return { duplicate };
}

export class PostgresManagedExecutorStore implements ManagedExecutorStore {
  constructor(readonly workspaceId: string) {}

  async reserveQuota(request: ManagedEngineRequest): Promise<{ duplicate: boolean }> {
    const row = await canonicalTransaction(async (client) => {
      const result = await client.query<QuotaAdmissionRow>(
        `SELECT * FROM rorca.reserve_managed_executor_quota_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::timestamptz)`,
        [request.workspaceId,request.runtimeId,request.attemptId,request.generation,request.leaseId,request.fencingToken,
          request.quotaReservationId,request.requestHash,request.capabilitySnapshotHash,request.quotaPolicyVersion,
          JSON.stringify(request.quota),request.leaseExpiresAt],
      );
      return result.rows[0];
    });
    if (!row?.admitted) throw admissionReason(row?.reason_code ?? 'quota_exhausted');
    return { duplicate: row.duplicate };
  }

  async prepare(request: ManagedEngineRequest): Promise<ManagedPreparation> {
    if (request.workspaceId !== this.workspaceId) throw new ManagedAdmissionError('scope_mismatch', 'store workspace differs from request workspace');
    await this.reserveQuota(request);
    const row = await canonicalTransaction(async (client) => {
      const result = await client.query<PreparationRow>('SELECT * FROM rorca.prepare_managed_executor_generation_v1($1::jsonb)', [JSON.stringify(request)]);
      return result.rows[0];
    });
    if (!row?.released) throw admissionReason(row?.reason_code ?? 'fence_lost');
    return Object.freeze({ request, launchToken: row.launch_token, released: row.released, replayed: row.replayed });
  }

  async revalidate(request: ManagedEngineRequest, phase: 'launch' | 'commit' | 'result' | 'closeout'): Promise<void> {
    const allowed = await canonicalTransaction(async (client) => {
      const result = await client.query<BooleanRow>(
        'SELECT rorca.revalidate_managed_executor_generation_v1($1,$2,$3) allowed',
        [this.workspaceId,request.requestHash,phase],
      );
      return result.rows[0]?.allowed === true;
    });
    if (!allowed) throw new ManagedAdmissionError('fence_lost', `managed generation failed ${phase} revalidation`);
  }

  async bindProcess(requestHash: string, processIdentity: string): Promise<void> {
    const bound = await canonicalTransaction(async (client) => {
      const result = await client.query<BooleanRow>(
        'SELECT rorca.bind_managed_executor_process_v1($1,$2,$3) allowed',
        [this.workspaceId,requestHash,processIdentity],
      );
      return result.rows[0]?.allowed === true;
    });
    if (!bound) throw new ManagedAdmissionError('fence_lost', 'managed process identity could not be bound');
  }

  async transition(requestHash: string, from: readonly ManagedAttemptState[], to: ManagedAttemptState, evidenceHash?: string): Promise<boolean> {
    return canonicalTransaction(async (client) => {
      const result = await client.query<BooleanRow>(
        'SELECT rorca.transition_managed_executor_generation_v1($1,$2,$3::text[],$4,$5) allowed',
        [this.workspaceId,requestHash,[...from],to,evidenceHash ?? null],
      );
      return result.rows[0]?.allowed === true;
    });
  }

  async load(requestHash: string): Promise<ManagedRecoveryRecord | null> {
    return canonicalTransaction(async (client) => {
      const result = await client.query<JsonRow>('SELECT rorca.load_managed_executor_generation_v1($1,$2) value', [this.workspaceId,requestHash]);
      return result.rows[0]?.value ? recoveryRecord(result.rows[0].value) : null;
    });
  }

  async listRecoverable(limit: number): Promise<readonly ManagedRecoveryRecord[]> {
    return canonicalTransaction(async (client) => {
      await client.query(`SELECT set_config('rorca.workspace_id',$1,TRUE)`,[this.workspaceId]);
      const result = await client.query<JsonRow>('SELECT value FROM rorca.list_recoverable_managed_executor_generations_v1($1,$2) value', [this.workspaceId,limit]);
      return Object.freeze(result.rows.map((row) => recoveryRecord(row.value)));
    });
  }

  async persistResult(proposal: ManagedResultProposal): Promise<{ duplicate: boolean }> {
    const duplicate = await canonicalTransaction(async (client) => {
      const result = await client.query<BooleanRow>('SELECT rorca.persist_managed_executor_result_proposal_v1($1,$2::jsonb) allowed', [this.workspaceId,JSON.stringify(proposal)]);
      return result.rows[0]?.allowed === true;
    });
    return { duplicate };
  }
}
