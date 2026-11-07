/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type PgBoss from 'pg-boss';
import { randomUUID } from 'node:crypto';
import { query, queryOne, transaction, withPgAdvisoryLock } from '../db/index';
import {
  createRun,
  getRunById,
  hashEffectivePolicy,
  insertStages,
  listActiveWorkflowConflicts,
  listStagesByRun,
  supersedeActiveWorkflowRuns,
  updateStageStatus,
  type InsertStageDependencyInput,
  type InsertStageInput,
  type PostSaveWorkflowRun,
  type PostSaveWorkflowStage,
  type PostSaveWorkflowStageKey,
} from '../db/spec-post-save';
import {
  advancePersistPostSaveDependencies,
  syncPersistPostSaveStageFromJob,
} from './spec-post-save';
import {
  compareAndSetJobStatus,
  getJob,
  recoverExactPostSaveJob,
  type JsonValue,
  type SpecJob,
  type SpecJobType,
} from '../db/spec-jobs';
import { initBoss, getBoss } from './pg-boss';
import { getPgBossSchemaName, getPgBossTableSql } from './pg-boss-schema';
import { publishSpecJobSnapshot } from './spec-job-events';
import { logger } from './logger';
import type { PostSavePolicy } from './post-save-policy';
import { POST_SAVE_POLICY_VERSION } from './post-save-policy';
import type { SpecStageFingerprints } from './spec-stage-fingerprints';
import { compileSpecPlan, type CompileSpecPlanResult } from './ssdlc-plan-service';

export type SpecPostSaveWorkflowStageKey = PostSaveWorkflowStageKey;
export type SpecPostSaveWorkflowStageStatus = 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'skipped';
export type SpecPostSaveWorkflowReason =
  | 'context_captured'
  | 'requested_by_policy'
  | 'disabled_by_policy'
  | 'fingerprint_unchanged'
  | 'durable_job_enqueueing'
  | 'durable_job_enqueued'
  | 'durable_job_enqueued_after_dependency'
  | 'job_started'
  | 'job_completed'
  | 'job_failed'
  | 'enqueue_failed'
  | 'blocked_by_required_stage_failed'
  | 'superseded_by_newer_save';

export interface SpecPostSaveWorkflowMemoryPayload {
  brief: string;
  stories: unknown[];
  contextSummary: Record<string, unknown>;
}

export interface StartSpecPostSaveWorkflowInput {
  specId: string;
  workspaceId: string;
  effectivePolicy: PostSavePolicy;
  saveGeneration?: number;
  generationLogId?: number;
  currentFingerprints?: Partial<SpecStageFingerprints>;
  priorFingerprints?: Partial<SpecStageFingerprints>;
  memory?: SpecPostSaveWorkflowMemoryPayload;
  source?: string;
  /**
   * Unique recovery execution. Normal save retries omit this and retain
   * save-generation idempotency; explicit repairs supply a fresh UUID.
   */
  workflowAttemptId?: string;
}

export interface SpecPostSaveWorkflowStageDefinition {
  key: SpecPostSaveWorkflowStageKey;
  dependsOn: SpecPostSaveWorkflowStageKey[];
  queueName: string | null;
  jobType: SpecJobType | null;
}

export type QueueableStageKey = 'enrich' | 'matchSkills' | 'memorySynthesis';

export type SpecPostSaveWorkflowJobMetadata = {
  origin: 'persist-post-save';
  workflow: 'spec-post-save-v1';
  workflowRunId: number;
  stage: QueueableStageKey;
  saveGeneration?: number;
  generationLogId?: number;
  effectivePolicyHash?: string;
  transportSchema: string;
  queueName: string;
  bossJobId: string;
  priority: number;
  singletonKey: string;
  fingerprint?: string;
  previousFingerprint?: string;
  memory?: SpecPostSaveWorkflowMemoryPayload;
};

export type ExactWorkflowRunForJobResult =
  | { ok: true; run: PostSaveWorkflowRun; metadata: SpecPostSaveWorkflowJobMetadata; stage: PostSaveWorkflowStage }
  | { ok: false; reason: 'metadata_invalid' | 'job_type_mismatch' | 'generation_invalid' | 'generation_mismatch' | 'run_binding_mismatch' | 'policy_integrity_mismatch' | 'stage_job_binding_mismatch' | 'transport_schema_mismatch' };

export const SPEC_POST_SAVE_STAGE_REGISTRY: readonly SpecPostSaveWorkflowStageDefinition[] = [
  { key: 'context', dependsOn: [], queueName: null, jobType: null },
  { key: 'enrich', dependsOn: ['context'], queueName: 'spec:enrich', jobType: 'enrich' },
  { key: 'matchSkills', dependsOn: ['enrich'], queueName: 'spec:match-skills', jobType: 'match-skills' },
  { key: 'memorySynthesis', dependsOn: ['matchSkills'], queueName: 'spec:memory-synthesis', jobType: 'memory-synthesis' },
] as const;

export const SPEC_POST_SAVE_STAGE_DEPENDENCIES: readonly InsertStageDependencyInput[] = SPEC_POST_SAVE_STAGE_REGISTRY
  .flatMap((stage) => stage.dependsOn.map((dependsOnStageKey) => ({ stageKey: stage.key, dependsOnStageKey })));

const STAGE_BY_KEY = new Map(SPEC_POST_SAVE_STAGE_REGISTRY.map((stage) => [stage.key, stage] as const));
const USER_TRIGGERED_POST_SAVE_PRIORITY = 1;
const POST_SAVE_SINGLETON_WINDOW_SECONDS = 1;
const TERMINAL_STAGE_STATUSES = new Set<SpecPostSaveWorkflowStageStatus>(['completed', 'failed', 'skipped']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function singletonKey(workspaceId: string, specId: string): string {
  return `persist-post-save:${workspaceId}:${specId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

function isWorkflowJobMetadata(value: unknown): value is SpecPostSaveWorkflowJobMetadata {
  if (!isRecord(value)) return false;
  return value.origin === 'persist-post-save'
    && value.workflow === 'spec-post-save-v1'
    && Number.isSafeInteger(value.workflowRunId)
    && Number(value.workflowRunId) > 0
    && (value.stage === 'enrich' || value.stage === 'matchSkills' || value.stage === 'memorySynthesis')
    && (value.saveGeneration === undefined || (Number.isSafeInteger(value.saveGeneration) && Number(value.saveGeneration) > 0))
    && (value.generationLogId === undefined || (Number.isSafeInteger(value.generationLogId) && Number(value.generationLogId) > 0))
    && (value.effectivePolicyHash === undefined || /^[0-9a-f]{64}$/.test(String(value.effectivePolicyHash)))
    && /^pgboss(?:_[a-z0-9_]{1,48})?$/.test(String(value.transportSchema))
    && typeof value.queueName === 'string'
    && UUID.test(String(value.bossJobId));
}

export function getSpecPostSaveWorkflowJobMetadata(job: Pick<SpecJob, 'requestPayload'>): SpecPostSaveWorkflowJobMetadata | null {
  return isWorkflowJobMetadata(job.requestPayload) ? job.requestPayload : null;
}

function stageRequestedByPolicy(stageKey: SpecPostSaveWorkflowStageKey, policy: PostSavePolicy): boolean {
  switch (stageKey) {
    case 'context': return policy.context === 'capture';
    case 'enrich': return policy.enrich === 'enqueue';
    case 'matchSkills': return policy.skills === 'match';
    case 'memorySynthesis': return policy.memory === 'synthesize';
  }
}

function fingerprintForStage(stageKey: SpecPostSaveWorkflowStageKey, fingerprints?: Partial<SpecStageFingerprints>): string | undefined {
  if (stageKey === 'enrich') return fingerprints?.enrichFingerprint;
  if (stageKey === 'matchSkills') return fingerprints?.matchSkillsFingerprint;
  return undefined;
}

function stageFingerprintUnchanged(stageKey: SpecPostSaveWorkflowStageKey, current?: Partial<SpecStageFingerprints>, prior?: Partial<SpecStageFingerprints>): boolean {
  const currentFingerprint = fingerprintForStage(stageKey, current);
  const previousFingerprint = fingerprintForStage(stageKey, prior);
  return !!currentFingerprint && !!previousFingerprint && currentFingerprint === previousFingerprint;
}

function buildInitialStages(input: StartSpecPostSaveWorkflowInput): InsertStageInput[] {
  const now = new Date();
  const contextRequested = stageRequestedByPolicy('context', input.effectivePolicy);
  const enrichRequested = stageRequestedByPolicy('enrich', input.effectivePolicy);
  const enrichSkippedByFingerprint = enrichRequested && stageFingerprintUnchanged('enrich', input.currentFingerprints, input.priorFingerprints);
  const matchRequested = stageRequestedByPolicy('matchSkills', input.effectivePolicy);
  const matchFingerprintUnchanged = matchRequested && stageFingerprintUnchanged('matchSkills', input.currentFingerprints, input.priorFingerprints);
  const enrichSatisfiedUpFront = !enrichRequested || enrichSkippedByFingerprint;
  const matchSkippedByFingerprint = matchFingerprintUnchanged && enrichSatisfiedUpFront;

  return SPEC_POST_SAVE_STAGE_REGISTRY.map((stage): InsertStageInput => {
    const requested = stageRequestedByPolicy(stage.key, input.effectivePolicy);
    const fingerprint = fingerprintForStage(stage.key, input.currentFingerprints) ?? null;
    const previousFingerprint = fingerprintForStage(stage.key, input.priorFingerprints) ?? null;

    if (stage.key === 'context') {
      return {
        stageKey: 'context',
        requested: contextRequested,
        status: contextRequested ? 'completed' : 'skipped',
        reason: contextRequested ? 'context_captured' : 'disabled_by_policy',
        finishedAt: now,
      };
    }

    if (!requested) {
      return {
        stageKey: stage.key,
        requested: false,
        status: 'skipped',
        reason: 'disabled_by_policy',
        ...(fingerprint ? { fingerprint } : {}),
        ...(previousFingerprint ? { previousFingerprint } : {}),
        finishedAt: now,
      };
    }

    const skipByFingerprint = stage.key === 'enrich' ? enrichSkippedByFingerprint : stage.key === 'matchSkills' ? matchSkippedByFingerprint : false;
    if (skipByFingerprint) {
      return {
        stageKey: stage.key,
        requested: true,
        status: 'skipped',
        reason: 'fingerprint_unchanged',
        ...(fingerprint ? { fingerprint } : {}),
        ...(previousFingerprint ? { previousFingerprint } : {}),
        finishedAt: now,
      };
    }

    return {
      stageKey: stage.key,
      requested: true,
      status: 'pending',
      reason: 'requested_by_policy',
      ...(fingerprint ? { fingerprint } : {}),
      ...(previousFingerprint ? { previousFingerprint } : {}),
    };
  });
}

async function ensureBossReady(): Promise<PgBoss> {
  await initBoss();
  return getBoss();
}

function jobTypeMatchesStage(jobType: SpecJobType, stage: QueueableStageKey): boolean {
  return (stage === 'enrich' && jobType === 'enrich')
    || (stage === 'matchSkills' && jobType === 'match-skills')
    || (stage === 'memorySynthesis' && jobType === 'memory-synthesis');
}

/**
 * Resolve only the workflow run named by immutable application-job metadata.
 * This deliberately never asks for the latest run: multiple policies may have
 * runs for one save generation and a later run must not capture an older job.
 */
export async function getExactWorkflowRunForJob(job: SpecJob): Promise<ExactWorkflowRunForJobResult> {
  const metadata = getSpecPostSaveWorkflowJobMetadata(job);
  if (!metadata) return { ok: false, reason: 'metadata_invalid' };
  if (!jobTypeMatchesStage(job.jobType, metadata.stage)) return { ok: false, reason: 'job_type_mismatch' };

  const generation = metadata.saveGeneration ?? job.saveGeneration;
  if (!Number.isSafeInteger(generation) || Number(generation) <= 0) {
    return { ok: false, reason: 'generation_invalid' };
  }
  const exactGeneration = Number(generation);
  if (job.saveGeneration !== null && job.saveGeneration !== exactGeneration) {
    return { ok: false, reason: 'generation_mismatch' };
  }

  const exactBinding = metadata.effectivePolicyHash !== undefined
    ? {
      workspaceId: job.workspaceId,
      specId: job.specId,
      saveGeneration: exactGeneration,
      effectivePolicyHash: metadata.effectivePolicyHash,
      ...(metadata.generationLogId !== undefined ? { generationLogId: metadata.generationLogId } : {}),
    }
    : undefined;
  const run = await getRunById(metadata.workflowRunId, exactBinding);
  if (!run
    || run.workspaceId !== job.workspaceId
    || run.specId !== job.specId
    || run.saveGeneration !== exactGeneration
    || (metadata.generationLogId !== undefined && run.generationLogId !== metadata.generationLogId)
    || (metadata.effectivePolicyHash !== undefined && run.effectivePolicyHash !== metadata.effectivePolicyHash)) {
    return { ok: false, reason: 'run_binding_mismatch' };
  }
  if (hashEffectivePolicy(run.effectivePolicy) !== run.effectivePolicyHash) {
    return { ok: false, reason: 'policy_integrity_mismatch' };
  }

  // Every metadata generation, including legacy rows, is subordinate to exact
  // stage/application-job/transport ownership. Full metadata must additionally
  // carry the durable pg-boss schema identity; missing or drifted evidence fails
  // closed instead of querying the process's current schema.
  const stage = (await listStagesByRun(run.id)).find((candidate) => candidate.stageKey === metadata.stage);
  if (!stage || stage.jobId !== job.id || stage.bossJobId !== job.bossJobId || job.bossJobId === null
    || metadata.bossJobId !== job.bossJobId || metadata.queueName !== stage.queueName) {
    return { ok: false, reason: 'stage_job_binding_mismatch' };
  }
  if (!metadata.transportSchema || !job.transportSchema || !stage.transportSchema
    || metadata.transportSchema !== job.transportSchema || stage.transportSchema !== job.transportSchema) {
    return { ok: false, reason: 'transport_schema_mismatch' };
  }

  return { ok: true, run, metadata, stage };
}

export async function claimExactPostSaveWorkflowJob(input: {
  jobId:string;workspaceId:string;specId:string;workflowRunId:number;stage:QueueableStageKey;
  bossJobId:string;queueName:string;transportSchema:string;startedAt:Date;
}):Promise<boolean>{
  return transaction(async(client)=>{
    const stage=(await client.query<{id:number;run_id:number;status:string;job_id:string;boss_job_id:string;queue_name:string;transport_schema:string}>(
      `SELECT id,run_id,status,job_id,boss_job_id,queue_name,transport_schema
         FROM spec_post_save_workflow_stages WHERE run_id=$1 AND stage_key=$2 FOR UPDATE`,
      [input.workflowRunId,input.stage])).rows[0];
    if(!stage)return false;
    const run=(await client.query<{id:number;workspace_id:string;spec_id:string;status:string}>(
      `SELECT id,workspace_id,spec_id,status FROM spec_post_save_workflow_runs WHERE id=$1 FOR UPDATE`,[input.workflowRunId])).rows[0];
    if(!run)return false;
    const job=(await client.query<{id:string;workspace_id:string;spec_id:string;status:string;boss_job_id:string;transport_schema:string;request_payload:Record<string,unknown>}>(
      `SELECT id,workspace_id,spec_id,status,boss_job_id,transport_schema,request_payload FROM spec_jobs WHERE id=$1::uuid FOR UPDATE`,[input.jobId])).rows[0];
    const metadata=job?.request_payload;
    if(!job||job.status!=='pending'||run.status!=='queued'||stage.status!=='queued'
      ||run.workspace_id!==input.workspaceId||run.spec_id!==input.specId
      ||job.workspace_id!==input.workspaceId||job.spec_id!==input.specId
      ||stage.job_id!==input.jobId||stage.boss_job_id!==input.bossJobId||job.boss_job_id!==input.bossJobId
      ||stage.queue_name!==input.queueName||stage.transport_schema!==input.transportSchema||job.transport_schema!==input.transportSchema
      ||metadata?.workflowRunId!==input.workflowRunId||metadata?.stage!==input.stage||metadata?.bossJobId!==input.bossJobId
      ||metadata?.queueName!==input.queueName||metadata?.transportSchema!==input.transportSchema)return false;
    const changed=await client.query(`UPDATE spec_jobs SET status='running',started_at=$2,progress_current=0,progress_total=0,
      progress_message=$3 WHERE id=$1::uuid AND status='pending' AND boss_job_id=$4::uuid AND transport_schema=$5`,
      [input.jobId,input.startedAt,`Picked up ${input.queueName} job`,input.bossJobId,input.transportSchema]);
    if(changed.rowCount!==1)return false;
    const stageChanged=await client.query(`UPDATE spec_post_save_workflow_stages
      SET status='running',reason='job_started',queue_status='running',queue_position=0,active_jobs_ahead=0,
          started_at=COALESCE(started_at,$3),updated_at=NOW()
      WHERE id=$1 AND status='queued' AND job_id=$2::uuid AND boss_job_id=$4 AND transport_schema=$5`,
      [stage.id,input.jobId,input.startedAt,input.bossJobId,input.transportSchema]);
    if(stageChanged.rowCount!==1)throw new Error('Exact post-save stage claim CAS lost');
    await client.query(`UPDATE spec_post_save_workflow_runs SET status='running',updated_at=NOW(),finished_at=NULL
      WHERE id=$1 AND status='queued'`,[input.workflowRunId]);
    return true;
  });
}

async function getRunForJob(job: SpecJob, metadata: SpecPostSaveWorkflowJobMetadata): Promise<PostSaveWorkflowRun | null> {
  const resolved = await getExactWorkflowRunForJob(job);
  if (!resolved.ok || resolved.metadata.workflowRunId !== metadata.workflowRunId) return null;
  return resolved.run;
}

async function isJobStale(job: SpecJob, metadata: SpecPostSaveWorkflowJobMetadata): Promise<boolean> {
  const generation = metadata.saveGeneration ?? job.saveGeneration;
  if (generation == null) return false;
  const latest = await queryOne<{ save_generation: number | string | null }>(
    `SELECT COALESCE(
        save_generation,
        CASE
          WHEN context_summary_json->>'saveGeneration' ~ '^\\d+$'
          THEN (context_summary_json->>'saveGeneration')::bigint
          ELSE NULL
        END,
        id::bigint
      ) AS save_generation
     FROM spec_generation_logs
     WHERE spec_slug = $1
       AND context_summary_json->>'workspaceId' = $2
       AND context_summary_json ? 'postSaveStages'
     ORDER BY COALESCE(
        save_generation,
        CASE
          WHEN context_summary_json->>'saveGeneration' ~ '^\\d+$'
          THEN (context_summary_json->>'saveGeneration')::bigint
          ELSE NULL
        END,
        id::bigint
      ) DESC, created_at DESC, id DESC
     LIMIT 1`,
    [job.specId,job.workspaceId],
  );
  return latest?.save_generation !== null && latest?.save_generation !== undefined && Number(latest.save_generation) > generation;
}

export async function markSpecPostSaveWorkflowJobSupersededIfStale(jobId: string): Promise<boolean> {
  const job = await getJob(jobId);
  if (!job) return false;
  const metadata = getSpecPostSaveWorkflowJobMetadata(job);
  if (!metadata) return false;
  if (!(await isJobStale(job, metadata))) return false;

  const superseded = await compareAndSetJobStatus({
    jobId: job.id, status: 'superseded', expectedStatuses: ['pending','running'],
    expectedWorkspaceId: job.workspaceId, expectedSpecId: job.specId,
    ...(job.bossJobId ? { expectedBossJobId: job.bossJobId } : {}),
    ...(job.transportSchema ? { expectedTransportSchema: job.transportSchema } : {}),
    fields: { finishedAt: new Date(), progressMessage: 'Superseded by newer spec save',
      resultPayload: asJsonValue({ skipped: true, skipReason: 'superseded_by_newer_save' }), errorMessage: null },
  });
  if (superseded) logger.info({ component: 'post-save-workflow', event: 'stale_job_superseded', jobId: job.id, specId: job.specId }, '[post-save-workflow] telemetry');
  return superseded || (await getJob(job.id))?.status === 'superseded';
}

function stageStateForJob(job: SpecJob, metadata: SpecPostSaveWorkflowJobMetadata): Pick<PostSaveWorkflowStage, 'status' | 'reason'> & Partial<PostSaveWorkflowStage> {
  if (job.status === 'running') {
    return { status: 'running', reason: 'job_started', startedAt: job.startedAt ?? new Date() } as Partial<PostSaveWorkflowStage> & Pick<PostSaveWorkflowStage, 'status' | 'reason'>;
  }
  if (job.status === 'completed') {
    return { status: 'completed', reason: 'job_completed', errorMessage: null, finishedAt: job.finishedAt ?? new Date() } as Partial<PostSaveWorkflowStage> & Pick<PostSaveWorkflowStage, 'status' | 'reason'>;
  }
  if (job.status === 'failed' || job.status === 'cancelled') {
    return { status: 'failed', reason: 'job_failed', errorMessage: job.status === 'cancelled'
      ? 'Application job was cancelled; raw diagnostics are restricted.'
      : 'Application job failed; raw diagnostics are restricted.', finishedAt: job.finishedAt ?? new Date() } as Partial<PostSaveWorkflowStage> & Pick<PostSaveWorkflowStage, 'status' | 'reason'>;
  }
  if (job.status === 'superseded') {
    return { status: 'skipped', reason: 'superseded_by_newer_save', errorMessage: null, finishedAt: job.finishedAt ?? new Date() } as Partial<PostSaveWorkflowStage> & Pick<PostSaveWorkflowStage, 'status' | 'reason'>;
  }
  return {
    status: job.bossJobId ? 'queued' : 'pending',
    reason: job.bossJobId ? 'durable_job_enqueued' : 'requested_by_policy',
    errorMessage: null,
    bossJobId: job.bossJobId,
    queuePriority: metadata.priority,
    singletonKey: metadata.singletonKey,
  } as Partial<PostSaveWorkflowStage> & Pick<PostSaveWorkflowStage, 'status' | 'reason'>;
}

function allowedCurrentStatusesForSyncedState(status: SpecPostSaveWorkflowStageStatus): SpecPostSaveWorkflowStageStatus[] {
  switch (status) {
    case 'pending':
      return ['pending'];
    case 'queued':
      return ['pending', 'queued'];
    case 'running':
      return ['pending', 'queued', 'running'];
    case 'completed':
    case 'failed':
    case 'skipped':
      return ['pending', 'queued', 'running'];
  }
}

export async function syncSpecPostSaveWorkflowStageFromJob(jobId: string): Promise<void> {
  const job = await getJob(jobId);
  if (!job) return;
  const metadata = getSpecPostSaveWorkflowJobMetadata(job);
  if (!metadata) return;
  if (await isJobStale(job, metadata)) return;

  const run = await getRunForJob(job, metadata);
  if (!run) return;
  const state = stageStateForJob(job, metadata);
  await updateStageStatus({
    runId: run.id,
    stageKey: metadata.stage,
    status: state.status,
    reason: state.reason,
    allowedCurrentStatuses: allowedCurrentStatusesForSyncedState(state.status),
    expectedJobId: job.id,
    expectedBossJobId: job.bossJobId,
    expectedTransportSchema: job.transportSchema,
    queueName: STAGE_BY_KEY.get(metadata.stage)?.queueName ?? null,
    queueStatus: state.status === 'running' ? 'running' : state.status === 'queued' ? 'queued' : null,
    queuePosition: state.status === 'queued' ? 1 : state.status === 'running' ? 0 : null,
    activeJobsAhead: state.status === 'queued' || state.status === 'running' ? 0 : null,
    queuePriority: metadata.priority,
    singletonKey: metadata.singletonKey,
    fingerprint: metadata.fingerprint ?? null,
    previousFingerprint: metadata.previousFingerprint ?? null,
    errorMessage: state.errorMessage,
    ...(state.status === 'running' ? { startedAt: state.startedAt ?? new Date() } : {}),
    ...(TERMINAL_STAGE_STATUSES.has(state.status) ? { finishedAt: state.finishedAt ?? new Date() } : {}),
  });
}

function stagesByKey(stages: PostSaveWorkflowStage[]): Map<SpecPostSaveWorkflowStageKey, PostSaveWorkflowStage> {
  return new Map(stages.map((stage) => [stage.stageKey, stage]));
}

function dependencyStages(stageKey: SpecPostSaveWorkflowStageKey, stages: Map<SpecPostSaveWorkflowStageKey, PostSaveWorkflowStage>): PostSaveWorkflowStage[] {
  const definition = STAGE_BY_KEY.get(stageKey);
  return (definition?.dependsOn ?? []).map((dependency) => stages.get(dependency)).filter((stage): stage is PostSaveWorkflowStage => !!stage);
}

function dependenciesSatisfied(stageKey: SpecPostSaveWorkflowStageKey, stages: Map<SpecPostSaveWorkflowStageKey, PostSaveWorkflowStage>): boolean {
  return dependencyStages(stageKey, stages).every((stage) => stage.status === 'completed' || stage.status === 'skipped');
}

function failedDependency(stageKey: SpecPostSaveWorkflowStageKey, stages: Map<SpecPostSaveWorkflowStageKey, PostSaveWorkflowStage>): PostSaveWorkflowStage | undefined {
  return dependencyStages(stageKey, stages).find((stage) => stage.status === 'failed' && stage.requested);
}

function dependentsOf(stageKey: SpecPostSaveWorkflowStageKey): SpecPostSaveWorkflowStageKey[] {
  return SPEC_POST_SAVE_STAGE_REGISTRY
    .filter((stage) => stage.dependsOn.includes(stageKey))
    .map((stage) => stage.key);
}

function metadataForStage(input: {
  run: PostSaveWorkflowRun;
  stage: PostSaveWorkflowStage;
  workspaceId: string;
  specId: string;
  memory?: SpecPostSaveWorkflowMemoryPayload;
  bossJobId: string;
  queueName: string;
}): SpecPostSaveWorkflowJobMetadata {
  const base: SpecPostSaveWorkflowJobMetadata = {
    origin: 'persist-post-save',
    workflow: 'spec-post-save-v1',
    workflowRunId: input.run.id,
    stage: input.stage.stageKey as QueueableStageKey,
    priority: USER_TRIGGERED_POST_SAVE_PRIORITY,
    singletonKey: singletonKey(input.workspaceId, input.specId),
    ...(input.run.saveGeneration !== null ? { saveGeneration: input.run.saveGeneration } : {}),
    ...(input.run.generationLogId !== null ? { generationLogId: input.run.generationLogId } : {}),
    effectivePolicyHash: input.run.effectivePolicyHash,
    transportSchema: getPgBossSchemaName(),
    queueName: input.queueName,
    bossJobId: input.bossJobId,
    ...(input.stage.fingerprint ? { fingerprint: input.stage.fingerprint } : {}),
    ...(input.stage.previousFingerprint ? { previousFingerprint: input.stage.previousFingerprint } : {}),
  };
  if (input.stage.stageKey === 'memorySynthesis' && input.memory) {
    base.memory = input.memory;
  }
  return base;
}

async function publishBoundWorkflowTransport(input: {
  job: SpecJob;
  metadata: SpecPostSaveWorkflowJobMetadata;
  queueName: string;
  reason: SpecPostSaveWorkflowReason;
}): Promise<void> {
  if (input.job.bossJobId !== input.metadata.bossJobId || input.job.transportSchema !== input.metadata.transportSchema
    || input.metadata.queueName !== input.queueName) throw new Error('Bound post-save publication ownership mismatch');
  if (input.metadata.transportSchema !== getPgBossSchemaName()) throw new Error('Bound post-save publication schema mismatch');
  const boss = await ensureBossReady();
  const publishedId = await boss.send(input.queueName, {
    jobId: input.job.id,
    specId: input.job.specId,
    workspaceId: input.job.workspaceId,
    workflowRunId: input.metadata.workflowRunId,
    stage: input.metadata.stage,
    bossJobId: input.metadata.bossJobId,
    queueName: input.metadata.queueName,
    transportSchema: input.metadata.transportSchema,
  }, {
    id: input.metadata.bossJobId,
    priority: input.metadata.priority,
    singletonKey: input.metadata.singletonKey,
    singletonSeconds: POST_SAVE_SINGLETON_WINDOW_SECONDS,
    // Application state is terminalized by the worker on every owned failure;
    // transport retries cannot outlive or resurrect that exact state.
    retryLimit: 0,
  });
  if (publishedId !== input.metadata.bossJobId) throw new Error(`Exact pg-boss publication failed for ${input.queueName}`);
  await compareAndSetJobStatus({
    jobId: input.job.id,
    status: 'pending',
    expectedStatuses: ['pending'],
    expectedWorkspaceId: input.job.workspaceId,
    expectedSpecId: input.job.specId,
    expectedBossJobId: input.metadata.bossJobId,
    expectedTransportSchema: input.metadata.transportSchema,
    fields: { progressMessage: `Queued ${input.queueName} job`, errorMessage: null, finishedAt: null },
  });
  await updateStageStatus({
    runId: input.metadata.workflowRunId,
    stageKey: input.metadata.stage,
    status: 'queued',
    reason: input.reason,
    allowedCurrentStatuses: ['queued'],
    expectedJobId: input.job.id,
    expectedBossJobId: input.metadata.bossJobId,
    expectedTransportSchema: input.metadata.transportSchema,
    queueStatus: 'queued', queuePosition: 1, activeJobsAhead: 0, errorMessage: null,
  });
}

async function enqueueStage(input: {
  run: PostSaveWorkflowRun;
  stage: PostSaveWorkflowStage;
  workspaceId: string;
  specId: string;
  reason: SpecPostSaveWorkflowReason;
  memory?: SpecPostSaveWorkflowMemoryPayload;
}): Promise<boolean> {
  const definition = STAGE_BY_KEY.get(input.stage.stageKey);
  if (!definition?.queueName || !definition.jobType) return false;
  const jobId = randomUUID();
  const bossJobId = randomUUID();
  const transportSchema = getPgBossSchemaName();
  const metadata = metadataForStage({
    run: input.run, stage: input.stage, workspaceId: input.workspaceId, specId: input.specId,
    memory: input.memory, bossJobId, queueName: definition.queueName,
  });

  const bound = await transaction(async (client) => {
    const stage = (await client.query<{ id: number }>(
      `SELECT id FROM spec_post_save_workflow_stages
       WHERE run_id=$1 AND stage_key=$2 FOR UPDATE`,
      [input.run.id, input.stage.stageKey],
    )).rows[0];
    if (!stage) return false;
    const run = (await client.query<{ id: number }>(
      `SELECT id FROM spec_post_save_workflow_runs
       WHERE id=$1 AND workspace_id=$2 AND spec_id=$3 FOR UPDATE`,
      [input.run.id, input.workspaceId, input.specId],
    )).rows[0];
    if (!run) return false;
    const inserted = await client.query(
      `INSERT INTO spec_jobs(id,workspace_id,spec_id,job_type,status,request_payload,save_generation,boss_job_id,transport_schema)
       SELECT $1::uuid,$2,$3,$4,'pending',$5::jsonb,$6,$7::uuid,$8
       WHERE EXISTS (
         SELECT 1 FROM spec_post_save_workflow_stages
         WHERE id=$9 AND status='pending' AND job_id IS NULL AND boss_job_id IS NULL AND transport_schema IS NULL
       )
       RETURNING id`,
      [jobId,input.workspaceId,input.specId,definition.jobType,JSON.stringify(metadata),input.run.saveGeneration,bossJobId,transportSchema,stage.id],
    );
    if (inserted.rowCount !== 1) return false;
    const updated = await client.query(
      `UPDATE spec_post_save_workflow_stages
       SET status='queued',reason='durable_job_enqueueing',job_id=$3::uuid,boss_job_id=$4,
           queue_name=$5,transport_schema=$6,queue_status='queued',queue_position=1,active_jobs_ahead=0,
           queue_priority=$7,singleton_key=$8,fingerprint=$9,previous_fingerprint=$10,error_message=NULL,updated_at=NOW()
       WHERE run_id=$1 AND stage_key=$2 AND status='pending' AND job_id IS NULL AND boss_job_id IS NULL AND transport_schema IS NULL`,
      [input.run.id,input.stage.stageKey,jobId,bossJobId,definition.queueName,transportSchema,metadata.priority,
        metadata.singletonKey,metadata.fingerprint ?? null,metadata.previousFingerprint ?? null],
    );
    if (updated.rowCount !== 1) throw new Error('Atomic post-save stage ownership binding lost');
    await client.query(`UPDATE spec_post_save_workflow_runs SET status='queued',updated_at=NOW(),finished_at=NULL
      WHERE id=$1 AND status IN ('pending','queued')`,[input.run.id]);
    return true;
  });
  if (!bound) return false;
  const job = await getJob(jobId);
  if (!job) throw new Error('Bound post-save application job is missing');
  try {
    await publishBoundWorkflowTransport({ job, metadata, queueName: definition.queueName, reason: input.reason });
    logger.info({ component: 'post-save-workflow', event: 'stage_queued', runId: input.run.id, stage: input.stage.stageKey, jobId, bossJobId }, '[post-save-workflow] telemetry');
  } catch (error) {
    // Publication is idempotently recoverable under the preallocated UUID. Do
    // not terminalize an ambiguous send; startup/periodic recovery republishes
    // only this exact bound payload before workers are registered.
    logger.warn({ errorName:error instanceof Error?error.name:'unknown', component:'post-save-workflow', event:'publication_deferred', runId:input.run.id, stage:input.stage.stageKey, jobId, bossJobId }, '[post-save-workflow] exact publication deferred');
  }
  return true;
}

export async function recoverBoundPostSaveWorkflowPublications(limit = 100): Promise<{scanned:number;published:number;failed:number}> {
  const bounded = Math.max(1,Math.min(limit,100));
  // Stages intentionally retain the legacy TEXT contract. Cast the UUID side
  // outward so empty or malformed legacy stage values cannot abort recovery.
  const rows = await query<{ id:string; request_payload:JsonValue }>(
    `SELECT job.id,job.request_payload
       FROM spec_jobs job
       JOIN spec_post_save_workflow_stages stage ON stage.job_id=job.id AND stage.boss_job_id=job.boss_job_id::text
        AND stage.transport_schema=job.transport_schema
       JOIN spec_post_save_workflow_runs run ON run.id=stage.run_id AND run.workspace_id=job.workspace_id AND run.spec_id=job.spec_id
      WHERE job.status='pending' AND job.boss_job_id IS NOT NULL AND job.transport_schema IS NOT NULL
        AND stage.status='queued'
        AND stage.queue_name IS NOT NULL
      ORDER BY job.created_at,job.id LIMIT $1`,[bounded]);
  let published=0,failed=0;
  for(const row of rows){
    const job=await getJob(row.id);const metadata=job?getSpecPostSaveWorkflowJobMetadata(job):null;
    if(!job||!metadata){failed++;continue;}
    try{
      await publishBoundWorkflowTransport({job,metadata,queueName:metadata.queueName,reason:'durable_job_enqueued'});
      published++;
    }catch(error){
      // A transport that already reached a terminal pg-boss state under the
      // preallocated id can never be republished (send returns null for a
      // duplicate id). Terminalize the exact application row instead of
      // deferring this publication every reconcile interval forever.
      const terminalTransport = await isTransportTerminalForPublication({
        bossJobId: metadata.bossJobId,
        queueName: metadata.queueName,
      }).catch(() => false);
      if (terminalTransport) {
        const terminalized = await recoverExactPostSaveJob({
          jobId: job.id,
          workspaceId: job.workspaceId,
          specId: job.specId,
          stageKey: metadata.stage as 'enrich' | 'matchSkills' | 'memorySynthesis',
          bossJobId: metadata.bossJobId,
          transportSchema: metadata.transportSchema,
          saveGeneration: metadata.saveGeneration ?? job.saveGeneration ?? -1,
          message: `Transport terminalized before application terminalization; recovery published no replacement`,
        }).catch(() => false);
        if (terminalized) {
          await syncPersistPostSaveStageFromJob(job.id).catch(() => undefined);
          await advancePersistPostSaveDependencies(job.id).catch(() => undefined);
          await publishSpecJobSnapshot(job.id, 'terminal').catch(() => undefined);
          failed++;
          continue;
        }
      }
      failed++;
      logger.warn({component:'post-save-workflow',event:'publication_recovery_failed',jobId:row.id,errorName:error instanceof Error?error.name:'unknown'},'[post-save-workflow] publication recovery deferred');
    }
  }
  return {scanned:rows.length,published,failed};
}

/** Read-only proof that the preallocated transport id is already terminal. */
async function isTransportTerminalForPublication(input: {
  bossJobId: string;
  queueName: string;
}): Promise<boolean> {
  const state = await queryOne<{ state: string }>(
    `SELECT state FROM ${getPgBossTableSql('job')} WHERE id=$1 AND name=$2
     UNION ALL
     SELECT state FROM ${getPgBossTableSql('archive')} WHERE id=$1 AND name=$2
     LIMIT 1`,
    [input.bossJobId, input.queueName],
  );
  return state ? ['completed', 'failed', 'cancelled'].includes(state.state) : false;
}

async function blockStageAndDependents(input: {
  run: PostSaveWorkflowRun;
  stageKey: SpecPostSaveWorkflowStageKey;
  blockedBy: PostSaveWorkflowStage;
  message: string;
}): Promise<boolean> {
  const blocked = await updateStageStatus({
    runId: input.run.id,
    stageKey: input.stageKey,
    status: 'failed',
    reason: 'blocked_by_required_stage_failed',
    allowedCurrentStatuses: ['pending'],
    errorMessage: input.message,
    details: asJsonValue({ blockedByStage: input.blockedBy.stageKey, blockedByReason: input.blockedBy.reason }),
  });
  if (!blocked) return false;

  for (const dependent of dependentsOf(input.stageKey)) {
    await blockStageAndDependents({
      run: input.run,
      stageKey: dependent,
      blockedBy: blocked,
      message: `Blocked because ${input.stageKey} did not complete successfully`,
    });
  }
  return true;
}

async function ensureStageGraphMaterialized(run: PostSaveWorkflowRun, input: StartSpecPostSaveWorkflowInput): Promise<void> {
  const existingStages = await listStagesByRun(run.id);
  const existingStageKeys = new Set(existingStages.map((stage) => stage.stageKey));
  const missingStages = buildInitialStages(input).filter((stage) => !existingStageKeys.has(stage.stageKey));
  await insertStages(run.id, missingStages, [...SPEC_POST_SAVE_STAGE_DEPENDENCIES]);
}

async function advanceReadyStages(run: PostSaveWorkflowRun, options: { workspaceId: string; specId: string; memory?: SpecPostSaveWorkflowMemoryPayload }): Promise<void> {
  let progressed = true;
  while (progressed) {
    progressed = false;
    const stages = await listStagesByRun(run.id);
    const byKey = stagesByKey(stages);

    for (const stage of stages) {
      if (stage.status !== 'pending' || !stage.requested) continue;
      const failed = failedDependency(stage.stageKey, byKey);
      if (failed) {
        const blocked = await blockStageAndDependents({
          run,
          stageKey: stage.stageKey,
          blockedBy: failed,
          message: `Blocked because ${failed.stageKey} did not complete successfully`,
        });
        progressed = blocked || progressed;
        continue;
      }
      if (!dependenciesSatisfied(stage.stageKey, byKey)) continue;
      const enqueued = await enqueueStage({
        run,
        stage,
        workspaceId: options.workspaceId,
        specId: options.specId,
        reason: 'durable_job_enqueued_after_dependency',
        memory: options.memory,
      });
      // Refresh only after this invocation durably claimed the stage. A failed
      // enqueue still counts because the claim and failed-state transition must
      // be observed before blocking dependents. A lost CAS must terminate.
      progressed = enqueued || progressed;
    }
  }
}

async function startSpecPostSaveWorkflowLocked(input: StartSpecPostSaveWorkflowInput): Promise<PostSaveWorkflowRun> {
  const effectivePolicy = {
    ...input.effectivePolicy,
    version: POST_SAVE_POLICY_VERSION,
  } as JsonValue;
  const attemptId = input.workflowAttemptId?.trim();
  if (input.workflowAttemptId !== undefined && !attemptId) {
    throw new Error('Post-save workflow attempt id must be non-empty when provided');
  }
  const generationKey = input.saveGeneration ?? 'latest';
  const idempotencyBase = `spec-post-save-v1:${input.workspaceId}:${input.specId}:${generationKey}`;
  const idempotencyKey = attemptId ? `${idempotencyBase}:attempt:${attemptId}` : idempotencyBase;
  const conflicts = await listActiveWorkflowConflicts({
    workspaceId: input.workspaceId,
    specId: input.specId,
    effectivePolicy,
  });
  const sameRunConflict = conflicts.find((conflict) => conflict.idempotencyKey === idempotencyKey);
  if (sameRunConflict) {
    await ensureStageGraphMaterialized(sameRunConflict, input);
    await advanceReadyStages(sameRunConflict, { workspaceId: input.workspaceId, specId: input.specId, memory: input.memory });
    return sameRunConflict;
  }
  if (conflicts.length > 0) {
    await supersedeActiveWorkflowRuns(input.workspaceId, input.specId, conflicts[0].effectivePolicyHash);
  }

  const run = await createRun({
    workspaceId: input.workspaceId,
    specId: input.specId,
    generationLogId: input.generationLogId ?? null,
    saveGeneration: input.saveGeneration ?? null,
    effectivePolicy,
    idempotencyKey,
    status: 'pending',
    source: input.source ?? 'persist-post-save',
  });

  await insertStages(run.id, buildInitialStages(input), [...SPEC_POST_SAVE_STAGE_DEPENDENCIES]);
  await advanceReadyStages(run, { workspaceId: input.workspaceId, specId: input.specId, memory: input.memory });
  return run;
}

export function withSpecPostSaveWorkflowFence<T>(
  workspaceId: string,
  specId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withPgAdvisoryLock(`spec-post-save-workflow:${workspaceId}:${specId}`,operation);
}

/** For orchestrators already holding withSpecPostSaveWorkflowFence. */
export function startSpecPostSaveWorkflowUnderFence(input: StartSpecPostSaveWorkflowInput): Promise<PostSaveWorkflowRun> {
  return startSpecPostSaveWorkflowLocked(input);
}

/**
 * Serializes conflict detection, non-resetting materialization, application-job
 * creation, transport publication, and final ownership binding for one spec.
 */
export async function startSpecPostSaveWorkflow(input: StartSpecPostSaveWorkflowInput): Promise<PostSaveWorkflowRun> {
  return withSpecPostSaveWorkflowFence(input.workspaceId,input.specId,() => startSpecPostSaveWorkflowLocked(input));
}

export async function finalizeSpecPostSavePlanIfReady(
  run: PostSaveWorkflowRun,
  options: { throwOnFailure?: boolean; source?: 'canonical-persist' | 'post-save-finalizer' } = {},
): Promise<CompileSpecPlanResult | null> {
  const stages = await listStagesByRun(run.id);
  if (!Array.isArray(stages) || stages.some((stage) => ['pending', 'queued', 'running'].includes(stage.status))) {
    return null;
  }

  const workspace = await queryOne<{ path: string }>('SELECT path FROM workspaces WHERE id = $1', [run.workspaceId]);
  if (!workspace) return null;
  try {
    return await compileSpecPlan({
      workspaceId: run.workspaceId,
      workspacePath: workspace.path,
      specSlug: run.specId,
      expectedSaveGeneration: run.saveGeneration,
      source: options.source ?? 'post-save-finalizer',
    });
  } catch (error) {
    logger.warn({ err: error, runId: run.id, specId: run.specId }, '[post-save-workflow] lifecycle plan finalizer deferred for retry');
    if (options.throwOnFailure) throw error;
    return null;
  }
}

export async function advanceSpecPostSaveWorkflowDependencies(jobId: string): Promise<void> {
  const job = await getJob(jobId);
  if (!job) return;
  const metadata = getSpecPostSaveWorkflowJobMetadata(job);
  if (!metadata) return;
  if (!['completed', 'failed', 'cancelled', 'superseded'].includes(job.status)) return;
  if (await isJobStale(job, metadata)) return;

  const run = await getRunForJob(job, metadata);
  if (!run) return;
  await syncSpecPostSaveWorkflowStageFromJob(jobId);
  await advanceReadyStages(run, { workspaceId: job.workspaceId, specId: job.specId, memory: metadata.memory });
  await finalizeSpecPostSavePlanIfReady(run);
}
