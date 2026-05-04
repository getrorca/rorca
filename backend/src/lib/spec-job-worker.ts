/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import PgBoss from 'pg-boss';
import {
  SpecJobPayload,
  type SpecJobPayloadType,
} from './pg-boss-schemas';
import { updateJobStatus } from '../db/spec-jobs';
import { logger } from './logger';
import { runEnrichJob, runMatchSkillsJob, runSuggestSkillsJob, type ProgressCallback } from './spec-job-handlers';

const SPEC_ENRICH_QUEUE = 'spec:enrich';
const SPEC_MATCH_SKILLS_QUEUE = 'spec:match-skills';
const SPEC_SUGGEST_SKILLS_QUEUE = 'spec:suggest-skills';
const PROGRESS_THROTTLE_MS = 500;

function buildProgressUpdater(jobId: string): ProgressCallback {
  let lastUpdateAt = 0;
  let pendingUpdate: Promise<void> = Promise.resolve();

  return async (progress) => {
    const now = Date.now();
    if (now - lastUpdateAt < PROGRESS_THROTTLE_MS) {
      return;
    }
    lastUpdateAt = now;
    pendingUpdate = pendingUpdate.then(() => updateJobStatus(jobId, 'running', {
      progressCurrent: progress.current,
      progressTotal: progress.total,
      progressMessage: progress.message,
    }));
    await pendingUpdate;
  };
}

function errorMessageFor(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
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
    const startedAt = new Date();
    const onProgress = buildProgressUpdater(payload.jobId);
    await updateJobStatus(payload.jobId, 'running', {
      startedAt,
      progressCurrent: 0,
      progressTotal: 0,
      progressMessage: `Picked up ${queueName} job`,
    });

    try {
      const resultPayload = await runner(payload, onProgress);
      await updateJobStatus(payload.jobId, 'completed', {
        resultPayload: resultPayload as never,
        finishedAt: new Date(),
      });
      logger.info({ queueName, jobId: payload.jobId, specId: payload.specId, workspaceId: payload.workspaceId }, '[spec-job-worker] job completed');
    } catch (error) {
      const message = errorMessageFor(error);
      await updateJobStatus(payload.jobId, 'failed', {
        errorMessage: message,
        finishedAt: new Date(),
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
  logger.info('[spec-job-worker] registered spec:enrich, spec:match-skills, spec:suggest-skills');
}
