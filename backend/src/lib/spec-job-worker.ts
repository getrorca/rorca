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
import { compareAndSetJobStatus, getJob, getJobByTransportOwnership, recordSpecJobTransportAttempt,
  terminalizeOwnedSpecJobTransportFailure } from '../db/spec-jobs';
import { logger } from './logger';
import { SpecReadinessReasonCode } from '../reason-codes';
import { runContextEnrichJob, runEnrichJob, runMatchSkillsJob, runMemorySynthesisJob, runSuggestSkillsJob, type ProgressCallback } from './spec-job-handlers';
import { publishSpecJobSnapshot } from './spec-job-events';
import {
  advanceSpecPostSaveWorkflowDependencies as advancePersistPostSaveDependencies,
  claimExactPostSaveWorkflowJob,
  getSpecPostSaveWorkflowJobMetadata,
  markSpecPostSaveWorkflowJobSupersededIfStale as markPersistPostSaveJobSupersededIfStale,
  syncSpecPostSaveWorkflowStageFromJob as syncPersistPostSaveStageFromJob,
} from './spec-post-save-workflow';
import { getPgBossSchemaName } from './pg-boss-schema';

export const SPEC_ENRICH_QUEUE = 'spec:enrich';
export const CONTEXT_ENRICH_QUEUE = 'context:enrich';
export const SPEC_MATCH_SKILLS_QUEUE = 'spec:match-skills';
export const SPEC_MEMORY_SYNTHESIS_QUEUE = 'spec:memory-synthesis';
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
      const current = await getJob(jobId);
      if (!current || !(await compareAndSetJobStatus({
        jobId, status: 'running', expectedStatuses: ['running'],
        expectedWorkspaceId: current.workspaceId, expectedSpecId: current.specId,
        ...(current.bossJobId ? { expectedBossJobId: current.bossJobId } : {}),
        ...(current.transportSchema ? { expectedTransportSchema: current.transportSchema } : {}),
        fields: { progressCurrent: progress.current, progressTotal: progress.total, progressMessage: progress.message },
      }))) throw new SpecJobCancelledError('Spec job lost its running ownership fence');
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

async function terminalizeOwnedPreRunFailure(input: {
  transport: PgBoss.Job<unknown>; queueName: string; configuredSchema: string; reasonCode: string;
}): Promise<boolean> {
  const {transport,queueName,configuredSchema,reasonCode}=input;
  if(transport.name!==queueName)return false;
  const terminalized=await terminalizeOwnedSpecJobTransportFailure({bossJobId:transport.id,transportSchema:configuredSchema,
    queueName,reasonCode});
  if(!terminalized)return false;
  await syncPersistPostSaveStageFromJob(terminalized.id);
  await advancePersistPostSaveDependencies(terminalized.id);
  await publishSpecJobSnapshot(terminalized.id,'terminal');
  return true;
}

export async function handleSpecJobs(
  jobs: PgBoss.Job<unknown>[],
  queueName: string,
  runner: (payload: SpecJobPayloadType, onProgress: ProgressCallback) => Promise<unknown>,
): Promise<void> {
  // pg-boss must observe any ownership, payload, claim, database, or runner
  // rejection. A settled transport is never acknowledged while its exact
  // application job remains nonterminal.
  await Promise.all(jobs.map(async (job) => {
    const configuredSchema = getPgBossSchemaName();
    // Broker identity is authoritative. Untrusted payload bytes never choose
    // which application row is terminalized.
    const existing=await getJobByTransportOwnership(job.id,configuredSchema,queueName);
    if(!existing)throw new Error(`Unowned ${queueName} transport was rejected`);
    const parsed = SpecJobPayload.safeParse(job.data);
    if (!parsed.success) {
      await terminalizeOwnedPreRunFailure({transport:job,queueName,configuredSchema,reasonCode:'invalid_transport_payload'});
      throw new Error(`Invalid ${queueName} payload: ${parsed.error.message}`);
    }

    const payload = parsed.data;
    if (existing.id!==payload.jobId||existing.workspaceId !== payload.workspaceId || existing.specId !== payload.specId
      || existing.bossJobId !== job.id || existing.transportSchema !== configuredSchema || job.name !== queueName) {
      await terminalizeOwnedPreRunFailure({transport:job,queueName,configuredSchema,reasonCode:'transport_ownership_mismatch'});
      throw new Error(`Exact ${queueName} transport ownership was rejected`);
    }
    try{
      await recordSpecJobTransportAttempt({workspaceId:existing.workspaceId,jobId:existing.id,bossJobId:job.id,queueName,transportSchema:configuredSchema,phase:'received'});
    }catch(error){
      await terminalizeOwnedPreRunFailure({transport:job,queueName,configuredSchema,reasonCode:'attempt_ledger_write_failed'});
      throw error;
    }
    const workflowMetadata = getSpecPostSaveWorkflowJobMetadata(existing);
    if (workflowMetadata) {
      if (payload.workflowRunId !== workflowMetadata.workflowRunId || payload.stage !== workflowMetadata.stage
        || payload.bossJobId !== workflowMetadata.bossJobId || payload.queueName !== workflowMetadata.queueName
        || payload.transportSchema !== workflowMetadata.transportSchema || workflowMetadata.queueName !== queueName) {
        await terminalizeOwnedPreRunFailure({transport:job,queueName,configuredSchema,reasonCode:'workflow_metadata_mismatch'});
        throw new Error(`Exact ${queueName} workflow payload ownership was rejected`);
      }
    } else if (payload.workflowRunId !== undefined || payload.stage !== undefined || payload.bossJobId !== undefined
      || payload.queueName !== undefined || payload.transportSchema !== undefined) {
      await terminalizeOwnedPreRunFailure({transport:job,queueName,configuredSchema,reasonCode:'unexpected_workflow_metadata'});
      throw new Error(`Unexpected ${queueName} workflow ownership fields were rejected`);
    }
    if (existing.status === 'cancelled' || existing.status === 'superseded') {
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
    const claimed = workflowMetadata
      ? await claimExactPostSaveWorkflowJob({
        jobId: existing.id, workspaceId: existing.workspaceId, specId: existing.specId,
        workflowRunId: workflowMetadata.workflowRunId, stage: workflowMetadata.stage,
        bossJobId: workflowMetadata.bossJobId, queueName: workflowMetadata.queueName,
        transportSchema: workflowMetadata.transportSchema, startedAt,
      })
      : await compareAndSetJobStatus({
        jobId: existing.id, status: 'running', expectedStatuses: ['pending'],
        expectedWorkspaceId: existing.workspaceId, expectedSpecId: existing.specId,
        expectedBossJobId: job.id, expectedTransportSchema: configuredSchema,
        fields: { startedAt, progressCurrent: 0, progressTotal: 0, progressMessage: `Picked up ${queueName} job` },
      });
    if (!claimed) {
      const latest = await getJob(payload.jobId);
      if (latest?.status === 'cancelled' || latest?.status === 'superseded') {
        await publishSpecJobSnapshot(payload.jobId, 'terminal');
        return;
      }
      await terminalizeOwnedPreRunFailure({transport:job,queueName,configuredSchema,reasonCode:'start_claim_cas_rejected'});
      throw new Error(`Exact ${queueName} start ownership CAS was rejected`);
    }
    let runnerStarted=false;
    try {
    await recordSpecJobTransportAttempt({workspaceId:existing.workspaceId,jobId:existing.id,bossJobId:job.id,queueName,transportSchema:configuredSchema,phase:'claimed'});
    if (await markPersistPostSaveJobSupersededIfStale(payload.jobId)) {
      await recordSpecJobTransportAttempt({workspaceId:existing.workspaceId,jobId:existing.id,bossJobId:job.id,queueName,transportSchema:configuredSchema,
        phase:'terminal',outcome:'superseded',reasonCode:'stale_after_claim'});
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

      runnerStarted=true;
      const resultPayload = await runner(payload, onProgress);
      await throwIfCancelled(payload.jobId);
      if (await markPersistPostSaveJobSupersededIfStale(payload.jobId)) {
        await publishSpecJobSnapshot(payload.jobId, 'terminal');
        logger.info({ queueName, jobId: payload.jobId, specId: payload.specId, workspaceId: payload.workspaceId }, '[spec-job-worker] stale post-save completion superseded');
        return;
      }
      const completed = await compareAndSetJobStatus({
        jobId: payload.jobId, status: 'completed', expectedStatuses: ['running'],
        expectedWorkspaceId: existing.workspaceId, expectedSpecId: existing.specId,
        expectedBossJobId: job.id, expectedTransportSchema: configuredSchema,
        fields: { resultPayload: resultPayload as never, finishedAt: new Date() },
      });
      if (!completed) {
        const latest = await getJob(payload.jobId);
        if (latest?.status === 'cancelled' || latest?.status === 'superseded') {
          await syncPersistPostSaveStageFromJob(payload.jobId);
          await advancePersistPostSaveDependencies(payload.jobId);
          await publishSpecJobSnapshot(payload.jobId, 'terminal');
          return;
        }
        throw new Error(`Exact ${queueName} completion ownership CAS was rejected`);
      }
      await recordSpecJobTransportAttempt({workspaceId:existing.workspaceId,jobId:existing.id,bossJobId:job.id,queueName,transportSchema:configuredSchema,
        phase:'terminal',outcome:'completed'});
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
        await compareAndSetJobStatus({
          jobId: payload.jobId, status: terminalStatus, expectedStatuses: ['pending','running'],
          expectedWorkspaceId: existing.workspaceId, expectedSpecId: existing.specId,
          expectedBossJobId: job.id, expectedTransportSchema: configuredSchema,
          fields: { finishedAt: new Date(), progressMessage: terminalStatus === 'superseded' ? 'Superseded by newer spec save' : 'Cancelled by user', errorMessage: null },
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

      if(!runnerStarted){
        await terminalizeOwnedPreRunFailure({transport:job,queueName,configuredSchema,reasonCode:'pre_run_database_failure'});
        throw error;
      }

      if (await markPersistPostSaveJobSupersededIfStale(payload.jobId)) {
        await publishSpecJobSnapshot(payload.jobId, 'terminal');
        logger.info({ queueName, jobId: payload.jobId, specId: payload.specId, workspaceId: payload.workspaceId }, '[spec-job-worker] stale post-save failure superseded');
        return;
      }

      const latest = await getJob(payload.jobId);
      if (latest?.status === 'cancelled' || latest?.status === 'superseded') {
        // Cancellation/supersession is already terminal and must never be
        // rewritten by a losing worker.
        await syncPersistPostSaveStageFromJob(payload.jobId);
        await advancePersistPostSaveDependencies(payload.jobId);
        await publishSpecJobSnapshot(payload.jobId, 'terminal');
        logger.info({ queueName, jobId: payload.jobId, specId: payload.specId, workspaceId: payload.workspaceId }, '[spec-job-worker] cancellation won race with failure');
        return;
      }

      const message = errorMessageFor(error);
      const failed = await compareAndSetJobStatus({
        jobId: payload.jobId, status: 'failed', expectedStatuses: ['running'],
        expectedWorkspaceId: existing.workspaceId, expectedSpecId: existing.specId,
        expectedBossJobId: job.id, expectedTransportSchema: configuredSchema,
        fields: { errorMessage: message, finishedAt: new Date() },
      });
      if (!failed) {
        await syncPersistPostSaveStageFromJob(payload.jobId);
        await advancePersistPostSaveDependencies(payload.jobId);
        await publishSpecJobSnapshot(payload.jobId, 'terminal');
        return;
      }
      await recordSpecJobTransportAttempt({workspaceId:existing.workspaceId,jobId:existing.id,bossJobId:job.id,queueName,transportSchema:configuredSchema,
        phase:'terminal',outcome:'failed',reasonCode:runnerStarted?'runner_failed':'pre_run_failed'});
      await syncPersistPostSaveStageFromJob(payload.jobId);
      await advancePersistPostSaveDependencies(payload.jobId);
      await publishSpecJobSnapshot(payload.jobId, 'terminal');
      logSpecJobTelemetry(SpecReadinessReasonCode.StageFailed, {
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
      runEnrichJob(payload.workspaceId, payload.specId, onProgress, { jobId: payload.jobId }),
    ),
  );
  await boss.work(CONTEXT_ENRICH_QUEUE, { batchSize: 1 }, (jobs) =>
    handleSpecJobs(jobs, CONTEXT_ENRICH_QUEUE, (payload, onProgress) =>
      runContextEnrichJob(payload, onProgress),
    ),
  );
  await boss.work(SPEC_MATCH_SKILLS_QUEUE, { batchSize: 1 }, (jobs) =>
    handleSpecJobs(jobs, SPEC_MATCH_SKILLS_QUEUE, (payload, onProgress) =>
      runMatchSkillsJob(payload.workspaceId, payload.specId, onProgress, { jobId: payload.jobId }),
    ),
  );
  await boss.work(SPEC_MEMORY_SYNTHESIS_QUEUE, { batchSize: 1 }, (jobs) =>
    handleSpecJobs(jobs, SPEC_MEMORY_SYNTHESIS_QUEUE, (payload, onProgress) =>
      runMemorySynthesisJob(payload, onProgress),
    ),
  );
  await boss.work(SPEC_SUGGEST_SKILLS_QUEUE, { batchSize: 1 }, (jobs) =>
    handleSpecJobs(jobs, SPEC_SUGGEST_SKILLS_QUEUE, (payload, onProgress) =>
      runSuggestSkillsJob(payload.workspaceId, payload.specId, onProgress),
    ),
  );
  logger.info('[spec-job-worker] registered spec:enrich, context:enrich, spec:match-skills, spec:memory-synthesis, spec:suggest-skills');
}
