/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { query, queryOne, execute } from '../db/index';
import {
  createJob,
  getJob,
  listJobsForSpec,
  updateJobStatus,
  type JsonValue,
  type SpecJob,
} from '../db/spec-jobs';
import { initBoss, getBoss } from './pg-boss';
import { logger } from './logger';
import type { SpecStageFingerprints } from './spec-stage-fingerprints';

export interface PersistPostSaveOptionsShape {
  enrich: boolean;
  matchSkills: boolean;
  memorySynthesis: boolean;
}

export type PersistStageStatus = 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'skipped' | 'superseded';
export type PersistStageReason =
  | 'requested_by_caller'
  | 'disabled_by_caller'
  | 'waiting_for_enrich'
  | 'durable_job_enqueued'
  | 'durable_job_enqueued_after_enrich'
  | 'job_started'
  | 'job_completed'
  | 'enqueue_failed'
  | 'job_failed'
  | 'superseded_by_newer_save'
  | 'blocked_by_enrich_failure'
  | 'blocked_by_enrich_enqueue_failure'
  | 'fingerprint_unchanged'
  | 'metadata_only_skip'
  | 'story_content_only'
  | 'context_bearing_change'
  | 'no_installed_skills';

export type PersistContextSource = 'caller_supplied' | 'server_backfilled' | 'missing';

export interface PersistPostSaveStageState {
  requested: boolean;
  status: PersistStageStatus;
  reason: PersistStageReason;
  jobId?: string;
  bossJobId?: string | null;
  error?: string | null;
  updatedAt?: string;
  fingerprint?: string;
  previousFingerprint?: string;
}

export type PersistPostSaveStageMap = Record<keyof PersistPostSaveOptionsShape, PersistPostSaveStageState>;

type DurableStageName = 'enrich' | 'matchSkills';
type DurableStageJobType = 'enrich' | 'match-skills';

type PostSaveJobMetadata = {
  origin: 'persist-post-save';
  stage: DurableStageName;
  waitForStage?: DurableStageName;
  blockedBy?: DurableStageName;
  fingerprint?: string;
  previousFingerprint?: string;
  invalidatedByStage?: DurableStageName;
  skipReason?: PersistStageReason;
  saveGeneration?: number;
};

export interface PersistPostSaveFingerprintOptions {
  currentFingerprints?: Partial<SpecStageFingerprints>;
  priorFingerprints?: Partial<SpecStageFingerprints>;
  saveGeneration?: number;
}

const STAGE_TO_JOB_TYPE: Record<DurableStageName, DurableStageJobType> = {
  enrich: 'enrich',
  matchSkills: 'match-skills',
};

const STAGE_TO_QUEUE: Record<DurableStageJobType, string> = {
  enrich: 'spec:enrich',
  'match-skills': 'spec:match-skills',
};

function nowIso(): string {
  return new Date().toISOString();
}

function errorMessageFor(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' ? value as Record<string, unknown> : {};
}

function isPostSaveJobMetadata(value: unknown): value is PostSaveJobMetadata {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.origin === 'persist-post-save'
    && (record.stage === 'enrich' || record.stage === 'matchSkills');
}

function getPostSaveJobMetadata(job: Pick<SpecJob, 'requestPayload'>): PostSaveJobMetadata | null {
  const parsed = parseRecord(job.requestPayload);
  return isPostSaveJobMetadata(parsed) ? parsed : null;
}

function stageStateForJob(job: SpecJob): PersistPostSaveStageState | null {
  const metadata = getPostSaveJobMetadata(job);
  if (!metadata) return null;

  const base = {
    requested: true,
    jobId: job.id,
    bossJobId: job.bossJobId,
    error: job.errorMessage,
    updatedAt: nowIso(),
    ...(metadata.fingerprint ? { fingerprint: metadata.fingerprint } : {}),
    ...(metadata.previousFingerprint ? { previousFingerprint: metadata.previousFingerprint } : {}),
  };

  if (job.status === 'running') {
    return { ...base, status: 'running', reason: 'job_started' };
  }

  if (job.status === 'completed') {
    const resultRecord = parseRecord(job.resultPayload);
    if (resultRecord.skipped === true && resultRecord.skipReason === 'no_installed_skills') {
      return { ...base, status: 'skipped', reason: 'no_installed_skills', error: null };
    }
    if (resultRecord.skipped === true && resultRecord.skipReason === 'fingerprint_unchanged') {
      return {
        ...base,
        status: 'skipped',
        reason: 'fingerprint_unchanged',
        error: null,
        ...(typeof resultRecord.fingerprint === 'string' ? { fingerprint: resultRecord.fingerprint } : {}),
        ...(typeof resultRecord.previousFingerprint === 'string' ? { previousFingerprint: resultRecord.previousFingerprint } : {}),
      };
    }
    return { ...base, status: 'completed', reason: 'job_completed', error: null };
  }

  if (job.status === 'failed') {
    if (metadata.blockedBy === 'enrich') {
      return {
        ...base,
        status: 'failed',
        reason: (job.errorMessage ?? '').includes('could not be enqueued')
          ? 'blocked_by_enrich_enqueue_failure'
          : 'blocked_by_enrich_failure',
      };
    }
    if (metadata.waitForStage === 'enrich' && !job.bossJobId) {
      return { ...base, status: 'failed', reason: 'blocked_by_enrich_failure' };
    }
    if ((job.errorMessage ?? '').includes('boss.send() returned null') || (job.errorMessage ?? '').includes('Failed to initialise pg-boss')) {
      return { ...base, status: 'failed', reason: 'enqueue_failed' };
    }
    return { ...base, status: 'failed', reason: 'job_failed' };
  }

  if (job.status === 'cancelled') {
    return { ...base, status: 'failed', reason: 'job_failed', error: job.errorMessage ?? 'Cancelled' };
  }

  if (job.status === 'superseded') {
    return { ...base, status: 'superseded', reason: 'superseded_by_newer_save', error: null };
  }

  if (metadata.waitForStage === 'enrich' && !job.bossJobId) {
    return { ...base, status: 'pending', reason: 'waiting_for_enrich' };
  }

  return {
    ...base,
    status: 'queued',
    reason: metadata.waitForStage === 'enrich' ? 'durable_job_enqueued_after_enrich' : 'durable_job_enqueued',
  };
}

function shouldUsePendingStatus(stages: PersistPostSaveStageMap): boolean {
  return ['enrich', 'matchSkills'].some((stageName) => {
    const stage = stages[stageName as DurableStageName];
    return stage.requested && ['pending', 'queued', 'running'].includes(stage.status);
  });
}

function hasFailedStage(stages: PersistPostSaveStageMap): boolean {
  return ['enrich', 'matchSkills'].some((stageName) => {
    const stage = stages[stageName as DurableStageName];
    return stage.requested && stage.status === 'failed';
  });
}

function deriveOverallStatus(currentStatus: string, stages: PersistPostSaveStageMap): string {
  if (hasFailedStage(stages)) {
    return 'failed';
  }
  if (shouldUsePendingStatus(stages)) {
    return 'pending_enrichment';
  }
  if (currentStatus === 'pending_enrichment') {
    return 'persisted';
  }
  return currentStatus;
}

export function buildPersistPostSaveStages(
  postSave: PersistPostSaveOptionsShape,
  stageReasons: Partial<Record<keyof PersistPostSaveOptionsShape, PersistStageReason>> = {},
): PersistPostSaveStageMap {
  const buildStage = (stageName: keyof PersistPostSaveOptionsShape, requested: boolean): PersistPostSaveStageState => ({
    requested,
    status: requested ? 'pending' : 'skipped',
    reason: stageReasons[stageName] ?? (requested ? 'requested_by_caller' : 'disabled_by_caller'),
  });

  return {
    enrich: buildStage('enrich', postSave.enrich),
    matchSkills: buildStage('matchSkills', postSave.matchSkills),
    memorySynthesis: buildStage('memorySynthesis', postSave.memorySynthesis),
  };
}

async function readGenerationLogs(specId: string): Promise<Array<Record<string, unknown>>> {
  return query<Record<string, unknown>>(
    'SELECT * FROM spec_generation_logs WHERE spec_slug = $1 ORDER BY created_at DESC, id DESC',
    [specId],
  );
}

function mergeStageStateMaps(baseStages: PersistPostSaveStageMap, jobs: SpecJob[], saveGeneration?: number | null): PersistPostSaveStageMap {
  const effectiveStages: PersistPostSaveStageMap = JSON.parse(JSON.stringify(baseStages)) as PersistPostSaveStageMap;
  const latestByStage = new Map<DurableStageName, SpecJob>();

  for (const job of jobs) {
    const metadata = getPostSaveJobMetadata(job);
    if (!metadata) continue;
    const jobGeneration = generationForJob(job, metadata);
    if (saveGeneration !== undefined && saveGeneration !== null && jobGeneration !== saveGeneration) continue;
    const current = latestByStage.get(metadata.stage);
    if (!current || current.createdAt.getTime() <= job.createdAt.getTime()) {
      latestByStage.set(metadata.stage, job);
    }
  }

  for (const [stageName, job] of latestByStage.entries()) {
    const stageState = stageStateForJob(job);
    if (!stageState) continue;
    effectiveStages[stageName] = stageState;
  }

  return effectiveStages;
}

export async function getEffectiveGenerationLog(specId: string): Promise<Record<string, unknown> | null> {
  const logs = await readGenerationLogs(specId);
  if (logs.length === 0) {
    return null;
  }

  const latest = { ...logs[0] };
  const persistLog = logs.find((log) => {
    const summary = parseRecord(log.context_summary_json);
    return summary.postSaveStages && typeof summary.postSaveStages === 'object';
  });

  if (!persistLog) {
    return latest;
  }

  const persistSummary = parseRecord(persistLog.context_summary_json);
  const baseStages = persistSummary.postSaveStages as PersistPostSaveStageMap | undefined;
  if (!baseStages) {
    return latest;
  }

  const workspaceId = typeof persistSummary.workspaceId === 'string'
    ? persistSummary.workspaceId
    : undefined;
  const jobs = workspaceId
    ? await listJobsForSpec(workspaceId, specId, ['enrich', 'match-skills'])
    : [];

  const summarySaveGeneration = typeof persistSummary.saveGeneration === 'number'
    ? persistSummary.saveGeneration
    : typeof persistSummary.saveGeneration === 'string'
      ? Number(persistSummary.saveGeneration)
      : null;
  const effectiveStages = mergeStageStateMaps(baseStages, jobs, summarySaveGeneration);
  const latestSummary = parseRecord(latest.context_summary_json);
  const mergedSummary = {
    ...persistSummary,
    ...latestSummary,
    postSave: persistSummary.postSave ?? latestSummary.postSave,
    postSaveStages: effectiveStages,
    enrichFingerprint: latestSummary.enrichFingerprint ?? persistSummary.enrichFingerprint,
    matchSkillsFingerprint: latestSummary.matchSkillsFingerprint ?? persistSummary.matchSkillsFingerprint,
    contextCaptureStatus: persistSummary.contextCaptureStatus ?? latestSummary.contextCaptureStatus,
    contextUsed: persistSummary.contextUsed ?? latestSummary.contextUsed,
    normalizationChanges: persistSummary.normalizationChanges ?? latestSummary.normalizationChanges,
  };

  return {
    ...latest,
    status: deriveOverallStatus(String(latest.status ?? ''), effectiveStages),
    context_summary_json: mergedSummary,
  };
}

export async function getEffectiveGenerationLogs(specId: string): Promise<Array<Record<string, unknown>>> {
  const logs = await readGenerationLogs(specId);
  if (logs.length === 0) return logs;
  const effectiveLatest = await getEffectiveGenerationLog(specId);
  if (!effectiveLatest) return logs;
  return [effectiveLatest, ...logs.slice(1)];
}

export async function updatePersistPostSaveStage(
  specId: string,
  stageName: DurableStageName,
  stageState: PersistPostSaveStageState,
  saveGeneration?: number | null,
): Promise<void> {
  const log = await queryOne<{ id: number; status: string; context_summary_json: unknown }>(
    `SELECT id, status, context_summary_json
     FROM spec_generation_logs
     WHERE spec_slug = $1
       AND context_summary_json ? 'postSaveStages'
       AND ($2::bigint IS NULL OR COALESCE(save_generation, id::bigint) = $2::bigint)
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [specId, saveGeneration ?? null],
  );

  if (!log) return;

  const summary = parseRecord(log.context_summary_json);
  const baseStages = summary.postSaveStages as PersistPostSaveStageMap | undefined;
  if (!baseStages) return;

  const nextStages: PersistPostSaveStageMap = {
    ...baseStages,
    [stageName]: {
      ...baseStages[stageName],
      ...stageState,
      updatedAt: stageState.updatedAt ?? nowIso(),
    },
  };

  await execute(
    `UPDATE spec_generation_logs
     SET context_summary_json = $2,
         status = $3
     WHERE id = $1`,
    [
      log.id,
      {
        ...summary,
        postSaveStages: nextStages,
      },
      deriveOverallStatus(log.status, nextStages),
    ],
  );
}

async function ensureBossReady(): Promise<void> {
  try {
    await initBoss();
  } catch (error) {
    throw new Error(`Failed to initialise pg-boss: ${errorMessageFor(error)}`);
  }
}

function generationForJob(job: SpecJob, metadata: PostSaveJobMetadata | null = getPostSaveJobMetadata(job)): number | null {
  return job.saveGeneration ?? metadata?.saveGeneration ?? null;
}

async function cancelBossJobForSupersededWork(job: SpecJob): Promise<void> {
  const metadata = getPostSaveJobMetadata(job);
  if (!metadata || !job.bossJobId) return;
  const jobType = STAGE_TO_JOB_TYPE[metadata.stage];
  try {
    await ensureBossReady();
    await getBoss().cancel(STAGE_TO_QUEUE[jobType], job.bossJobId);
  } catch (error) {
    logger.warn({ err: error, specId: job.specId, workspaceId: job.workspaceId, jobId: job.id, bossJobId: job.bossJobId }, '[post-save] failed to cancel superseded pg-boss job');
  }
}

export async function supersedeOlderPersistPostSaveJobs(specId: string, workspaceId: string, saveGeneration: number): Promise<number> {
  const jobs = await listJobsForSpec(workspaceId, specId, ['enrich', 'match-skills']);
  const supersededJobs = jobs.filter((job) => {
    if (!['pending', 'running'].includes(job.status)) return false;
    const metadata = getPostSaveJobMetadata(job);
    if (!metadata) return false;
    const jobGeneration = generationForJob(job, metadata);
    return jobGeneration !== null && jobGeneration < saveGeneration;
  });

  for (const job of supersededJobs) {
    const metadata = getPostSaveJobMetadata(job);
    if (!metadata) continue;
    await cancelBossJobForSupersededWork(job);
    await updateJobStatus(job.id, 'superseded', {
      finishedAt: new Date(),
      progressMessage: 'Superseded by newer spec save',
      errorMessage: null,
    });
    await updatePersistPostSaveStage(job.specId, metadata.stage, {
      requested: true,
      status: 'superseded',
      reason: 'superseded_by_newer_save',
      jobId: job.id,
      bossJobId: job.bossJobId,
      error: null,
    }, generationForJob(job, metadata));
  }

  return supersededJobs.length;
}

export async function isPersistPostSaveJobStale(jobId: string): Promise<boolean> {
  const job = await getJob(jobId);
  if (!job) return false;
  const metadata = getPostSaveJobMetadata(job);
  const jobGeneration = generationForJob(job, metadata);
  if (!metadata || jobGeneration === null) return false;

  const current = await queryOne<{ save_generation: number | string }>(
    `SELECT COALESCE(save_generation, id::bigint) AS save_generation
     FROM spec_generation_logs
     WHERE spec_slug = $1
       AND context_summary_json ? 'postSaveStages'
     ORDER BY COALESCE(save_generation, id::bigint) DESC, created_at DESC, id DESC
     LIMIT 1`,
    [job.specId],
  );
  return current ? jobGeneration < Number(current.save_generation) : false;
}

export async function markPersistPostSaveJobSupersededIfStale(jobId: string): Promise<boolean> {
  const stale = await isPersistPostSaveJobStale(jobId);
  if (!stale) return false;
  const job = await getJob(jobId);
  if (!job || job.status === 'superseded') return true;
  const metadata = getPostSaveJobMetadata(job);
  if (!metadata) return false;
  await updateJobStatus(job.id, 'superseded', {
    finishedAt: new Date(),
    progressMessage: 'Superseded by newer spec save',
    errorMessage: null,
  });
  return true;
}

async function enqueueExistingJob(job: SpecJob, jobType: DurableStageJobType, stageName: DurableStageName, reason: PersistStageReason): Promise<boolean> {
  try {
    await ensureBossReady();
    const bossJobId = await getBoss().send(STAGE_TO_QUEUE[jobType], {
      jobId: job.id,
      specId: job.specId,
      workspaceId: job.workspaceId,
    });

    if (!bossJobId) {
      throw new Error(`boss.send() returned null for ${jobType}`);
    }

    await updateJobStatus(job.id, 'pending', {
      bossJobId,
      progressMessage: `Queued ${jobType} job`,
      errorMessage: null,
      finishedAt: null,
    });
    await updatePersistPostSaveStage(job.specId, stageName, {
      requested: true,
      status: 'queued',
      reason,
      jobId: job.id,
      bossJobId,
      error: null,
    }, job.saveGeneration);
    return true;
  } catch (error) {
    const message = errorMessageFor(error);
    await updateJobStatus(job.id, 'failed', {
      errorMessage: message,
      finishedAt: new Date(),
      progressMessage: `Failed to enqueue ${jobType} job`,
    });
    await updatePersistPostSaveStage(job.specId, stageName, {
      requested: true,
      status: 'failed',
      reason: 'enqueue_failed',
      jobId: job.id,
      error: message,
    }, job.saveGeneration);
    logger.warn({ err: error, specId: job.specId, workspaceId: job.workspaceId, jobId: job.id, jobType }, '[post-save] durable enqueue failed');
    return false;
  }
}

async function createAndEnqueueStageJob(specId: string, workspaceId: string, stageName: DurableStageName, metadata: PostSaveJobMetadata, reason: PersistStageReason): Promise<SpecJob | null> {
  const jobType = STAGE_TO_JOB_TYPE[stageName];
  let job: SpecJob | null = null;

  try {
    job = await createJob(workspaceId, specId, jobType, metadata as unknown as JsonValue);
  } catch (error) {
    const message = errorMessageFor(error);
    await updatePersistPostSaveStage(specId, stageName, {
      requested: true,
      status: 'failed',
      reason: 'enqueue_failed',
      error: message,
    }, metadata.saveGeneration);
    logger.warn({ err: error, specId, workspaceId, jobType }, '[post-save] failed to create spec job row');
    return null;
  }

  const success = await enqueueExistingJob(job, jobType, stageName, reason);
  return success ? job : null;
}

async function createDeferredStageJob(specId: string, workspaceId: string, stageName: DurableStageName, metadata: PostSaveJobMetadata): Promise<SpecJob | null> {
  const jobType = STAGE_TO_JOB_TYPE[stageName];
  try {
    const job = await createJob(workspaceId, specId, jobType, metadata as unknown as JsonValue);
    await updateJobStatus(job.id, 'pending', {
      progressMessage: 'Waiting for enrich post-save stage to complete before enqueue',
    });
    await updatePersistPostSaveStage(specId, stageName, {
      requested: true,
      status: 'pending',
      reason: 'waiting_for_enrich',
      jobId: job.id,
      bossJobId: null,
      error: null,
      ...(metadata.fingerprint ? { fingerprint: metadata.fingerprint } : {}),
      ...(metadata.previousFingerprint ? { previousFingerprint: metadata.previousFingerprint } : {}),
    }, job.saveGeneration);
    return job;
  } catch (error) {
    const message = errorMessageFor(error);
    await updatePersistPostSaveStage(specId, stageName, {
      requested: true,
      status: 'failed',
      reason: 'enqueue_failed',
      error: message,
    }, metadata.saveGeneration);
    logger.warn({ err: error, specId, workspaceId, jobType }, '[post-save] failed to create deferred spec job row');
    return null;
  }
}

async function markExistingJobSkippedByFingerprint(
  job: SpecJob,
  stageName: DurableStageName,
  metadata: PostSaveJobMetadata,
): Promise<void> {
  const resultPayload = {
    skipped: true,
    skipReason: 'fingerprint_unchanged',
    stage: stageName,
    fingerprint: metadata.fingerprint ?? null,
    previousFingerprint: metadata.previousFingerprint ?? null,
  } as JsonValue;
  await updateJobStatus(job.id, 'completed', {
    resultPayload,
    progressMessage: 'Skipped post-save stage because fingerprint was unchanged',
    finishedAt: new Date(),
  });
  await updatePersistPostSaveStage(job.specId, stageName, {
    requested: true,
    status: 'skipped',
    reason: 'fingerprint_unchanged',
    jobId: job.id,
    bossJobId: null,
    error: null,
    ...(metadata.fingerprint ? { fingerprint: metadata.fingerprint } : {}),
    ...(metadata.previousFingerprint ? { previousFingerprint: metadata.previousFingerprint } : {}),
  }, job.saveGeneration);
}

async function createSkippedStageJob(
  specId: string,
  workspaceId: string,
  stageName: DurableStageName,
  metadata: PostSaveJobMetadata,
): Promise<SpecJob | null> {
  const jobType = STAGE_TO_JOB_TYPE[stageName];
  try {
    const job = await createJob(workspaceId, specId, jobType, metadata as unknown as JsonValue);
    await markExistingJobSkippedByFingerprint(job, stageName, metadata);
    return job;
  } catch (error) {
    const message = errorMessageFor(error);
    await updatePersistPostSaveStage(specId, stageName, {
      requested: true,
      status: 'failed',
      reason: 'enqueue_failed',
      error: message,
    }, metadata.saveGeneration);
    logger.warn({ err: error, specId, workspaceId, jobType }, '[post-save] failed to persist skipped spec job row');
    return null;
  }
}

async function createFailedStageJob(
  specId: string,
  workspaceId: string,
  stageName: DurableStageName,
  metadata: PostSaveJobMetadata,
  reason: PersistStageReason,
  errorMessage: string,
): Promise<void> {
  const jobType = STAGE_TO_JOB_TYPE[stageName];
  try {
    const job = await createJob(workspaceId, specId, jobType, metadata as unknown as JsonValue);
    await updateJobStatus(job.id, 'failed', {
      errorMessage,
      finishedAt: new Date(),
      progressMessage: errorMessage,
    });
    await updatePersistPostSaveStage(specId, stageName, {
      requested: true,
      status: 'failed',
      reason,
      jobId: job.id,
      bossJobId: null,
      error: errorMessage,
    }, job.saveGeneration);
  } catch (error) {
    logger.warn({ err: error, specId, workspaceId, jobType }, '[post-save] failed to persist blocked stage job');
    await updatePersistPostSaveStage(specId, stageName, {
      requested: true,
      status: 'failed',
      reason,
      error: errorMessage,
    }, metadata.saveGeneration);
  }
}

export async function enqueuePersistPostSaveJobs(
  specId: string,
  workspaceId: string,
  options: Pick<PersistPostSaveOptionsShape, 'enrich' | 'matchSkills'> & PersistPostSaveFingerprintOptions,
): Promise<void> {
  if (!options.enrich && !options.matchSkills) return;

  const current = options.currentFingerprints ?? {};
  const prior = options.priorFingerprints ?? {};
  const saveGeneration = options.saveGeneration;
  if (saveGeneration !== undefined) {
    await supersedeOlderPersistPostSaveJobs(specId, workspaceId, saveGeneration);
  }
  const enrichFingerprintChanged = !current.enrichFingerprint
    || !prior.enrichFingerprint
    || current.enrichFingerprint !== prior.enrichFingerprint;
  const matchSkillsFingerprintChanged = !current.matchSkillsFingerprint
    || !prior.matchSkillsFingerprint
    || current.matchSkillsFingerprint !== prior.matchSkillsFingerprint;

  const enrichMetadata = (): PostSaveJobMetadata => ({
    origin: 'persist-post-save',
    stage: 'enrich',
    ...(saveGeneration !== undefined ? { saveGeneration } : {}),
    ...(current.enrichFingerprint ? { fingerprint: current.enrichFingerprint } : {}),
    ...(prior.enrichFingerprint ? { previousFingerprint: prior.enrichFingerprint } : {}),
  });
  const matchMetadata = (extra: Partial<PostSaveJobMetadata> = {}): PostSaveJobMetadata => ({
    origin: 'persist-post-save',
    stage: 'matchSkills',
    ...(saveGeneration !== undefined ? { saveGeneration } : {}),
    ...(current.matchSkillsFingerprint ? { fingerprint: current.matchSkillsFingerprint } : {}),
    ...(prior.matchSkillsFingerprint ? { previousFingerprint: prior.matchSkillsFingerprint } : {}),
    ...extra,
  });

  if (options.enrich) {
    if (!enrichFingerprintChanged) {
      await createSkippedStageJob(
        specId,
        workspaceId,
        'enrich',
        { ...enrichMetadata(), skipReason: 'fingerprint_unchanged' },
      );

      if (options.matchSkills) {
        if (!matchSkillsFingerprintChanged) {
          await createSkippedStageJob(
            specId,
            workspaceId,
            'matchSkills',
            { ...matchMetadata(), skipReason: 'fingerprint_unchanged' },
          );
        } else {
          await createAndEnqueueStageJob(
            specId,
            workspaceId,
            'matchSkills',
            matchMetadata(),
            'durable_job_enqueued',
          );
        }
      }
      return;
    }

    const enrichJob = await createAndEnqueueStageJob(
      specId,
      workspaceId,
      'enrich',
      enrichMetadata(),
      'durable_job_enqueued',
    );

    if (options.matchSkills) {
      if (enrichJob) {
        await createDeferredStageJob(specId, workspaceId, 'matchSkills', matchMetadata({
          waitForStage: 'enrich',
          invalidatedByStage: 'enrich',
        }));
      } else {
        await createFailedStageJob(
          specId,
          workspaceId,
          'matchSkills',
          matchMetadata({ blockedBy: 'enrich' }),
          'blocked_by_enrich_enqueue_failure',
          'Blocked because enrich could not be enqueued',
        );
      }
    }
    return;
  }

  if (!matchSkillsFingerprintChanged) {
    await createSkippedStageJob(
      specId,
      workspaceId,
      'matchSkills',
      { ...matchMetadata(), skipReason: 'fingerprint_unchanged' },
    );
    return;
  }

  await createAndEnqueueStageJob(
    specId,
    workspaceId,
    'matchSkills',
    matchMetadata(),
    'durable_job_enqueued',
  );
}

export async function syncPersistPostSaveStageFromJob(jobId: string): Promise<void> {
  const job = await getJob(jobId);
  if (!job) return;

  const metadata = getPostSaveJobMetadata(job);
  if (!metadata) return;

  if (await isPersistPostSaveJobStale(jobId)) return;

  const stageState = stageStateForJob(job);
  if (!stageState) return;
  await updatePersistPostSaveStage(job.specId, metadata.stage, stageState, generationForJob(job, metadata));
}

export async function advancePersistPostSaveDependencies(jobId: string): Promise<void> {
  const job = await getJob(jobId);
  if (!job) return;

  const metadata = getPostSaveJobMetadata(job);
  if (!metadata || metadata.stage !== 'enrich' || !['completed', 'failed', 'cancelled'].includes(job.status)) {
    return;
  }
  if (await isPersistPostSaveJobStale(jobId)) return;
  const enrichGeneration = generationForJob(job, metadata);

  const jobs = await listJobsForSpec(job.workspaceId, job.specId, ['match-skills']);
  const deferredJobs = jobs.filter((candidate) => {
    const candidateMetadata = getPostSaveJobMetadata(candidate);
    const candidateGeneration = generationForJob(candidate, candidateMetadata);
    return candidate.status === 'pending'
      && !candidate.bossJobId
      && candidateMetadata?.stage === 'matchSkills'
      && candidateMetadata.waitForStage === 'enrich'
      && (enrichGeneration === null || candidateGeneration === enrichGeneration);
  });

  if (deferredJobs.length === 0) return;

  if (job.status === 'completed') {
    const enrichResult = parseRecord(job.resultPayload);
    const enrichSkippedByFingerprint = enrichResult.skipped === true
      && enrichResult.skipReason === 'fingerprint_unchanged';

    for (const deferredJob of deferredJobs) {
      const deferredMetadata = getPostSaveJobMetadata(deferredJob);
      const matchFingerprintUnchanged = enrichSkippedByFingerprint
        && deferredMetadata?.fingerprint
        && deferredMetadata.previousFingerprint
        && deferredMetadata.fingerprint === deferredMetadata.previousFingerprint;

      if (matchFingerprintUnchanged && deferredMetadata) {
        await markExistingJobSkippedByFingerprint(deferredJob, 'matchSkills', deferredMetadata);
      } else {
        await enqueueExistingJob(deferredJob, 'match-skills', 'matchSkills', 'durable_job_enqueued_after_enrich');
      }
    }
    return;
  }

  const error = job.errorMessage ?? `Blocked because enrich ${job.status}`;
  for (const deferredJob of deferredJobs) {
    await updateJobStatus(deferredJob.id, 'failed', {
      errorMessage: error,
      finishedAt: new Date(),
      progressMessage: 'Blocked because enrich did not complete successfully',
    });
    await updatePersistPostSaveStage(job.specId, 'matchSkills', {
      requested: true,
      status: 'failed',
      reason: 'blocked_by_enrich_failure',
      jobId: deferredJob.id,
      bossJobId: null,
      error,
    }, generationForJob(deferredJob, getPostSaveJobMetadata(deferredJob)));
  }
}
