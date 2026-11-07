/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { execute, query, queryOne, transaction } from './index';
import { SpecReadinessReasonCode } from '../reason-codes';

export type SpecJobType =
  | 'enrich'
  | 'context-enrich'
  | 'match-skills'
  | 'memory-synthesis'
  | 'suggest-skills'
  | 'suggest-models'
  | 'detect-dependencies'
  | 'knowledge-graph'
  | 'add-stories'
  | 'validate'
  | 'score';

export type SpecJobStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'superseded';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface SpecJob {
  id: string;
  specId: string;
  workspaceId: string;
  jobType: SpecJobType;
  status: SpecJobStatus;
  bossJobId: string | null;
  transportSchema: string | null;
  saveGeneration: number | null;
  progressCurrent: number;
  progressTotal: number;
  progressMessage: string | null;
  requestPayload: JsonValue | null;
  resultPayload: JsonValue | null;
  errorMessage: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

interface SpecJobRow {
  id: string;
  spec_id: string;
  workspace_id: string;
  job_type: SpecJobType;
  status: SpecJobStatus;
  boss_job_id: string | null;
  transport_schema: string | null;
  save_generation: number | string | null;
  progress_current: number | null;
  progress_total: number | null;
  progress_message: string | null;
  request_payload: JsonValue | null;
  result_payload: JsonValue | null;
  error_message: string | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  created_at: Date | string;
}

export interface UpdateJobStatusFields {
  bossJobId?: string | null;
  transportSchema?: string | null;
  progressCurrent?: number;
  progressTotal?: number;
  progressMessage?: string | null;
  requestPayload?: JsonValue | null;
  resultPayload?: JsonValue | null;
  errorMessage?: string | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
}

function asDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

function mapSpecJobRow(row: SpecJobRow): SpecJob {
  return {
    id: row.id,
    specId: row.spec_id,
    workspaceId: row.workspace_id,
    jobType: row.job_type,
    status: row.status,
    bossJobId: row.boss_job_id,
    transportSchema: row.transport_schema,
    saveGeneration: row.save_generation === null ? null : Number(row.save_generation),
    progressCurrent: row.progress_current ?? 0,
    progressTotal: row.progress_total ?? 0,
    progressMessage: row.progress_message,
    requestPayload: row.request_payload,
    resultPayload: row.result_payload,
    errorMessage: row.error_message,
    startedAt: asDate(row.started_at),
    finishedAt: asDate(row.finished_at),
    createdAt: asDate(row.created_at) ?? new Date(0),
  };
}

export interface SpecJobState {
  id: string;
  specId: string;
  workspaceId: string;
  jobType: SpecJobType;
  status: SpecJobStatus;
  saveGeneration: number | null;
  progress: {
    current: number;
    total: number;
    message: string | null;
  };
  result: JsonValue | null;
  error: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

export function toSpecJobState(job: SpecJob): SpecJobState {
  return {
    id: job.id,
    specId: job.specId,
    workspaceId: job.workspaceId,
    jobType: job.jobType,
    status: job.status,
    saveGeneration: job.saveGeneration,
    progress: {
      current: job.progressCurrent,
      total: job.progressTotal,
      message: job.progressMessage,
    },
    result: job.resultPayload,
    error: job.errorMessage,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    createdAt: job.createdAt,
  };
}

export function isTerminalStatus(status: SpecJobStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'superseded';
}

function extractSaveGeneration(requestPayload: JsonValue | null): number | null {
  if (!requestPayload || typeof requestPayload !== 'object' || Array.isArray(requestPayload)) return null;
  const value = (requestPayload as { [key: string]: JsonValue }).saveGeneration;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function extractTransportSchema(requestPayload: JsonValue | null): string | null {
  if (!requestPayload || typeof requestPayload !== 'object' || Array.isArray(requestPayload)) return null;
  const value = (requestPayload as { [key: string]: JsonValue }).transportSchema;
  return typeof value === 'string' && /^pgboss(?:_[a-z0-9_]{1,48})?$/.test(value) ? value : null;
}

export interface CreateJobOwnership {
  jobId?: string;
  bossJobId?: string;
  transportSchema?: string;
}

export async function createJob(
  workspaceId: string,
  specId: string,
  jobType: SpecJobType,
  requestPayload: JsonValue | null,
  ownership: CreateJobOwnership = {},
): Promise<SpecJob> {
  const row = await queryOne<SpecJobRow>(
    `INSERT INTO spec_jobs (
      id,
      workspace_id,
      spec_id,
      job_type,
      status,
      request_payload,
      save_generation,
      boss_job_id,
      transport_schema
    ) VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, 'pending', $5, $6, $7::uuid, $8)
    RETURNING
      id,
      spec_id,
      workspace_id,
      job_type,
      status,
      boss_job_id,
      transport_schema,
      save_generation,
      progress_current,
      progress_total,
      progress_message,
      request_payload,
      result_payload,
      error_message,
      started_at,
      finished_at,
      created_at`,
    [
      ownership.jobId ?? null,
      workspaceId,
      specId,
      jobType,
      requestPayload,
      extractSaveGeneration(requestPayload),
      ownership.bossJobId ?? null,
      ownership.transportSchema ?? extractTransportSchema(requestPayload),
    ],
  );

  if (!row) {
    throw new Error('Failed to create spec job');
  }

  return mapSpecJobRow(row);
}

export async function getJob(jobId: string): Promise<SpecJob | null> {
  const row = await queryOne<SpecJobRow>(
    `SELECT
      id,
      spec_id,
      workspace_id,
      job_type,
      status,
      boss_job_id,
      transport_schema,
      save_generation,
      progress_current,
      progress_total,
      progress_message,
      request_payload,
      result_payload,
      error_message,
      started_at,
      finished_at,
      created_at
    FROM spec_jobs
    WHERE id = $1`,
    [jobId],
  );

  return row ? mapSpecJobRow(row) : null;
}

function expectedQueueForJobType(jobType:SpecJobType):string|null{
  if(jobType==='enrich')return 'spec:enrich';
  if(jobType==='context-enrich')return 'context:enrich';
  if(jobType==='match-skills')return 'spec:match-skills';
  if(jobType==='memory-synthesis')return 'spec:memory-synthesis';
  if(jobType==='suggest-skills')return 'spec:suggest-skills';
  return null;
}

/** Resolve immutable application ownership from broker identity before parsing untrusted payload bytes. */
export async function getJobByTransportOwnership(bossJobId:string,transportSchema:string,queueName:string):Promise<SpecJob|null>{
  const row=await queryOne<SpecJobRow>(`SELECT id,spec_id,workspace_id,job_type,status,boss_job_id,transport_schema,
    save_generation,progress_current,progress_total,progress_message,request_payload,result_payload,error_message,
    started_at,finished_at,created_at FROM spec_jobs
    WHERE boss_job_id=$1::uuid AND transport_schema=$2 LIMIT 2`,[bossJobId,transportSchema]);
  if(!row||expectedQueueForJobType(row.job_type)!==queueName)return null;
  return mapSpecJobRow(row);
}

export async function updateJobStatus(
  jobId: string,
  status: SpecJobStatus,
  fields: UpdateJobStatusFields = {},
): Promise<void> {
  const updates: string[] = ['status = $2'];
  const values: Array<string | number | Date | JsonValue | null> = [jobId, status];
  let paramIndex = 3;

  if (fields.bossJobId !== undefined) {
    updates.push(`boss_job_id = $${paramIndex++}`);
    values.push(fields.bossJobId);
  }
  if (fields.transportSchema !== undefined) {
    updates.push(`transport_schema = $${paramIndex++}`);
    values.push(fields.transportSchema);
  }
  if (fields.progressCurrent !== undefined) {
    updates.push(`progress_current = $${paramIndex++}`);
    values.push(fields.progressCurrent);
  }
  if (fields.progressTotal !== undefined) {
    updates.push(`progress_total = $${paramIndex++}`);
    values.push(fields.progressTotal);
  }
  if (fields.progressMessage !== undefined) {
    updates.push(`progress_message = $${paramIndex++}`);
    values.push(fields.progressMessage);
  }
  if (fields.requestPayload !== undefined) {
    updates.push(`request_payload = $${paramIndex++}`);
    values.push(fields.requestPayload);
  }
  if (fields.resultPayload !== undefined) {
    updates.push(`result_payload = $${paramIndex++}`);
    values.push(fields.resultPayload);
  }
  if (fields.errorMessage !== undefined) {
    updates.push(`error_message = $${paramIndex++}`);
    values.push(fields.errorMessage);
  }
  if (fields.startedAt !== undefined) {
    updates.push(`started_at = $${paramIndex++}`);
    values.push(fields.startedAt);
  }
  if (fields.finishedAt !== undefined) {
    updates.push(`finished_at = $${paramIndex++}`);
    values.push(fields.finishedAt);
  }

  await execute(
    `UPDATE spec_jobs
     SET ${updates.join(', ')}
     WHERE id = $1`,
    values,
  );
}

export interface CompareAndSetJobStatusInput {
  jobId: string;
  status: SpecJobStatus;
  expectedStatuses: SpecJobStatus[];
  expectedWorkspaceId?: string;
  expectedSpecId?: string;
  expectedBossJobId?: string;
  expectedTransportSchema?: string;
  fields?: UpdateJobStatusFields;
}

/** Monotonic application-job lifecycle transition with exact optional ownership guards. */
export async function compareAndSetJobStatus(input: CompareAndSetJobStatusInput): Promise<boolean> {
  const updates: string[] = ['status = $2'];
  const values: Array<string | number | Date | JsonValue | null | string[]> = [input.jobId, input.status];
  let paramIndex = 3;
  const addUpdate = (column: string, value: string | number | Date | JsonValue | null): void => {
    updates.push(`${column} = $${paramIndex++}`);
    values.push(value);
  };
  const fields = input.fields ?? {};
  if (fields.bossJobId !== undefined) addUpdate('boss_job_id', fields.bossJobId);
  if (fields.transportSchema !== undefined) addUpdate('transport_schema', fields.transportSchema);
  if (fields.progressCurrent !== undefined) addUpdate('progress_current', fields.progressCurrent);
  if (fields.progressTotal !== undefined) addUpdate('progress_total', fields.progressTotal);
  if (fields.progressMessage !== undefined) addUpdate('progress_message', fields.progressMessage);
  if (fields.requestPayload !== undefined) addUpdate('request_payload', fields.requestPayload);
  if (fields.resultPayload !== undefined) addUpdate('result_payload', fields.resultPayload);
  if (fields.errorMessage !== undefined) addUpdate('error_message', fields.errorMessage);
  if (fields.startedAt !== undefined) addUpdate('started_at', fields.startedAt);
  if (fields.finishedAt !== undefined) addUpdate('finished_at', fields.finishedAt);

  let guards = ` AND status = ANY($${paramIndex++}::text[])`;
  values.push(input.expectedStatuses);
  for (const [column, expected] of [
    ['workspace_id', input.expectedWorkspaceId],
    ['spec_id', input.expectedSpecId],
    ['boss_job_id', input.expectedBossJobId],
    ['transport_schema', input.expectedTransportSchema],
  ] as const) {
    if (expected !== undefined) {
      guards += ` AND ${column} IS NOT DISTINCT FROM $${paramIndex++}`;
      values.push(expected);
    }
  }
  const result = await execute(`UPDATE spec_jobs SET ${updates.join(', ')} WHERE id = $1${guards}`, values);
  return result.rowCount === 1;
}

export interface SpecJobTransportAttemptInput {
  workspaceId: string;
  jobId: string;
  bossJobId: string;
  queueName: string;
  transportSchema: string;
  phase: 'received' | 'validated' | 'claimed' | 'running' | 'terminal';
  outcome?: 'completed' | 'failed' | 'cancelled' | 'superseded' | 'rejected';
  reasonCode?: string;
}

/** Append exact transport-attempt evidence without changing application state. */
export async function recordSpecJobTransportAttempt(input: SpecJobTransportAttemptInput): Promise<void> {
  await transaction(async(client)=>{
    await client.query(`SELECT set_config('rorca.workspace_id',$1,TRUE)`,[input.workspaceId]);
    const owned=await client.query(`SELECT 1 FROM spec_jobs WHERE id=$1::uuid AND workspace_id=$2
      AND boss_job_id=$3::uuid AND transport_schema=$4 FOR UPDATE`,
    [input.jobId,input.workspaceId,input.bossJobId,input.transportSchema]);
    if(owned.rowCount!==1)throw new Error('Spec-job transport attempt lost exact ownership');
    await client.query(`INSERT INTO spec_job_transport_attempts
      (workspace_id,job_id,boss_job_id,queue_name,transport_schema,attempt_number,phase,outcome,reason_code)
      SELECT $1,$2::uuid,$3::uuid,$4,$5,COALESCE(max(attempt_number),0)+1,$6,$7,$8
        FROM spec_job_transport_attempts WHERE workspace_id=$1 AND job_id=$2::uuid AND boss_job_id=$3::uuid`,
    [input.workspaceId,input.jobId,input.bossJobId,input.queueName,input.transportSchema,input.phase,input.outcome??null,input.reasonCode??null]);
  });
}

/** Exact owner terminalization and its poison/DB-failure evidence are one durable transaction. */
export async function terminalizeOwnedSpecJobTransportFailure(input:{
  bossJobId:string;transportSchema:string;queueName:string;reasonCode:string;
}):Promise<SpecJob|null>{
  return transaction(async(client)=>{
    const located=await client.query<SpecJobRow>(`SELECT id,spec_id,workspace_id,job_type,status,boss_job_id,transport_schema,
      save_generation,progress_current,progress_total,progress_message,request_payload,result_payload,error_message,
      started_at,finished_at,created_at FROM spec_jobs
      WHERE boss_job_id=$1::uuid AND transport_schema=$2 FOR UPDATE`,[input.bossJobId,input.transportSchema]);
    const row=located.rows[0];
    if(!row||located.rows.length!==1||expectedQueueForJobType(row.job_type)!==input.queueName)return null;
    await client.query(`SELECT set_config('rorca.workspace_id',$1,TRUE)`,[row.workspace_id]);
    const terminal=await client.query(`UPDATE spec_jobs SET status='failed',
      error_message=$5,progress_message='Transport quarantined before runner',finished_at=clock_timestamp()
      WHERE id=$1::uuid AND workspace_id=$2 AND boss_job_id=$3::uuid AND transport_schema=$4
        AND status IN('pending','running')`,[row.id,row.workspace_id,input.bossJobId,input.transportSchema,
      `Transport rejected before runner: ${input.reasonCode}`]);
    if(terminal.rowCount!==1)return null;
    await client.query(`INSERT INTO spec_job_transport_attempts
      (workspace_id,job_id,boss_job_id,queue_name,transport_schema,attempt_number,phase,outcome,reason_code)
      SELECT $1,$2::uuid,$3::uuid,$4,$5,COALESCE(max(attempt_number),0)+1,'terminal','rejected',$6
      FROM spec_job_transport_attempts WHERE workspace_id=$1 AND job_id=$2::uuid AND boss_job_id=$3::uuid`,
    [row.workspace_id,row.id,input.bossJobId,input.queueName,input.transportSchema,input.reasonCode]);
    const current=await client.query<SpecJobRow>(`SELECT id,spec_id,workspace_id,job_type,status,boss_job_id,transport_schema,
      save_generation,progress_current,progress_total,progress_message,request_payload,result_payload,error_message,
      started_at,finished_at,created_at FROM spec_jobs WHERE id=$1::uuid`,[row.id]);
    return mapSpecJobRow(current.rows[0]!);
  });
}

export interface RecoverExactPostSaveJobInput {
  jobId: string;
  workspaceId: string;
  specId: string;
  stageKey: 'enrich' | 'matchSkills' | 'memorySynthesis';
  bossJobId: string;
  transportSchema: string;
  saveGeneration: number;
  message: string;
}

/**
 * Recovery-only terminal CAS. The application job and its stage/run/transport
 * ownership are re-read by PostgreSQL in the same statement; a worker that has
 * already completed or changed any ownership dimension wins and recovery does
 * not create replacement work.
 */
export async function recoverExactPostSaveJob(input: RecoverExactPostSaveJobInput): Promise<boolean> {
  const result = await execute(
    `UPDATE spec_jobs job
        SET status='failed',finished_at=statement_timestamp(),progress_message=$8,error_message=$8
      WHERE job.id=$1::uuid AND job.workspace_id=$2 AND job.spec_id=$3
        AND job.status IN('pending','running')
        AND job.boss_job_id=$5::uuid AND job.transport_schema=$6 AND job.save_generation=$7
        AND EXISTS(
          SELECT 1
            FROM spec_post_save_workflow_stages stage
            JOIN spec_post_save_workflow_runs run ON run.id=stage.run_id
           WHERE stage.job_id=job.id AND stage.stage_key=$4
             AND stage.status IN('queued','running')
             AND stage.boss_job_id=job.boss_job_id::text
             AND stage.transport_schema=job.transport_schema
             AND run.workspace_id=job.workspace_id AND run.spec_id=job.spec_id
             AND run.save_generation=job.save_generation
             AND run.status IN('queued','running')
        )`,
    [input.jobId,input.workspaceId,input.specId,input.stageKey,input.bossJobId,input.transportSchema,input.saveGeneration,input.message],
  );
  return result.rowCount === 1;
}

export async function listActiveJobs(workspaceId: string, specId?: string): Promise<SpecJob[]> {
  const rows = specId
    ? await query<SpecJobRow>(
      `SELECT
        id,
        spec_id,
        workspace_id,
        job_type,
        status,
        boss_job_id,
        transport_schema,
        save_generation,
        progress_current,
        progress_total,
        progress_message,
        request_payload,
        result_payload,
        error_message,
        started_at,
        finished_at,
        created_at
      FROM spec_jobs
      WHERE workspace_id = $1
        AND spec_id = $2
        AND status IN ('pending', 'running')
      ORDER BY created_at DESC`,
      [workspaceId, specId],
    )
    : await query<SpecJobRow>(
      `SELECT
        id,
        spec_id,
        workspace_id,
        job_type,
        status,
        boss_job_id,
        transport_schema,
        save_generation,
        progress_current,
        progress_total,
        progress_message,
        request_payload,
        result_payload,
        error_message,
        started_at,
        finished_at,
        created_at
      FROM spec_jobs
      WHERE workspace_id = $1
        AND status IN ('pending', 'running')
      ORDER BY created_at DESC`,
      [workspaceId],
    );

  return rows.map(mapSpecJobRow);
}

export async function listJobsForSpec(
  workspaceId: string,
  specId: string,
  jobTypes?: SpecJobType[],
): Promise<SpecJob[]> {
  const rows = jobTypes && jobTypes.length > 0
    ? await query<SpecJobRow>(
      `SELECT
        id,
        spec_id,
        workspace_id,
        job_type,
        status,
        boss_job_id,
        transport_schema,
        save_generation,
        progress_current,
        progress_total,
        progress_message,
        request_payload,
        result_payload,
        error_message,
        started_at,
        finished_at,
        created_at
      FROM spec_jobs
      WHERE workspace_id = $1
        AND spec_id = $2
        AND job_type = ANY($3::text[])
      ORDER BY created_at DESC`,
      [workspaceId, specId, jobTypes],
    )
    : await query<SpecJobRow>(
      `SELECT
        id,
        spec_id,
        workspace_id,
        job_type,
        status,
        boss_job_id,
        transport_schema,
        save_generation,
        progress_current,
        progress_total,
        progress_message,
        request_payload,
        result_payload,
        error_message,
        started_at,
        finished_at,
        created_at
      FROM spec_jobs
      WHERE workspace_id = $1
        AND spec_id = $2
      ORDER BY created_at DESC`,
      [workspaceId, specId],
    );

  return rows.map(mapSpecJobRow);
}

// ─── Repair candidate discovery ─────────────────────────────────────────────

export type RepairDiscoveryKind =
  | 'missing_generation_log'
  | 'missing_context_summary'
  | 'stuck_pending_enrichment'
  | 'failed_enrichment'
  | 'missing_suggested_skills';

export type RepairIssueCategory =
  | typeof SpecReadinessReasonCode.MissingContext
  | typeof SpecReadinessReasonCode.PostSavePending
  | typeof SpecReadinessReasonCode.StageFailed
  | typeof SpecReadinessReasonCode.NoInstalledSkills;

export interface RepairCandidateRow {
  spec_slug: string;
  log_id: number | null;
  status: string | null;
  issues: RepairIssueCategory[];
  findings: RepairDiscoveryKind[];
  context_summary_json: Record<string, unknown> | null;
}

function reasonCodeForRepairFinding(finding: RepairDiscoveryKind): RepairIssueCategory {
  switch (finding) {
    case 'missing_generation_log':
    case 'missing_context_summary':
      return SpecReadinessReasonCode.MissingContext;
    case 'stuck_pending_enrichment':
      return SpecReadinessReasonCode.PostSavePending;
    case 'failed_enrichment':
      return SpecReadinessReasonCode.StageFailed;
    case 'missing_suggested_skills':
      return SpecReadinessReasonCode.NoInstalledSkills;
  }
}

/**
 * Find specs in a workspace that are candidates for repair.
 *
 * Scans spec_generation_logs (latest per slug) for the given workspace and
 * checks each against known issue categories. Optionally filter by specific
 * issue categories and limit results.
 *
 * NOTE: This only discovers specs that have generation logs with a workspaceId
 * matching the given workspace. Specs with NO generation log at all are
 * discovered separately via filesystem scan (handled by the route layer).
 */
export async function listRepairCandidatesFromLogs(
  workspaceId: string,
  options: {
    categories?: RepairIssueCategory[];
    limit?: number;
  } = {},
): Promise<RepairCandidateRow[]> {
  const limit = Math.min(options.limit ?? 100, 500);

  // Fetch the latest generation log per spec_slug for this workspace
  const rows = await query<{
    spec_slug: string;
    id: number;
    status: string;
    context_summary_json: unknown;
  }>(
    `SELECT DISTINCT ON (sgl.spec_slug)
       sgl.spec_slug,
       sgl.id,
       sgl.status,
       sgl.context_summary_json
     FROM spec_generation_logs sgl
     WHERE sgl.context_summary_json IS NOT NULL
       AND sgl.context_summary_json ->> 'workspaceId' = $1
     ORDER BY sgl.spec_slug, sgl.created_at DESC, sgl.id DESC
     LIMIT $2`,
    [workspaceId, limit * 5], // over-fetch since we filter in app
  );

  const wantedCategories = options.categories
    ? new Set(options.categories)
    : null;

  const candidates: RepairCandidateRow[] = [];

  for (const row of rows) {
    const summary = parseJsonColumn(row.context_summary_json);
    const findings: RepairDiscoveryKind[] = [];

    // Check for missing context summary
    const ctxCapture = summary.contextCaptureStatus as Record<string, unknown> | undefined;
    if (!ctxCapture || ctxCapture.status === 'missing' || !summary.contextCaptureStatus) {
      findings.push('missing_context_summary');
    }

    // Check enrichment stage health
    const stages = summary.postSaveStages as Record<string, Record<string, unknown>> | undefined;
    if (stages) {
      const enrichStage = stages.enrich;
      const matchSkillsStage = stages.matchSkills;

      // Stuck pending enrichment: a requested stage is still pending/queued/running for too long
      const isStuckEnrich = enrichStage?.requested
        && ['pending', 'queued', 'running'].includes(String(enrichStage.status ?? ''));
      const isStuckMatchSkills = matchSkillsStage?.requested
        && ['pending', 'queued', 'running'].includes(String(matchSkillsStage.status ?? ''));
      if (isStuckEnrich || isStuckMatchSkills) {
        findings.push('stuck_pending_enrichment');
      }

      // Failed enrichment
      const isFailedEnrich = enrichStage?.requested && enrichStage.status === 'failed';
      const isFailedMatchSkills = matchSkillsStage?.requested && matchSkillsStage.status === 'failed';
      if (isFailedEnrich || isFailedMatchSkills) {
        findings.push('failed_enrichment');
      }

      // Missing suggested skills: match-skills completed but spec has no suggestedSkills
      // (this is a heuristic — we mark it and let the route verify against the spec file)
      if (matchSkillsStage?.requested
          && matchSkillsStage.status === 'skipped'
          && matchSkillsStage.reason === SpecReadinessReasonCode.NoInstalledSkills) {
        findings.push('missing_suggested_skills');
      }
    } else {
      // No postSaveStages at all — stage tracking is missing
      if (summary.postSave && typeof summary.postSave === 'object') {
        const postSave = summary.postSave as Record<string, unknown>;
        if (postSave.enrich || postSave.matchSkills) {
          findings.push('stuck_pending_enrichment');
        }
      }
    }

    if (findings.length === 0) continue;

    const issues = [...new Set(findings.map(reasonCodeForRepairFinding))];

    // Filter by requested categories
    if (wantedCategories) {
      const matched = issues.filter((i) => wantedCategories.has(i));
      if (matched.length === 0) continue;
      const matchedFindings = findings.filter((finding) => matched.includes(reasonCodeForRepairFinding(finding)));
      candidates.push({
        spec_slug: row.spec_slug,
        log_id: row.id,
        status: row.status,
        issues: matched,
        findings: matchedFindings,
        context_summary_json: summary,
      });
    } else {
      candidates.push({
        spec_slug: row.spec_slug,
        log_id: row.id,
        status: row.status,
        issues,
        findings,
        context_summary_json: summary,
      });
    }

    if (candidates.length >= limit) break;
  }

  return candidates;
}

function parseJsonColumn(value: unknown): Record<string, unknown> {
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

export async function cleanupStaleJobs(): Promise<number> {
  const result = await execute(
    `UPDATE spec_jobs
     SET
       status = 'failed',
       error_message = COALESCE(error_message, 'Recovered by stale job cleanup after worker crash or timeout'),
       finished_at = COALESCE(finished_at, NOW())
     WHERE status = 'running'
       AND started_at IS NOT NULL
       AND started_at < NOW() - INTERVAL '30 minutes'`,
  );

  return result.rowCount;
}
