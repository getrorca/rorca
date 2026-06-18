/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { execute, query, queryOne } from './index';

export type SpecJobType =
  | 'enrich'
  | 'context-enrich'
  | 'match-skills'
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

export async function createJob(
  workspaceId: string,
  specId: string,
  jobType: SpecJobType,
  requestPayload: JsonValue | null,
): Promise<SpecJob> {
  const row = await queryOne<SpecJobRow>(
    `INSERT INTO spec_jobs (
      workspace_id,
      spec_id,
      job_type,
      status,
      request_payload,
      save_generation
    ) VALUES ($1, $2, $3, 'pending', $4, $5)
    RETURNING
      id,
      spec_id,
      workspace_id,
      job_type,
      status,
      boss_job_id,
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
    [workspaceId, specId, jobType, requestPayload, extractSaveGeneration(requestPayload)],
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

export type RepairIssueCategory =
  | 'missing_generation_log'
  | 'missing_context_summary'
  | 'stuck_pending_enrichment'
  | 'failed_enrichment'
  | 'missing_suggested_skills';

export interface RepairCandidateRow {
  spec_slug: string;
  log_id: number | null;
  status: string | null;
  issues: RepairIssueCategory[];
  context_summary_json: Record<string, unknown> | null;
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
    const issues: RepairIssueCategory[] = [];

    // Check for missing context summary
    const ctxCapture = summary.contextCaptureStatus as Record<string, unknown> | undefined;
    if (!ctxCapture || ctxCapture.status === 'missing' || !summary.contextCaptureStatus) {
      issues.push('missing_context_summary');
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
        issues.push('stuck_pending_enrichment');
      }

      // Failed enrichment
      const isFailedEnrich = enrichStage?.requested && enrichStage.status === 'failed';
      const isFailedMatchSkills = matchSkillsStage?.requested && matchSkillsStage.status === 'failed';
      if (isFailedEnrich || isFailedMatchSkills) {
        issues.push('failed_enrichment');
      }

      // Missing suggested skills: match-skills completed but spec has no suggestedSkills
      // (this is a heuristic — we mark it and let the route verify against the spec file)
      if (matchSkillsStage?.requested
          && matchSkillsStage.status === 'skipped'
          && matchSkillsStage.reason === 'no_installed_skills') {
        issues.push('missing_suggested_skills');
      }
    } else {
      // No postSaveStages at all — stage tracking is missing
      if (summary.postSave && typeof summary.postSave === 'object') {
        const postSave = summary.postSave as Record<string, unknown>;
        if (postSave.enrich || postSave.matchSkills) {
          issues.push('stuck_pending_enrichment');
        }
      }
    }

    if (issues.length === 0) continue;

    // Filter by requested categories
    if (wantedCategories) {
      const matched = issues.filter((i) => wantedCategories.has(i));
      if (matched.length === 0) continue;
      candidates.push({
        spec_slug: row.spec_slug,
        log_id: row.id,
        status: row.status,
        issues: matched,
        context_summary_json: summary,
      });
    } else {
      candidates.push({
        spec_slug: row.spec_slug,
        log_id: row.id,
        status: row.status,
        issues,
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
