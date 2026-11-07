/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Exact-run reconciliation for terminal application-owned post-save jobs. */
import * as crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, transaction } from '../db/index';
import type { SpecJob, SpecJobStatus } from '../db/spec-jobs';
import type {
  PostSaveWorkflowRun,
  PostSaveWorkflowStageKey,
  PostSaveWorkflowStageStatus,
} from '../db/spec-post-save';
import { getJob } from '../db/spec-jobs';
import {
  getExactWorkflowRunForJob,
  withSpecPostSaveWorkflowFence,
} from './spec-post-save-workflow';
import { getPgBossSchemaSql } from './pg-boss-schema';
import { logger } from './logger';

export const SPEC_POST_SAVE_RECONCILIATION_VERSION = 'rorca.spec-post-save-reconciliation.v1' as const;
export type ReconcileSource = 'operator' | 'repair' | 'stage_retry' | 'worker_recovery';
export type QueueBackedPostSaveStage = Exclude<PostSaveWorkflowStageKey, 'context'>;
export type ReconcileOutcome = 'accepted' | 'rejected' | 'no_op';

export interface ReconcilePostSaveStageInput {
  workspaceId: string;
  specId: string;
  workflowRunId: number;
  stageKey: QueueBackedPostSaveStage;
  applicationJobId: string;
  operationId: string;
  source: ReconcileSource;
  actorId: string;
  authorityClass: 'local_human_admin' | 'internal_controller';
}

export interface ReconcilePostSaveStageResult {
  schemaVersion: typeof SPEC_POST_SAVE_RECONCILIATION_VERSION;
  outcome: ReconcileOutcome;
  reasonCode: string;
  workspaceId: string;
  specId: string;
  workflowRunId: number;
  stageKey: QueueBackedPostSaveStage;
  applicationJobId: string;
  bossJobId: string | null;
  beforeStatus: PostSaveWorkflowStageStatus | null;
  afterStatus: PostSaveWorkflowStageStatus | null;
  applicationJobStatus: SpecJobStatus | null;
  transport: { location: 'live' | 'archive' | 'missing'; state: string | null };
  auditId: number | null;
}

interface RunRow {
  id: number | string;
  workspace_id: string;
  spec_id: string;
  generation_log_id: number | string | null;
  save_generation: number | string | null;
  effective_policy_hash: string;
  effective_policy: PostSaveWorkflowRun['effectivePolicy'];
  idempotency_key: string;
  status: PostSaveWorkflowRun['status'];
  source: string;
  error_message: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  finished_at: Date | string | null;
}

interface StageRow {
  id: number | string;
  run_id: number | string;
  stage_key: QueueBackedPostSaveStage;
  requested: boolean;
  status: PostSaveWorkflowStageStatus;
  reason: string;
  job_id: string | null;
  boss_job_id: string | null;
  queue_name: string | null;
  transport_schema: string | null;
  error_message: string | null;
}

interface TransportRow {
  id: string;
  name: string;
  state: string;
  data: Record<string, unknown> | null;
  location: 'live' | 'archive';
}

interface AuditInsert {
  workspaceId: string;
  specId: string;
  workflowRunId: number | null;
  stageKey: QueueBackedPostSaveStage | null;
  applicationJobId: string | null;
  bossJobId: string | null;
  operationId: string;
  source: ReconcileSource;
  actorId: string;
  authorityClass: 'local_human_admin' | 'internal_controller';
  requestHash: string;
  operationReceiptId?: number | null;
  outcome: ReconcileOutcome;
  reasonCode: string;
  beforeStatus: PostSaveWorkflowStageStatus | null;
  afterStatus: PostSaveWorkflowStageStatus | null;
  applicationJobStatus: SpecJobStatus | null;
  transportLocation: 'live' | 'archive' | 'missing' | null;
  transportState: string | null;
}

const QUEUE_BY_STAGE: Record<QueueBackedPostSaveStage, string> = {
  enrich: 'spec:enrich',
  matchSkills: 'spec:match-skills',
  memorySynthesis: 'spec:memory-synthesis',
};
const LIVE_TRANSPORT_STATES = new Set(['created', 'retry', 'active']);
const TERMINAL_APPLICATION_STATES = new Set<SpecJobStatus>(['completed', 'failed', 'cancelled', 'superseded']);
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{7,199}$/;
const ACTOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function sha256(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function reconciliationRequestHash(input: ReconcilePostSaveStageInput): string {
  return sha256(stableStringify({
    schemaVersion: SPEC_POST_SAVE_RECONCILIATION_VERSION,
    workspaceId: input.workspaceId,
    specId: input.specId,
    workflowRunId: input.workflowRunId,
    stageKey: input.stageKey,
    applicationJobId: input.applicationJobId,
    source: input.source,
    actorId: input.actorId,
    authorityClass: input.authorityClass,
  }));
}

function operationKeyHash(operationId: string): string {
  return sha256(operationId);
}

function bindingHash(input: AuditInsert): string {
  return `sha256:${crypto.createHash('sha256').update(stableStringify({
    schemaVersion: SPEC_POST_SAVE_RECONCILIATION_VERSION,
    workspaceId: input.workspaceId,
    specId: input.specId,
    workflowRunId: input.workflowRunId,
    stageKey: input.stageKey,
    applicationJobId: input.applicationJobId,
    bossJobId: input.bossJobId,
    operationKeyHash: operationKeyHash(input.operationId),
    source: input.source,
    actorId: input.actorId,
    authorityClass: input.authorityClass,
    requestHash: input.requestHash,
    outcome: input.outcome,
    reasonCode: input.reasonCode,
    beforeStatus: input.beforeStatus,
    afterStatus: input.afterStatus,
    applicationJobStatus: input.applicationJobStatus,
    transportLocation: input.transportLocation,
    transportState: input.transportState,
  })).digest('hex')}`;
}

async function setWorkspaceScope(client: PoolClient, workspaceId: string): Promise<void> {
  await client.query("SELECT set_config('rorca.workspace_id',$1,TRUE)", [workspaceId]);
}

interface OperationReceiptRow {
  id: number | string;
  request_hash: string;
  response_json: ReconcilePostSaveStageResult;
}

async function getOperationReceipt(client: PoolClient, input: ReconcilePostSaveStageInput): Promise<OperationReceiptRow | null> {
  await setWorkspaceScope(client, input.workspaceId);
  return (await client.query<OperationReceiptRow>(
    `SELECT id,request_hash,response_json
       FROM spec_post_save_reconciliation_operations
      WHERE workspace_id=$1 AND actor_id=$2 AND authority_class=$3
        AND operation_kind='stage_reconciliation' AND operation_key_hash=$4`,
    [input.workspaceId, input.actorId, input.authorityClass, operationKeyHash(input.operationId)],
  )).rows[0] ?? null;
}

async function insertOperationReceipt(
  client: PoolClient,
  input: ReconcilePostSaveStageInput,
  requestHash: string,
  result: ReconcilePostSaveStageResult,
): Promise<void> {
  await client.query(
    `INSERT INTO spec_post_save_reconciliation_operations(
       workspace_id,actor_id,authority_class,operation_kind,operation_key_hash,request_hash,response_json
     ) VALUES($1,$2,$3,'stage_reconciliation',$4,$5,$6::jsonb)`,
    [input.workspaceId,input.actorId,input.authorityClass,operationKeyHash(input.operationId),requestHash,JSON.stringify(result)],
  );
}

async function insertAudit(client: PoolClient, input: AuditInsert): Promise<number> {
  await setWorkspaceScope(client, input.workspaceId);
  const row = (await client.query<{ id: number | string }>(
    `INSERT INTO spec_post_save_reconciliation_audit (
       workspace_id,spec_id,workflow_run_id,stage_key,application_job_id,boss_job_id,
       operation_id,source,actor_id,authority_class,request_hash,operation_receipt_id,
       outcome,reason_code,before_stage_status,after_stage_status,
       application_job_status,transport_location,transport_state,binding_hash
     ) VALUES ($1,$2,$3,$4,$5::uuid,$6::uuid,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     RETURNING id`,
    [
      input.workspaceId, input.specId, input.workflowRunId, input.stageKey,
      input.applicationJobId, input.bossJobId, operationKeyHash(input.operationId), input.source,
      input.actorId, input.authorityClass, input.requestHash, input.operationReceiptId ?? null,
      input.outcome, input.reasonCode, input.beforeStatus, input.afterStatus,
      input.applicationJobStatus, input.transportLocation, input.transportState,
      bindingHash(input),
    ],
  )).rows[0];
  return Number(row.id);
}

function mapRun(row: RunRow): PostSaveWorkflowRun {
  return {
    id: Number(row.id), workspaceId: row.workspace_id, specId: row.spec_id,
    generationLogId: row.generation_log_id === null ? null : Number(row.generation_log_id),
    saveGeneration: row.save_generation === null ? null : Number(row.save_generation),
    effectivePolicyHash: row.effective_policy_hash, effectivePolicy: row.effective_policy,
    idempotencyKey: row.idempotency_key, status: row.status, source: row.source,
    errorMessage: row.error_message, createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at), finishedAt: row.finished_at ? new Date(row.finished_at) : null,
  };
}

function emptyResult(input: ReconcilePostSaveStageInput, reasonCode: string): ReconcilePostSaveStageResult {
  return {
    schemaVersion: SPEC_POST_SAVE_RECONCILIATION_VERSION,
    outcome: 'rejected', reasonCode, workspaceId: input.workspaceId, specId: input.specId,
    workflowRunId: input.workflowRunId, stageKey: input.stageKey,
    applicationJobId: input.applicationJobId, bossJobId: null,
    beforeStatus: null, afterStatus: null, applicationJobStatus: null,
    transport: { location: 'missing', state: null }, auditId: null,
  };
}

function resultFromAudit(input: ReconcilePostSaveStageInput, audit: AuditInsert, auditId: number): ReconcilePostSaveStageResult {
  return {
    schemaVersion: SPEC_POST_SAVE_RECONCILIATION_VERSION,
    outcome: audit.outcome, reasonCode: audit.reasonCode,
    workspaceId: input.workspaceId, specId: input.specId, workflowRunId: input.workflowRunId,
    stageKey: input.stageKey, applicationJobId: input.applicationJobId,
    bossJobId: audit.bossJobId, beforeStatus: audit.beforeStatus, afterStatus: audit.afterStatus,
    applicationJobStatus: audit.applicationJobStatus,
    transport: { location: audit.transportLocation ?? 'missing', state: audit.transportState },
    auditId,
  };
}

function targetForJob(status: SpecJobStatus): { status: PostSaveWorkflowStageStatus; reason: string } | null {
  if (status === 'completed') return { status: 'completed', reason: 'job_completed' };
  if (status === 'failed' || status === 'cancelled') return { status: 'failed', reason: 'job_failed' };
  if (status === 'superseded') return { status: 'skipped', reason: 'superseded_by_newer_save' };
  return null;
}

async function inspectTransport(client: PoolClient, job: SpecJob, expectedQueue: string): Promise<{
  location: 'live' | 'archive' | 'missing';
  state: string | null;
  liveWork: boolean;
  valid: boolean;
  reasonCode?: string;
}> {
  if (!job.bossJobId || !UUID.test(job.bossJobId)) {
    return { location: 'missing', state: null, liveWork: false, valid: false, reasonCode: 'transport_identity_invalid' };
  }
  if (!job.transportSchema) {
    return { location: 'missing', state: null, liveWork: false, valid: false, reasonCode: 'transport_schema_missing' };
  }
  const schema = getPgBossSchemaSql(job.transportSchema);
  const read = async (table: 'job' | 'archive', location: 'live' | 'archive'): Promise<TransportRow[]> => {
    const rows = await client.query<Omit<TransportRow, 'location'>>(
      `SELECT id::text,name,state,data FROM ${schema}.${table}
       WHERE id=$1::uuid LIMIT 2`,
      [job.bossJobId],
    );
    return rows.rows.map((row) => ({ ...row, location }));
  };
  const rows = [...await read('job', 'live'), ...await read('archive', 'archive')];
  const liveWork = rows.some((row) => row.location === 'live' && LIVE_TRANSPORT_STATES.has(row.state));
  const exactRows = rows.filter((row) => row.id === job.bossJobId);
  if (rows.length > 1 || exactRows.length > 1) {
    return { location: exactRows[0]?.location ?? 'missing', state: exactRows[0]?.state ?? null, liveWork, valid: false, reasonCode: 'transport_duplicate' };
  }
  const exact = exactRows[0];
  if (!exact) {
    if (rows.length > 0) {
      return { location: rows[0].location, state: rows[0].state, liveWork, valid: false, reasonCode: 'transport_identity_mismatch' };
    }
    return { location: 'missing', state: null, liveWork: false, valid: true };
  }
  const data = exact.data;
  const valid = exact.name === expectedQueue
    && data?.jobId === job.id
    && data?.specId === job.specId
    && data?.workspaceId === job.workspaceId;
  return {
    location: exact.location,
    state: exact.state,
    liveWork,
    valid,
    ...(valid ? {} : { reasonCode: 'transport_identity_mismatch' }),
  };
}

async function hasExactStrictMemoryReceipt(
  client: PoolClient,
  input: { run: PostSaveWorkflowRun; stage: StageRow; job: SpecJob },
): Promise<boolean> {
  if (input.run.generationLogId === null || input.run.saveGeneration === null) return false;
  const row = (await client.query<{ ok: boolean }>(
    `SELECT TRUE AS ok
       FROM spec_memory_synthesis_receipts receipt
       JOIN memories memory ON memory.id=receipt.memory_id
      WHERE receipt.workspace_id=$1 AND receipt.spec_id=$2
        AND receipt.workflow_run_id=$3 AND receipt.workflow_stage_id=$4
        AND receipt.generation_log_id=$5 AND receipt.save_generation=$6
        AND receipt.policy_hash=$7 AND receipt.application_job_id=$8::uuid
        AND receipt.material_hash ~ '^sha256:[0-9a-f]{64}$'
        AND receipt.derivation_hash ~ '^sha256:[0-9a-f]{64}$'
        AND receipt.sandbox_profile='linux-bwrap-strict-memory-v2'
        AND memory.workspace_id=receipt.workspace_id AND memory.source_spec_id=receipt.spec_id
        AND memory.source_type='auto-extracted' AND memory.source='strict-spec-derived-facts-v2'
      LIMIT 1`,
    [input.run.workspaceId,input.run.specId,input.run.id,Number(input.stage.id),input.run.generationLogId,
      input.run.saveGeneration,input.run.effectivePolicyHash,input.job.id],
  )).rows[0];
  return row?.ok === true;
}

function safeStageFailureMessage(status: SpecJobStatus): string | null {
  if (status !== 'failed' && status !== 'cancelled') return null;
  return status === 'cancelled'
    ? 'Application job was cancelled; raw diagnostics are restricted.'
    : 'Application job failed; raw diagnostics are restricted.';
}

async function recomputeRunStatus(client: PoolClient, runId: number): Promise<void> {
  await client.query(
    `WITH counts AS (
       SELECT COUNT(*) FILTER (WHERE requested AND status='failed') failed,
              COUNT(*) FILTER (WHERE requested AND status='running') running,
              COUNT(*) FILTER (WHERE requested AND status IN ('pending','queued')) waiting,
              COUNT(*) total
       FROM spec_post_save_workflow_stages WHERE run_id=$1
     ), next AS (
       SELECT CASE WHEN total=0 THEN 'pending' WHEN failed>0 THEN 'failed'
         WHEN running>0 THEN 'running' WHEN waiting>0 THEN 'queued' ELSE 'completed' END status
       FROM counts
     )
     UPDATE spec_post_save_workflow_runs run
     SET status=next.status,updated_at=statement_timestamp(),
         finished_at=CASE WHEN next.status IN ('completed','failed','cancelled','superseded')
           THEN COALESCE(run.finished_at,statement_timestamp()) ELSE NULL END
     FROM next WHERE run.id=$1`,
    [runId],
  );
}

async function reconcileLocked(input: ReconcilePostSaveStageInput): Promise<ReconcilePostSaveStageResult> {
  return transaction(async (client) => {
    await setWorkspaceScope(client, input.workspaceId);
    const requestHash = reconciliationRequestHash(input);
    const prior = await getOperationReceipt(client, input);
    if (prior) {
      if (prior.request_hash === requestHash) return prior.response_json;
      const existingConflict = (await client.query<{ id: number | string }>(
        `SELECT id FROM spec_post_save_reconciliation_audit
          WHERE operation_receipt_id=$1 AND reason_code='idempotency_key_reused_with_changed_request' LIMIT 1`,
        [prior.id],
      )).rows[0];
      const audit: AuditInsert = {
        workspaceId: input.workspaceId,specId: input.specId,workflowRunId: input.workflowRunId,stageKey: input.stageKey,
        applicationJobId: input.applicationJobId,bossJobId:null,operationId:input.operationId,source:input.source,
        actorId:input.actorId,authorityClass:input.authorityClass,requestHash,operationReceiptId:Number(prior.id),
        outcome:'rejected',reasonCode:'idempotency_key_reused_with_changed_request',beforeStatus:null,afterStatus:null,
        applicationJobStatus:null,transportLocation:null,transportState:null,
      };
      const auditId = existingConflict ? Number(existingConflict.id) : await insertAudit(client,audit);
      return resultFromAudit(input,audit,auditId);
    }
    const finalize = async (audit: AuditInsert): Promise<ReconcilePostSaveStageResult> => {
      const result = resultFromAudit(input,audit,await insertAudit(client,audit));
      await insertOperationReceipt(client,input,requestHash,result);
      return result;
    };
    const reject = async (reasonCode: string, context: Partial<AuditInsert> = {}): Promise<ReconcilePostSaveStageResult> => {
      const audit: AuditInsert = {
        workspaceId: input.workspaceId, specId: input.specId,
        workflowRunId: input.workflowRunId, stageKey: input.stageKey,
        applicationJobId: UUID.test(input.applicationJobId) ? input.applicationJobId : null,
        bossJobId: null, operationId: input.operationId, source: input.source,
        actorId:input.actorId,authorityClass:input.authorityClass,requestHash,
        outcome: 'rejected', reasonCode, beforeStatus: null, afterStatus: null,
        applicationJobStatus: null, transportLocation: null, transportState: null,
        ...context,
      };
      return finalize(audit);
    };

    // Global row-lock order for every stage writer is stage -> run. Never take
    // the run first: worker synchronization uses this same order.
    const stage = (await client.query<StageRow>(
      `SELECT id,run_id,stage_key,requested,status,reason,job_id,boss_job_id,queue_name,transport_schema,error_message
       FROM spec_post_save_workflow_stages WHERE run_id=$1 AND stage_key=$2 FOR UPDATE`,
      [input.workflowRunId, input.stageKey],
    )).rows[0];
    if (!stage) return reject('stage_not_found');
    const runRow = (await client.query<RunRow>(
      'SELECT * FROM spec_post_save_workflow_runs WHERE id=$1 FOR UPDATE',
      [input.workflowRunId],
    )).rows[0];
    if (!runRow || runRow.workspace_id !== input.workspaceId || runRow.spec_id !== input.specId) {
      return reject('run_binding_mismatch');
    }
    const run = mapRun(runRow);
    if (stage.job_id !== input.applicationJobId) {
      return reject('stage_job_fence_mismatch', { beforeStatus: stage.status, afterStatus: stage.status });
    }
    await client.query('SELECT id FROM spec_jobs WHERE id=$1::uuid FOR UPDATE', [input.applicationJobId]);
    const job = await getJob(input.applicationJobId);
    if (!job) return reject('application_job_not_found', { beforeStatus: stage.status, afterStatus: stage.status });
    const exact = await getExactWorkflowRunForJob(job);
    if (!exact.ok || exact.run.id !== run.id || exact.metadata.stage !== input.stageKey) {
      return reject(`exact_job_${exact.ok ? 'stage_mismatch' : exact.reason}`, {
        beforeStatus: stage.status, afterStatus: stage.status,
        applicationJobStatus: job.status, bossJobId: UUID.test(job.bossJobId ?? '') ? job.bossJobId : null,
      });
    }
    const transport = await inspectTransport(client, job, QUEUE_BY_STAGE[input.stageKey]);
    const auditContext: Partial<AuditInsert> = {
      beforeStatus: stage.status, afterStatus: stage.status,
      applicationJobStatus: job.status, bossJobId: job.bossJobId,
      transportLocation: transport.location, transportState: transport.state,
    };
    if (!transport.valid) return reject(transport.reasonCode ?? 'transport_invalid', auditContext);
    if (transport.liveWork) return reject('transport_live_work', auditContext);
    if (!TERMINAL_APPLICATION_STATES.has(job.status)) return reject('application_job_nonterminal', auditContext);

    const target = targetForJob(job.status)!;
    if (stage.status === 'failed' && stage.requested && target.status !== 'failed') {
      return reject('required_failed_stage_cannot_be_promoted', auditContext);
    }
    if (input.stageKey === 'memorySynthesis' && job.status === 'completed'
      && !(await hasExactStrictMemoryReceipt(client,{ run,stage,job }))) {
      return reject('strict_memory_receipt_missing_or_mismatched',auditContext);
    }
    if (['completed', 'failed', 'skipped'].includes(stage.status)) {
      const same = stage.status === target.status;
      const audit: AuditInsert = {
        workspaceId: input.workspaceId, specId: input.specId, workflowRunId: run.id,
        stageKey: input.stageKey, applicationJobId: job.id, bossJobId: job.bossJobId,
        operationId: input.operationId, source: input.source,
        actorId:input.actorId,authorityClass:input.authorityClass,requestHash,
        outcome: same ? 'no_op' : 'rejected',
        reasonCode: same ? 'stage_already_reconciled' : 'terminal_stage_conflict',
        beforeStatus: stage.status, afterStatus: stage.status, applicationJobStatus: job.status,
        transportLocation: transport.location, transportState: transport.state,
      };
      return finalize(audit);
    }

    const updated = (await client.query<{ status: PostSaveWorkflowStageStatus }>(
      `UPDATE spec_post_save_workflow_stages
       SET status=$4,reason=$5,queue_status=NULL,queue_position=NULL,active_jobs_ahead=NULL,
           error_message=$6,updated_at=statement_timestamp(),
           started_at=CASE WHEN $4='running' THEN COALESCE(started_at,statement_timestamp()) ELSE started_at END,
           finished_at=CASE WHEN $4 IN ('completed','failed','skipped') THEN COALESCE(finished_at,statement_timestamp()) ELSE finished_at END
       WHERE run_id=$1 AND stage_key=$2 AND job_id=$3::uuid AND status=$7
       RETURNING status`,
      [run.id, input.stageKey, job.id, target.status, target.reason,
        safeStageFailureMessage(job.status),
        stage.status],
    )).rows[0];
    if (!updated) return reject('stage_compare_and_set_lost', auditContext);
    await recomputeRunStatus(client, run.id);

    const audit: AuditInsert = {
      workspaceId: input.workspaceId, specId: input.specId, workflowRunId: run.id,
      stageKey: input.stageKey, applicationJobId: job.id, bossJobId: job.bossJobId,
      operationId: input.operationId, source: input.source,
      actorId:input.actorId,authorityClass:input.authorityClass,requestHash,
      outcome: 'accepted', reasonCode: 'terminal_application_job_applied', beforeStatus: stage.status,
      afterStatus: target.status, applicationJobStatus: job.status,
      transportLocation: transport.location, transportState: transport.state,
    };
    return finalize(audit);
  });
}

export async function reconcilePostSaveWorkflowStage(input: ReconcilePostSaveStageInput): Promise<ReconcilePostSaveStageResult> {
  if (!OPERATION_ID.test(input.operationId) || !ACTOR_ID.test(input.actorId)
    || !['local_human_admin','internal_controller'].includes(input.authorityClass)
    || !Number.isSafeInteger(input.workflowRunId) || input.workflowRunId <= 0
    || !UUID.test(input.applicationJobId)) {
    return emptyResult(input, 'request_invalid');
  }
  try {
    return await withSpecPostSaveWorkflowFence(input.workspaceId,input.specId,() => reconcileLocked(input));
  } catch (error) {
    logger.warn({
      component: 'spec-post-save-reconciliation',
      event: 'reconciliation_evidence_unavailable',
      errorName: error instanceof Error ? error.name : 'unknown',
      errorCode: typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code ?? '') : '',
      ...(process.env.RORCA_RECONCILIATION_TEST_DIAGNOSTICS === '1' && error instanceof Error ? { testErrorMessage: error.message } : {}),
      workflowRunId: input.workflowRunId,
      stageKey: input.stageKey,
    }, '[spec-post-save-reconciliation] reconciliation failed closed');
    // The rejected audit is a separate bounded transaction because a transport
    // catalog/query failure aborts the locked transaction. It intentionally
    // stores only supplied identities and a stable reason code.
    const fallback = emptyResult(input, 'reconciliation_evidence_unavailable');
    try {
      return await transaction(async (client) => {
        const requestHash = reconciliationRequestHash(input);
        const prior = await getOperationReceipt(client,input);
        if (prior?.request_hash === requestHash) return prior.response_json;
        if (prior) {
          const existingConflict=(await client.query<{id:number|string}>(
            `SELECT id FROM spec_post_save_reconciliation_audit
              WHERE operation_receipt_id=$1 AND reason_code='idempotency_key_reused_with_changed_request' LIMIT 1`,[prior.id])).rows[0];
          const conflictAudit:AuditInsert={
            workspaceId:input.workspaceId,specId:input.specId,workflowRunId:input.workflowRunId,stageKey:input.stageKey,
            applicationJobId:input.applicationJobId,bossJobId:null,operationId:input.operationId,source:input.source,
            actorId:input.actorId,authorityClass:input.authorityClass,requestHash,operationReceiptId:Number(prior.id),
            outcome:'rejected',reasonCode:'idempotency_key_reused_with_changed_request',beforeStatus:null,afterStatus:null,
            applicationJobStatus:null,transportLocation:null,transportState:null,
          };
          const auditId=existingConflict?Number(existingConflict.id):await insertAudit(client,conflictAudit);
          return resultFromAudit(input,conflictAudit,auditId);
        }
        const audit: AuditInsert = {
          workspaceId: input.workspaceId, specId: input.specId, workflowRunId: input.workflowRunId,
          stageKey: input.stageKey, applicationJobId: input.applicationJobId, bossJobId: null,
          operationId: input.operationId, source: input.source,
          actorId:input.actorId,authorityClass:input.authorityClass,requestHash,
          outcome: 'rejected', reasonCode: fallback.reasonCode, beforeStatus: null, afterStatus: null,
          applicationJobStatus: null, transportLocation: null, transportState: null,
        };
        const result = resultFromAudit(input,audit,await insertAudit(client,audit));
        await insertOperationReceipt(client,input,requestHash,result);
        return result;
      });
    } catch (auditError) {
      logger.warn({
        component: 'spec-post-save-reconciliation',
        event: 'reconciliation_rejection_audit_unavailable',
        errorName: auditError instanceof Error ? auditError.name : 'unknown',
        errorCode: typeof auditError === 'object' && auditError !== null && 'code' in auditError ? String((auditError as { code?: unknown }).code ?? '') : '',
        ...(process.env.RORCA_RECONCILIATION_TEST_DIAGNOSTICS === '1' && auditError instanceof Error ? { testErrorMessage: auditError.message } : {}),
        workflowRunId: input.workflowRunId,
        stageKey: input.stageKey,
      }, '[spec-post-save-reconciliation] rejection audit failed closed');
      return fallback;
    }
  }
}

export async function reconcilePostSaveWorkflowStageUnderFence(input: ReconcilePostSaveStageInput): Promise<ReconcilePostSaveStageResult> {
  return reconcileLocked(input);
}

export interface StaleActiveRunReconciliationResult {
  workflowRunId: number;
  attempted: number;
  results: ReconcilePostSaveStageResult[];
}

/**
 * Repair/retry preflight: inspect only one named active run and reconcile at
 * most three stale queue-backed stages. It never supersedes another run and it
 * never enqueues work.
 */
export async function reconcileStaleActivePostSaveWorkflowRun(input: {
  workspaceId: string;
  specId: string;
  workflowRunId: number;
  source: 'repair' | 'stage_retry';
  now?: Date;
  fenceHeld?: boolean;
}): Promise<StaleActiveRunReconciliationResult> {
  const rows = await query<{
    stage_key: QueueBackedPostSaveStage;
    job_id: string;
    status: PostSaveWorkflowStageStatus;
    updated_at: Date | string;
  }>(
    `SELECT stage.stage_key,stage.job_id,stage.status,stage.updated_at
     FROM spec_post_save_workflow_runs run
     JOIN spec_post_save_workflow_stages stage ON stage.run_id=run.id
     WHERE run.id=$1 AND run.workspace_id=$2 AND run.spec_id=$3
       AND run.status IN ('pending','queued','running')
       AND stage.stage_key IN ('enrich','matchSkills','memorySynthesis')
       AND stage.status IN ('pending','queued','running')
       AND stage.job_id IS NOT NULL
     ORDER BY stage.id ASC LIMIT 3`,
    [input.workflowRunId, input.workspaceId, input.specId],
  );
  const now = (input.now ?? new Date()).getTime();
  const runningMinutes = Math.max(Number(process.env.RORCA_REPAIR_STALE_RUNNING_MINUTES ?? 15), 1);
  const queuedMinutes = Math.max(Number(process.env.RORCA_REPAIR_STALE_QUEUED_MINUTES ?? 30), 1);
  const stale = rows.filter((row) => {
    const threshold = row.status === 'running' ? runningMinutes : queuedMinutes;
    return now - new Date(row.updated_at).getTime() >= threshold * 60_000;
  });
  const results: ReconcilePostSaveStageResult[] = [];
  for (const row of stale) {
    const request: ReconcilePostSaveStageInput = {
      workspaceId: input.workspaceId,
      specId: input.specId,
      workflowRunId: input.workflowRunId,
      stageKey: row.stage_key,
      applicationJobId: row.job_id,
      operationId: `${input.source}:${input.workflowRunId}:${row.stage_key}:${row.job_id}`,
      source: input.source,
      actorId: `controller:${input.source}`,
      authorityClass: 'internal_controller',
    };
    results.push(await (input.fenceHeld
      ? reconcilePostSaveWorkflowStageUnderFence(request)
      : reconcilePostSaveWorkflowStage(request)));
  }
  return { workflowRunId: input.workflowRunId, attempted: stale.length, results };
}

export interface ExactPostSaveWorkflowInspection {
  schemaVersion: 'rorca.spec-post-save-workflow-inspection.v1';
  workflow: {
    runId: number;
    workspaceId: string;
    specId: string;
    saveGeneration: number | null;
    generationLogId: number | null;
    effectivePolicyHash: string;
    status: string;
    source: string;
  };
  stages: Array<{
    key: QueueBackedPostSaveStage | 'context';
    requested: boolean;
    status: string;
    reason: string;
    applicationJobId: string | null;
    bossJobId: string | null;
    transportSchema: string | null;
  }>;
}

export async function inspectExactPostSaveWorkflow(input: {
  workspaceId: string;
  specId: string;
  workflowRunId: number;
}): Promise<ExactPostSaveWorkflowInspection | null> {
  const runs = await query<RunRow>(
    `SELECT * FROM spec_post_save_workflow_runs
     WHERE id=$1 AND workspace_id=$2 AND spec_id=$3`,
    [input.workflowRunId, input.workspaceId, input.specId],
  );
  const row = runs[0];
  if (!row) return null;
  const stages = await query<StageRow>(
    `SELECT id,run_id,stage_key,requested,status,reason,job_id,boss_job_id,queue_name,transport_schema,error_message
     FROM spec_post_save_workflow_stages WHERE run_id=$1
     ORDER BY CASE stage_key WHEN 'context' THEN 1 WHEN 'enrich' THEN 2 WHEN 'matchSkills' THEN 3 ELSE 4 END`,
    [input.workflowRunId],
  );
  return {
    schemaVersion: 'rorca.spec-post-save-workflow-inspection.v1',
    workflow: {
      runId: Number(row.id), workspaceId: row.workspace_id, specId: row.spec_id,
      saveGeneration: row.save_generation === null ? null : Number(row.save_generation),
      generationLogId: row.generation_log_id === null ? null : Number(row.generation_log_id),
      effectivePolicyHash: row.effective_policy_hash, status: row.status, source: row.source,
    },
    stages: stages.map((stage) => ({
      key: stage.stage_key, requested: stage.requested, status: stage.status,
      reason: stage.reason, applicationJobId: stage.job_id, bossJobId: stage.boss_job_id,
      transportSchema: stage.transport_schema,
    })),
  };
}
