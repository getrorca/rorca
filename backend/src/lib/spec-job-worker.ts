/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import PgBoss from 'pg-boss';
import {
  SpecJobPayload,
  type SpecJobPayloadType,
} from './pg-boss-schemas';
import { getJob, updateJobStatus } from '../db/spec-jobs';
import { logger } from './logger';
import { runContextEnrichJob, runEnrichJob, runMatchSkillsJob, runSuggestSkillsJob, type ProgressCallback } from './spec-job-handlers';
import { publishSpecJobSnapshot } from './spec-job-events';
import { advancePersistPostSaveDependencies, markPersistPostSaveJobSupersededIfStale, syncPersistPostSaveStageFromJob } from './spec-post-save';

export const SPEC_ENRICH_QUEUE = 'spec:enrich';
export const CONTEXT_ENRICH_QUEUE = 'context:enrich';
export const SPEC_MATCH_SKILLS_QUEUE = 'spec:match-skills';
export const SPEC_SUGGEST_SKILLS_QUEUE = 'spec:suggest-skills';
const PROGRESS_THROTTLE_MS = 500;

class SpecJobCancelledError extends Error {
  constructor(message = 'Spec job cancelled') {
    super(message);
    this.name = 'SpecJobCancelledError';
  }
}

async function throwIfCancelled(jobId: string): Promise<void> {
  const job = await getJob(jobId);
  if (job?.status === 'cancelled') {
    throw new SpecJobCancelledError('Spec job cancelled');
  }
  if (job?.status === 'superseded') {
    throw new SpecJobCancelledError('Spec job superseded by newer save');
  }
}

function buildProgressUpdater(jobId: string): ProgressCallback {
  let lastUpdateAt = 0;
  let pendingUpdate: Promise<void> = Promise.resolve();

  return async (progress) => {
    await throwIfCancelled(jobId);
    const now = Date.now();
    if (now - lastUpdateAt < PROGRESS_THROTTLE_MS) {
      return;
    }
    lastUpdateAt = now;
    pendingUpdate = pendingUpdate.then(async () => {
      await updateJobStatus(jobId, 'running', {
        progressCurrent: progress.current,
        progressTotal: progress.total,
        progressMessage: progress.message,
      });
      await syncPersistPostSaveStageFromJob(jobId);
      await publishSpecJobSnapshot(jobId, 'progress');
    });
    await pendingUpdate;
  };
}

function errorMessageFor(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function logSpecJobTelemetry(event: string, payload: Record<string, string | number | boolean | null | undefined>): void {
  logger.info({ component: 'spec-job-worker', event, ...payload }, '[spec-job-worker] telemetry');
}

async function handleSpecJobs(
  jobs: PgBoss.Job<unknown>[],
  queueName: string,
  runner: (payload: SpecJobPayloadType, onProgress: ProgressCallback) => Promise<unknown>,
): Promise<void> {
  await Promise.allSettled(jobs.map(async (job) => {
    const parsed = SpecJobPayload.safeParse(job.data);
    if (!parsed.success) {
      throw new Error(`Invalid ${queueName} payload: ${parsed.error.message}`);
    }

    const payload = parsed.data;
    const existing = await getJob(payload.jobId);
    if (existing?.status === 'cancelled' || existing?.status === 'superseded') {
      await publishSpecJobSnapshot(payload.jobId, 'terminal');
      logger.info({ queueName, jobId: payload.jobId, status: existing.status }, '[spec-job-worker] skipped inactive job before start');
      return;
    }
    if (await markPersistPostSaveJobSupersededIfStale(payload.jobId)) {
      await publishSpecJobSnapshot(payload.jobId, 'terminal');
      logger.info({ queueName, jobId: payload.jobId }, '[spec-job-worker] skipped stale post-save job before start');
      return;
    }

    const startedAt = new Date();
    const onProgress = buildProgressUpdater(payload.jobId);
    await updateJobStatus(payload.jobId, 'running', {
      startedAt,
      progressCurrent: 0,
      progressTotal: 0,
      progressMessage: `Picked up ${queueName} job`,
    });
    if (await markPersistPostSaveJobSupersededIfStale(payload.jobId)) {
      await publishSpecJobSnapshot(payload.jobId, 'terminal');
      logger.info({ queueName, jobId: payload.jobId }, '[spec-job-worker] stale post-save job superseded after pickup');
      return;
    }
    await syncPersistPostSaveStageFromJob(payload.jobId);
    await publishSpecJobSnapshot(payload.jobId, 'progress');
    logSpecJobTelemetry('stage_started', {
      queueName,
      jobId: payload.jobId,
      specId: payload.specId,
      workspaceId: payload.workspaceId,
      queueWaitMs: Math.max(0, startedAt.getTime() - (existing?.createdAt?.getTime() ?? startedAt.getTime())),
    });

    try {
      const resultPayload = await runner(payload, onProgress);
      await throwIfCancelled(payload.jobId);
      if (await markPersistPostSaveJobSupersededIfStale(payload.jobId)) {
        await publishSpecJobSnapshot(payload.jobId, 'terminal');
        logger.info({ queueName, jobId: payload.jobId, specId: payload.specId, workspaceId: payload.workspaceId }, '[spec-job-worker] stale post-save completion superseded');
        return;
      }
      await updateJobStatus(payload.jobId, 'completed', {
        resultPayload: resultPayload as never,
        finishedAt: new Date(),
      });
      await syncPersistPostSaveStageFromJob(payload.jobId);
      await advancePersistPostSaveDependencies(payload.jobId);
      await publishSpecJobSnapshot(payload.jobId, 'terminal');
      logSpecJobTelemetry('stage_completed', {
        queueName,
        jobId: payload.jobId,
        specId: payload.specId,
        workspaceId: payload.workspaceId,
        stageDurationMs: Math.max(0, Date.now() - startedAt.getTime()),
      });
      logger.info({ queueName, jobId: payload.jobId, specId: payload.specId, workspaceId: payload.workspaceId }, '[spec-job-worker] job completed');
    } catch (error) {
      if (error instanceof SpecJobCancelledError) {
        const latest = await getJob(payload.jobId);
        const terminalStatus = latest?.status === 'superseded' ? 'superseded' : 'cancelled';
        await updateJobStatus(payload.jobId, terminalStatus, {
          finishedAt: new Date(),
          progressMessage: terminalStatus === 'superseded' ? 'Superseded by newer spec save' : 'Cancelled by user',
          errorMessage: null,
        });
        await syncPersistPostSaveStageFromJob(payload.jobId);
        await advancePersistPostSaveDependencies(payload.jobId);
        await publishSpecJobSnapshot(payload.jobId, 'terminal');
        logSpecJobTelemetry('stage_stopped', {
          queueName,
          jobId: payload.jobId,
          specId: payload.specId,
          workspaceId: payload.workspaceId,
          status: terminalStatus,
          stageDurationMs: Math.max(0, Date.now() - startedAt.getTime()),
          skipReason: terminalStatus === 'superseded' ? 'superseded_by_newer_save' : 'cancelled_by_user',
        });
        logger.info({ queueName, jobId: payload.jobId, specId: payload.specId, workspaceId: payload.workspaceId, status: terminalStatus }, '[spec-job-worker] job stopped');
        return;
      }

      if (await markPersistPostSaveJobSupersededIfStale(payload.jobId)) {
        await publishSpecJobSnapshot(payload.jobId, 'terminal');
        logger.info({ queueName, jobId: payload.jobId, specId: payload.specId, workspaceId: payload.workspaceId }, '[spec-job-worker] stale post-save failure superseded');
        return;
      }

      const latest = await getJob(payload.jobId);
      if (latest?.status === 'cancelled' || latest?.status === 'superseded') {
        await updateJobStatus(payload.jobId, latest.status, {
          finishedAt: new Date(),
          progressMessage: latest.status === 'superseded' ? 'Superseded by newer spec save' : 'Cancelled by user',
          errorMessage: null,
        });
        await syncPersistPostSaveStageFromJob(payload.jobId);
        await advancePersistPostSaveDependencies(payload.jobId);
        await publishSpecJobSnapshot(payload.jobId, 'terminal');
        logger.info({ queueName, jobId: payload.jobId, specId: payload.specId, workspaceId: payload.workspaceId }, '[spec-job-worker] cancellation won race with failure');
        return;
      }

      const message = errorMessageFor(error);
      await updateJobStatus(payload.jobId, 'failed', {
        errorMessage: message,
        finishedAt: new Date(),
      });
      await syncPersistPostSaveStageFromJob(payload.jobId);
      await advancePersistPostSaveDependencies(payload.jobId);
      await publishSpecJobSnapshot(payload.jobId, 'terminal');
      logSpecJobTelemetry('stage_failed', {
        queueName,
        jobId: payload.jobId,
        specId: payload.specId,
        workspaceId: payload.workspaceId,
        stageDurationMs: Math.max(0, Date.now() - startedAt.getTime()),
      });
      logger.warn({ queueName, jobId: payload.jobId, specId: payload.specId, workspaceId: payload.workspaceId, error: message }, '[spec-job-worker] job failed');
      throw error;
    }
  }));
}

export async function registerSpecJobHandlers(boss: PgBoss): Promise<void> {
  await boss.work(SPEC_ENRICH_QUEUE, { batchSize: 1 }, (jobs) =>
    handleSpecJobs(jobs, SPEC_ENRICH_QUEUE, (payload, onProgress) =>
      runEnrichJob(payload.workspaceId, payload.specId, onProgress),
    ),
  );
  await boss.work(CONTEXT_ENRICH_QUEUE, { batchSize: 1 }, (jobs) =>
    handleSpecJobs(jobs, CONTEXT_ENRICH_QUEUE, (payload, onProgress) =>
      runContextEnrichJob(payload, onProgress),
    ),
  );
  await boss.work(SPEC_MATCH_SKILLS_QUEUE, { batchSize: 1 }, (jobs) =>
    handleSpecJobs(jobs, SPEC_MATCH_SKILLS_QUEUE, (payload, onProgress) =>
      runMatchSkillsJob(payload.workspaceId, payload.specId, onProgress),
    ),
  );
  await boss.work(SPEC_SUGGEST_SKILLS_QUEUE, { batchSize: 1 }, (jobs) =>
    handleSpecJobs(jobs, SPEC_SUGGEST_SKILLS_QUEUE, (payload, onProgress) =>
      runSuggestSkillsJob(payload.workspaceId, payload.specId, onProgress),
    ),
  );
  logger.info('[spec-job-worker] registered spec:enrich, context:enrich, spec:match-skills, spec:suggest-skills');
}
