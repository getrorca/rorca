/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'child_process';
import { queryOne, transaction } from '../db/index';
import type { PoolClient } from 'pg';
import {
  computeLocalQualificationIdentity,
  loadCanonicalQualificationAssertionIds,
  verifyQualificationReceipt,
  type QualificationReceipt,
  type QualificationReport,
} from './wave-qualification-evidence';
import { QUALIFICATION_SCENARIOS } from './wave-qualification-model';
import {
  assertWavePolicyEnvelopeIntegrity,
  defaultWaveRolloutPolicy,
  evaluateWaveProductionPolicy,
  wavePolicyEnvironment,
  type WavePolicyEnvelope,
  type WavePolicyRequest,
  type WaveQualificationIdentity,
  type WaveRolloutPolicy,
} from './wave-production-policy';

interface RolloutRow {
  enabled: boolean;
  qualification_receipt_id: string | number | null;
  cohort: string;
  workspace_allowlist: string[];
  run_allowlist: Array<string | number>;
  max_parallelism: number | string;
  max_active_wave_runs: number | string;
  max_active_wave_runs_per_workspace: number | string;
  max_cpu_percent: number | string;
  max_memory_percent: number | string;
  max_error_rate: number | string;
  observed_cpu_percent: number | string;
  observed_memory_percent: number | string;
  observed_error_rate: number | string;
  halted: boolean;
  draining: boolean;
  rationale: string;
  release_readiness_packet_id: string | null;
  production_activation_approval_id: string | null;
  release_readiness_current: boolean;
  operator_activation_current: boolean;
  policy_epoch: number | string;
}

interface ReceiptRow {
  id: string | number;
  report_hash: string;
  source_revision: string;
  report: QualificationReport | string;
  receipt: QualificationReceipt | string;
  production_enable_available: boolean;
}

function json<T>(value: T | string): T {
  return typeof value === 'string' ? JSON.parse(value) as T : value;
}

function trustedIssuers(): Record<string, Record<string, string>> | null {
  const serialized = process.env.RORCA_QUALIFICATION_TRUSTED_ISSUERS_JSON;
  if (!serialized) return null;
  try {
    const parsed = JSON.parse(serialized) as Record<string, Record<string, string>>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function rolloutFrom(row: RolloutRow | undefined): WaveRolloutPolicy {
  if (!row) return defaultWaveRolloutPolicy();
  return {
    enabled: row.enabled,
    cohort: row.cohort,
    workspaceAllowlist: row.workspace_allowlist ?? [],
    runAllowlist: (row.run_allowlist ?? []).map(Number),
    maxParallelism: Number(row.max_parallelism),
    maxActiveWaveRuns: Number(row.max_active_wave_runs),
    maxActiveWaveRunsPerWorkspace: Number(row.max_active_wave_runs_per_workspace),
    maxCpuPercent: Number(row.max_cpu_percent),
    maxMemoryPercent: Number(row.max_memory_percent),
    maxErrorRate: Number(row.max_error_rate),
    observedCpuPercent: Number(row.observed_cpu_percent),
    observedMemoryPercent: Number(row.observed_memory_percent),
    observedErrorRate: Number(row.observed_error_rate),
    halted: row.halted,
    draining: row.draining,
    rationale: row.rationale,
    releaseReadinessPacketId: row.release_readiness_packet_id,
    productionActivationApprovalId: row.production_activation_approval_id,
    releaseReadinessCurrent: row.release_readiness_current,
    operatorActivationCurrent: row.operator_activation_current,
    policyEpoch: Number(row.policy_epoch ?? 0),
  };
}

export async function resolveWaveProductionPolicy(input: {
  workspaceId: string;
  workspacePath: string;
  request: WavePolicyRequest;
  runId?: number;
}): Promise<WavePolicyEnvelope> {
  const rolloutRow = await queryOne<RolloutRow>(
    `SELECT control.*,
            EXISTS (
              SELECT 1
                FROM wave_release_readiness_packets packet
                JOIN wave_qualification_receipts receipt
                  ON receipt.id = packet.qualification_receipt_id
               WHERE packet.id = control.release_readiness_packet_id
                 AND packet.workspace_id = control.workspace_id
                 AND packet.qualification_receipt_id = control.qualification_receipt_id
                 AND packet.report_hash = receipt.report_hash
                 AND packet.source_revision = receipt.source_revision
                 AND packet.approved
            ) AS release_readiness_current,
            EXISTS (
              SELECT 1
                FROM wave_production_activation_approvals approval
               WHERE approval.id = control.production_activation_approval_id
                 AND approval.workspace_id = control.workspace_id
                 AND approval.release_readiness_packet_id = control.release_readiness_packet_id
            ) AS operator_activation_current,
            control.policy_epoch
       FROM wave_parallel_rollout_controls control
      WHERE control.workspace_id = $1`,
    [input.workspaceId],
  );
  const rollout = rolloutFrom(rolloutRow);
  let currentRevision = '';
  try {
    currentRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: input.workspacePath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // Missing revision fails closed only for a requested qualified wave. Ordinary
    // sequential work remains available.
  }
  let receiptIdentity: WaveQualificationIdentity | null = null;
  if (rolloutRow?.qualification_receipt_id !== null && rolloutRow?.qualification_receipt_id !== undefined) {
    const receiptRow = await queryOne<ReceiptRow>(
      'SELECT * FROM wave_qualification_receipts WHERE id = $1 AND workspace_id = $2',
      [rolloutRow.qualification_receipt_id, input.workspaceId],
    );
    if (receiptRow) {
      let current = false;
      const issuers = trustedIssuers();
      if (issuers) {
        try {
          const localIdentity = computeLocalQualificationIdentity(input.workspacePath, input.workspaceId);
          verifyQualificationReceipt({
            report: json(receiptRow.report),
            receipt: json(receiptRow.receipt),
            localIdentity,
            requiredScenarioIds: QUALIFICATION_SCENARIOS,
            requiredAssertionIds: loadCanonicalQualificationAssertionIds(),
            trustedIssuers: issuers,
            now: new Date().toISOString(),
          });
          current = true;
        } catch {
          current = false;
        }
      }
      receiptIdentity = {
        id: String(receiptRow.id),
        reportHash: receiptRow.report_hash,
        sourceRevision: receiptRow.source_revision,
        current,
        productionEnableAvailable: receiptRow.production_enable_available,
      };
    }
  }
  const counts = await queryOne<{ global_count: string; workspace_count: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE orchestration_mode = 'wave-parallel' AND status IN ('starting', 'running') AND ($2::bigint IS NULL OR id <> $2))::text AS global_count,
       COUNT(*) FILTER (WHERE workspace_id = $1 AND orchestration_mode = 'wave-parallel' AND status IN ('starting', 'running') AND ($2::bigint IS NULL OR id <> $2))::text AS workspace_count
     FROM pipeline_runs`,
    [input.workspaceId, input.runId ?? null],
  );
  return evaluateWaveProductionPolicy({
    request: input.request,
    environment: wavePolicyEnvironment(),
    workspaceId: input.workspaceId,
    runId: input.runId,
    currentRevision,
    receipt: receiptIdentity,
    rollout,
    activeWaveRuns: Number(counts?.global_count ?? 0),
    activeWorkspaceWaveRuns: Number(counts?.workspace_count ?? 0),
  });
}

export async function auditWaveProductionDecision(input: {
  envelope: WavePolicyEnvelope;
  actor: string;
  rationale?: string;
  eventType?: 'enable' | 'deny' | 'receipt_verification' | 'cohort_change' | 'automatic_halt' | 'rollback' | 'drain' | 'cancel';
  outcome?: 'allowed' | 'denied' | 'halted' | 'draining' | 'recorded';
}): Promise<void> {
  const actor = input.actor.replace(/[^A-Za-z0-9@._:-]/g, '_').slice(0, 256) || 'local-operator';
  const rationale = (input.rationale ?? input.envelope.reason).replace(/[\r\n]/g, ' ').slice(0, 2048);
  const eventType = input.eventType ?? (input.envelope.allowed ? 'enable' : 'deny');
  const outcome = input.outcome ?? (input.envelope.allowed ? 'allowed' : input.envelope.status === 'draining' ? 'draining' : input.envelope.status === 'halted' ? 'halted' : 'denied');
  await queryOne(
    `INSERT INTO wave_parallel_governance_audit (
       workspace_id, run_id, event_type, actor, rationale, receipt_hash,
       source_revision, requested_policy, effective_policy, rollout_cohort,
       fencing_policy, outcome
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12)
     RETURNING id`,
    [
      input.envelope.workspaceId,
      input.envelope.runId,
      eventType,
      actor,
      rationale,
      input.envelope.receipt?.reportHash ?? null,
      input.envelope.receipt?.sourceRevision ?? null,
      JSON.stringify(input.envelope.requested),
      JSON.stringify({ ...input.envelope.effective, status: input.envelope.status, fence: input.envelope.fence }),
      input.envelope.rollout.cohort,
      input.envelope.fencingPolicy,
      outcome,
    ],
  );
}

export async function revalidatePersistedWavePolicy(input: {
  runId: number;
  queueEnvelope?: unknown;
}): Promise<WavePolicyEnvelope> {
  const row = await queryOne<{
    workspace_id: string;
    workspace_path: string;
    wave_policy: WavePolicyEnvelope | string | null;
    orchestration_mode: string | null;
    parallelism: number;
  }>(
    `SELECT run.workspace_id, workspace.path AS workspace_path, run.wave_policy,
            run.orchestration_mode, run.parallelism
       FROM pipeline_runs run
       JOIN workspaces workspace ON workspace.id = run.workspace_id
      WHERE run.id = $1`,
    [input.runId],
  );
  if (!row) throw new Error('[wave-production-policy] run row is missing');
  if (!row.wave_policy) {
    if ((row.orchestration_mode ?? 'sequential') === 'sequential' && Number(row.parallelism ?? 1) === 1) {
      return resolveWaveProductionPolicy({ workspaceId: row.workspace_id, workspacePath: row.workspace_path, runId: input.runId, request: {} });
    }
    throw new Error('[wave-production-policy] parallel run is missing governed policy evidence');
  }
  const envelope = json(row.wave_policy);
  if (input.queueEnvelope) {
    const queueEnvelope = input.queueEnvelope as WavePolicyEnvelope;
    assertWavePolicyEnvelopeIntegrity(queueEnvelope);
    if (queueEnvelope.fence !== envelope.fence) throw new Error('[wave-production-policy] queue fence differs from persisted run fence');
  }
  assertWavePolicyEnvelopeIntegrity(envelope);
  if (envelope.effective.orchestrationMode === 'sequential') {
    if ((row.orchestration_mode ?? 'sequential') !== 'sequential' || Number(row.parallelism ?? 1) !== 1) {
      throw new Error('[wave-production-policy] sequential envelope cannot authorize parallel persisted work');
    }
    return envelope;
  }
  const current = await resolveWaveProductionPolicy({
    workspaceId: row.workspace_id,
    workspacePath: row.workspace_path,
    runId: input.runId,
    request: envelope.requested,
  });
  if (current.fence !== envelope.fence) throw new Error(`[wave-production-policy] persisted policy is stale: ${current.reason}`);
  return current;
}

export type WaveDispatchClaim = { claimed: boolean; reason?: string; leaseExpiresAt?: string };

/**
 * The only queued -> starting transition for governed dispatch.  The control row,
 * capacity check/reservation and ownership fence are committed together, so two
 * workers cannot both observe a free slot or start the same queue message.
 */
export async function claimWaveProductionDispatch(input: {
  runId: number;
  owner: string;
  envelope: WavePolicyEnvelope;
  leaseSeconds?: number;
}): Promise<WaveDispatchClaim> {
  assertWavePolicyEnvelopeIntegrity(input.envelope);
  const leaseSeconds = Math.max(30, Math.min(input.leaseSeconds ?? 300, 3600));
  return transaction(async (client: PoolClient) => {
    // Advisory locks serialize global and workspace capacity accounting without
    // pretending a snapshot COUNT is a reservation.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('rorca:wave-capacity:global'))`);
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('rorca:wave-capacity:' || $1))`, [input.envelope.workspaceId]);
    const run = await client.query<{
      workspace_id: string; status: string; orchestration_mode: string | null;
      wave_policy_fence: string | null; wave_policy_epoch: string | null;
    }>(`SELECT workspace_id, status, orchestration_mode, wave_policy_fence, wave_policy_epoch
          FROM pipeline_runs WHERE id = $1 FOR UPDATE`, [input.runId]);
    const row = run.rows[0];
    if (!row || row.status !== 'queued') return { claimed: false, reason: 'run_not_queued' };
    if (row.workspace_id !== input.envelope.workspaceId || row.wave_policy_fence !== input.envelope.fence
      || Number(row.wave_policy_epoch ?? 0) !== input.envelope.rollout.policyEpoch) {
      return { claimed: false, reason: 'persisted_policy_mismatch' };
    }
    const control = await client.query<{
      policy_epoch: string; max_active_wave_runs: string; max_active_wave_runs_per_workspace: string;
    }>(`SELECT policy_epoch, max_active_wave_runs, max_active_wave_runs_per_workspace
          FROM wave_parallel_rollout_controls WHERE workspace_id = $1 FOR UPDATE`, [row.workspace_id]);
    const controlRow = control.rows[0];
    // Sequential runs have epoch zero when no rollout row exists.  A rollout
    // control appearing after enqueue intentionally fences that stale payload.
    const currentEpoch = Number(controlRow?.policy_epoch ?? 0);
    if (currentEpoch !== input.envelope.rollout.policyEpoch) return { claimed: false, reason: 'policy_epoch_stale' };

    if (input.envelope.effective.orchestrationMode === 'wave-parallel') {
      if (!controlRow || !input.envelope.allowed) return { claimed: false, reason: 'parallel_not_authorized' };
      const counts = await client.query<{ global_count: string; workspace_count: string }>(
        `SELECT COUNT(*) FILTER (
                  WHERE orchestration_mode = 'wave-parallel' AND status IN ('starting', 'running')
                )::text AS global_count,
                COUNT(*) FILTER (
                  WHERE workspace_id = $1 AND orchestration_mode = 'wave-parallel'
                    AND status IN ('starting', 'running')
                )::text AS workspace_count
           FROM pipeline_runs`, [row.workspace_id]);
      const active = counts.rows[0];
      if (Number(active?.global_count ?? 0) >= Number(controlRow.max_active_wave_runs)
        || Number(active?.workspace_count ?? 0) >= Number(controlRow.max_active_wave_runs_per_workspace)) {
        return { claimed: false, reason: 'capacity_exhausted' };
      }
      await client.query(
        `INSERT INTO wave_parallel_capacity_reservations (run_id, workspace_id, policy_epoch, owner, fence, lease_expires_at)
         VALUES ($1, $2, $3, $4, $5, NOW() + ($6 * INTERVAL '1 second'))`,
        [input.runId, row.workspace_id, currentEpoch, input.owner, input.envelope.fence, leaseSeconds],
      );
    }
    const updated = await client.query<{ lease_expires_at: Date }>(
      `UPDATE pipeline_runs
          SET status = 'starting', started_at = COALESCE(started_at, NOW()), worker_id = $2,
              dispatch_owner = $2, dispatch_fence = $3,
              dispatch_lease_expires_at = NOW() + ($4 * INTERVAL '1 second'),
              lifecycle_status = 'starting', lifecycle_diagnostics = lifecycle_diagnostics || $5::jsonb,
              lifecycle_updated_at = NOW()
        WHERE id = $1 AND status = 'queued'
        RETURNING dispatch_lease_expires_at`,
      [input.runId, input.owner, input.envelope.fence, leaseSeconds, JSON.stringify({ owner: input.owner, process: 'atomic_dispatch_claim' })],
    );
    return updated.rows[0]
      ? { claimed: true, leaseExpiresAt: updated.rows[0].lease_expires_at.toISOString() }
      : { claimed: false, reason: 'claim_raced' };
  });
}

/** Guard worker lifecycle/status writes after a claim against a stale owner. */
export async function advanceClaimedWaveDispatch(input: {
  runId: number; owner: string; fence: string; lifecycle: 'starting' | 'running';
}): Promise<boolean> {
  const result = await queryOne<{ id: number }>(
    `UPDATE pipeline_runs SET status = 'running', lifecycle_status = $4,
       lifecycle_updated_at = NOW(), lifecycle_diagnostics = lifecycle_diagnostics || $5::jsonb
     WHERE id = $1 AND dispatch_owner = $2 AND dispatch_fence = $3
       AND dispatch_lease_expires_at > NOW() AND status = 'starting'
     RETURNING id`,
    [input.runId, input.owner, input.fence, input.lifecycle, JSON.stringify({ owner: input.owner, process: 'engine_spawned' })],
  );
  return Boolean(result);
}
