/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type PgBoss from 'pg-boss';
import { queryOne } from '../db/index';
import {
  createRun,
  getLatestRunForSpec,
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
  createJob,
  getJob,
  updateJobStatus,
  type JsonValue,
  type SpecJob,
  type SpecJobType,
} from '../db/spec-jobs';
import { initBoss, getBoss } from './pg-boss';
import { logger } from './logger';
import type { PostSavePolicy } from './post-save-policy';
import { POST_SAVE_POLICY_VERSION } from './post-save-policy';
import type { SpecStageFingerprints } from './spec-stage-fingerprints';

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
}

export interface SpecPostSaveWorkflowStageDefinition {
  key: SpecPostSaveWorkflowStageKey;
  dependsOn: SpecPostSaveWorkflowStageKey[];
  queueName: string | null;
  jobType: SpecJobType | null;
}

type QueueableStageKey = 'enrich' | 'matchSkills' | 'memorySynthesis';

type SpecPostSaveWorkflowJobMetadata = {
  origin: 'persist-post-save';
  workflow: 'spec-post-save-v1';
  workflowRunId: number;
  stage: QueueableStageKey;
  saveGeneration?: number;
  priority: number;
  singletonKey: string;
  fingerprint?: string;
  previousFingerprint?: string;
  memory?: SpecPostSaveWorkflowMemoryPayload;
};

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

function singletonKey(workspaceId: string, specId: string): string {
  return `persist-post-save:${workspaceId}:${specId}`;
}

function errorMessageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    && typeof value.workflowRunId === 'number'
    && (value.stage === 'enrich' || value.stage === 'matchSkills' || value.stage === 'memorySynthesis');
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

async function getRunForJob(job: SpecJob, metadata: SpecPostSaveWorkflowJobMetadata): Promise<PostSaveWorkflowRun | null> {
  const byGeneration = await getLatestRunForSpec(job.specId, {
    workspaceId: job.workspaceId,
    saveGeneration: metadata.saveGeneration ?? job.saveGeneration ?? null,
  });
  if (byGeneration?.id === metadata.workflowRunId) return byGeneration;
  if (byGeneration && metadata.workflowRunId === undefined) return byGeneration;

  const byLatest = await getLatestRunForSpec(job.specId, { workspaceId: job.workspaceId });
  return byLatest?.id === metadata.workflowRunId ? byLatest : null;
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
    [job.specId],
  );
  return latest?.save_generation !== null && latest?.save_generation !== undefined && Number(latest.save_generation) > generation;
}

export async function markSpecPostSaveWorkflowJobSupersededIfStale(jobId: string): Promise<boolean> {
  const job = await getJob(jobId);
  if (!job) return false;
  const metadata = getSpecPostSaveWorkflowJobMetadata(job);
  if (!metadata) return false;
  if (!(await isJobStale(job, metadata))) return false;

  await updateJobStatus(job.id, 'superseded', {
    finishedAt: new Date(),
    progressMessage: 'Superseded by newer spec save',
    resultPayload: asJsonValue({ skipped: true, skipReason: 'superseded_by_newer_save' }),
    errorMessage: null,
  });
  logger.info({ component: 'post-save-workflow', event: 'stale_job_superseded', jobId: job.id, specId: job.specId }, '[post-save-workflow] telemetry');
  return true;
}

function stageStateForJob(job: SpecJob, metadata: SpecPostSaveWorkflowJobMetadata): Pick<PostSaveWorkflowStage, 'status' | 'reason'> & Partial<PostSaveWorkflowStage> {
  if (job.status === 'running') {
    return { status: 'running', reason: 'job_started', startedAt: job.startedAt ?? new Date() } as Partial<PostSaveWorkflowStage> & Pick<PostSaveWorkflowStage, 'status' | 'reason'>;
  }
  if (job.status === 'completed') {
    return { status: 'completed', reason: 'job_completed', errorMessage: null, finishedAt: job.finishedAt ?? new Date() } as Partial<PostSaveWorkflowStage> & Pick<PostSaveWorkflowStage, 'status' | 'reason'>;
  }
  if (job.status === 'failed' || job.status === 'cancelled') {
    return { status: 'failed', reason: 'job_failed', errorMessage: job.errorMessage ?? 'Job failed', finishedAt: job.finishedAt ?? new Date() } as Partial<PostSaveWorkflowStage> & Pick<PostSaveWorkflowStage, 'status' | 'reason'>;
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
    jobId: job.id,
    bossJobId: job.bossJobId,
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
}): SpecPostSaveWorkflowJobMetadata {
  const base: SpecPostSaveWorkflowJobMetadata = {
    origin: 'persist-post-save',
    workflow: 'spec-post-save-v1',
    workflowRunId: input.run.id,
    stage: input.stage.stageKey as QueueableStageKey,
    priority: USER_TRIGGERED_POST_SAVE_PRIORITY,
    singletonKey: singletonKey(input.workspaceId, input.specId),
    ...(input.run.saveGeneration !== null ? { saveGeneration: input.run.saveGeneration } : {}),
    ...(input.stage.fingerprint ? { fingerprint: input.stage.fingerprint } : {}),
    ...(input.stage.previousFingerprint ? { previousFingerprint: input.stage.previousFingerprint } : {}),
  };
  if (input.stage.stageKey === 'memorySynthesis' && input.memory) {
    base.memory = input.memory;
  }
  return base;
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

  const claimed = await updateStageStatus({
    runId: input.run.id,
    stageKey: input.stage.stageKey,
    status: 'queued',
    reason: 'durable_job_enqueueing',
    allowedCurrentStatuses: ['pending'],
    queueName: definition.queueName,
    queueStatus: 'queued',
    queuePosition: 1,
    activeJobsAhead: 0,
    queuePriority: USER_TRIGGERED_POST_SAVE_PRIORITY,
    singletonKey: singletonKey(input.workspaceId, input.specId),
  });
  if (!claimed) return false;

  let job: SpecJob | null = null;
  try {
    const metadata = metadataForStage({ run: input.run, stage: input.stage, workspaceId: input.workspaceId, specId: input.specId, memory: input.memory });
    job = await createJob(input.workspaceId, input.specId, definition.jobType, asJsonValue(metadata));
    const boss = await ensureBossReady();
    const bossJobId = await boss.send(definition.queueName, {
      jobId: job.id,
      specId: input.specId,
      workspaceId: input.workspaceId,
    }, {
      priority: metadata.priority,
      singletonKey: metadata.singletonKey,
      singletonSeconds: POST_SAVE_SINGLETON_WINDOW_SECONDS,
    });

    if (!bossJobId) throw new Error(`boss.send() returned null for ${definition.queueName}`);

    await updateJobStatus(job.id, 'pending', {
      bossJobId,
      progressMessage: `Queued ${definition.queueName} job`,
      errorMessage: null,
      finishedAt: null,
    });
    await updateStageStatus({
      runId: input.run.id,
      stageKey: input.stage.stageKey,
      status: 'queued',
      reason: input.reason,
      allowedCurrentStatuses: ['queued'],
      jobId: job.id,
      bossJobId,
      queueName: definition.queueName,
      queueStatus: 'queued',
      queuePosition: 1,
      activeJobsAhead: 0,
      queuePriority: metadata.priority,
      singletonKey: metadata.singletonKey,
      fingerprint: metadata.fingerprint ?? null,
      previousFingerprint: metadata.previousFingerprint ?? null,
      errorMessage: null,
    });
    logger.info({ component: 'post-save-workflow', event: 'stage_queued', runId: input.run.id, stage: input.stage.stageKey, jobId: job.id, bossJobId }, '[post-save-workflow] telemetry');
    return true;
  } catch (error) {
    const message = errorMessageFor(error);
    if (job) {
      await updateJobStatus(job.id, 'failed', {
        errorMessage: message,
        finishedAt: new Date(),
        progressMessage: `Failed to enqueue ${definition.queueName} job`,
      });
    }
    await updateStageStatus({
      runId: input.run.id,
      stageKey: input.stage.stageKey,
      status: 'failed',
      reason: 'enqueue_failed',
      ...(job ? { jobId: job.id } : {}),
      errorMessage: message,
    });
    logger.warn({ err: error, component: 'post-save-workflow', runId: input.run.id, stage: input.stage.stageKey }, '[post-save-workflow] durable enqueue failed');
    return false;
  }
}

async function blockStageAndDependents(input: {
  run: PostSaveWorkflowRun;
  stageKey: SpecPostSaveWorkflowStageKey;
  blockedBy: PostSaveWorkflowStage;
  message: string;
}): Promise<void> {
  const blocked = await updateStageStatus({
    runId: input.run.id,
    stageKey: input.stageKey,
    status: 'failed',
    reason: 'blocked_by_required_stage_failed',
    allowedCurrentStatuses: ['pending'],
    errorMessage: input.message,
    details: asJsonValue({ blockedByStage: input.blockedBy.stageKey, blockedByReason: input.blockedBy.reason }),
  });
  if (!blocked) return;

  for (const dependent of dependentsOf(input.stageKey)) {
    await blockStageAndDependents({
      run: input.run,
      stageKey: dependent,
      blockedBy: blocked,
      message: `Blocked because ${input.stageKey} did not complete successfully`,
    });
  }
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
        await blockStageAndDependents({
          run,
          stageKey: stage.stageKey,
          blockedBy: failed,
          message: `Blocked because ${failed.stageKey} did not complete successfully`,
        });
        progressed = true;
        continue;
      }
      if (!dependenciesSatisfied(stage.stageKey, byKey)) continue;
      await enqueueStage({
        run,
        stage,
        workspaceId: options.workspaceId,
        specId: options.specId,
        reason: 'durable_job_enqueued_after_dependency',
        memory: options.memory,
      });
      // Refresh after both success and enqueue failure. A failed required stage
      // must durably block its dependents even when no worker will run.
      progressed = true;
    }
  }
}

export async function startSpecPostSaveWorkflow(input: StartSpecPostSaveWorkflowInput): Promise<PostSaveWorkflowRun> {
  const effectivePolicy = {
    ...input.effectivePolicy,
    version: POST_SAVE_POLICY_VERSION,
  } as unknown as JsonValue;
  const idempotencyKey = `spec-post-save-v1:${input.workspaceId}:${input.specId}:${input.saveGeneration ?? 'latest'}`;
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
}
