/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as crypto from 'crypto';
import type { PoolClient } from 'pg';
import { execute, query, queryOne, transaction } from './index';
import type { JsonValue } from './spec-jobs';

export type PostSaveWorkflowStageKey = 'context' | 'enrich' | 'matchSkills' | 'memorySynthesis';
export type PostSaveWorkflowRunStatus = 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'superseded';
export type PostSaveWorkflowStageStatus = 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'skipped';
export type PostSaveWorkflowQueueStatus = 'waiting' | 'queued' | 'running';

export interface PostSaveWorkflowRun {
  id: number;
  workspaceId: string;
  specId: string;
  generationLogId: number | null;
  saveGeneration: number | null;
  effectivePolicyHash: string;
  effectivePolicy: JsonValue;
  idempotencyKey: string;
  status: PostSaveWorkflowRunStatus;
  source: string;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

export interface PostSaveWorkflowStage {
  id: number;
  runId: number;
  stageKey: PostSaveWorkflowStageKey;
  requested: boolean;
  status: PostSaveWorkflowStageStatus;
  reason: string;
  jobId: string | null;
  bossJobId: string | null;
  queueName: string | null;
  queueStatus: PostSaveWorkflowQueueStatus | null;
  queuePosition: number | null;
  activeJobsAhead: number | null;
  queuePriority: number | null;
  singletonKey: string | null;
  fingerprint: string | null;
  previousFingerprint: string | null;
  errorMessage: string | null;
  details: JsonValue;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

interface PostSaveWorkflowRunRow {
  id: number | string;
  workspace_id: string;
  spec_id: string;
  generation_log_id: number | string | null;
  save_generation: number | string | null;
  effective_policy_hash: string;
  effective_policy: JsonValue;
  idempotency_key: string;
  status: PostSaveWorkflowRunStatus;
  source: string;
  error_message: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  finished_at: Date | string | null;
}

interface PostSaveWorkflowStageRow {
  id: number | string;
  run_id: number | string;
  stage_key: PostSaveWorkflowStageKey;
  requested: boolean;
  status: PostSaveWorkflowStageStatus;
  reason: string;
  job_id: string | null;
  boss_job_id: string | null;
  queue_name: string | null;
  queue_status: PostSaveWorkflowQueueStatus | null;
  queue_position: number | null;
  active_jobs_ahead: number | null;
  queue_priority: number | null;
  singleton_key: string | null;
  fingerprint: string | null;
  previous_fingerprint: string | null;
  error_message: string | null;
  details: JsonValue;
  created_at: Date | string;
  updated_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
}

export interface CreateRunInput {
  workspaceId: string;
  specId: string;
  effectivePolicy?: JsonValue;
  effectivePolicyHash?: string;
  idempotencyKey: string;
  generationLogId?: number | null;
  saveGeneration?: number | null;
  status?: PostSaveWorkflowRunStatus;
  source?: string;
}

export interface InsertStageInput {
  stageKey: PostSaveWorkflowStageKey;
  requested: boolean;
  status: PostSaveWorkflowStageStatus;
  reason: string;
  jobId?: string | null;
  bossJobId?: string | null;
  queueName?: string | null;
  queueStatus?: PostSaveWorkflowQueueStatus | null;
  queuePosition?: number | null;
  activeJobsAhead?: number | null;
  queuePriority?: number | null;
  singletonKey?: string | null;
  fingerprint?: string | null;
  previousFingerprint?: string | null;
  errorMessage?: string | null;
  details?: JsonValue;
  startedAt?: Date | null;
  finishedAt?: Date | null;
}

export interface InsertStageDependencyInput {
  stageKey: PostSaveWorkflowStageKey;
  dependsOnStageKey: PostSaveWorkflowStageKey;
}

export interface UpdateStageStatusInput {
  runId: number;
  stageKey: PostSaveWorkflowStageKey;
  status: PostSaveWorkflowStageStatus;
  reason?: string;
  allowedCurrentStatuses?: PostSaveWorkflowStageStatus[];
  jobId?: string | null;
  bossJobId?: string | null;
  queueName?: string | null;
  queueStatus?: PostSaveWorkflowQueueStatus | null;
  queuePosition?: number | null;
  activeJobsAhead?: number | null;
  queuePriority?: number | null;
  singletonKey?: string | null;
  fingerprint?: string | null;
  previousFingerprint?: string | null;
  errorMessage?: string | null;
  details?: JsonValue;
  startedAt?: Date | null;
  finishedAt?: Date | null;
}

export interface LatestRunForSpecOptions {
  workspaceId?: string;
  saveGeneration?: number | null;
}

export interface ListActiveWorkflowConflictsInput {
  workspaceId: string;
  specId: string;
  effectivePolicyHash?: string;
  effectivePolicy?: JsonValue;
  excludeRunId?: number;
}

export interface ProjectedPostSaveStageState {
  requested: boolean;
  status: PostSaveWorkflowStageStatus;
  reason: string;
  jobId?: string;
  bossJobId?: string | null;
  error?: string | null;
  updatedAt?: string;
  fingerprint?: string;
  previousFingerprint?: string;
  queueName?: string;
  queueStatus?: PostSaveWorkflowQueueStatus;
  queuePosition?: number;
  activeJobsAhead?: number;
  queuePriority?: number;
  singletonKey?: string;
}

export type ProjectedPostSaveStageMap = Partial<Record<PostSaveWorkflowStageKey, ProjectedPostSaveStageState>>;

function asDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

function mapRunRow(row: PostSaveWorkflowRunRow): PostSaveWorkflowRun {
  return {
    id: Number(row.id),
    workspaceId: row.workspace_id,
    specId: row.spec_id,
    generationLogId: row.generation_log_id === null ? null : Number(row.generation_log_id),
    saveGeneration: row.save_generation === null ? null : Number(row.save_generation),
    effectivePolicyHash: row.effective_policy_hash,
    effectivePolicy: row.effective_policy,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    source: row.source,
    errorMessage: row.error_message,
    createdAt: asDate(row.created_at) ?? new Date(0),
    updatedAt: asDate(row.updated_at) ?? new Date(0),
    finishedAt: asDate(row.finished_at),
  };
}

function mapStageRow(row: PostSaveWorkflowStageRow): PostSaveWorkflowStage {
  return {
    id: Number(row.id),
    runId: Number(row.run_id),
    stageKey: row.stage_key,
    requested: row.requested,
    status: row.status,
    reason: row.reason,
    jobId: row.job_id,
    bossJobId: row.boss_job_id,
    queueName: row.queue_name,
    queueStatus: row.queue_status,
    queuePosition: row.queue_position,
    activeJobsAhead: row.active_jobs_ahead,
    queuePriority: row.queue_priority,
    singletonKey: row.singleton_key,
    fingerprint: row.fingerprint,
    previousFingerprint: row.previous_fingerprint,
    errorMessage: row.error_message,
    details: row.details,
    createdAt: asDate(row.created_at) ?? new Date(0),
    updatedAt: asDate(row.updated_at) ?? new Date(0),
    startedAt: asDate(row.started_at),
    finishedAt: asDate(row.finished_at),
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

export function hashEffectivePolicy(policy: JsonValue): string {
  return crypto.createHash('sha256').update(stableStringify(policy)).digest('hex');
}

const RUN_SELECT = `
  id,
  workspace_id,
  spec_id,
  generation_log_id,
  save_generation,
  effective_policy_hash,
  effective_policy,
  idempotency_key,
  status,
  source,
  error_message,
  created_at,
  updated_at,
  finished_at`;

const STAGE_SELECT = `
  id,
  run_id,
  stage_key,
  requested,
  status,
  reason,
  job_id,
  boss_job_id,
  queue_name,
  queue_status,
  queue_position,
  active_jobs_ahead,
  queue_priority,
  singleton_key,
  fingerprint,
  previous_fingerprint,
  error_message,
  details,
  created_at,
  updated_at,
  started_at,
  finished_at`;

export async function createRun(input: CreateRunInput): Promise<PostSaveWorkflowRun> {
  const effectivePolicy = input.effectivePolicy ?? {};
  const effectivePolicyHash = input.effectivePolicyHash ?? hashEffectivePolicy(effectivePolicy);
  const row = await queryOne<PostSaveWorkflowRunRow>(
    `INSERT INTO spec_post_save_workflow_runs (
       workspace_id,
       spec_id,
       generation_log_id,
       save_generation,
       effective_policy_hash,
       effective_policy,
       idempotency_key,
       status,
       source
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT ON CONSTRAINT spec_post_save_workflow_runs_idempotency_unique
     DO UPDATE SET updated_at = NOW()
     RETURNING ${RUN_SELECT}`,
    [
      input.workspaceId,
      input.specId,
      input.generationLogId ?? null,
      input.saveGeneration ?? null,
      effectivePolicyHash,
      effectivePolicy,
      input.idempotencyKey,
      input.status ?? 'pending',
      input.source ?? 'persist-post-save',
    ],
  );

  if (!row) {
    throw new Error('Failed to create post-save workflow run');
  }

  return mapRunRow(row);
}

export async function getLatestRunForSpec(
  specId: string,
  options: LatestRunForSpecOptions = {},
): Promise<PostSaveWorkflowRun | null> {
  const row = await queryOne<PostSaveWorkflowRunRow>(
    `SELECT ${RUN_SELECT}
     FROM spec_post_save_workflow_runs
     WHERE spec_id = $1
       AND ($2::text IS NULL OR workspace_id = $2::text)
       AND ($3::bigint IS NULL OR save_generation = $3::bigint)
     ORDER BY save_generation DESC NULLS LAST, created_at DESC, id DESC
     LIMIT 1`,
    [specId, options.workspaceId ?? null, options.saveGeneration ?? null],
  );

  return row ? mapRunRow(row) : null;
}

async function recomputeRunStatus(client: PoolClient, runId: number): Promise<void> {
  await client.query(
    `WITH stage_counts AS (
       SELECT
         COUNT(*) FILTER (WHERE status = 'failed' AND requested) AS failed_count,
         COUNT(*) FILTER (WHERE status = 'running' AND requested) AS running_count,
         COUNT(*) FILTER (WHERE status IN ('pending', 'queued') AND requested) AS waiting_count,
         COUNT(*) AS total_count
       FROM spec_post_save_workflow_stages
       WHERE run_id = $1
     ), next_status AS (
       SELECT CASE
         WHEN total_count = 0 THEN 'pending'
         WHEN failed_count > 0 THEN 'failed'
         WHEN running_count > 0 THEN 'running'
         WHEN waiting_count > 0 THEN 'queued'
         ELSE 'completed'
       END AS status
       FROM stage_counts
     )
     UPDATE spec_post_save_workflow_runs run
     SET status = next_status.status,
         updated_at = NOW(),
         finished_at = CASE
           WHEN next_status.status IN ('completed', 'failed', 'cancelled', 'superseded') THEN COALESCE(run.finished_at, NOW())
           ELSE NULL
         END
     FROM next_status
     WHERE run.id = $1`,
    [runId],
  );
}

export async function insertStages(
  runId: number,
  stages: InsertStageInput[],
  dependencies: InsertStageDependencyInput[] = [],
): Promise<PostSaveWorkflowStage[]> {
  return transaction(async (client) => {
    const inserted: PostSaveWorkflowStage[] = [];

    for (const stage of stages) {
      const result = await client.query<PostSaveWorkflowStageRow>(
        `INSERT INTO spec_post_save_workflow_stages (
           run_id,
           stage_key,
           requested,
           status,
           reason,
           job_id,
           boss_job_id,
           queue_name,
           queue_status,
           queue_position,
           active_jobs_ahead,
           queue_priority,
           singleton_key,
           fingerprint,
           previous_fingerprint,
           error_message,
           details,
           started_at,
           finished_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         ON CONFLICT (run_id, stage_key)
         DO UPDATE SET
           requested = EXCLUDED.requested,
           status = EXCLUDED.status,
           reason = EXCLUDED.reason,
           job_id = EXCLUDED.job_id,
           boss_job_id = EXCLUDED.boss_job_id,
           queue_name = EXCLUDED.queue_name,
           queue_status = EXCLUDED.queue_status,
           queue_position = EXCLUDED.queue_position,
           active_jobs_ahead = EXCLUDED.active_jobs_ahead,
           queue_priority = EXCLUDED.queue_priority,
           singleton_key = EXCLUDED.singleton_key,
           fingerprint = EXCLUDED.fingerprint,
           previous_fingerprint = EXCLUDED.previous_fingerprint,
           error_message = EXCLUDED.error_message,
           details = EXCLUDED.details,
           started_at = EXCLUDED.started_at,
           finished_at = EXCLUDED.finished_at,
           updated_at = NOW()
         RETURNING ${STAGE_SELECT}`,
        [
          runId,
          stage.stageKey,
          stage.requested,
          stage.status,
          stage.reason,
          stage.jobId ?? null,
          stage.bossJobId ?? null,
          stage.queueName ?? null,
          stage.queueStatus ?? null,
          stage.queuePosition ?? null,
          stage.activeJobsAhead ?? null,
          stage.queuePriority ?? null,
          stage.singletonKey ?? null,
          stage.fingerprint ?? null,
          stage.previousFingerprint ?? null,
          stage.errorMessage ?? null,
          stage.details ?? {},
          stage.startedAt ?? null,
          stage.finishedAt ?? null,
        ],
      );
      if (result.rows[0]) inserted.push(mapStageRow(result.rows[0]));
    }

    for (const dependency of dependencies) {
      await client.query(
        `INSERT INTO spec_post_save_stage_dependencies (run_id, stage_key, depends_on_stage_key)
         VALUES ($1, $2, $3)
         ON CONFLICT (run_id, stage_key, depends_on_stage_key) DO NOTHING`,
        [runId, dependency.stageKey, dependency.dependsOnStageKey],
      );
    }

    await recomputeRunStatus(client, runId);
    return inserted;
  });
}

export async function updateStageStatus(input: UpdateStageStatusInput): Promise<PostSaveWorkflowStage | null> {
  return transaction(async (client) => {
    const updates = ['status = $3', 'updated_at = NOW()'];
    const values: unknown[] = [input.runId, input.stageKey, input.status];
    let paramIndex = 4;

    const addUpdate = (column: string, value: unknown): void => {
      updates.push(`${column} = $${paramIndex++}`);
      values.push(value);
    };

    if (input.reason !== undefined) addUpdate('reason', input.reason);
    if (input.jobId !== undefined) addUpdate('job_id', input.jobId);
    if (input.bossJobId !== undefined) addUpdate('boss_job_id', input.bossJobId);
    if (input.queueName !== undefined) addUpdate('queue_name', input.queueName);
    if (input.queueStatus !== undefined) addUpdate('queue_status', input.queueStatus);
    if (input.queuePosition !== undefined) addUpdate('queue_position', input.queuePosition);
    if (input.activeJobsAhead !== undefined) addUpdate('active_jobs_ahead', input.activeJobsAhead);
    if (input.queuePriority !== undefined) addUpdate('queue_priority', input.queuePriority);
    if (input.singletonKey !== undefined) addUpdate('singleton_key', input.singletonKey);
    if (input.fingerprint !== undefined) addUpdate('fingerprint', input.fingerprint);
    if (input.previousFingerprint !== undefined) addUpdate('previous_fingerprint', input.previousFingerprint);
    if (input.errorMessage !== undefined) addUpdate('error_message', input.errorMessage);
    if (input.details !== undefined) addUpdate('details', input.details);
    if (input.startedAt !== undefined) addUpdate('started_at', input.startedAt);
    if (input.finishedAt !== undefined) addUpdate('finished_at', input.finishedAt);

    if (input.status === 'running' && input.startedAt === undefined) {
      updates.push('started_at = COALESCE(started_at, NOW())');
    }
    if (['completed', 'failed', 'skipped'].includes(input.status) && input.finishedAt === undefined) {
      updates.push('finished_at = COALESCE(finished_at, NOW())');
    }

    let statusGuard = '';
    if (input.allowedCurrentStatuses !== undefined) {
      statusGuard = `\n         AND status = ANY($${paramIndex++}::text[])`;
      values.push(input.allowedCurrentStatuses);
    }

    const result = await client.query<PostSaveWorkflowStageRow>(
      `UPDATE spec_post_save_workflow_stages
       SET ${updates.join(', ')}
       WHERE run_id = $1
         AND stage_key = $2${statusGuard}
       RETURNING ${STAGE_SELECT}`,
      values,
    );

    await recomputeRunStatus(client, input.runId);
    return result.rows[0] ? mapStageRow(result.rows[0]) : null;
  });
}

export async function attachBossJobId(
  runId: number,
  stageKey: PostSaveWorkflowStageKey,
  bossJobId: string,
  jobId?: string | null,
): Promise<PostSaveWorkflowStage | null> {
  return updateStageStatus({
    runId,
    stageKey,
    status: 'queued',
    reason: 'durable_job_enqueued',
    bossJobId,
    ...(jobId !== undefined ? { jobId } : {}),
  });
}

export async function listStagesByRun(runId: number): Promise<PostSaveWorkflowStage[]> {
  const rows = await query<PostSaveWorkflowStageRow>(
    `SELECT ${STAGE_SELECT}
     FROM spec_post_save_workflow_stages
     WHERE run_id = $1
     ORDER BY CASE stage_key
       WHEN 'context' THEN 1
       WHEN 'enrich' THEN 2
       WHEN 'matchSkills' THEN 3
       WHEN 'memorySynthesis' THEN 4
       ELSE 5
     END`,
    [runId],
  );

  return rows.map(mapStageRow);
}

export async function listActiveWorkflowConflicts(
  input: ListActiveWorkflowConflictsInput,
): Promise<PostSaveWorkflowRun[]> {
  const effectivePolicyHash = input.effectivePolicyHash ?? hashEffectivePolicy(input.effectivePolicy ?? {});
  const rows = await query<PostSaveWorkflowRunRow>(
    `SELECT ${RUN_SELECT}
     FROM spec_post_save_workflow_runs
     WHERE workspace_id = $1
       AND spec_id = $2
       AND effective_policy_hash = $3
       AND status IN ('pending', 'queued', 'running')
       AND ($4::bigint IS NULL OR id <> $4::bigint)
     ORDER BY created_at DESC, id DESC`,
    [input.workspaceId, input.specId, effectivePolicyHash, input.excludeRunId ?? null],
  );

  return rows.map(mapRunRow);
}

export async function supersedeActiveWorkflowRuns(
  workspaceId: string,
  specId: string,
  effectivePolicyHash?: string,
): Promise<number> {
  const result = await execute(
    `UPDATE spec_post_save_workflow_runs
     SET status = 'superseded',
         updated_at = NOW(),
         finished_at = COALESCE(finished_at, NOW())
     WHERE workspace_id = $1
       AND spec_id = $2
       AND ($3::text IS NULL OR effective_policy_hash = $3::text)
       AND status IN ('pending', 'queued', 'running')`,
    [workspaceId, specId, effectivePolicyHash ?? null],
  );

  return result.rowCount;
}

export function projectPostSaveStages(stages: PostSaveWorkflowStage[]): ProjectedPostSaveStageMap {
  const projected: ProjectedPostSaveStageMap = {};
  for (const stage of stages) {
    projected[stage.stageKey] = {
      requested: stage.requested,
      status: stage.status,
      reason: stage.reason,
      ...(stage.jobId ? { jobId: stage.jobId } : {}),
      ...(stage.bossJobId !== null ? { bossJobId: stage.bossJobId } : {}),
      ...(stage.errorMessage !== null ? { error: stage.errorMessage } : {}),
      updatedAt: stage.updatedAt.toISOString(),
      ...(stage.fingerprint ? { fingerprint: stage.fingerprint } : {}),
      ...(stage.previousFingerprint ? { previousFingerprint: stage.previousFingerprint } : {}),
      ...(stage.queueName ? { queueName: stage.queueName } : {}),
      ...(stage.queueStatus ? { queueStatus: stage.queueStatus } : {}),
      ...(stage.queuePosition !== null ? { queuePosition: stage.queuePosition } : {}),
      ...(stage.activeJobsAhead !== null ? { activeJobsAhead: stage.activeJobsAhead } : {}),
      ...(stage.queuePriority !== null ? { queuePriority: stage.queuePriority } : {}),
      ...(stage.singletonKey ? { singletonKey: stage.singletonKey } : {}),
    };
  }
  return projected;
}
